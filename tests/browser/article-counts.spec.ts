import { test, expect } from "@playwright/test";

test("menu counts follow committed cross-tab replacements, source changes and full reloads", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("quilna.feed.refresh.v1", "0");
  });
  await page.goto("/?view=feeds");
  await expect(
    page.getByRole("button", { name: "フィードを探す", exact: true }),
  ).toBeEnabled();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("tsumiki.rss.v1");
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["feeds", "articles"], "readwrite");
      for (const name of ["a", "b"])
        tx.objectStore("feeds").put({
          url: `https://example.org/${name}`,
          title: name,
          fetchedAt: "2026-10-24T00:00:00Z",
        });
      for (const [id, feedUrl, read, saved] of [
        ["a", "https://example.org/a", false, false],
        ["b", "https://example.org/b", true, true],
        ["single", "", false, false],
      ])
        tx.objectStore("articles").put({
          id,
          feedUrl,
          read,
          saved,
          title: id,
          ...(id === "b"
            ? { tags: { version: 1, state: "unclassified", suggestions: [] } }
            : {}),
          body: "Body",
          url: "",
          published: null,
          fetchedAt: "2026-10-24T00:00:00Z",
        });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  });
  await page.reload();
  const counts = async (
    all: number,
    unread: number,
    saved: number,
    pending: number,
  ) => {
    for (const name of [
      `すべての記事 · ${all}`,
      `未読 · ${unread}`,
      `保存した記事 · ${saved}`,
    ])
      await expect(
        page.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: `未処理${pending}件のタグを判定`,
        exact: true,
      }),
    ).toBeEnabled();
  };
  await counts(3, 2, 1, 3);
  await page.getByLabel("保存領域の記事を検索").fill("no matches");
  await expect(page.locator("#rss-search-status")).toHaveText(
    "0件 · 0–0件を表示",
  );
  await page
    .getByLabel("配信元", { exact: true })
    .selectOption("https://example.org/a");
  await counts(1, 1, 0, 3);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("tsumiki.rss.v1");
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite");
      const store = tx.objectStore("articles");
      const r = store.get("a");
      r.onsuccess = () =>
        store.put({
          ...r.result,
          feedUrl: "https://example.org/b",
          read: true,
          saved: true,
          tags: { version: 2, state: "unclassified", suggestions: [] },
        });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    const channel = new BroadcastChannel("tsumiki.rss.v1");
    channel.postMessage({ articleId: "a" });
    channel.close();
  });
  await counts(0, 0, 0, 2);
  await page
    .getByLabel("配信元", { exact: true })
    .selectOption("https://example.org/b");
  await counts(2, 0, 2, 2);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("tsumiki.rss.v1");
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite");
      tx.objectStore("articles").delete("b");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    const channel = new BroadcastChannel("tsumiki.rss.v1");
    channel.postMessage("changed");
    channel.close();
  });
  await counts(1, 0, 1, 1);
  await page.reload();
  await counts(2, 1, 1, 1);
});
