import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import fixture from "../fixtures/crossref-work.json" with { type: "json" };
import { crossrefMetadata, paperSnapshot } from "../../src/paper-format";

const doi = fixture.message.DOI;
/** Refuse accidental live provider/publisher traffic; return only synthetic metadata. */
async function provider(page: Page, response = fixture) {
  const requests: string[] = [];
  await page.route("https://api.crossref.org/**", async (route) => {
    requests.push(route.request().url());
    expect(route.request().headers().cookie).toBeUndefined();
    expect(route.request().headers().authorization).toBeUndefined();
    expect(route.request().headers().referer).toBeUndefined();
    await route.fulfill({
      json: response,
      headers: {
        "x-rate-limit-limit": "5",
        "x-rate-limit-interval": "1s",
        "x-rate-limit-type": "single",
      },
    });
  });
  await page.route("https://publisher.example.org/**", (route) => {
    throw Error(`Unexpected publisher request: ${route.request().url()}`);
  });
  return requests;
}
/** Submit only after the explicit DOI disclosure and wait for the selected snapshot. */
async function lookup(page: Page) {
  await page.getByLabel("DOIまたは https://doi.org/ のURL").fill(doi);
  await page.getByRole("button", { name: "DOIをCrossrefへ送って確認" }).click();
  await expect(
    page.getByRole("heading", { name: fixture.message.title[0], exact: true }),
  ).toBeVisible();
}
/** Inspect the independent library using its public reader API rather than UI status alone. */
async function records(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/paper-store.ts";
    const api: typeof import("../../src/paper-store") = await import(path);
    return api.listPapers();
  });
}
/** Hold delivery of one real committed save without changing its data or transaction result. */
async function holdPaperCompletion(
  page: Page,
  mode: "readonly" | "readwrite" = "readwrite",
) {
  await page.evaluate((mode) => {
    const original = IDBDatabase.prototype.transaction;
    const state = window as unknown as {
      heldPaperCompletion: boolean;
      settledPaperCompletion: boolean;
      releasePaperCompletion: () => void;
    };
    state.heldPaperCompletion = false;
    state.settledPaperCompletion = false;
    let first = true;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = original.apply(this, args);
      if (first && this.name === "quilna.papers.v1" && tx.mode === mode) {
        first = false;
        const close = this.close;
        this.close = function () {
          close.call(this);
          state.settledPaperCompletion = true;
        };
        let completed:
          ((this: IDBTransaction, event: Event) => unknown) | null = null;
        Object.defineProperty(tx, "oncomplete", {
          set(value) {
            completed = value;
          },
          get() {
            return completed;
          },
        });
        tx.addEventListener("complete", (event) => {
          state.heldPaperCompletion = true;
          state.releasePaperCompletion = () => {
            const callback = completed;
            completed = null;
            callback?.call(tx, event);
          };
        });
      }
      return tx;
    };
  }, mode);
}
/** Observe actual commit delivery being held before changing focus or the selected observation. */
async function waitForPaperCompletion(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { heldPaperCompletion: boolean })
            .heldPaperCompletion,
      ),
    )
    .toBe(true);
}
/** Resume the commit, observe validation/connection cleanup, then cross the UI continuation boundary. */
async function releasePaperCompletion(page: Page) {
  await page.evaluate(() => {
    (
      window as unknown as { releasePaperCompletion: () => void }
    ).releasePaperCompletion();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { settledPaperCompletion: boolean })
            .settledPaperCompletion,
      ),
    )
    .toBe(true);
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}
test("explicit preview/save/file round trip preserves bibliographic identity and excludes unselected/private fields", async ({
  page,
  browser,
}, info) => {
  const requests = await provider(page);
  await page.goto("/?view=papers");
  await page.evaluate(() =>
    localStorage.setItem("PRIVATE_SENTINEL", "PRIVATE_READER_HISTORY"),
  );
  await expect(page).toHaveTitle("論文の書誌情報 · Quilna");
  await expect(page.getByRole("status")).toBeEmpty();
  expect(requests).toEqual([]);
  await lookup(page);
  expect(requests).toEqual([
    "https://api.crossref.org/works/10.5555%2Fquilna.synthetic",
  ]);
  const preview = page.getByRole("region", { name: "書誌情報のプレビュー" });
  await expect(preview).toContainText("2026-10");
  await expect(preview).toContainText("is-preprint-of");
  await expect(preview).toContainText("Synthetic correction");
  await expect(preview.locator("script")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as Record<string, unknown>).PAPER_XSS,
    ),
  ).toBeUndefined();
  expect((await records(page)).snapshots).toHaveLength(0);
  const save = page.getByRole("button", { name: "この書誌情報を保存" });
  await save.focus();
  await save.press("Enter");
  await expect(
    page.getByRole("button", { name: "保存済み", exact: true }),
  ).toBeFocused();
  const original = (await records(page)).snapshots[0];
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "この記録をファイルに保存" }).click();
  const file = await download,
    path = info.outputPath("paper.json");
  await file.saveAs(path);
  const exported = new TextDecoder().decode(await readFile(path));
  expect(JSON.parse(exported)).toEqual(original);
  expect(exported).not.toMatch(
    /COPYRIGHTED|UNSELECTED|PRIVATE_READER_HISTORY|privateFixtureField/,
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "書誌情報を開く" }),
  ).toHaveCount(1);
  const context = await browser.newContext({
    viewport: info.project.use.viewport,
    isMobile: info.project.use.isMobile,
    locale: "ja-JP",
  });
  try {
    const other = await context.newPage(),
      otherRequests = await provider(other);
    await other.goto("http://127.0.0.1:5197/?view=papers");
    expect((await records(other)).snapshots).toHaveLength(0);
    await other.getByLabel("保存した書誌ファイルを確認").setInputFiles(path);
    await expect(other.getByRole("status")).toContainText(
      "提供元への通信は行っていません",
    );
    await other.getByRole("button", { name: "この書誌情報を保存" }).click();
    await expect(
      other.getByRole("button", { name: "保存済み", exact: true }),
    ).toBeVisible();
    expect((await records(other)).snapshots).toEqual([original]);
    expect(otherRequests).toEqual([]);
    await other.getByLabel("保存した書誌ファイルを確認").setInputFiles(path);
    await expect(other.getByRole("status")).toContainText(
      "提供元への通信は行っていません",
    );
    await other.getByRole("button", { name: "この書誌情報を保存" }).click();
    await expect(
      other.getByRole("region", { name: "書誌情報のプレビュー" }),
    ).toContainText("同じ書誌情報は保存済み");
    expect((await records(other)).snapshots).toEqual([original]);
  } finally {
    await context.close();
  }
});
test("concurrent recaptures reuse the original timestamp while a changed deposit retains a separate snapshot", async ({
  page,
}) => {
  await page.goto("/?view=papers");
  const metadata = crossrefMetadata(fixture, doi),
    first = await paperSnapshot(metadata, "2026-11-01T00:00:00.000Z"),
    later = await paperSnapshot(metadata, "2026-11-03T00:00:00.000Z");
  const changed = structuredClone(metadata);
  changed.version = "3";
  changed.titles = ["Revised deposit"];
  const revised = await paperSnapshot(changed, "2026-11-04T00:00:00.000Z");
  const result = await page.evaluate(
    async ({ first, later, revised }) => {
      const path = "/src/paper-store.ts",
        api: typeof import("../../src/paper-store") = await import(path);
      const a = await api.savePaper(first);
      const b = await Promise.all([
        api.savePaper(later),
        api.savePaper(later),
        api.savePaper(revised),
      ]);
      return { a, b, page: await api.listPapers() };
    },
    { first, later, revised },
  );
  expect(result.a.reused).toBe(false);
  expect(result.b.map((r) => r.reused)).toEqual([true, true, false]);
  expect(result.b[0].snapshot).toEqual(first);
  expect(result.page.snapshots).toHaveLength(2);
  expect(result.page.snapshots).toEqual(
    expect.arrayContaining([first, revised]),
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "書誌情報を開く" }),
  ).toHaveCount(2);
});
test("saving unchanged metadata again displays and exports the first retained capture without losing keyboard focus", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    const clock = window as unknown as { paperTime: number };
    clock.paperTime = Date.parse("2026-11-01T00:00:00.000Z");
    Date.now = () => clock.paperTime;
  });
  const requests = await provider(page);
  await page.goto("/?view=papers");
  await lookup(page);
  await page.getByRole("button", { name: "この書誌情報を保存" }).click();
  await expect(
    page.getByRole("button", { name: "保存済み", exact: true }),
  ).toBeVisible();
  const first = (await records(page)).snapshots[0];
  expect(first.capturedAt).toBe("2026-11-01T00:00:00.000Z");
  await page.evaluate(() => {
    (window as unknown as { paperTime: number }).paperTime = Date.parse(
      "2026-11-02T00:00:00.000Z",
    );
  });
  await lookup(page);
  const preview = page.getByRole("region", { name: "書誌情報のプレビュー" });
  const nextTime = await page.evaluate(() =>
    new Date("2026-11-02T00:00:00.000Z").toLocaleString("ja-JP"),
  );
  await expect(
    preview.getByText(`Crossref · ${nextTime}`, { exact: true }),
  ).toBeVisible();
  const save = page.getByRole("button", { name: "この書誌情報を保存" });
  await save.focus();
  await save.press("Enter");
  await expect(preview).toContainText("同じ書誌情報は保存済み");
  await expect(
    page.getByRole("button", { name: "保存済み", exact: true }),
  ).toBeFocused();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "この記録をファイルに保存" }).click();
  const path = info.outputPath("retained-paper.json");
  await (await download).saveAs(path);
  expect(JSON.parse(new TextDecoder().decode(await readFile(path)))).toEqual(
    first,
  );
  const firstTime = await page.evaluate(
    (time: string) => new Date(time).toLocaleString("ja-JP"),
    first.capturedAt,
  );
  await expect(
    preview.getByText(`Crossref · ${firstTime}`, { exact: true }),
  ).toBeVisible();
  expect((await records(page)).snapshots).toEqual([first]);
  expect(requests).toHaveLength(2);
});
test("invalid DOI and imports cannot dispatch a provider or overwrite saved observations", async ({
  page,
}, info) => {
  const requests = await provider(page);
  await page.goto("/?view=papers");
  await lookup(page);
  await page.getByRole("button", { name: "この書誌情報を保存" }).click();
  await expect(
    page.getByRole("button", { name: "保存済み", exact: true }),
  ).toBeVisible();
  const before = await records(page);
  await page
    .getByLabel("DOIまたは https://doi.org/ のURL")
    .fill("https://evil.test/secret");
  await page.getByRole("button", { name: "DOIをCrossrefへ送って確認" }).click();
  await expect(page.getByRole("status")).toContainText("有効なDOI");
  const file = { ...before.snapshots[0], schemaVersion: 2 };
  const path = info.outputPath("future.json");
  await writeFile(path, new TextEncoder().encode(JSON.stringify(file)));
  await page.getByLabel("保存した書誌ファイルを確認").setInputFiles(path);
  await expect(page.getByRole("status")).toContainText("形式または保存記録");
  expect(await records(page)).toEqual(before);
  expect(requests).toHaveLength(1);
});
test("a delayed reused save respects newer focus and a different selected observation", async ({
  page,
}, info) => {
  await page.goto("/?view=papers");
  const metadata = crossrefMetadata(fixture, doi),
    first = await paperSnapshot(metadata, "2026-11-01T00:00:00.000Z");
  const other = await paperSnapshot(
    {
      ...metadata,
      doi: "10.5555/other",
      titles: ["Different retained observation"],
    },
    "2026-11-01T01:00:00.000Z",
  );
  await page.evaluate(
    async ({ first, other }) => {
      const path = "/src/paper-store.ts",
        api: typeof import("../../src/paper-store") = await import(path);
      await api.savePaper(first);
      await api.savePaper(other);
    },
    { first, other },
  );
  await page.reload();
  const path = info.outputPath("recapture.json");
  await writeFile(
    path,
    new TextEncoder().encode(
      JSON.stringify({ ...first, capturedAt: "2026-11-02T00:00:00.000Z" }),
    ),
  );
  await page.getByLabel("保存した書誌ファイルを確認").setInputFiles(path);
  await expect(page.getByRole("status")).toContainText(
    "書誌ファイルを確認しました",
  );
  await holdPaperCompletion(page);
  await page.getByRole("button", { name: "この書誌情報を保存" }).click();
  await waitForPaperCompletion(page);
  const input = page.getByLabel("DOIまたは https://doi.org/ のURL");
  await input.focus();
  await releasePaperCompletion(page);
  await expect(input).toBeFocused();
  await expect(
    page.getByRole("region", { name: "書誌情報のプレビュー" }),
  ).toContainText("同じ書誌情報は保存済み");
  await page.getByLabel("保存した書誌ファイルを確認").setInputFiles(path);
  await expect(page.getByRole("status")).toContainText(
    "書誌ファイルを確認しました",
  );
  await holdPaperCompletion(page);
  await page.getByRole("button", { name: "この書誌情報を保存" }).click();
  await waitForPaperCompletion(page);
  await page
    .locator(".paper-row")
    .filter({ hasText: "Different retained observation" })
    .getByRole("button", { name: "書誌情報を開く" })
    .click();
  const heading = page.getByRole("heading", {
    name: "Different retained observation",
    exact: true,
  });
  await expect(heading).toBeFocused();
  await releasePaperCompletion(page);
  await expect(heading).toBeFocused();
  await expect(
    page.getByRole("region", { name: "書誌情報のプレビュー" }),
  ).toContainText("10.5555/other");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "この記録をファイルに保存" }).click();
  const exported = info.outputPath("selected.json");
  await (await download).saveAs(exported);
  expect(
    JSON.parse(new TextDecoder().decode(await readFile(exported))),
  ).toEqual(other);
  expect((await records(page)).snapshots).toEqual(
    expect.arrayContaining([first, other]),
  );
  expect((await records(page)).snapshots).toHaveLength(2);
});
test("editing the DOI cancels late completion without replacing a newer preview or sending a new request", async ({
  page,
}) => {
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  await page.route("https://api.crossref.org/**", async (route) => {
    entered();
    await gate;
    await route.fulfill({ json: fixture }).catch(() => {});
  });
  await page.goto("/?view=papers");
  await page.getByLabel("DOIまたは https://doi.org/ のURL").fill(doi);
  await page.getByRole("button", { name: "DOIをCrossrefへ送って確認" }).click();
  await pending;
  await page
    .getByLabel("DOIまたは https://doi.org/ のURL")
    .fill("10.5555/new-input");
  release();
  await expect(page.getByRole("status")).toHaveText(
    "DOIを確認してから送信してください。",
  );
  await expect(
    page.getByRole("region", { name: "書誌情報のプレビュー" }),
  ).toBeEmpty();
  expect((await records(page)).snapshots).toHaveLength(0);
});
test("a completed save preserves the focused library record and the current library page", async ({
  page,
}, info) => {
  await page.goto("/?view=papers");
  const metadata = crossrefMetadata(fixture, doi);
  const snapshots = await Promise.all(
    Array.from({ length: 21 }, (_, i) =>
      paperSnapshot(
        {
          ...metadata,
          doi: `10.5555/focus-${String(i).padStart(2, "0")}`,
          titles: [`Focus observation ${String(i).padStart(2, "0")}`],
        },
        "2026-11-01T00:00:00.000Z",
      ),
    ),
  );
  await page.evaluate(async (snapshots) => {
    const path = "/src/paper-store.ts",
      api: typeof import("../../src/paper-store") = await import(path);
    for (const p of snapshots) await api.savePaper(p);
  }, snapshots);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "書誌情報を開く" }),
  ).toHaveCount(20);
  const path = info.outputPath("library-focus.json");
  for (const [index, target] of [
    [0, 1],
    [20, 20],
  ]) {
    if (index === 20) {
      await page.getByRole("button", { name: "次の20件" }).click();
      await expect(
        page.getByRole("button", { name: "書誌情報を開く" }),
      ).toHaveCount(1);
    }
    await writeFile(
      path,
      new TextEncoder().encode(
        JSON.stringify({
          ...snapshots[index],
          capturedAt: "2026-11-02T00:00:00.000Z",
        }),
      ),
    );
    await page.getByLabel("保存した書誌ファイルを確認").setInputFiles(path);
    await expect(page.getByRole("status")).toContainText(
      "書誌ファイルを確認しました",
    );
    await page.evaluate(() => {
      const state = window as unknown as { paperLibraryUpdated: boolean };
      state.paperLibraryUpdated = false;
      const library = document.querySelector('[aria-label="保存した書誌情報"]');
      if (!library) throw Error("missing library");
      const observer = new MutationObserver(() => {
        state.paperLibraryUpdated = true;
        observer.disconnect();
      });
      observer.observe(library, { childList: true });
    });
    await holdPaperCompletion(page);
    await page.getByRole("button", { name: "この書誌情報を保存" }).click();
    await waitForPaperCompletion(page);
    const focused = page
      .locator(".paper-row")
      .filter({
        hasText: `Focus observation ${String(target).padStart(2, "0")}`,
      })
      .getByRole("button", { name: "書誌情報を開く" });
    await focused.focus();
    await releasePaperCompletion(page);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { paperLibraryUpdated: boolean })
              .paperLibraryUpdated,
        ),
      )
      .toBe(true);
    await expect(focused).toBeFocused();
    if (index === 20) {
      await expect(
        page.getByRole("button", { name: "書誌情報を開く" }),
      ).toHaveCount(1);
      await expect(
        page.getByRole("button", { name: "先頭の20件" }),
      ).toBeVisible();
    }
  }
  await page.getByRole("button", { name: "先頭の20件" }).click();
  await expect(
    page.getByRole("button", { name: "書誌情報を開く" }),
  ).toHaveCount(20);
  await expect(
    page.getByRole("heading", { name: "保存した書誌情報", exact: true }),
  ).toBeFocused();
});
test("an older held library page cannot replace a newer page request or its focus", async ({
  page,
}) => {
  await page.goto("/?view=papers");
  const metadata = crossrefMetadata(fixture, doi);
  const snapshots = await Promise.all(
    Array.from({ length: 41 }, (_, i) =>
      paperSnapshot(
        {
          ...metadata,
          doi: `10.5555/page-${String(i).padStart(2, "0")}`,
          titles: [`Page race ${String(i).padStart(2, "0")}`],
        },
        "2026-11-01T00:00:00.000Z",
      ),
    ),
  );
  await page.evaluate(async (snapshots) => {
    const path = "/src/paper-store.ts",
      api: typeof import("../../src/paper-store") = await import(path);
    for (const p of snapshots) await api.savePaper(p);
  }, snapshots);
  await page.reload();
  await page.getByRole("button", { name: "次の20件" }).click();
  await expect(
    page.locator(".paper-row").filter({ hasText: "Page race 20" }),
  ).toBeVisible();
  await holdPaperCompletion(page, "readonly");
  await page.getByRole("button", { name: "次の20件" }).click();
  await waitForPaperCompletion(page);
  await page.getByRole("button", { name: "先頭の20件" }).click();
  await expect(
    page.locator(".paper-row").filter({ hasText: "Page race 00" }),
  ).toBeVisible();
  const heading = page.getByRole("heading", {
    name: "保存した書誌情報",
    exact: true,
  });
  await expect(heading).toBeFocused();
  await releasePaperCompletion(page);
  await expect(heading).toBeFocused();
  await expect(
    page.locator(".paper-row").filter({ hasText: "Page race 00" }),
  ).toBeVisible();
  await expect(
    page.locator(".paper-row").filter({ hasText: "Page race 40" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "書誌情報を開く" }),
  ).toHaveCount(20);
});
test("malformed JSON and UTF-8 use Japanese notices and same-file retries preserve saved records", async ({
  page,
}, info) => {
  await provider(page);
  await page.goto("/?view=papers");
  await lookup(page);
  await page.getByRole("button", { name: "この書誌情報を保存" }).click();
  await expect(
    page.getByRole("button", { name: "保存済み", exact: true }),
  ).toBeVisible();
  const before = await records(page),
    path = info.outputPath("retry.json");
  for (const { bytes, message } of [
    {
      bytes: new TextEncoder().encode("PRIVATE_FILE_FRAGMENT"),
      message:
        "書誌情報の形式または保存記録を確認できません。既存の記録は保持しています。",
    },
    {
      bytes: Uint8Array.from([0xff]),
      message:
        "書誌ファイルを確認できません。UTF-8の対応するJSONファイルを選んでください。保存済みの記録は保持しています。",
    },
  ]) {
    await writeFile(path, bytes);
    await page.getByLabel("保存した書誌ファイルを確認").setInputFiles(path);
    await expect(page.getByRole("status")).toHaveText(message);
    await expect(page.getByRole("status")).not.toContainText(
      "PRIVATE_FILE_FRAGMENT",
    );
    expect(await records(page)).toEqual(before);
  }
  await writeFile(
    path,
    new TextEncoder().encode(JSON.stringify(before.snapshots[0])),
  );
  await page.getByLabel("保存した書誌ファイルを確認").setInputFiles(path);
  await expect(page.getByRole("status")).toContainText(
    "書誌ファイルを確認しました",
  );
  await page.getByRole("button", { name: "この書誌情報を保存" }).click();
  await expect(
    page.getByRole("region", { name: "書誌情報のプレビュー" }),
  ).toContainText("同じ書誌情報は保存済み");
  expect(await records(page)).toEqual(before);
});
test("320px metadata remains bounded and a rejected provider retry retains the saved library", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await provider(page);
  await page.goto("/?view=papers");
  await lookup(page);
  await page.getByRole("button", { name: "この書誌情報を保存" }).click();
  await expect(
    page.getByRole("button", { name: "保存済み", exact: true }),
  ).toBeVisible();
  const before = await records(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("paper-preview.png"),
    fullPage: true,
  });
  await page.route("https://api.crossref.org/**", (route) =>
    route.fulfill({
      status: 429,
      body: "limited",
      headers: { "retry-after": "120" },
    }),
  );
  await page.evaluate(() => localStorage.removeItem("quilna.crossref-rate.v1"));
  await page.getByLabel("DOIまたは https://doi.org/ のURL").fill(doi);
  await page.getByRole("button", { name: "DOIをCrossrefへ送って確認" }).click();
  await expect(page.getByRole("status")).toContainText("要求上限");
  expect(await records(page)).toEqual(before);
  await page.getByRole("button", { name: "DOIをCrossrefへ送って確認" }).click();
  await expect(page.getByRole("status")).toContainText("以降");
  expect(await records(page)).toEqual(before);
});
