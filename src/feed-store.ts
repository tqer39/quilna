import { feedFailure } from "./feed-auto-refresh";
import {
  classifyArticle,
  normalizeManualTags,
  validArticleTags,
  validManualTags,
} from "./article-tags";
import type { Feed, FeedArticle } from "./feed-parser";
import { articleTextLimit } from "./article-content";
import { legacyArticleText, validCodeRanges } from "./article-code";
import type { ArticleContent, ArticleTranslation } from "./article-content";
import { articleURL } from "./feed-parser";
import { validDocumentReference, sourceContent } from "./source-document";
const text = (value: unknown) =>
  typeof value === "string" && value.length <= 40000;
const timestamp = (value: unknown) =>
  text(value) && Number.isFinite(Date.parse(value as string));
export function validArticle(a: FeedArticle) {
  return (
    a &&
    [a.id, a.feedUrl, a.title, a.url, a.body, a.fetchedAt].every(text) &&
    timestamp(a.fetchedAt) &&
    (a.published === null || timestamp(a.published)) &&
    typeof a.read === "boolean" &&
    typeof a.saved === "boolean" &&
    (!a.url || articleURL(a.url, a.feedUrl || a.url) === a.url) &&
    (a.contentError === undefined || text(a.contentError)) &&
    (a.tags === undefined || validArticleTags(a.tags)) &&
    (a.manualTags === undefined || validManualTags(a.manualTags)) &&
    (a.content === undefined ||
      (a.content &&
        typeof a.content.text === "string" &&
        a.content.text.length <= articleTextLimit &&
        validCodeRanges(a.content.text, a.content.codeRanges) &&
        (a.content.document === undefined ||
          validDocumentReference(a.content.document)) &&
        text(a.content.url) &&
        articleURL(a.content.url, a.url) === a.content.url &&
        text(a.content.title) &&
        text(a.content.language) &&
        timestamp(a.content.fetchedAt))) &&
    (a.translation === undefined ||
      (a.translation &&
        typeof a.translation.text === "string" &&
        a.translation.text.length <= articleTextLimit * 2 &&
        validCodeRanges(a.translation.text, a.translation.codeRanges) &&
        typeof a.translation.sourceText === "string" &&
        a.translation.sourceText.length <= articleTextLimit &&
        text(a.translation.sourceLanguage) &&
        typeof a.translation.targetLanguage === "string" &&
        /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(
          a.translation.targetLanguage,
        ) &&
        a.translation.targetLanguage.length <= 35))
  );
}
export function readArticle(db: IDBDatabase, id: string): Promise<FeedArticle> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("articles", "readonly");
    const request = tx.objectStore("articles").get(id);
    tx.oncomplete = () => {
      if (validArticle(request.result)) resolve(request.result);
      else
        reject(
          Error(
            "記事の保存形式を確認できませんでした。既存データは保持しています。",
          ),
        );
    };
    tx.onerror = tx.onabort = () =>
      reject(Error("記事を読み込めませんでした。"));
  });
}

export const feedDatabase = "tsumiki.rss.v1";
export function openFeedLibrary(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(feedDatabase, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("feeds", { keyPath: "url" });
      request.result.createObjectStore("articles", { keyPath: "id" });
    };
    request.onerror = () =>
      reject(
        Error(
          "記事の保存領域を開けませんでした。既存データは削除していません。",
        ),
      );
    request.onblocked = () =>
      reject(Error("別タブを閉じて保存領域の再接続を試してください。"));
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}
export function validFeed(feed: Feed) {
  return (
    feed &&
    text(feed.url) &&
    text(feed.title) &&
    timestamp(feed.fetchedAt) &&
    (feed.refreshFailure === undefined ||
      (feed.refreshFailure &&
        Number.isInteger(feed.refreshFailure.failures) &&
        feed.refreshFailure.failures > 0 &&
        feed.refreshFailure.failures <= 8 &&
        Number.isSafeInteger(feed.refreshFailure.retryAt) &&
        feed.refreshFailure.retryAt >= 0 &&
        feed.refreshFailure.retryAt <= 8_640_000_000_000_000 &&
        text(feed.refreshFailure.error)))
  );
}
export function readFeed(
  db: IDBDatabase,
  address: string,
): Promise<Feed | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("feeds", "readonly");
    const get = tx.objectStore("feeds").get(address);
    tx.oncomplete = () =>
      get.result === undefined || validFeed(get.result)
        ? resolve(get.result)
        : reject(Error("配信元の保存形式を確認できません。"));
    tx.onerror = tx.onabort = () =>
      reject(Error("配信元を読み込めませんでした。"));
  });
}
export function recordFeedFailure(
  db: IDBDatabase,
  address: string,
  error: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("feeds", "readwrite");
    const store = tx.objectStore("feeds");
    const get = store.get(address);
    get.onsuccess = () => {
      if (!get.result) return;
      if (!validFeed(get.result)) {
        tx.abort();
        return;
      }
      try {
        store.put({
          ...get.result,
          refreshFailure: feedFailure(get.result.refreshFailure, error),
        });
      } catch {
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () =>
      reject(Error("更新の待機時刻を保存できませんでした。"));
  });
}
export function readFeedLibrary(
  db: IDBDatabase,
): Promise<{ feeds: Feed[]; articles: FeedArticle[] }> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["feeds", "articles"], "readonly");
    const feeds = tx.objectStore("feeds").getAll();
    const store = tx.objectStore("articles");
    const articles: FeedArticle[] = [];
    let invalidArticles = false;
    // Bound each native IDB result as well as JS callback work. One huge
    // getAll result can leave a large native value array for later cleanup.
    // Enqueue the next batch synchronously in onsuccess: every batch remains
    // in this one readonly transaction/snapshot, with no partial publication.
    const readBatch = (after?: string) => {
      const request = store.getAll(
        after === undefined ? null : IDBKeyRange.lowerBound(after, true),
        500,
      );
      request.onsuccess = () => {
        const batch = request.result as FeedArticle[];
        if (!batch.every(validArticle)) {
          invalidArticles = true;
          tx.abort();
          return;
        }
        articles.push(...batch);
        if (batch.length === 500) readBatch(batch[batch.length - 1].id);
      };
    };
    readBatch();
    tx.oncomplete = () => {
      const validFeeds = feeds.result.every(validFeed);
      if (!validFeeds) {
        reject(
          Error(
            "保存データの形式を確認できませんでした。データは削除していません。",
          ),
        );
        return;
      }
      resolve({ feeds: feeds.result, articles });
    };
    tx.onabort = tx.onerror = () =>
      reject(
        Error(
          invalidArticles
            ? "保存データの形式を確認できませんでした。データは削除していません。"
            : "保存した記事を読み込めませんでした。",
        ),
      );
  });
}
export function mergeFeed(
  db: IDBDatabase,
  feed: Feed,
  articles: FeedArticle[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["feeds", "articles"], "readwrite");
    const feedStore = tx.objectStore("feeds");
    const existing = feedStore.get(feed.url);
    existing.onsuccess = () => {
      const count = feedStore.count();
      count.onsuccess = () => {
        if (!existing.result && count.result >= 50) {
          reject(Error("この試作では購読50件まで登録できます。"));
          tx.abort();
          return;
        }
        if (
          !existing.result ||
          Date.parse(existing.result.fetchedAt) <= Date.parse(feed.fetchedAt)
        )
          feedStore.put(feed);
      };
    };
    const store = tx.objectStore("articles");
    for (const article of articles) {
      const request = store.get(article.id);
      request.onsuccess = () => {
        const old = request.result as FeedArticle | undefined;
        // A saved article is a stable local copy, even when its feed changes.
        const next =
          old &&
          (old.saved ||
            Date.parse(old.fetchedAt) > Date.parse(article.fetchedAt))
            ? old
            : {
                ...article,
                read: old?.read ?? false,
                content: old?.content,
                contentError: old?.contentError,
                translation: old?.translation,
                manualTags: old?.manualTags,
              };
        store.put({ ...next, tags: classifyArticle(next) });
      };
    }
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(
        Error("記事を保存できませんでした。以前の保存内容は保持しています。"),
      );
  });
}
export function flagArticle(
  db: IDBDatabase,
  id: string,
  field: "saved" | "read",
  value: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("articles", "readwrite");
    const store = tx.objectStore("articles");
    const request = store.get(id);
    request.onsuccess = () => {
      if (request.result) store.put({ ...request.result, [field]: value });
      else tx.abort();
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(Error("変更を保存できませんでした。再試行してください。"));
  });
}

// Update the latest record transactionally so concurrent saved/read changes survive.
export function updateArticleContent(
  db: IDBDatabase,
  article: FeedArticle,
  patch: {
    content?: ArticleContent;
    contentError?: string;
    translation?: ArticleTranslation;
  },
  insert = false,
  signal?: AbortSignal,
  restoreCode = false,
  contentMode: "preserve" | "metadata" | "replace" = "preserve",
): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const tx = db.transaction("articles", "readwrite");
    const abort = () => {
      try {
        tx.abort();
      } catch {
        /* Already committed. */
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const store = tx.objectStore("articles");
    const request = store.get(article.id);
    request.onsuccess = () => {
      const old = request.result as FeedArticle | undefined;
      if (!old && !insert) {
        tx.abort();
        return;
      }
      // A slower import in another tab must not replace an already saved original.
      if (patch.content && old?.content) {
        if (contentMode !== "preserve") {
          if (
            JSON.stringify(old.content) !== JSON.stringify(article.content) ||
            (contentMode === "metadata" &&
              JSON.stringify(sourceContent(old.content)) !==
                JSON.stringify(sourceContent(patch.content)))
          ) {
            tx.abort();
            return;
          }
        } else {
          if (!restoreCode) return;
          // Only enrich the exact old snapshot with formatting; never replace a
          // changed source or another tab's successful upgrade.
          if (old.content.codeRanges !== undefined) return;
          if (
            JSON.stringify(old.content) !== JSON.stringify(article.content) ||
            legacyArticleText(patch.content.text) !== old.content.text
          ) {
            tx.abort();
            return;
          }
        }
      }
      // Do not attach a translation to a newer original from another tab.
      if (
        patch.translation &&
        (patch.translation.sourceText !== (old?.content?.text || old?.body) ||
          JSON.stringify(article.content?.codeRanges ?? []) !==
            JSON.stringify(old?.content?.codeRanges ?? []))
      ) {
        tx.abort();
        return;
      }
      try {
        const next = {
          ...(old ?? article),
          ...patch,
          ...(patch.content
            ? {
                ...(contentMode === "metadata" ||
                (old?.content &&
                  JSON.stringify({
                    ...sourceContent(old.content),
                    fetchedAt: "",
                  }) ===
                    JSON.stringify({
                      ...sourceContent(patch.content),
                      fetchedAt: "",
                    }))
                  ? {}
                  : { translation: undefined }),
                contentError: patch.contentError,
              }
            : {}),
        };
        store.put({ ...next, tags: classifyArticle(next) });
      } catch {
        tx.abort();
      }
    };
    tx.oncomplete = () => {
      cleanup();
      resolve();
    };
    tx.onabort = tx.onerror = () => {
      cleanup();
      reject(
        Error(
          "本文・翻訳を保存できませんでした。以前の内容は保持しています。再試行してください。",
        ),
      );
    };
  });
}

// Read the latest record inside the write transaction; never replace newer content or flags.
export function setArticleTags(
  db: IDBDatabase,
  id: string,
  manualTags?: string[],
  preserveManual = false,
): Promise<void> {
  const normalized =
    manualTags === undefined ? undefined : normalizeManualTags(manualTags);
  return new Promise((resolve, reject) => {
    const tx = db.transaction("articles", "readwrite");
    const store = tx.objectStore("articles");
    const get = store.get(id);
    get.onsuccess = () => {
      const article = get.result as FeedArticle;
      if (!validArticle(article)) {
        tx.abort();
        return;
      }
      try {
        store.put({
          ...article,
          tags: classifyArticle(article),
          manualTags: preserveManual ? article.manualTags : normalized,
        });
      } catch {
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () =>
      reject(
        Error(
          "タグを保存できませんでした。以前のタグは保持しています。再試行してください。",
        ),
      );
  });
}
