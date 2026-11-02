import { test, expect, type Page } from "@playwright/test";

async function change(page: Page, saved: boolean) {
  await page.evaluate(async (saved) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("tsumiki.rss.v1");
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite"),
        store = tx.objectStore("articles");
      const r = store.get("navigation-article");
      r.onsuccess = () => store.put({ ...r.result, saved });
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    db.close();
    const channel = new BroadcastChannel("tsumiki.rss.v1");
    channel.postMessage({ articleId: "navigation-article" });
    channel.close();
  }, saved);
  await expect(
    page.getByRole("button", {
      name: `保存した記事 · ${saved ? 1 : 0}`,
      exact: true,
    }),
  ).toBeVisible();
}

test("background article commits preserve an unfinished source URL selection and refresh-button focus", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("quilna.feed.refresh.v1", "0"),
  );
  await page.goto("/?view=feeds");
  await expect(
    page.getByRole("button", { name: "フィードを探す", exact: true }),
  ).toBeEnabled();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("tsumiki.rss.v1");
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["feeds", "articles"], "readwrite");
      tx.objectStore("feeds").put({
        url: "https://example.org/news",
        title: "Navigation news",
        fetchedAt: "2026-10-30T00:00:00Z",
      });
      tx.objectStore("articles").put({
        id: "navigation-article",
        feedUrl: "https://example.org/news",
        title: "Navigation article",
        body: "Stored source",
        url: "",
        published: null,
        fetchedAt: "2026-10-30T00:00:00Z",
        saved: false,
        read: false,
      });
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Navigation article", exact: true }),
  ).toBeVisible();
  const field = page.getByLabel("サイト・RSSのURL");
  await field.fill("https://example.org/unfinished");
  await field.evaluate((node: HTMLInputElement) =>
    node.setSelectionRange(8, 15, "backward"),
  );
  await change(page, true);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("https://example.org/unfinished");
  expect(
    await field.evaluate((node: HTMLInputElement) => [
      node.selectionStart,
      node.selectionEnd,
      node.selectionDirection,
    ]),
  ).toEqual([8, 15, "backward"]);
  const refresh = page.getByRole("button", {
    name: "Navigation newsを更新",
    exact: true,
  });
  await refresh.focus();
  await change(page, false);
  await expect(refresh).toBeFocused();
  await expect(field).toHaveValue("https://example.org/unfinished");
});
