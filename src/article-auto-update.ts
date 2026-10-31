import type { FeedArticle } from "./feed-parser";
import { validArticle } from "./feed-store";
import { DocumentAcquisition } from "./document-acquisition";
import { currentDocument, retainDocument } from "./source-document-store";
import { versionContent, type DocumentReference } from "./source-document";
import {
  articleUpdateIdentity,
  nextArticleUpdate,
  type ArticleUpdate,
} from "./article-update";

const failed = () =>
  Error("本文の更新確認を保存できませんでした。以前の本文は保持しています。");

async function currentCandidates(db: IDBDatabase, candidates: FeedArticle[]) {
  return new Promise<FeedArticle[]>((resolve, reject) => {
    const tx = db.transaction(["articles", "feeds"]),
      result: FeedArticle[] = [];
    for (const candidate of candidates) {
      const get = tx.objectStore("articles").get(candidate.id);
      const feed = candidate.feedUrl
        ? tx.objectStore("feeds").get(candidate.feedUrl)
        : undefined;
      (feed ?? get).onsuccess = () => {
        const a = get.result as FeedArticle | undefined;
        if (!a) return; // Deletion during a queued check must not resurrect it.
        if (!validArticle(a)) {
          tx.abort();
          return;
        }
        if (
          a.url === candidate.url &&
          a.feedUrl === candidate.feedUrl &&
          a.content &&
          (!a.feedUrl || (feed?.result && !feed.result.unsubscribed))
        )
          result.push(a);
      };
    }
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(failed());
  });
}

async function commit(
  db: IDBDatabase,
  snapshots: FeedArticle[],
  updates: Map<string, ArticleUpdate>,
  originals: Map<string, DocumentReference>,
  check: () => void,
) {
  check();
  return new Promise<string[]>((resolve, reject) => {
    const tx = db.transaction(["articles", "feeds"], "readwrite"),
      changed: string[] = [];
    for (const snapshot of snapshots) {
      const store = tx.objectStore("articles"),
        get = store.get(snapshot.id),
        feed = snapshot.feedUrl
          ? tx.objectStore("feeds").get(snapshot.feedUrl)
          : undefined;
      (feed ?? get).onsuccess = () => {
        try {
          check();
          const a = get.result as FeedArticle | undefined;
          if (
            !a ||
            articleUpdateIdentity(a) !== articleUpdateIdentity(snapshot) ||
            (a.feedUrl && (!feed?.result || feed.result.unsubscribed))
          )
            return;
          const original = originals.get(a.id),
            update = updates.get(a.id);
          if (!update) return;
          const next = {
            ...a,
            bodyUpdate: update,
            content:
              original && a.content
                ? { ...a.content, document: original }
                : a.content,
          };
          if (!validArticle(next)) throw failed();
          store.put(next);
          changed.push(a.id);
        } catch {
          tx.abort();
        }
      };
    }
    tx.oncomplete = () => resolve(changed);
    tx.onabort = tx.onerror = () => reject(failed());
  });
}

/** One source per call. The scheduler owns the cross-tab lock and rate limit. */
export async function checkArticleUpdates(
  db: IDBDatabase,
  candidates: FeedArticle[],
  acquisition: DocumentAcquisition,
  check: () => void,
): Promise<string[]> {
  check();
  const live = await currentCandidates(db, candidates),
    now = Date.now();
  const first = live.find((a) => nextArticleUpdate(a) <= now);
  if (!first) return [];
  const group = live.filter(
    (a) => a.url === first.url && nextArticleUpdate(a) <= now,
  );
  const snapshot = acquisition.snapshot();
  const active = () => {
    check();
    snapshot.check();
  };
  const originals = new Map<string, DocumentReference>(),
    updates = new Map<string, ArticleUpdate>();
  const eligible = group.filter(
    (a) => !a.feedRevision || a.feedRevision.url === a.url,
  );
  let latest: DocumentReference | undefined, error: string | undefined;
  try {
    for (const a of eligible) {
      active();
      if (a.content && !a.content.document) {
        const saved = await retainDocument(a.url, a.content, { seed: true });
        originals.set(a.id, versionContent(saved.version).document!);
      }
    }
    if (eligible.length) {
      active();
      // Reuse a source another feed/tab/manual check already checked after
      // these observations. Cloud acquisition still reauthorizes every delivery.
      const cached =
        snapshot.preference.mode === "browser"
          ? await currentDocument(first.url)
          : undefined;
      const changedAt = Math.max(
        ...eligible.map(
          (a) => Date.parse(a.feedRevision?.changedAt ?? "") || 0,
        ),
      );
      const force =
        snapshot.preference.mode === "browser"
          ? changedAt > (Date.parse(cached?.document.checkedAt ?? "") || 0)
          : eligible.some(
              (a) =>
                a.feedRevision &&
                a.feedRevision.fingerprint !== a.bodyUpdate?.fingerprint,
            );
      const result = await acquisition.acquire(first.url, !!force, snapshot);
      active();
      if (result.warning) error = result.warning;
      else latest = result.content.document;
      if (!error && !latest) throw failed();
    }
  } catch (e) {
    active(); // Cancellation/preferences changes must not write failure metadata.
    error =
      e instanceof Error ? e.message : "本文の更新を確認できませんでした。";
  }
  const checkedAt = Date.now();
  for (const a of group) {
    const message =
      a.feedRevision && a.feedRevision.url !== a.url
        ? "配信元の記事URLが変更されています。保存した記事のリンクから元サイトを確認してください。"
        : error;
    const failures = message
      ? Math.min(8, (a.bodyUpdate?.failures ?? 0) + 1)
      : 0;
    updates.set(a.id, {
      checkedAt: message ? (a.bodyUpdate?.checkedAt ?? 0) : checkedAt,
      fingerprint: message
        ? a.bodyUpdate?.fingerprint
        : a.feedRevision?.fingerprint,
      failures,
      retryAt: message
        ? checkedAt + Math.min(5 * 2 ** (failures - 1), 24 * 60) * 60_000
        : 0,
      latest: message ? a.bodyUpdate?.latest : latest,
      ...(message ? { error: message.slice(0, 2000) } : {}),
    });
  }
  return commit(db, group, updates, originals, active);
}

const lastAttemptKey = "quilna.article.updates.last-attempt.v1";
export class ArticleAutoUpdate {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private generation = 0;
  private started = false;
  private blockedUntil = 0;
  constructor(
    private options: {
      db: () => IDBDatabase | null;
      articles: () => FeedArticle[];
      canRun: () => boolean;
      acquisition: DocumentAcquisition;
      changed: (ids: string[]) => Promise<void>;
      failed: (error: unknown) => void;
    },
  ) {}
  start() {
    this.started = true;
    this.wake();
  }
  stop() {
    this.started = false;
    this.generation++;
    clearTimeout(this.timer);
  }
  wake() {
    clearTimeout(this.timer);
    if (
      !this.started ||
      this.running ||
      !this.options.canRun() ||
      !navigator.locks
    )
      return;
    void this.run();
  }
  private async run() {
    this.running = true;
    const generation = this.generation;
    const check = () => {
      if (
        !this.started ||
        generation !== this.generation ||
        !this.options.canRun()
      )
        throw Error("本文の自動確認を停止しました。");
    };
    try {
      await navigator.locks.request(
        "quilna.article.updates",
        { ifAvailable: true },
        async (lock) => {
          if (!lock) return;
          check();
          const db = this.options.db();
          if (!db || Date.now() < this.blockedUntil) return;
          const last = Number(localStorage.getItem(lastAttemptKey)),
            now = Date.now();
          if (last > now - 30_000 && last <= now + 30_000) return;
          const candidates = this.options.articles();
          let first: FeedArticle | undefined,
            due = Infinity;
          for (const a of candidates) {
            const next = nextArticleUpdate(a);
            if (next <= now && next < due) {
              first = a;
              due = next;
            }
          }
          if (!first) return;
          localStorage.setItem(lastAttemptKey, String(now));
          const ids = await checkArticleUpdates(
            db,
            candidates.filter((a) => a.url === first!.url),
            this.options.acquisition,
            check,
          );
          if (ids.length) await this.options.changed(ids);
        },
      );
    } catch (error) {
      if (
        this.started &&
        generation === this.generation &&
        this.options.canRun()
      ) {
        this.blockedUntil = Date.now() + 5 * 60_000;
        this.options.failed(error);
      }
    } finally {
      this.running = false;
      if (this.started && this.options.canRun())
        this.timer = setTimeout(() => this.wake(), 30_000);
    }
  }
}
