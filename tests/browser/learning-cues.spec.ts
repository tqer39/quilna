import { test, expect, type Page } from "@playwright/test";
const definition =
  "観察とは、目の前で起きた変化を丁寧に記録して比べることを意味します。";
const reason =
  "同じ条件で記録するため、異なる日の変化を後から比較しやすくなります。";
const contrast =
  "一方、測定する時間が異なると、温度以外の影響も含まれる場合があります。";
const code =
  "For example, this marked program must never become a learning cue.";
const body = [definition, code, reason, contrast].join("\n\n");
const translated =
  "記録とは、観察した内容を後から確かめられる形で残すことを意味します。";

async function fixture(
  page: Page,
  options: { blocked?: boolean; long?: boolean } = {},
) {
  await page.addInitScript(({ blocked }) => {
    localStorage.setItem("quilna.feed.refresh.v1", "0");
    if (blocked) {
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (name, version) => {
        if (name === "quilna.highlights.v1")
          throw new DOMException("Unavailable", "SecurityError");
        return open(name, version);
      };
    }
  }, options);
  await page.route("**/api/collection", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  await page.route("**/__cue-fixture", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Learning fixture</title>",
    }),
  );
  await page.goto("/__cue-fixture");
  await page.evaluate(
    async ({ body, code, translated, long }) => {
      const path = "/src/feed-store.ts";
      const { openFeedLibrary } = await import(path);
      const db = await openFeedLibrary();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("articles", "readwrite");
        for (const id of ["a", "b"]) {
          const text =
            long && id === "a"
              ? "A neutral observation without any specific cue.\n".repeat(
                  3500,
                ) + body
              : id === "a"
                ? body
                : "今日は静かな朝でした。窓を開けて日記を読みました。";
          tx.objectStore("articles").put({
            id,
            title: `Learning article ${id}`,
            url: `https://example.org/${id}`,
            feedUrl: "",
            body: text.slice(0, 40000),
            published: null,
            fetchedAt: "2026-10-27T00:00:00Z",
            saved: true,
            read: true,
            content: {
              text,
              title: `Learning article ${id}`,
              url: `https://example.org/${id}`,
              language: "en",
              fetchedAt: "2026-10-27T00:00:00Z",
              codeRanges:
                id === "a"
                  ? [
                      {
                        start: text.indexOf(code),
                        end: text.indexOf(code) + code.length,
                        block: true,
                      },
                    ]
                  : [],
            },
            translation: {
              text: translated,
              sourceText: text,
              sourceLanguage: "en",
              targetLanguage: "ja",
              codeRanges: [],
            },
          });
        }
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    { body, code, translated, long: options.long },
  );
  await page.goto("/?view=feeds");
  await open(page);
}
async function open(page: Page, id = "a") {
  await page
    .getByRole("button", { name: `Learning article ${id}`, exact: true })
    .click();
  await expect(page.locator("#rss-current-title")).toHaveText(
    `Learning article ${id}`,
  );
}
const panel = (page: Page) =>
  page.getByRole("region", { name: "学ぶきっかけ", exact: true });
async function show(page: Page) {
  await panel(page).locator("summary").click();
  await expect(panel(page).getByRole("status")).not.toContainText(
    "探しています",
  );
}
async function stored(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/article-highlights.ts";
    const m = await import(path);
    return m.readHighlights("a");
  });
}

test("optional source-bound questions reveal exact text and save editable highlights across reload", async ({
  page,
}, info) => {
  await fixture(page);
  await expect(panel(page).getByRole("list")).toBeHidden();
  await show(page);
  await expect(panel(page).getByRole("listitem")).toHaveCount(3);
  await expect(panel(page).getByRole("blockquote")).toHaveText([
    definition,
    reason,
    contrast,
  ]);
  expect(await stored(page)).toEqual([]);
  await panel(page)
    .getByRole("button", { name: "根拠の本文へ", exact: true })
    .first()
    .click();
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(
    definition,
  );
  await expect(page.locator(".rss-source-text p").first()).toBeFocused();
  await panel(page)
    .getByRole("button", { name: "引用と問いを残す", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("気づいたこと・メモ（任意）")).toHaveValue(
    /^問い：/,
  );
  expect(await stored(page)).toEqual([]);
  await page
    .getByLabel("気づいたこと・メモ（任意）")
    .fill("問いを自分の観察と比べて考えてみる。");
  await page
    .getByRole("button", { name: "ハイライトを保存", exact: true })
    .click();
  await expect(page.locator("#rss-highlights summary")).toHaveText(
    "ハイライト・メモ（1）",
  );
  const first = (await stored(page))[0];
  expect(first).toMatchObject({
    start: 0,
    end: definition.length,
    quote: definition,
    view: "original",
    note: "問いを自分の観察と比べて考えてみる。",
  });
  await page.reload();
  await open(page);
  await page.locator("#rss-highlights summary").click();
  await expect(page.locator("#rss-highlights .rss-highlight-memo")).toHaveText(
    first.note,
  );
  expect(await stored(page)).toEqual([first]);
  await page.screenshot({ path: info.outputPath("learning-highlight.png") });
});

test("hiding and restoring questions is optional and scoped to the displayed article version", async ({
  page,
}) => {
  await fixture(page);
  await show(page);
  for (let i = 0; i < 3; i++)
    await panel(page)
      .getByRole("button", { name: "この候補を非表示", exact: true })
      .first()
      .click();
  await expect(panel(page).getByRole("listitem")).toHaveCount(0);
  await panel(page).locator("summary").click();
  await show(page);
  await expect(panel(page).getByRole("listitem")).toHaveCount(0);
  await panel(page)
    .getByRole("button", { name: "非表示にした問いを戻す", exact: true })
    .click();
  await expect(panel(page).getByRole("listitem")).toHaveCount(3);
  await page
    .getByRole("button", { name: "日本語訳を読む", exact: true })
    .click();
  await expect(panel(page).getByRole("list")).toBeHidden();
  await show(page);
  await expect(panel(page).getByRole("blockquote")).toHaveText(translated);
  await panel(page)
    .getByRole("button", { name: "引用と問いを残す", exact: true })
    .click();
  await page
    .getByRole("button", { name: "ハイライトを保存", exact: true })
    .click();
  await expect(page.locator("#rss-highlights summary")).toContainText("（1）");
  expect((await stored(page))[0]).toMatchObject({
    view: "translation",
    language: "ja",
    quote: translated,
  });
  await page.getByRole("button", { name: "原文を読む", exact: true }).click();
  await show(page);
  await expect(panel(page).getByRole("blockquote")).toHaveText([
    definition,
    reason,
    contrast,
  ]);
  await expect(page.locator(".rss-source-text mark")).toHaveCount(0);
});

test("a question never overwrites an existing highlight draft or a failed save", async ({
  page,
}) => {
  await fixture(page);
  await show(page);
  await panel(page)
    .getByRole("button", { name: "引用と問いを残す", exact: true })
    .first()
    .click();
  await page
    .getByLabel("気づいたこと・メモ（任意）")
    .fill("まだ保存していない考え");
  await panel(page)
    .getByRole("button", { name: "引用と問いを残す", exact: true })
    .nth(1)
    .click();
  await expect(panel(page).getByRole("status")).toContainText("編集内容を保持");
  await expect(page.getByLabel("気づいたこと・メモ（任意）")).toHaveValue(
    "まだ保存していない考え",
  );
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === "highlights")
        throw new DOMException("Full", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  await page
    .getByRole("button", { name: "ハイライトを保存", exact: true })
    .click();
  await expect(page.locator("#rss-highlights [role=status]")).toContainText(
    "保存できません",
  );
  await panel(page)
    .getByRole("button", { name: "引用と問いを残す", exact: true })
    .nth(1)
    .click();
  await expect(page.getByLabel("気づいたこと・メモ（任意）")).toHaveValue(
    "まだ保存していない考え",
  );
  expect(await stored(page)).toEqual([]);
});

test("unavailable highlight storage keeps excerpts readable and explains why saving cannot start", async ({
  page,
}) => {
  await fixture(page, { blocked: true });
  await show(page);
  await expect(panel(page).getByRole("listitem")).toHaveCount(3);
  await panel(page)
    .getByRole("button", { name: "引用と問いを残す", exact: true })
    .first()
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "ハイライトをまだ読み込めていません",
  );
  await panel(page)
    .getByRole("button", { name: "根拠の本文へ", exact: true })
    .first()
    .click();
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(
    definition,
  );
  await expect(page.locator(".rss-source-text")).toContainText(definition);
});

test("closing and navigating during a large scan cannot show the previous article's candidates", async ({
  page,
}) => {
  await fixture(page, { long: true });
  await panel(page).locator("summary").click();
  await page.getByRole("button", { name: "← 記事一覧へ", exact: true }).click();
  await open(page, "b");
  await show(page);
  await expect(panel(page).getByRole("status")).toContainText(
    "候補を見つけられませんでした",
  );
  await expect(panel(page).getByRole("listitem")).toHaveCount(0);
  await page.getByRole("button", { name: "← 記事一覧へ", exact: true }).click();
  await open(page);
  await show(page);
  await expect(panel(page).getByRole("listitem")).toHaveCount(3);
  await panel(page).locator("summary").click();
  await show(page);
  await expect(panel(page).getByRole("listitem")).toHaveCount(3);
});

test("questions are keyboard reachable and fit 320px in every viewer design", async ({
  page,
}, info) => {
  await fixture(page);
  await page.setViewportSize({ width: 320, height: 800 });
  for (const design of ["studio", "editorial", "focus"]) {
    await page.evaluate(
      (design) => localStorage.setItem("quilna.reader.design.v1", design),
      design,
    );
    await page.reload();
    await open(page);
    await panel(page).locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(panel(page).getByRole("listitem")).toHaveCount(3);
    const hide = panel(page)
      .getByRole("button", { name: "この候補を非表示", exact: true })
      .first();
    await hide.focus();
    await page.keyboard.press("Enter");
    await expect(
      panel(page).getByRole("button", {
        name: "非表示にした問いを戻す",
        exact: true,
      }),
    ).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await panel(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`${design}-learning.png`) });
  }
});

test("a pending real highlight transaction rejects a second question without replacing the submitted draft", async ({
  page,
}) => {
  await fixture(page);
  await show(page);
  await panel(page)
    .getByRole("button", { name: "引用と問いを残す", exact: true })
    .first()
    .click();
  await page.getByLabel("気づいたこと・メモ（任意）").fill("保存中も守る問い");
  await page.evaluate(async () => {
    const path = "/src/article-highlights.ts";
    const m = await import(path);
    const db = await m.openHighlights();
    const tx = db.transaction("highlights", "readwrite");
    const store = tx.objectStore("highlights");
    let hold = true;
    (window as unknown as { releaseCueSave: () => void }).releaseCueSave =
      () => {
        hold = false;
      };
    const keep = () => {
      const request = store.get("gate");
      request.onsuccess = () => {
        if (hold) keep();
      };
    };
    keep();
  });
  await page
    .getByRole("button", { name: "ハイライトを保存", exact: true })
    .click();
  await expect(page.locator("#rss-highlights [role=status]")).toHaveText(
    "保存しています…",
  );
  await panel(page)
    .getByRole("button", { name: "引用と問いを残す", exact: true })
    .nth(1)
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "ハイライトを保存中",
  );
  await expect(page.getByLabel("気づいたこと・メモ（任意）")).toHaveValue(
    "保存中も守る問い",
  );
  await page.evaluate(() =>
    (window as unknown as { releaseCueSave: () => void }).releaseCueSave(),
  );
  await expect(page.locator("#rss-highlights summary")).toContainText("（1）");
  expect(
    (await stored(page)).map((h: { quote: string; note: string }) => ({
      quote: h.quote,
      note: h.note,
    })),
  ).toEqual([{ quote: definition, note: "保存中も守る問い" }]);
});

test("an old scan released after a newer A version is ready cannot replace the new questions", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const details = document.querySelector<HTMLDetailsElement>(
      "#rss-learning-cues details",
    )!;
    details.addEventListener(
      "toggle",
      () => {
        const original = window.setTimeout;
        let held = false;
        window.setTimeout = ((
          callback: TimerHandler,
          delay?: number,
          ...args: unknown[]
        ) => {
          if (!held && delay === 0 && typeof callback === "function") {
            held = true;
            window.setTimeout = original;
            (
              window as unknown as { releaseCueScan: () => void }
            ).releaseCueScan = () => callback(...args);
            return 0;
          }
          return original(callback, delay, ...args);
        }) as typeof window.setTimeout;
      },
      { once: true, capture: true },
    );
  });
  await panel(page).locator("summary").click();
  await expect(panel(page).getByRole("status")).toContainText("探しています");
  expect(
    await page.evaluate(
      () =>
        typeof (window as unknown as { releaseCueScan: unknown })
          .releaseCueScan,
    ),
  ).toBe("function");
  await page.getByRole("button", { name: "← 記事一覧へ", exact: true }).click();
  await open(page, "b");
  await show(page);
  await expect(panel(page).getByRole("status")).toContainText(
    "候補を見つけられません",
  );
  const changed =
    "For example, the new article version describes a completely different observation.";
  await page.evaluate(async (text) => {
    const path = "/src/feed-store.ts";
    const m = await import(path);
    const db = await m.openFeedLibrary();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite"),
        store = tx.objectStore("articles");
      const get = store.get("a");
      get.onsuccess = () => {
        const a = get.result;
        a.body = text;
        a.content.text = text;
        a.content.codeRanges = [];
        delete a.translation;
        store.put(a);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    db.close();
    const channel = new BroadcastChannel("tsumiki.rss.v1");
    channel.postMessage({ articleId: "a" });
    channel.close();
  }, changed);
  await page.getByRole("button", { name: "← 記事一覧へ", exact: true }).click();
  await expect(
    page.getByRole("list", { name: "記事一覧", exact: true }),
  ).toContainText(changed);
  await open(page);
  await show(page);
  await expect(panel(page).getByRole("blockquote")).toHaveText(changed);
  await page.evaluate(async () => {
    (window as unknown as { releaseCueScan: () => void }).releaseCueScan();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  await expect(panel(page).getByRole("blockquote")).toHaveText(changed);
  await expect(panel(page).getByRole("status")).toContainText("1件の候補");
});
