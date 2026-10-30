import { test, expect } from "@playwright/test";
async function seed(page: import("@playwright/test").Page, count = 125) {
  await page.goto("/?view=feeds");
  await expect(
    page.getByRole("button", { name: "フィードを探す", exact: true }),
  ).toBeEnabled();
  await page.evaluate(async (count) => {
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open("tsumiki.rss.v1");
      r.onsuccess = () => {
        const db = r.result;
        const tx = db.transaction("articles", "readwrite");
        const store = tx.objectStore("articles");
        for (let i = 0; i < count; i++) {
          const body = `original ${i} SQLite 分散 ${i === 99 ? "特別な原文" : "普通の本文"}`;
          store.put({
            id: `id-${i.toString().padStart(6, "0")}`,
            title: `記事 ${i}`,
            body,
            url: "",
            feedUrl: "",
            read: i % 2 === 0,
            saved: i % 5 === 0,
            published: null,
            fetchedAt: "2026-10-24T00:00:00Z",
            translation: {
              text: `訳文 ${i === 99 ? "固有の翻訳" : "普通の訳"}`,
              sourceText: body,
              sourceLanguage: "en",
              targetLanguage: "ja",
            },
          });
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, count);
  await page.reload();
  await expect(page.locator("#rss-search-status")).toContainText(`${count}件`);
}
test("originals and translations are searchable; clear, saved and unread filters work", async ({
  page,
}) => {
  await seed(page);
  await page.getByLabel("保存領域の記事を検索").fill("ＳＱＬｉｔｅ　特別");
  await expect(page.locator(".rss-article-list li")).toHaveCount(1);
  await expect(page.locator(".rss-article-list")).toContainText("記事 99");
  await page.getByLabel("保存領域の記事を検索").fill("固有の翻訳");
  await expect(page.locator(".rss-article-list li")).toHaveCount(1);
  await page.getByRole("button", { name: /保存した記事 ·/ }).click();
  await expect(page.locator(".rss-empty")).toContainText(
    "一致する記事はありません",
  );
  await page.getByRole("button", { name: /未読 ·/ }).click();
  await expect(page.locator(".rss-article-list")).toContainText("記事 99");
  await page.getByRole("button", { name: "検索を解除", exact: true }).click();
  await expect(page.getByLabel("保存領域の記事を検索")).toHaveValue("");
  await expect(page.locator("#rss-search-status")).toContainText("62件");
});
test("pagination exposes every result once and resets after query changes", async ({
  page,
}, info) => {
  await seed(page);
  const titles: string[] = [];
  for (let i = 0; i < 3; i++) {
    titles.push(
      ...(await page.locator(".rss-article-title").allTextContents()),
    );
    if (i < 2)
      await page.getByRole("button", { name: "次の50件", exact: true }).click();
  }
  expect(titles.length).toBe(125);
  expect(new Set(titles).size).toBe(125);
  await expect(
    page.getByRole("button", { name: "次の50件", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("保存領域の記事を検索").fill("特別");
  await expect(page.locator("#rss-search-status")).toContainText("1件 · 1–1件");
  await page.screenshot({
    path: info.outputPath("search.png"),
    fullPage: true,
  });
});
test("IME composition does not replace the input before conversion completes", async ({
  page,
}) => {
  await seed(page);
  const input = page.getByLabel("保存領域の記事を検索");
  await input.dispatchEvent("compositionstart");
  await input.fill("特別");
  await expect(page.locator(".rss-article-list li")).toHaveCount(50);
  await expect(input).toHaveValue("特別");
  await input.dispatchEvent("compositionend");
  await expect(page.locator(".rss-article-list li")).toHaveCount(1);
});

test("search input is readable and touch-sized within the article column", async ({
  page,
}) => {
  await seed(page, 2);
  const input = page.getByLabel("保存領域の記事を検索");
  await input.scrollIntoViewIfNeeded();
  const box = await input.boundingBox();
  const main = await page.locator(".rss-main").boundingBox();
  expect(box).not.toBeNull();
  expect(main).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(Math.min(280, main!.width));
  expect(box!.x).toBeGreaterThanOrEqual(main!.x);
  expect(box!.x + box!.width).toBeLessThanOrEqual(main!.x + main!.width + 1);
  await input.fill("original");
  await expect(page.locator(".rss-article-list li")).toHaveCount(2);
  await page.screenshot({ path: test.info().outputPath("search-layout.png") });
});

test("unchanged results stay connected and retain keyboard focus through repeated renders", async ({
  page,
}) => {
  await seed(page, 55);
  const first = await page
    .locator(".rss-article-title")
    .first()
    .elementHandle();
  await first!.focus();
  const preserved = await page.evaluate((first) => {
    const list = document.querySelector(".rss-article-list")!;
    const status = document.querySelector("#rss-search-status")!;
    const input = document.querySelector<HTMLInputElement>("#rss-search")!;
    let removals = 0;
    const observer = new MutationObserver(() => {});
    observer.observe(list.parentElement!, { childList: true, subtree: true });
    for (let i = 0; i < 20; i++)
      input.dispatchEvent(new Event("input", { bubbles: true }));
    for (const mutation of observer.takeRecords())
      removals += mutation.removedNodes.length;
    observer.disconnect();
    return {
      focused: document.activeElement === first,
      connected: first!.isConnected,
      list: document.querySelector(".rss-article-list") === list,
      status: document.querySelector("#rss-search-status") === status,
      removals,
    };
  }, first);
  expect(preserved).toEqual({
    focused: true,
    connected: true,
    list: true,
    status: true,
    removals: 0,
  });
  await page.keyboard.press("Enter");
  await expect(page.locator("#rss-current-title")).toHaveText("記事 0");
});

test("reused rows reflect replacements and open the latest saved translation", async ({
  page,
}) => {
  await seed(page, 3);
  const first = await page
    .locator(".rss-article-title")
    .first()
    .elementHandle();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("tsumiki.rss.v1");
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite");
      const store = tx.objectStore("articles");
      const request = store.get("id-000000");
      request.onsuccess = () =>
        store.put({
          ...request.result,
          title: "更新後の記事",
          body: "更新後の本文",
          read: false,
          saved: false,
          manualTags: ["更新タグ"],
          translation: {
            text: "最新の保存済み翻訳",
            sourceText: "更新後の本文",
            sourceLanguage: "en",
            targetLanguage: "ja",
          },
        });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    const channel = new BroadcastChannel("tsumiki.rss.v1");
    channel.postMessage({ articleId: "id-000000" });
    channel.close();
  });
  const row = page.locator(".rss-article-list li").first();
  await expect(row).toContainText("更新後の記事");
  await expect(row).toContainText("更新後の本文");
  await expect(row).toContainText("更新タグ");
  await expect(row).toContainText("未読");
  await expect(row).not.toContainText("保存済み");
  expect(await first!.evaluate((node) => node.isConnected)).toBe(true);
  await page.getByRole("button", { name: "更新後の記事", exact: true }).click();
  await page
    .getByRole("button", { name: "日本語訳を読む", exact: true })
    .click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "最新の保存済み翻訳",
  );
  await page.getByRole("button", { name: "← 記事一覧へ", exact: true }).click();
  await page.getByLabel("保存領域の記事を検索").fill("no-matching-result");
  await expect(page.locator(".rss-article-list li")).toHaveCount(0);
  expect(await first!.evaluate((node) => node.isConnected)).toBe(false);
  await page.getByLabel("保存領域の記事を検索").fill("最新の保存済み翻訳");
  await expect(page.locator(".rss-article-title")).toHaveText("更新後の記事");
});

test("background control removal, reordering and deletion preserve focus on surviving rows", async ({
  page,
}) => {
  await seed(page, 2);
  const first = await page
    .getByRole("button", { name: "記事 0", exact: true })
    .elementHandle();
  const second = await page
    .getByRole("button", { name: "記事 1", exact: true })
    .elementHandle();
  await second!.focus();
  const change = async (action: "classify" | "reorder" | "delete") => {
    await page.evaluate(async (action) => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open("tsumiki.rss.v1");
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("articles", "readwrite");
        const store = tx.objectStore("articles");
        if (action === "delete") store.delete("id-000001");
        else
          for (const id of action === "classify"
            ? ["id-000000", "id-000001"]
            : ["id-000001"]) {
            const get = store.get(id);
            get.onsuccess = () =>
              store.put({
                ...get.result,
                ...(action === "classify"
                  ? {
                      tags: {
                        version: 2,
                        state: "unclassified",
                        suggestions: [],
                      },
                    }
                  : { published: "2026-10-25T00:00:00Z" }),
              });
          }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
      const channel = new BroadcastChannel("tsumiki.rss.v1");
      channel.postMessage("changed");
      channel.close();
    }, action);
  };
  await change("classify");
  await expect(
    page.getByRole("button", { name: /未処理.*件のタグを判定/ }),
  ).toHaveCount(0);
  expect(
    await second!.evaluate((node) => document.activeElement === node),
  ).toBe(true);
  await change("reorder");
  await expect(page.locator(".rss-article-title").first()).toHaveText("記事 1");
  expect(
    await second!.evaluate((node) => document.activeElement === node),
  ).toBe(true);
  await first!.focus();
  await change("delete");
  await expect(page.locator("#rss-search-status")).toHaveText(
    "1件 · 1–1件を表示",
  );
  await expect(page.locator(".rss-article-title")).toHaveText("記事 0");
  expect(await first!.evaluate((node) => document.activeElement === node)).toBe(
    true,
  );
  expect(await second!.evaluate((node) => node.isConnected)).toBe(false);
});
