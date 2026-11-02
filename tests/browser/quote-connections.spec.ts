import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page, design = "studio") {
  await page.addInitScript((design) => {
    localStorage.setItem("quilna.reader.design.v1", design);
    localStorage.setItem("quilna.feed.refresh.v1", "0");
  }, design);
  await page.route("**/api/collection", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  await page.route("**/__quotes", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Quote links</title>",
    }),
  );
  await page.goto("/__quotes");
  await page.evaluate(async () => {
    const libraryPath = "/src/feed-store.ts",
      highlightPath = "/src/article-highlights.ts";
    const { openFeedLibrary } = await import(libraryPath);
    const { writeHighlight, highlightVersion } = await import(highlightPath);
    const db = await openFeedLibrary();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite");
      for (const id of ["a", "b"])
        tx.objectStore("articles").put({
          id,
          title: `Quote article ${id}`,
          url: `https://example.org/${id}`,
          feedUrl: "",
          published: null,
          fetchedAt: "2026-10-30T00:00:00Z",
          body: `Evidence ${id}. Another point.`,
          read: true,
          saved: id === "a",
          content: {
            text: `Evidence ${id}. Another point.`,
            title: `Quote article ${id}`,
            url: `https://example.org/${id}`,
            language: "en",
            fetchedAt: "2026-10-30T00:00:00Z",
          },
        });
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    db.close();
    for (const [index, id] of ["a", "b", "a"].entries()) {
      const text = `Evidence ${id}. Another point.`;
      const start = index === 2 ? 12 : 0,
        quote = index === 2 ? "Another point." : `Evidence ${id}.`;
      await writeHighlight(
        {
          id: `00000000-0000-4000-8000-00000000000${index}`,
          articleId: id,
          title: `Quote article ${id}`,
          url: `https://example.org/${id}`,
          view: "original",
          language: "en",
          version: await highlightVersion(text, text, "original", "en"),
          start,
          end: start + quote.length,
          quote,
          note: `メモ ${index}`,
          createdAt: "2026-10-30T00:00:00Z",
          revision: 1,
        },
        null,
      );
    }
  });
  await page.goto("/?view=feeds");
  await page
    .getByRole("button", { name: "Quote article a", exact: true })
    .click();
}
const panel = (page: Page) => page.locator("#rss-quote-connections");
async function begin(page: Page) {
  await page.locator("#rss-highlights summary").click();
  await page
    .getByRole("button", { name: "この引用をつなぐ", exact: true })
    .first()
    .click();
  await expect(panel(page).getByRole("status")).toContainText("0件のつながり");
}
async function selectOther(page: Page) {
  await page.getByLabel("引用を探す記事の題名").fill("Quote article b");
  await page
    .getByRole("button", { name: "引用のある記事を探す", exact: true })
    .click();
  await panel(page)
    .getByRole("button", { name: "Quote article b", exact: true })
    .click();
  await page
    .getByRole("button", { name: "この引用を相手にする", exact: true })
    .click();
}
async function connect(
  page: Page,
  reason = "両方の根拠を比較する <img src=x onerror=alert(1)>",
) {
  await selectOther(page);
  await page.getByLabel("引用をつなぐ理由（必須）").fill(reason);
  await page
    .getByRole("button", { name: "引用のつながりを保存", exact: true })
    .click();
  await expect(
    panel(page).getByRole("list", { name: "保存した引用のつながり" }),
  ).toContainText(reason);
}
for (const design of ["studio", "editorial", "focus"])
  test(`${design} links quotes, preserves evidence, edits, explores and unlinks`, async ({
    page,
  }, info) => {
    await fixture(page, design);
    await begin(page);
    await connect(page);
    await expect(panel(page).locator("img,script")).toHaveCount(0);
    await page.reload();
    await page
      .getByRole("button", { name: "Quote article a", exact: true })
      .click();
    await page.locator("#rss-highlights summary").click();
    await page
      .getByRole("button", { name: "この引用をつなぐ", exact: true })
      .first()
      .click();
    await expect(
      panel(page).getByRole("list", { name: "保存した引用のつながり" }),
    ).toContainText("メモ 1");
    await page
      .getByRole("button", { name: "引用の関連理由を編集", exact: true })
      .click();
    await page.getByLabel("引用をつなぐ理由（必須）").fill("比較の理由を修正");
    await page
      .getByRole("button", { name: "引用のつながりを保存", exact: true })
      .click();
    await expect(panel(page).getByRole("status")).toContainText(
      "1件のつながり",
    );
    await page
      .getByRole("button", { name: "関係図でこの引用を辿る", exact: true })
      .click();
    await expect(page.locator(".rss-graph-center")).toContainText(
      "Evidence b.",
    );
    await page
      .locator(".rss-graph-node")
      .filter({ hasText: "Evidence a." })
      .click();
    await expect(page.locator(".rss-graph-evidence")).toContainText(
      "比較の理由を修正",
    );
    await expect(page.locator(".rss-graph-evidence")).toContainText(
      "Quote article a",
    );
    await expect(page.locator(".rss-graph-evidence")).toContainText(
      "Quote article b",
    );
    await page.setViewportSize({ width: 320, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("quote-links.png"),
      fullPage: true,
    });
    page.once("dialog", (d) => d.accept());
    await page
      .getByRole("button", { name: "引用のつながりを解除", exact: true })
      .click();
    await expect(panel(page).getByRole("status")).toContainText(
      "0件のつながり",
    );
    await expect(page.locator("#rss-highlights summary")).toHaveText(
      "ハイライト・メモ（2）",
    );
  });
test("same-article quotes remain distinct and empty reasons are not saved", async ({
  page,
}) => {
  await fixture(page);
  await begin(page);
  await page.getByRole("button", { name: "同じ記事の引用を選ぶ" }).click();
  await expect(
    page.getByRole("button", { name: "この引用を相手にする" }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "この引用を相手にする" }).click();
  await page
    .getByRole("button", { name: "引用のつながりを保存", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText("1〜2000文字");
  await page
    .getByLabel("引用をつなぐ理由（必須）")
    .fill("同じ記事の説明を比較");
  await page
    .getByRole("button", { name: "引用のつながりを保存", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText("1件のつながり");
});
test("write failure retains a draft and retry saves without replacing highlights", async ({
  page,
}) => {
  await fixture(page);
  await begin(page);
  await selectOther(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.transaction.db.name === "quilna.quote-connections.v1")
        throw new DOMException("full", "QuotaExceededError");
      return put.apply(this, args);
    };
    Object.assign(window, {
      restoreQuotePut: () => {
        IDBObjectStore.prototype.put = put;
      },
    });
  });
  await page.getByLabel("引用をつなぐ理由（必須）").fill("失敗しても残す理由");
  await page
    .getByRole("button", { name: "引用のつながりを保存", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "保存できませんでした",
  );
  await expect(page.getByLabel("引用をつなぐ理由（必須）")).toHaveValue(
    "失敗しても残す理由",
  );
  await page.evaluate(() =>
    (window as unknown as { restoreQuotePut: () => void }).restoreQuotePut(),
  );
  await page
    .getByRole("button", { name: "引用のつながりを保存", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText("1件のつながり");
  await expect(page.locator("#rss-highlights summary")).toHaveText(
    "ハイライト・メモ（2）",
  );
});

test("storage rejects conflicting edits and changed evidence; reverse pairs do not duplicate", async ({
  page,
}) => {
  await fixture(page);
  await begin(page);
  await connect(page);
  const result = await page.evaluate(async () => {
    const path = "/src/quote-connections.ts";
    const { readQuoteConnections, writeQuoteConnection } = await import(path);
    const a = "00000000-0000-4000-8000-000000000000";
    const old = (await readQuoteConnections(a))[0];
    const outcomes = await Promise.allSettled([
      writeQuoteConnection({ ...old, reason: "first edit", revision: 2 }, 1),
      writeQuoteConnection({ ...old, reason: "second edit", revision: 2 }, 1),
    ]);
    const current = (await readQuoteConnections(a))[0];
    const reversed = await Promise.allSettled([
      writeQuoteConnection({ ...old, from: old.to, to: old.from }, null),
    ]);
    const changed = await Promise.allSettled([
      writeQuoteConnection(
        {
          ...current,
          from: { ...current.from, note: "replace evidence" },
          revision: 3,
        },
        2,
      ),
    ]);
    const final = await readQuoteConnections(a);
    return {
      outcomes: outcomes.map((x) => x.status),
      reversed: reversed[0].status,
      changed: changed[0].status,
      final,
    };
  });
  expect(result.outcomes.sort()).toEqual(["fulfilled", "rejected"]);
  expect(result.reversed).toBe("rejected");
  expect(result.changed).toBe("rejected");
  expect(result.final).toHaveLength(1);
  expect(result.final[0].from.note).toBe("メモ 0");
});

test("per-article capacity is atomic across different quote pairs", async ({
  page,
}) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const path = "/src/quote-connections.ts",
      hpath = "/src/article-highlights.ts",
      cpath = "/src/article-connections.ts";
    const {
      openQuoteConnections,
      writeQuoteConnection,
      readArticleQuoteConnections,
    } = await import(path);
    const { readHighlights } = await import(hpath);
    const { connectionKey } = await import(cpath);
    const a = (await readHighlights("a"))[0],
      b = (await readHighlights("b"))[0];
    const make = () => {
      const from = { ...a, id: crypto.randomUUID() },
        to = { ...b, id: crypto.randomUUID() };
      return {
        id: connectionKey(from.id, to.id),
        members: [from.id, to.id].sort(),
        articles: ["a", "b"],
        from,
        to,
        reason: "capacity",
        createdAt: "2026-10-30T00:00:00Z",
        revision: 1,
      };
    };
    const db = await openQuoteConnections();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("connections", "readwrite");
      for (let i = 0; i < 199; i++) tx.objectStore("connections").put(make());
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    const results = await Promise.allSettled([
      writeQuoteConnection(make(), null),
      writeQuoteConnection(make(), null),
    ]);
    return {
      results: results.map((x) => x.status),
      a: (await readArticleQuoteConnections("a")).length,
      b: (await readArticleQuoteConnections("b")).length,
    };
  });
  expect(result.results.sort()).toEqual(["fulfilled", "rejected"]);
  expect(result.a).toBe(200);
  expect(result.b).toBe(200);
});

test("deleted highlights retain linked snapshots reachable and removable from the article graph", async ({
  page,
}) => {
  await fixture(page);
  await begin(page);
  await connect(page, "保存時の根拠を残す");
  await page.evaluate(async () => {
    const path = "/src/article-highlights.ts";
    const { readHighlights, writeHighlight } = await import(path);
    for (const article of ["a", "b"])
      for (const h of await readHighlights(article))
        await writeHighlight(h, h.revision, true);
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Quote article a", exact: true })
    .click();
  await page.locator("#rss-graph > details > summary").click();
  await page
    .locator(".rss-graph-node")
    .filter({ hasText: "Evidence a." })
    .click();
  await page
    .getByRole("button", { name: "ここを起点に周辺を見る", exact: true })
    .click();
  await expect(
    page.locator("#rss-graph > details > [role=status]"),
  ).toContainText("一覧から削除");
  await page
    .locator(".rss-graph-node")
    .filter({ hasText: "Evidence b." })
    .click();
  await expect(page.locator(".rss-graph-evidence")).toContainText(
    "保存時の根拠を残す",
  );
  await page
    .getByRole("button", { name: "この引用のつながりを編集", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText("1件のつながり");
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "引用のつながりを解除", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText("0件のつながり");
});

test("a future schema is refused without deleting its contents", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const r = indexedDB.open("quilna.quote-connections.v1", 2);
        r.onupgradeneeded = () =>
          r.result.createObjectStore("future").put("keep", "marker");
        r.onsuccess = () => {
          r.result.close();
          resolve();
        };
        r.onerror = () => reject(r.error);
      }),
  );
  await page.locator("#rss-highlights summary").click();
  await page
    .getByRole("button", { name: "この引用をつなぐ", exact: true })
    .first()
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "保存領域を開けませんでした",
  );
  expect(
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const r = indexedDB.open("quilna.quote-connections.v1", 2);
          r.onsuccess = () => {
            const db = r.result;
            const req = db
              .transaction("future")
              .objectStore("future")
              .get("marker");
            req.onsuccess = () => {
              resolve(req.result);
              db.close();
            };
            req.onerror = () => reject(req.error);
          };
          r.onerror = () => reject(r.error);
        }),
    ),
  ).toBe("keep");
});

for (const outcome of ["success", "failure"] as const)
  test(`late ${outcome} from an old quote cannot replace a newer selection`, async ({
    page,
  }) => {
    await fixture(page);
    await begin(page);
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
          this.name === "quilna.quote-connections.v1" &&
          tx.mode === "readonly" &&
          first
        ) {
          first = false;
          held = tx;
          for (const eventName of ["complete", "abort"] as const)
            Object.defineProperty(tx, `on${eventName}`, {
              configurable: true,
              set(handler: (event: Event) => void) {
                tx.addEventListener(
                  eventName,
                  (event) =>
                    Object.assign(window, {
                      quoteReadHeld: true,
                      releaseQuoteRead: () => handler.call(tx, event),
                    }),
                  { once: true },
                );
              },
            });
        }
        return tx;
      };
      IDBIndex.prototype.getAll = function (...args) {
        const r = getAll.apply(this, args);
        if (this.objectStore.transaction === held && outcome === "failure")
          r.addEventListener("success", () => held!.abort());
        return r;
      };
    }, outcome);
    await page
      .getByRole("button", { name: "引用のつながりを再読み込み", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { quoteReadHeld?: boolean }).quoteReadHeld,
        ),
      )
      .toBe(true);
    await page
      .getByRole("button", { name: "この引用をつなぐ", exact: true })
      .nth(1)
      .click();
    await expect(panel(page).getByRole("status")).toContainText(
      "0件のつながり",
    );
    await expect(panel(page).locator(".rss-quote-card").first()).toContainText(
      "Another point.",
    );
    await page.evaluate(() =>
      (
        window as unknown as { releaseQuoteRead: () => void }
      ).releaseQuoteRead(),
    );
    await expect(panel(page).locator(".rss-quote-card").first()).toContainText(
      "Another point.",
    );
    await expect(panel(page).getByRole("status")).toContainText(
      "0件のつながり",
    );
    await expect(
      page.getByRole("button", { name: "同じ記事の引用を選ぶ" }),
    ).toBeEnabled();
  });

test("concurrent edit keeps the local draft and an explicit cancel enables fresh editing", async ({
  page,
}) => {
  await fixture(page);
  await begin(page);
  await connect(page, "最初の理由");
  await page
    .getByRole("button", { name: "引用の関連理由を編集", exact: true })
    .click();
  await page.getByLabel("引用をつなぐ理由（必須）").fill("手元の理由");
  await page.evaluate(async () => {
    const path = "/src/quote-connections.ts";
    const { readQuoteConnections, writeQuoteConnection } = await import(path);
    const old = (
      await readQuoteConnections("00000000-0000-4000-8000-000000000000")
    )[0];
    await writeQuoteConnection(
      { ...old, reason: "別の画面の理由", revision: old.revision + 1 },
      old.revision,
    );
    const channel = new BroadcastChannel("quilna.quote-connections.v1");
    channel.postMessage(old.members);
    channel.close();
  });
  await expect(
    panel(page).getByRole("list", { name: "保存した引用のつながり" }),
  ).toContainText("別の画面の理由");
  await page
    .getByRole("button", { name: "引用のつながりを保存", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "別の画面でつながりが変わりました",
  );
  await expect(page.getByLabel("引用をつなぐ理由（必須）")).toHaveValue(
    "手元の理由",
  );
  await page
    .getByRole("button", { name: "引用の関連編集をやめる", exact: true })
    .click();
  await page
    .getByRole("button", { name: "引用の関連理由を編集", exact: true })
    .click();
  await expect(page.getByLabel("引用をつなぐ理由（必須）")).toHaveValue(
    "別の画面の理由",
  );
});

test("failed unlink preserves the record and can be retried", async ({
  page,
}) => {
  await fixture(page);
  await begin(page);
  await connect(page, "解除の対象");
  await page.evaluate(() => {
    const remove = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (
      ...args: Parameters<typeof remove>
    ) {
      if (this.transaction.db.name === "quilna.quote-connections.v1")
        throw new Error("denied");
      return remove.apply(this, args);
    };
    Object.assign(window, {
      restoreQuoteDelete: () => {
        IDBObjectStore.prototype.delete = remove;
      },
    });
  });
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "引用のつながりを解除", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "保存できませんでした",
  );
  await expect(
    panel(page).getByRole("list", { name: "保存した引用のつながり" }),
  ).toContainText("解除の対象");
  await page.evaluate(() =>
    (
      window as unknown as { restoreQuoteDelete: () => void }
    ).restoreQuoteDelete(),
  );
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "引用のつながりを解除", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText("0件のつながり");
});

test("keyboard linking keeps read and saved state unchanged", async ({
  page,
}) => {
  await fixture(page);
  await page.locator("#rss-highlights summary").focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: "この引用をつなぐ", exact: true })
    .first()
    .focus();
  await page.keyboard.press("Enter");
  await expect(panel(page).getByRole("status")).toContainText("0件のつながり");
  await page.getByLabel("引用を探す記事の題名").fill("Quote article b");
  await page.getByLabel("引用を探す記事の題名").press("Enter");
  await panel(page)
    .getByRole("button", { name: "Quote article b", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: "この引用を相手にする", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("引用をつなぐ理由（必須）")).toBeFocused();
  await page.keyboard.type("Keyboard connection");
  await page
    .getByRole("button", { name: "引用のつながりを保存", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(panel(page).getByRole("status")).toContainText(
    "引用のつながりを保存しました",
  );
  expect(
    await page.evaluate(async () => {
      const path = "/src/feed-store.ts";
      const db = await (await import(path)).openFeedLibrary();
      const articles = await new Promise<
        { id: string; read: boolean; saved: boolean }[]
      >((resolve, reject) => {
        const req = db.transaction("articles").objectStore("articles").getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return articles.map((a) => ({ id: a.id, read: a.read, saved: a.saved }));
    }),
  ).toEqual([
    { id: "a", read: true, saved: true },
    { id: "b", read: true, saved: false },
  ]);
});

test("late target lookup cannot erase a save failure or its draft", async ({
  page,
}) => {
  await fixture(page);
  await begin(page);
  await connect(page, "保存済みの理由");
  await page.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction;
    let first = true;
    IDBDatabase.prototype.transaction = function (
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      const tx = transaction.apply(this, args);
      if (
        this.name === "quilna.highlights.v1" &&
        tx.mode === "readonly" &&
        first
      ) {
        first = false;
        Object.defineProperty(tx, "oncomplete", {
          configurable: true,
          set(handler: (event: Event) => void) {
            tx.addEventListener(
              "complete",
              (event) =>
                Object.assign(window, {
                  targetReadHeld: true,
                  releaseTargetRead: () => handler.call(tx, event),
                }),
              { once: true },
            );
          },
        });
      }
      return tx;
    };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.transaction.db.name === "quilna.quote-connections.v1")
        throw new Error("quota");
      return put.apply(this, args);
    };
  });
  await page.getByRole("button", { name: "同じ記事の引用を選ぶ" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { targetReadHeld?: boolean }).targetReadHeld,
      ),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "引用の関連理由を編集", exact: true })
    .click();
  await page.getByLabel("引用をつなぐ理由（必須）").fill("失敗した入力を守る");
  await page
    .getByRole("button", { name: "引用のつながりを保存", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "保存できませんでした",
  );
  await page.evaluate(() =>
    (
      window as unknown as { releaseTargetRead: () => void }
    ).releaseTargetRead(),
  );
  await expect(panel(page).getByRole("status")).toContainText(
    "保存できませんでした",
  );
  await expect(page.getByLabel("引用をつなぐ理由（必須）")).toHaveValue(
    "失敗した入力を守る",
  );
});
