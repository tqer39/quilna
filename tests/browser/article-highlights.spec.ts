import { test, expect, type Page } from "@playwright/test";
import type { ArticleHighlight } from "../../src/article-highlights";
const body =
  "First repeated phrase.\n\nCall deleteAlarm() now.\n\nSecond repeated phrase. 日本語😀終わり。";
const codeStart = body.indexOf("deleteAlarm()");
async function fixture(page: Page, waitReady = true) {
  await page.addInitScript(() =>
    localStorage.setItem("quilna.feed.refresh.v1", "0"),
  );
  await page.route("**/api/collection", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  await page.route("**/__highlight-fixture", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Highlight fixture</title>",
    }),
  );
  await page.goto("/__highlight-fixture");
  await page.evaluate(
    async ({ body, codeStart }) => {
      const path = "/src/feed-store.ts";
      const { openFeedLibrary } = await import(path);
      const db = await openFeedLibrary();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("articles", "readwrite");
        for (const id of ["a", "b"])
          tx.objectStore("articles").put({
            id,
            title: `Highlight article ${id}`,
            url: "https://example.org/" + id,
            feedUrl: "",
            body,
            published: null,
            fetchedAt: "2026-10-27T00:00:00Z",
            saved: true,
            read: true,
            content: {
              text: body,
              title: `Highlight article ${id}`,
              url: "https://example.org/" + id,
              language: "en",
              fetchedAt: "2026-10-27T00:00:00Z",
              codeRanges: [
                { start: codeStart, end: codeStart + 13, block: false },
              ],
            },
            translation: {
              text: "日本語の引用です。\n\nもう一つの気づきです。",
              sourceText: body,
              sourceLanguage: "en",
              targetLanguage: "ja",
              codeRanges: [],
            },
          });
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    { body, codeStart },
  );
  await page.goto("/?view=feeds");
  if (waitReady) await open(page);
  else
    await page
      .getByRole("button", { name: "Highlight article a", exact: true })
      .click();
}
async function open(page: Page) {
  await page
    .getByRole("button", { name: "Highlight article a", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "引用の候補を探す",
      exact: true,
      includeHidden: true,
    }),
  ).toBeEnabled();
}
async function quote(page: Page, value: string) {
  await page.locator("#rss-highlights summary").click();
  await page
    .getByLabel("本文から探す引用（完全一致）", { exact: true })
    .fill(value);
  await page
    .getByRole("button", { name: "引用の候補を探す", exact: true })
    .click();
}
async function records(page: Page): Promise<ArticleHighlight[]> {
  return page.evaluate(async () => {
    const path = "/src/article-highlights.ts";
    const m = await import(path);
    return m.readHighlights("a");
  });
}

test("selection across prose and inline code stores exact offsets, memo, and safe marks across reload", async ({
  page,
}, info) => {
  await fixture(page);
  await page.locator(".rss-source-text").evaluate((node) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode())
      nodes.push(n as Text);
    const start = nodes.find((n) => n.textContent?.includes("Call "))!;
    const end = nodes.find((n) => n.textContent?.includes(" now."))!;
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, end.length);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page
    .getByRole("button", { name: "選択範囲をハイライト", exact: true })
    .click();
  await expect(page.locator("#rss-highlights blockquote").first()).toHaveText(
    "Call deleteAlarm() now.",
  );
  await page
    .getByLabel("気づいたこと・メモ（任意）")
    .fill("<img src=x onerror=alert(1)> 学びのメモ");
  await page
    .getByRole("button", { name: "ハイライトを保存", exact: true })
    .click();
  await expect(page.locator("#rss-highlights summary")).toHaveText(
    "ハイライト・メモ（1）",
  );
  const saved = await records(page);
  expect(saved[0]).toMatchObject({
    quote: "Call deleteAlarm() now.",
    start: body.indexOf("Call "),
    end: body.indexOf(" now.") + 5,
    note: "<img src=x onerror=alert(1)> 学びのメモ",
    view: "original",
  });
  expect(saved[0].version).toMatch(/^[a-f0-9]{64}$/);
  await expect(page.locator(".rss-source-text code mark")).toHaveText(
    "deleteAlarm()",
  );
  await expect(page.locator("#rss-highlights img")).toHaveCount(0);
  await page.reload();
  await open(page);
  await page.locator("#rss-highlights summary").click();
  await expect(page.locator("#rss-highlights .rss-highlight-memo")).toHaveText(
    saved[0].note,
  );
  await page.getByRole("button", { name: "本文の引用へ", exact: true }).click();
  await expect(page.locator(".rss-source-text mark").first()).toBeFocused();
  await page.screenshot({ path: info.outputPath("highlight.png") });
});

test("exact quote lookup disambiguates repeated text and keeps old source and translated references separate", async ({
  page,
}) => {
  await fixture(page);
  await quote(page, "repeated phrase.");
  await expect(page.getByLabel("引用の候補位置")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "ハイライトを保存", exact: true }),
  ).toBeHidden();
  await page.getByLabel("引用の候補位置").selectOption("1");
  await page
    .getByRole("button", { name: "ハイライトを保存", exact: true })
    .click();
  await expect(page.locator("#rss-highlights summary")).toContainText("（1）");
  expect((await records(page))[0].start).toBe(
    body.lastIndexOf("repeated phrase."),
  );
  await page
    .getByRole("button", { name: "日本語訳を読む", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "引用の候補を探す",
      exact: true,
      includeHidden: true,
    }),
  ).toBeEnabled();
  await quote(page, "日本語の引用です。");
  await page
    .getByRole("button", { name: "ハイライトを保存", exact: true })
    .click();
  await expect(page.locator("#rss-highlights summary")).toContainText("（2）");
  await expect(page.locator(".rss-source-text mark")).toHaveText(
    "日本語の引用です。",
  );
  await expect(
    page.getByRole("button", { name: "本文の引用へ", exact: true }).first(),
  ).toBeDisabled();
  await page.evaluate(async () => {
    const path = "/src/feed-store.ts";
    const m = await import(path);
    const db = await m.openFeedLibrary();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite"),
        store = tx.objectStore("articles"),
        get = store.get("a");
      get.onsuccess = () =>
        store.put({
          ...get.result,
          content: {
            ...get.result.content,
            text: "NEW\n\n" + get.result.content.text,
            codeRanges: [],
          },
        });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await open(page);
  await page.locator("#rss-highlights summary").click();
  await expect(page.locator(".rss-source-text mark")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "本文の引用へ", exact: true }).nth(0),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "本文の引用へ", exact: true }).nth(1),
  ).toBeDisabled();
  expect(await records(page)).toHaveLength(2);
});

test("failed save and delete retain drafts and data until an explicit retry commits", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put,
      remove = IDBObjectStore.prototype.delete;
    (window as unknown as { failHighlights: boolean }).failHighlights = true;
    IDBObjectStore.prototype.put = function (...args) {
      if (
        this.name === "highlights" &&
        (window as unknown as { failHighlights: boolean }).failHighlights
      )
        throw new DOMException("full", "QuotaExceededError");
      return put.apply(this, args);
    };
    IDBObjectStore.prototype.delete = function (...args) {
      if (
        this.name === "highlights" &&
        (window as unknown as { failHighlights: boolean }).failHighlights
      )
        throw new DOMException("full", "QuotaExceededError");
      return remove.apply(this, args);
    };
  });
  await quote(page, "日本語😀終わり。");
  await page
    .getByLabel("気づいたこと・メモ（任意）")
    .fill("失敗しても残すメモ");
  await page
    .getByRole("button", { name: "ハイライトを保存", exact: true })
    .click();
  await expect(page.locator("#rss-highlights [role=status]")).toContainText(
    "保存できませんでした",
  );
  expect(await records(page)).toHaveLength(0);
  await expect(page.getByLabel("気づいたこと・メモ（任意）")).toHaveValue(
    "失敗しても残すメモ",
  );
  await page.evaluate(() => {
    (window as unknown as { failHighlights: boolean }).failHighlights = false;
  });
  await page
    .getByRole("button", { name: "ハイライトを保存", exact: true })
    .click();
  await expect(page.locator("#rss-highlights summary")).toContainText("（1）");
  page.once("dialog", (d) => d.dismiss());
  await page
    .getByRole("button", { name: "ハイライトを削除", exact: true })
    .click();
  expect(await records(page)).toHaveLength(1);
  await page.evaluate(() => {
    (window as unknown as { failHighlights: boolean }).failHighlights = true;
  });
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "ハイライトを削除", exact: true })
    .click();
  await expect(page.locator("#rss-highlights [role=status]")).toContainText(
    "保存できませんでした",
  );
  expect(await records(page)).toHaveLength(1);
  await page.evaluate(() => {
    (window as unknown as { failHighlights: boolean }).failHighlights = false;
  });
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "ハイライトを削除", exact: true })
    .click();
  await expect(page.locator("#rss-highlights summary")).toContainText("（0）");
  await expect(page.locator(".rss-source-text mark")).toHaveCount(0);
  await expect(page.locator(".rss-source-text")).toContainText(
    "日本語😀終わり。",
  );
});

test("a stale memo cannot overwrite another tab and source anchors cannot be changed by an edit", async ({
  page,
  context,
}) => {
  await fixture(page);
  await quote(page, "日本語😀終わり。");
  await page
    .getByRole("button", { name: "ハイライトを保存", exact: true })
    .click();
  await expect(page.locator("#rss-highlights summary")).toContainText("（1）");
  await page.getByRole("button", { name: "メモを編集", exact: true }).click();
  await page.getByLabel("気づいたこと・メモ（任意）").fill("古い編集");
  const other = await context.newPage();
  await other.goto("/?view=feeds");
  await open(other);
  await other.locator("#rss-highlights summary").click();
  await other.getByRole("button", { name: "メモを編集", exact: true }).click();
  await other
    .getByLabel("気づいたこと・メモ（任意）")
    .fill("別タブの新しい編集");
  await other.getByRole("button", { name: "メモを更新", exact: true }).click();
  await expect(other.locator("#rss-highlights .rss-highlight-memo")).toHaveText(
    "別タブの新しい編集",
  );
  await page.getByRole("button", { name: "メモを更新", exact: true }).click();
  await expect(page.locator("#rss-highlights [role=status]")).toContainText(
    "別の画面で記録が変わりました",
  );
  await expect(page.getByLabel("気づいたこと・メモ（任意）")).toHaveValue(
    "古い編集",
  );
  expect((await records(page))[0].note).toBe("別タブの新しい編集");
  const rejected = await page.evaluate(async () => {
    const path = "/src/article-highlights.ts";
    const m = await import(path);
    const h = (await m.readHighlights("a"))[0];
    try {
      await m.writeHighlight(
        { ...h, start: h.start + 1, end: h.end + 1, revision: h.revision + 1 },
        h.revision,
      );
      return false;
    } catch {
      return true;
    }
  });
  expect(rejected).toBe(true);
  await other.close();
});

test("corrupt records do not get overwritten and reading remains usable", async ({
  page,
}) => {
  await fixture(page);
  await quote(page, "日本語😀終わり。");
  await page
    .getByRole("button", { name: "ハイライトを保存", exact: true })
    .click();
  await expect(page.locator("#rss-highlights summary")).toContainText("（1）");
  await page.evaluate(async () => {
    const path = "/src/article-highlights.ts";
    const m = await import(path);
    const db = await m.openHighlights();
    await new Promise<void>((resolve) => {
      const tx = db.transaction("highlights", "readwrite"),
        s = tx.objectStore("highlights"),
        g = s.getAll();
      g.onsuccess = () => s.put({ ...g.result[0], revision: "broken" });
      tx.oncomplete = () => resolve();
    });
  });
  await page
    .getByRole("button", { name: "ハイライト一覧を再読み込み", exact: true })
    .click();
  await expect(page.locator("#rss-highlights [role=status]")).toContainText(
    "保存形式を確認できません",
  );
  await expect(
    page.getByRole("button", {
      name: "引用の候補を探す",
      exact: true,
      includeHidden: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "メモを編集", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".rss-source-text")).toContainText(
    "日本語😀終わり。",
  );
  await expect(page.locator("#rss-save-article")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

for (const outcome of ["success", "failure"]) {
  test(`late ${outcome} from a previous translated view cannot replace an A-B-A reading context`, async ({
    page,
  }) => {
    await fixture(page);
    await quote(page, "日本語😀終わり。");
    await page
      .getByRole("button", { name: "ハイライトを保存", exact: true })
      .click();
    await expect(page.locator("#rss-highlights summary")).toContainText(
      "（1）",
    );
    await page.evaluate(() => {
      const original = crypto.subtle.digest.bind(crypto.subtle);
      let hold = true;
      crypto.subtle.digest = (...args) => {
        if (!hold) return original(...args);
        hold = false;
        return new Promise<ArrayBuffer>((resolve, reject) => {
          (
            window as unknown as { releaseDigest: (fail: boolean) => void }
          ).releaseDigest = (fail) => {
            if (fail) reject(Error("late hash failure"));
            else void original(...args).then(resolve, reject);
          };
        });
      };
    });
    await page
      .getByRole("button", { name: "日本語訳を読む", exact: true })
      .click();
    await expect(page.locator("#rss-highlights [role=status]")).toContainText(
      "読み込んでいます",
    );
    await page
      .getByRole("button", { name: "← 記事一覧へ", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Highlight article b", exact: true })
      .click();
    await expect(page.locator("#rss-highlights [role=status]")).toContainText(
      "気になる言葉",
    );
    await page
      .getByRole("button", { name: "← 記事一覧へ", exact: true })
      .click();
    await open(page);
    await page.evaluate(
      (fail) =>
        (
          window as unknown as { releaseDigest: (fail: boolean) => void }
        ).releaseDigest(fail),
      outcome === "failure",
    );
    await expect(page.locator("#rss-highlights [role=status]")).toHaveText(
      "1件の引用を保存しています。",
    );
    await expect(page.locator(".rss-source-text mark")).toHaveText(
      "日本語😀終わり。",
    );
    await expect(page.locator(".rss-source-text")).toContainText(
      "First repeated phrase.",
    );
    await expect(page.locator("#rss-current-title")).toHaveText(
      "Highlight article a",
    );
  });
}

test("the article limit is enforced atomically and a simultaneous memo update has one winner", async ({
  page,
}) => {
  await fixture(page);
  await quote(page, "日本語😀終わり。");
  await page
    .getByRole("button", { name: "ハイライトを保存", exact: true })
    .click();
  await expect(page.locator("#rss-highlights summary")).toContainText("（1）");
  const result = await page.evaluate(async () => {
    const path = "/src/article-highlights.ts";
    const m = await import(path);
    const h = (await m.readHighlights("a"))[0];
    const updates = await Promise.allSettled([
      m.writeHighlight({ ...h, note: "one", revision: 2 }, 1),
      m.writeHighlight({ ...h, note: "two", revision: 2 }, 1),
    ]);
    const db = await m.openHighlights();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("highlights", "readwrite"),
        s = tx.objectStore("highlights");
      for (let i = 0; i < 198; i++) s.put({ ...h, id: crypto.randomUUID() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const additions = await Promise.allSettled([
      m.writeHighlight({ ...h, id: crypto.randomUUID() }, null),
      m.writeHighlight({ ...h, id: crypto.randomUUID() }, null),
    ]);
    return {
      updates: updates.map((r) => r.status),
      additions: additions.map((r) => r.status),
      count: (await m.readHighlights("a")).length,
    };
  });
  expect(result.updates.sort()).toEqual(["fulfilled", "rejected"]);
  expect(result.additions.sort()).toEqual(["fulfilled", "rejected"]);
  expect(result.count).toBe(200);
});

test("keyboard quote lookup and memo controls reflow in all viewer designs", async ({
  page,
}, info) => {
  await fixture(page);
  await page
    .getByRole("link", { name: "ハイライト・メモ", exact: true })
    .click();
  await expect(page.locator("#rss-highlights")).toBeFocused();
  await page.locator("#rss-highlights summary").focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("本文から探す引用（完全一致）").focus();
  await page.keyboard.type("Call deleteAlarm() now.");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("気づいたこと・メモ（任意）")).toBeFocused();
  await page.keyboard.type("Keyboard note");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.locator("#rss-highlights summary")).toContainText("（1）");
  for (const design of ["Studio", "Editorial", "Focus"]) {
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("radio", { name: design, exact: true }).check();
    await page.getByRole("button", { name: "閉じる", exact: true }).click();
    await page.setViewportSize({ width: 320, height: 740 });
    await page.locator("#rss-highlights").scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.locator("#rss-highlights .rss-highlight-memo"),
    ).toHaveText("Keyboard note");
    await page.screenshot({
      path: info.outputPath(`${design}-highlights.png`),
    });
  }
});

test("a pending memo save cannot switch drafts and preserves the submitted memo on failure", async ({
  page,
}) => {
  await fixture(page);
  await quote(page, "First repeated phrase.");
  await page.getByLabel("気づいたこと・メモ（任意）").fill("First memo");
  await page
    .getByRole("button", { name: "ハイライトを保存", exact: true })
    .click();
  await expect(page.locator("#rss-highlights summary")).toContainText("（1）");
  await page
    .getByLabel("本文から探す引用（完全一致）")
    .fill("日本語😀終わり。");
  await page
    .getByRole("button", { name: "引用の候補を探す", exact: true })
    .click();
  await page.getByLabel("気づいたこと・メモ（任意）").fill("Second memo");
  await page
    .getByRole("button", { name: "ハイライトを保存", exact: true })
    .click();
  await expect(page.locator("#rss-highlights summary")).toContainText("（2）");
  await page
    .getByRole("button", { name: "メモを編集", exact: true })
    .first()
    .click();
  await page
    .getByLabel("気づいたこと・メモ（任意）")
    .fill("First memo draft that must survive");
  await page.evaluate(async () => {
    const path = "/src/article-highlights.ts";
    const m = await import(path);
    const db = await m.openHighlights();
    const tx = db.transaction("highlights", "readwrite"),
      s = tx.objectStore("highlights");
    let hold = true;
    (
      window as unknown as { releaseHighlightWriter: () => void }
    ).releaseHighlightWriter = () => {
      hold = false;
    };
    const keep = () => {
      const g = s.get("gate");
      g.onsuccess = () => {
        if (hold) keep();
      };
    };
    keep();
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "highlights")
        throw new DOMException("full", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  await page.getByRole("button", { name: "メモを更新", exact: true }).click();
  await expect(page.locator("#rss-highlights [role=status]")).toHaveText(
    "保存しています…",
  );
  // Native click obeys disabled state. This used to replace the pending draft.
  await page
    .getByRole("button", { name: "メモを編集", exact: true })
    .nth(1)
    .evaluate((b) => (b as HTMLButtonElement).click());
  await page.evaluate(() =>
    (
      window as unknown as { releaseHighlightWriter: () => void }
    ).releaseHighlightWriter(),
  );
  await expect(page.locator("#rss-highlights [role=status]")).toContainText(
    "保存できませんでした",
  );
  await expect(page.getByLabel("気づいたこと・メモ（任意）")).toHaveValue(
    "First memo draft that must survive",
  );
  expect((await records(page)).map((h) => h.note)).toEqual([
    "First memo",
    "Second memo",
  ]);
});

for (const pending of [false, true]) {
  test(`new highlights use current metadata while prior citations remain unchanged (pending load: ${pending})`, async ({
    page,
  }) => {
    await fixture(page);
    await quote(page, "First repeated phrase.");
    await page
      .getByRole("button", { name: "ハイライトを保存", exact: true })
      .click();
    await expect(page.locator("#rss-highlights summary")).toContainText(
      "（1）",
    );
    await page.goto("/__highlight-fixture");
    await page.evaluate(
      async ({ body, pending }) => {
        const path = "/src/article-highlight-view.ts";
        const { ArticleHighlightView } = await import(path);
        const component = new ArticleHighlightView();
        const content = document.createElement("div");
        const view = {
          articleId: "a",
          title: "Old title",
          url: "https://example.org/old",
          view: "original" as const,
          language: "en",
          text: body,
          original: body,
        };
        let release = () => {};
        if (pending) {
          const digest = crypto.subtle.digest.bind(crypto.subtle);
          crypto.subtle.digest = (...args) =>
            new Promise<ArrayBuffer>((resolve, reject) => {
              release = () => {
                void digest(...args).then(resolve, reject);
              };
            });
        }
        document.body.append(content, component.mount(view, content));
        (
          window as unknown as { updateHighlightMetadata: () => void }
        ).updateHighlightMetadata = () => {
          component.mount(
            {
              ...view,
              title: "Current title",
              url: "https://example.org/current",
            },
            content,
          );
          release();
        };
      },
      { body, pending },
    );
    if (!pending)
      await expect(
        page.getByRole("button", {
          name: "引用の候補を探す",
          includeHidden: true,
        }),
      ).toBeEnabled();
    await page.evaluate(() =>
      (
        window as unknown as { updateHighlightMetadata: () => void }
      ).updateHighlightMetadata(),
    );
    await expect(
      page.getByRole("button", {
        name: "引用の候補を探す",
        includeHidden: true,
      }),
    ).toBeEnabled();
    // Restore normal hashing before the post-save reload.
    if (pending)
      await page.evaluate(() => {
        delete (crypto.subtle as Partial<SubtleCrypto>).digest;
      });
    await quote(page, "日本語😀終わり。");
    await page
      .getByRole("button", { name: "ハイライトを保存", exact: true })
      .click();
    await expect(page.locator("#rss-highlights summary")).toContainText(
      "（2）",
    );
    const saved = await records(page);
    expect(saved[0]).toMatchObject({
      title: "Highlight article a",
      url: "https://example.org/a",
    });
    expect(saved[1]).toMatchObject({
      title: "Current title",
      url: "https://example.org/current",
    });
  });
}

test("a queued cross-tab refresh retains a failed save message and draft", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const listen = BroadcastChannel.prototype.addEventListener;
    BroadcastChannel.prototype.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (
        this.name === "quilna.highlights.v1" &&
        type === "message" &&
        typeof listener === "function"
      ) {
        const wrapped: EventListener = (event) => {
          listener.call(this, event);
          (
            window as unknown as { highlightNotified: boolean }
          ).highlightNotified = true;
        };
        return listen.call(this, type, wrapped, options);
      }
      return listen.call(this, type, listener, options);
    };
  });
  await fixture(page);
  await quote(page, "First repeated phrase.");
  await page.getByLabel("気づいたこと・メモ（任意）").fill("Unsaved draft");
  await page.evaluate(async () => {
    const path = "/src/article-highlights.ts";
    const m = await import(path);
    const db = await m.openHighlights();
    const tx = db.transaction("highlights", "readwrite"),
      store = tx.objectStore("highlights");
    let hold = true;
    (
      window as unknown as { releaseHighlightWriter: () => void }
    ).releaseHighlightWriter = () => {
      hold = false;
    };
    const keep = () => {
      const request = store.get("gate");
      request.onsuccess = () => {
        if (hold) keep();
      };
    };
    keep();
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "highlights")
        throw new DOMException("full", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  await page
    .getByRole("button", { name: "ハイライトを保存", exact: true })
    .click();
  await expect(page.locator("#rss-highlights [role=status]")).toHaveText(
    "保存しています…",
  );
  await page.evaluate(() => {
    const c = new BroadcastChannel("quilna.highlights.v1");
    c.postMessage("a");
    c.close();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { highlightNotified: boolean })
            .highlightNotified,
      ),
    )
    .toBe(true);
  await page.evaluate(() =>
    (
      window as unknown as { releaseHighlightWriter: () => void }
    ).releaseHighlightWriter(),
  );
  await expect(
    page.getByRole("button", { name: "ハイライトを保存", exact: true }),
  ).toBeEnabled();
  await expect(page.locator("#rss-highlights [role=status]")).toContainText(
    "保存できませんでした",
  );
  await expect(page.getByLabel("気づいたこと・メモ（任意）")).toHaveValue(
    "Unsaved draft",
  );
  expect(await records(page)).toHaveLength(0);
});

test("an unavailable highlight store can be retried without changing article storage", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const open = indexedDB.open.bind(indexedDB);
    (window as unknown as { denyHighlights: boolean }).denyHighlights = true;
    indexedDB.open = (...args) => {
      if (
        args[0] === "quilna.highlights.v1" &&
        (window as unknown as { denyHighlights: boolean }).denyHighlights
      )
        throw new DOMException(
          "Highlight storage is unavailable",
          "SecurityError",
        );
      return open(...args);
    };
  });
  // Seed articles normally, but do not wait for highlight readiness.
  await fixture(page, false);
  await expect(page.locator("#rss-highlights [role=status]")).toContainText(
    "Highlight storage is unavailable",
  );
  await expect(page.locator(".rss-source-text")).toContainText(
    body.replace(/\n\n/g, ""),
  );
  await expect(page.locator("#rss-save-article")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator("#rss-highlights summary").click();
  await expect(
    page.getByRole("button", { name: "引用の候補を探す", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    (window as unknown as { denyHighlights: boolean }).denyHighlights = false;
  });
  await page
    .getByRole("button", { name: "ハイライト一覧を再読み込み", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "引用の候補を探す", exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel("本文から探す引用（完全一致）")
    .fill("日本語😀終わり。");
  await page
    .getByRole("button", { name: "引用の候補を探す", exact: true })
    .click();
  await page
    .getByRole("button", { name: "ハイライトを保存", exact: true })
    .click();
  await expect(page.locator("#rss-highlights summary")).toContainText("（1）");
});

test("a newer highlight schema is refused without deleting or downgrading stored data", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/__highlight-fixture");
  await page.evaluate(async () => {
    const request = indexedDB.open("quilna.highlights.v1", 2);
    request.onupgradeneeded = () =>
      request.result
        .createObjectStore("future")
        .put({ preserve: true }, "sentinel");
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  });
  await page.goto("/?view=feeds");
  await page
    .getByRole("button", { name: "Highlight article a", exact: true })
    .click();
  await expect(page.locator("#rss-highlights [role=status]")).toContainText(
    "保存領域を開けませんでした",
  );
  await expect(
    page.getByRole("button", { name: "引用の候補を探す", includeHidden: true }),
  ).toBeDisabled();
  await expect(page.locator(".rss-source-text")).toContainText(
    "日本語😀終わり。",
  );
  const preserved = await page.evaluate(async () => {
    const request = indexedDB.open("quilna.highlights.v1");
    return new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
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
    stores: ["future", "highlights"],
    value: { preserve: true },
  });
});

test("dismissing the text selection also dismisses the capture action", async ({
  page,
}) => {
  await fixture(page);
  await page
    .locator(".rss-source-text p")
    .first()
    .evaluate((paragraph) => {
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
  const action = page.getByRole("button", {
    name: "選択範囲をハイライト",
    exact: true,
  });
  await expect(action).toBeVisible();
  await page.evaluate(() => {
    getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(action).toBeHidden();
});
