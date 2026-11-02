import { test, expect, type Page } from "@playwright/test";
import type { ArticleConnection } from "../../src/article-connections";
async function fixture(page: Page, waitReady = true) {
  await page.addInitScript(() =>
    localStorage.setItem("quilna.feed.refresh.v1", "0"),
  );
  await page.route("**/api/collection", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  await page.route("**/__connections", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Connections fixture</title>",
    }),
  );
  await page.goto("/__connections");
  await page.evaluate(async () => {
    const path = "/src/feed-store.ts";
    const { openFeedLibrary } = await import(path);
    const db = await openFeedLibrary();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite");
      for (const id of ["a", "b", "c", "d"])
        tx.objectStore("articles").put({
          id,
          title: `Connection article ${id}`,
          url: `https://example.org/${id}`,
          feedUrl: "",
          published: null,
          fetchedAt: "2026-10-27T00:00:00Z",
          body: `Article ${id} original source.`,
          read: id !== "d",
          saved: id === "a",
          manualTags: id === "c" ? ["別の話題"] : ["共通の話題"],
          content: {
            text: `Article ${id} original source.`,
            title: `Connection article ${id}`,
            url: `https://example.org/${id}`,
            language: "en",
            fetchedAt: "2026-10-27T00:00:00Z",
          },
        });
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
  await page.goto("/?view=feeds");
  await open(page, "a", waitReady);
}
async function open(page: Page, id: string, waitReady = true) {
  await page
    .getByRole("button", { name: `Connection article ${id}`, exact: true })
    .click();
  await page.locator("#rss-connections > details > summary").click();
  if (waitReady)
    await expect(
      page.getByRole("button", { name: "つなぐ記事を探す", exact: true }),
    ).toBeEnabled();
}
async function records(page: Page, id = "a"): Promise<ArticleConnection[]> {
  return page.evaluate(async (id) => {
    const path = "/src/article-connections.ts";
    return (await import(path)).readConnections(id);
  }, id);
}
async function choose(page: Page, title: string) {
  await page
    .getByLabel("ライブラリの記事を題名で探す", { exact: true })
    .fill(title);
  await page
    .getByRole("button", { name: "つなぐ記事を探す", exact: true })
    .click();
  await page
    .getByRole("list", { name: "つなぐ記事の検索結果" })
    .getByRole("button", { name: "この記事を選ぶ" })
    .click();
}
async function save(page: Page, reason: string) {
  await page.getByLabel("つながりの理由（必須）", { exact: true }).fill(reason);
  await page
    .getByRole("button", { name: "つながりを保存", exact: true })
    .click();
  await expect(
    page.locator("#rss-connections .rss-connection-reason"),
  ).toContainText(reason);
}

test("shared-tag candidates remain distinct from persisted, editable and reversible article connections", async ({
  page,
}) => {
  await fixture(page);
  const suggestions = page.getByRole("list", {
    name: "共通タグからの候補",
    exact: true,
  });
  await expect(suggestions).toContainText("Connection article b");
  await expect(suggestions).toContainText("候補の理由：共通タグ「共通の話題」");
  await expect(suggestions).not.toContainText("Connection article c");
  await expect(suggestions).not.toContainText("Connection article d");
  expect(await records(page)).toHaveLength(0);
  await suggestions.getByRole("button", { name: "理由を添えてつなぐ" }).click();
  await save(page, "<img src=x onerror=alert(1)> 同じ話題を別の視点で比較する");
  const first = (await records(page))[0];
  expect(first).toMatchObject({
    members: ["a", "b"],
    state: "linked",
    revision: 1,
    from: { id: "a", title: "Connection article a" },
    to: { id: "b", url: "https://example.org/b" },
  });
  await expect(page.locator("#rss-connections img")).toHaveCount(0);
  await expect(suggestions).not.toContainText("Connection article b");
  await page.reload();
  await open(page, "a");
  await expect(
    page.locator("#rss-connections .rss-connection-reason"),
  ).toContainText("別の視点");
  await page.getByRole("button", { name: "関連の理由を編集" }).click();
  await save(page, "共通点と相違点を比較する");
  expect((await records(page))[0].revision).toBe(2);
  await page
    .getByRole("list", { name: "自分で保存したつながり", exact: true })
    .getByRole("button", { name: "この記事を読む" })
    .click();
  await expect(page.locator("#rss-current-title")).toHaveText(
    "Connection article b",
  );
  await page.locator("#rss-connections > details > summary").click();
  await expect(
    page.locator("#rss-connections .rss-connection-reason"),
  ).toHaveText("共通点と相違点を比較する");
  expect((await records(page, "b"))[0].id).toBe(first.id);
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: "関連を解除", exact: true }).click();
  expect(await records(page)).toHaveLength(1);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "関連を解除", exact: true }).click();
  await expect(
    page.locator("#rss-connections .rss-connection-reason"),
  ).toHaveCount(0);
  expect(await records(page)).toHaveLength(0);
  await expect(page.locator(".rss-source-text")).toContainText(
    "Article b original source.",
  );
});

test("hidden pairs persist across reload and can be restored, while manual linking does not require tags", async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByRole("button", { name: "この候補を非表示", exact: true })
    .click();
  await expect(
    page.getByRole("list", { name: "共通タグからの候補", exact: true }),
  ).not.toContainText("Connection article b");
  expect((await records(page))[0].state).toBe("hidden");
  await page.reload();
  await open(page, "a");
  await expect(
    page.getByRole("list", { name: "共通タグからの候補", exact: true }),
  ).not.toContainText("Connection article b");
  await page.locator("#rss-connections details details summary").click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "候補の非表示を解除" }).click();
  await expect(
    page.getByRole("list", { name: "共通タグからの候補", exact: true }),
  ).toContainText("Connection article b");
  await choose(page, "article c");
  await save(page, "タグが違っても、問いがつながる");
  expect((await records(page))[0].members).toEqual(["a", "c"]);
});

test("write failures preserve the draft and stored links through reload notifications, then explicit retry commits", async ({
  page,
}) => {
  await fixture(page);
  await choose(page, "article c");
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    (window as unknown as { failConnection: boolean }).failConnection = true;
    IDBObjectStore.prototype.put = function (...args) {
      if (
        this.name === "connections" &&
        (window as unknown as { failConnection: boolean }).failConnection
      )
        throw new DOMException("full", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  await page.getByLabel("つながりの理由（必須）").fill("失敗しても残す理由");
  await page
    .getByRole("button", { name: "つながりを保存", exact: true })
    .click();
  await expect(page.locator("#rss-connections [role=status]")).toContainText(
    "保存できませんでした",
  );
  await page.evaluate(() => {
    const c = new BroadcastChannel("quilna.connections.v1");
    c.postMessage(["a", "c"]);
    c.close();
  });
  await page
    .getByRole("button", { name: "つながりを再読み込み", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "つながりを保存", exact: true }),
  ).toBeEnabled();
  await expect(page.locator("#rss-connections [role=status]")).toContainText(
    "保存できませんでした",
  );
  await expect(page.getByLabel("つながりの理由（必須）")).toHaveValue(
    "失敗しても残す理由",
  );
  expect(await records(page)).toHaveLength(0);
  await page.evaluate(() => {
    (window as unknown as { failConnection: boolean }).failConnection = false;
  });
  await page
    .getByRole("button", { name: "つながりを保存", exact: true })
    .click();
  await expect(
    page.locator("#rss-connections .rss-connection-reason"),
  ).toHaveText("失敗しても残す理由");
  await expect(page.locator("#rss-save-article")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("cross-tab edits are compare-and-swap and cannot silently replace a newer reason", async ({
  page,
  context,
}) => {
  await fixture(page);
  await choose(page, "article c");
  await save(page, "Initial reason");
  await page.getByRole("button", { name: "関連の理由を編集" }).click();
  await page.getByLabel("つながりの理由（必須）").fill("Stale draft");
  const other = await context.newPage();
  await other.goto("/?view=feeds");
  await open(other, "a");
  await other.getByRole("button", { name: "関連の理由を編集" }).click();
  await save(other, "Newer reason");
  await page
    .getByRole("button", { name: "つながりを保存", exact: true })
    .click();
  await expect(page.locator("#rss-connections [role=status]")).toContainText(
    "別の画面でつながりが変わりました",
  );
  await expect(page.getByLabel("つながりの理由（必須）")).toHaveValue(
    "Stale draft",
  );
  expect((await records(page))[0].reason).toBe("Newer reason");
});

test("one transaction enforces capacity at either endpoint and freezes citation metadata", async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const path = "/src/article-connections.ts";
    const m = await import(path);
    const db = await m.openConnections();
    const make = (a: string, b: string) => ({
      id: m.connectionKey(a, b),
      members: [a, b].sort(),
      from: { id: a, title: a, url: "" },
      to: { id: b, title: b, url: "" },
      state: "linked",
      reason: "Reason",
      revision: 1,
      createdAt: "2026-10-27T00:00:00Z",
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("connections", "readwrite");
      for (let i = 0; i < 199; i++)
        tx.objectStore("connections").put(make("hub", `other-${i}`));
      tx.oncomplete = () => resolve();
    });
    const writes = await Promise.allSettled([
      m.writeConnection(make("a", "hub"), null),
      m.writeConnection(make("b", "hub"), null),
    ]);
    const values = await m.readConnections("hub");
    const stored = values[0];
    let metadataRejected = false;
    try {
      await m.writeConnection(
        {
          ...stored,
          from: { ...stored.from, title: "Changed source" },
          revision: 2,
        },
        1,
      );
    } catch {
      metadataRejected = true;
    }
    const edits = await Promise.allSettled([
      m.writeConnection({ ...stored, reason: "First", revision: 2 }, 1),
      m.writeConnection({ ...stored, reason: "Second", revision: 2 }, 1),
    ]);
    return {
      writes: writes.map((r) => r.status),
      count: values.length,
      metadataRejected,
      edits: edits.map((r) => r.status),
    };
  });
  expect(result.writes.sort()).toEqual(["fulfilled", "rejected"]);
  expect(result.count).toBe(200);
  expect(result.metadataRejected).toBe(true);
  expect(result.edits.sort()).toEqual(["fulfilled", "rejected"]);
});

test("corrupt stored links block editing without changing articles or stored values", async ({
  page,
}) => {
  await fixture(page);
  await choose(page, "article c");
  await save(page, "Preserved");
  await page.evaluate(async () => {
    const path = "/src/article-connections.ts";
    const m = await import(path);
    const db = await m.openConnections();
    await new Promise<void>((resolve) => {
      const tx = db.transaction("connections", "readwrite"),
        store = tx.objectStore("connections"),
        get = store.getAll();
      get.onsuccess = () => store.put({ ...get.result[0], revision: "broken" });
      tx.oncomplete = () => resolve();
    });
  });
  await page
    .getByRole("button", { name: "つながりを再読み込み", exact: true })
    .click();
  await expect(page.locator("#rss-connections [role=status]")).toContainText(
    "保存形式を確認できません",
  );
  await expect(
    page.getByRole("button", { name: "関連の理由を編集" }),
  ).toBeDisabled();
  await expect(page.locator(".rss-source-text")).toContainText(
    "Article a original source.",
  );
  await expect(page.locator("#rss-save-article")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

async function holdWrites(page: Page, failPut = false) {
  await page.evaluate(async (failPut) => {
    const path = "/src/article-connections.ts";
    const m = await import(path),
      db = await m.openConnections();
    const tx = db.transaction("connections", "readwrite"),
      store = tx.objectStore("connections");
    let hold = true;
    (
      window as unknown as { releaseConnections: () => void }
    ).releaseConnections = () => {
      hold = false;
    };
    const keep = () => {
      const request = store.get("gate");
      request.onsuccess = () => {
        if (hold) keep();
      };
    };
    keep();
    if (failPut) {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === "connections")
          throw new DOMException("full", "QuotaExceededError");
        return put.apply(this, args);
      };
    }
  }, failPut);
}
async function releaseWrites(page: Page) {
  await page.evaluate(() =>
    (
      window as unknown as { releaseConnections: () => void }
    ).releaseConnections(),
  );
}
async function changeWhilePending(page: Page, id: string) {
  await page.getByRole("button", { name: "← 記事一覧へ", exact: true }).click();
  await page
    .getByRole("button", { name: `Connection article ${id}`, exact: true })
    .click();
  await page.locator("#rss-connections > details > summary").click();
  await expect(page.locator("#rss-connections [role=status]")).toContainText(
    "読み込んでいます",
  );
}

test("a failed deletion retains the connection and can be retried explicitly", async ({
  page,
}) => {
  await fixture(page);
  await choose(page, "article c");
  await save(page, "Keep this record");
  await page.evaluate(() => {
    const remove = IDBObjectStore.prototype.delete;
    (window as unknown as { failRemoval: boolean }).failRemoval = true;
    IDBObjectStore.prototype.delete = function (...args) {
      if (
        this.name === "connections" &&
        (window as unknown as { failRemoval: boolean }).failRemoval
      )
        throw new DOMException("full", "QuotaExceededError");
      return remove.apply(this, args);
    };
  });
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "関連を解除", exact: true }).click();
  await expect(page.locator("#rss-connections [role=status]")).toContainText(
    "保存できませんでした",
  );
  expect((await records(page))[0].reason).toBe("Keep this record");
  await expect(
    page.locator("#rss-connections .rss-connection-reason"),
  ).toHaveText("Keep this record");
  await page.evaluate(() => {
    (window as unknown as { failRemoval: boolean }).failRemoval = false;
  });
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "関連を解除", exact: true }).click();
  await expect(
    page.locator("#rss-connections .rss-connection-reason"),
  ).toHaveCount(0);
  expect(await records(page)).toHaveLength(0);
});

test("a pending save cannot replace its draft with another candidate", async ({
  page,
}) => {
  await fixture(page);
  await choose(page, "article c");
  await page.getByLabel("つながりの理由（必須）").fill("Draft for C");
  await holdWrites(page, true);
  await page
    .getByRole("button", { name: "つながりを保存", exact: true })
    .click();
  await expect(page.locator("#rss-connections [role=status]")).toHaveText(
    "つながりを保存しています…",
  );
  await page
    .getByRole("button", { name: "理由を添えてつなぐ", exact: true })
    .evaluate((b) => (b as HTMLButtonElement).click());
  await releaseWrites(page);
  await expect(page.locator("#rss-connections [role=status]")).toContainText(
    "保存できませんでした",
  );
  await expect(page.getByLabel("つながりの理由（必須）")).toHaveValue(
    "Draft for C",
  );
  expect(await records(page)).toHaveLength(0);
});

for (const failure of [false, true]) {
  test(`late ${failure ? "failure" : "success"} from an old read cannot replace A-B-A context`, async ({
    page,
  }) => {
    await fixture(page);
    await choose(page, "article c");
    await save(page, "A to C reason");
    await page.locator("#rss-connections > details > summary").click();
    await holdWrites(page);
    await page.evaluate((failure) => {
      if (!failure) return;
      const get = IDBIndex.prototype.getAll;
      let first = true;
      IDBIndex.prototype.getAll = function (...args) {
        const request = get.apply(this, args);
        if (this.name === "members" && first) {
          first = false;
          const tx = this.objectStore.transaction;
          request.addEventListener("success", () => tx.abort());
        }
        return request;
      };
    }, failure);
    await page.locator("#rss-connections > details > summary").click();
    await expect(page.locator("#rss-connections [role=status]")).toContainText(
      "読み込んでいます",
    );
    await changeWhilePending(page, "b");
    await changeWhilePending(page, "a");
    await releaseWrites(page);
    await expect(
      page.getByRole("button", { name: "つなぐ記事を探す", exact: true }),
    ).toBeEnabled();
    await expect(
      page.locator("#rss-connections .rss-connection-reason"),
    ).toHaveText("A to C reason");
    await expect(
      page.locator("#rss-connections [role=status]"),
    ).not.toContainText("読み込めません");
    await expect(page.locator("#rss-current-title")).toHaveText(
      "Connection article a",
    );
  });
  test(`late ${failure ? "failure" : "success"} from a submitted save stays with its source through A-B-A`, async ({
    page,
  }) => {
    await fixture(page);
    await choose(page, "article c");
    await page.getByLabel("つながりの理由（必須）").fill("Submitted from A");
    await holdWrites(page, failure);
    await page
      .getByRole("button", { name: "つながりを保存", exact: true })
      .click();
    await expect(page.locator("#rss-connections [role=status]")).toHaveText(
      "つながりを保存しています…",
    );
    await changeWhilePending(page, "b");
    await changeWhilePending(page, "a");
    await releaseWrites(page);
    await expect(
      page.getByRole("button", { name: "つなぐ記事を探す", exact: true }),
    ).toBeEnabled();
    await expect(page.getByLabel("つながりの理由（必須）")).toBeHidden();
    await expect(
      page.locator("#rss-connections [role=status]"),
    ).not.toContainText("保存できませんでした");
    expect(await records(page)).toHaveLength(failure ? 0 : 1);
    expect(await records(page, "b")).toHaveLength(0);
    if (!failure)
      await expect(
        page.locator("#rss-connections .rss-connection-reason"),
      ).toHaveText("Submitted from A");
  });
}

test("closing a loading panel keeps it closed and a subsequent open recovers", async ({
  page,
}) => {
  await fixture(page);
  await page.locator("#rss-connections > details > summary").click();
  await holdWrites(page);
  await page.locator("#rss-connections > details > summary").click();
  await expect(page.locator("#rss-connections [role=status]")).toContainText(
    "読み込んでいます",
  );
  await page.locator("#rss-connections > details > summary").click();
  await releaseWrites(page);
  await expect(
    page.getByRole("button", { name: "つなぐ記事を探す", exact: true }),
  ).toBeHidden();
  await page.locator("#rss-connections > details > summary").click();
  await expect(
    page.getByRole("button", { name: "つなぐ記事を探す", exact: true }),
  ).toBeEnabled();
});

test("keyboard editing reflows with each reader design at 320px", async ({
  page,
}, info) => {
  await fixture(page);
  await choose(page, "article c");
  await expect(page.getByLabel("つながりの理由（必須）")).toBeFocused();
  await page.keyboard.type("Keyboard connection");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(
    page.locator("#rss-connections .rss-connection-reason"),
  ).toHaveText("Keyboard connection");
  for (const design of ["Studio", "Editorial", "Focus"]) {
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("radio", { name: design, exact: true }).check();
    await page.getByRole("button", { name: "閉じる", exact: true }).click();
    await page.setViewportSize({ width: 320, height: 740 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const contrast = await page
      .getByRole("list", { name: "自分で保存したつながり", exact: true })
      .getByRole("link", { name: "保存した出典を開く" })
      .evaluate((link) => {
        const luminance = (color: string) => {
          const channels = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((v) => {
              const s = v / 255;
              return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            });
          return (
            channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
          );
        };
        let parent: Element | null = link,
          background = "rgba(0, 0, 0, 0)";
        while (parent && background === "rgba(0, 0, 0, 0)") {
          background = getComputedStyle(parent).backgroundColor;
          parent = parent.parentElement;
        }
        const a = luminance(getComputedStyle(link).color),
          b = luminance(background);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
    expect(contrast, `${design} source-link contrast`).toBeGreaterThanOrEqual(
      4.5,
    );
    await page.getByRole("button", { name: "関連の理由を編集" }).click();
    await expect(page.getByLabel("つながりの理由（必須）")).toHaveValue(
      "Keyboard connection",
    );
    await page.screenshot({
      path: info.outputPath(`${design}-connections.png`),
    });
    await page.getByRole("button", { name: "関連の編集をやめる" }).click();
  }
});

test("unavailable connection storage can be retried without discarding saved articles", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const open = indexedDB.open.bind(indexedDB);
    (window as unknown as { denyConnections: boolean }).denyConnections = true;
    indexedDB.open = (...args) => {
      if (
        args[0] === "quilna.connections.v1" &&
        (window as unknown as { denyConnections: boolean }).denyConnections
      )
        throw new DOMException(
          "Unavailable connection storage",
          "SecurityError",
        );
      return open(...args);
    };
  });
  await fixture(page, false);
  await expect(page.locator("#rss-connections [role=status]")).toContainText(
    "Unavailable connection storage",
  );
  await expect(
    page.getByRole("button", { name: "つなぐ記事を探す", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".rss-source-text")).toContainText(
    "Article a original source.",
  );
  await page.evaluate(() => {
    (window as unknown as { denyConnections: boolean }).denyConnections = false;
  });
  await page
    .getByRole("button", { name: "つながりを再読み込み", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "つなぐ記事を探す", exact: true }),
  ).toBeEnabled();
  await choose(page, "article c");
  await save(page, "Recovered after retry");
  await expect(page.locator("#rss-save-article")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("a newer connection schema is refused without removing or downgrading it", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/__connections");
  await page.evaluate(async () => {
    const r = indexedDB.open("quilna.connections.v1", 2);
    r.onupgradeneeded = () =>
      r.result.createObjectStore("future").put("keep", "sentinel");
    await new Promise<void>((resolve, reject) => {
      r.onsuccess = () => {
        r.result.close();
        resolve();
      };
      r.onerror = () => reject(r.error);
    });
  });
  await page.goto("/?view=feeds");
  await open(page, "a", false);
  await expect(page.locator("#rss-connections [role=status]")).toContainText(
    "保存領域を開けませんでした",
  );
  await expect(
    page.getByRole("button", { name: "つなぐ記事を探す", exact: true }),
  ).toBeDisabled();
  const preserved = await page.evaluate(async () => {
    const r = indexedDB.open("quilna.connections.v1");
    return new Promise((resolve) => {
      r.onsuccess = () => {
        const db = r.result,
          tx = db.transaction("future", "readonly"),
          get = tx.objectStore("future").get("sentinel");
        tx.oncomplete = () => {
          resolve({
            version: db.version,
            stores: Array.from(db.objectStoreNames),
            value: get.result,
          });
          db.close();
        };
      };
    });
  });
  expect(preserved).toEqual({
    version: 2,
    stores: ["connections", "future"],
    value: "keep",
  });
  await expect(page.locator(".rss-source-text")).toContainText(
    "Article a original source.",
  );
});

test("a missing target retains its source reference while disabling local navigation", async ({
  page,
}) => {
  await fixture(page);
  await choose(page, "article c");
  await save(page, "Retain the citation");
  await page.evaluate(async () => {
    const path = "/src/feed-store.ts";
    const { openFeedLibrary } = await import(path),
      db = await openFeedLibrary();
    await new Promise<void>((resolve) => {
      const tx = db.transaction("articles", "readwrite");
      tx.objectStore("articles").delete("c");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
    });
  });
  await page.reload();
  await open(page, "a");
  const linked = page.getByRole("list", {
    name: "自分で保存したつながり",
    exact: true,
  });
  await expect(linked).toContainText("Retain the citation");
  await expect(
    linked.getByRole("button", { name: "この記事を読む" }),
  ).toBeDisabled();
  await expect(
    linked.getByRole("link", { name: "保存した出典を開く" }),
  ).toHaveAttribute("href", "https://example.org/c");
  expect((await records(page))[0].to.title).toBe("Connection article c");
});

for (const outcome of ["success", "failure"] as const) {
  test(`an old ${outcome} notification delivered after the new A is ready cannot change its records or status`, async ({
    page,
  }) => {
    await fixture(page);
    await choose(page, "article c");
    await save(page, "Old reason");
    await page.locator("#rss-connections > details > summary").click();
    await page.evaluate((outcome) => {
      const transaction = IDBDatabase.prototype.transaction;
      const getAll = IDBIndex.prototype.getAll;
      let first = true,
        held: IDBTransaction | undefined;
      IDBDatabase.prototype.transaction = function (
        ...args: Parameters<IDBDatabase["transaction"]>
      ) {
        const tx = transaction.apply(this, args);
        if (
          this.name === "quilna.connections.v1" &&
          tx.mode === "readonly" &&
          first
        ) {
          first = false;
          held = tx;
          for (const eventName of ["complete", "abort"] as const) {
            Object.defineProperty(tx, `on${eventName}`, {
              configurable: true,
              set(handler: (event: Event) => void) {
                tx.addEventListener(
                  eventName,
                  (event) => {
                    (
                      window as unknown as {
                        heldConnectionNotification: boolean;
                      }
                    ).heldConnectionNotification = true;
                    (
                      window as unknown as {
                        releaseConnectionNotification: () => void;
                      }
                    ).releaseConnectionNotification = () =>
                      handler.call(tx, event);
                  },
                  { once: true },
                );
              },
            });
          }
        }
        return tx;
      };
      IDBIndex.prototype.getAll = function (...args) {
        const request = getAll.apply(this, args),
          tx = this.objectStore.transaction;
        if (tx === held && outcome === "failure")
          request.addEventListener("success", () => tx.abort());
        return request;
      };
    }, outcome);
    await page.locator("#rss-connections > details > summary").click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { heldConnectionNotification: boolean })
              .heldConnectionNotification,
        ),
      )
      .toBe(true);
    await page.evaluate(async () => {
      const path = "/src/article-connections.ts";
      const m = await import(path),
        old = (await m.readConnections("a"))[0];
      await m.writeConnection(
        {
          ...old,
          reason: "New reason after the old read",
          revision: old.revision + 1,
        },
        old.revision,
      );
    });
    await page
      .getByRole("button", { name: "← 記事一覧へ", exact: true })
      .click();
    await open(page, "b");
    await page
      .getByRole("button", { name: "← 記事一覧へ", exact: true })
      .click();
    await open(page, "a");
    await expect(
      page.locator("#rss-connections .rss-connection-reason"),
    ).toHaveText("New reason after the old read");
    await page.evaluate(async () => {
      (
        window as unknown as { releaseConnectionNotification: () => void }
      ).releaseConnectionNotification();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    });
    await expect(
      page.locator("#rss-connections .rss-connection-reason"),
    ).toHaveText("New reason after the old read");
    await expect(page.locator("#rss-connections [role=status]")).toHaveText(
      "保存した関連と、自動の候補を分けて表示しています。",
    );
    await expect(
      page.getByRole("button", { name: "つなぐ記事を探す", exact: true }),
    ).toBeEnabled();
  });
}
