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
