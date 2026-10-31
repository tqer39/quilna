import { z } from "zod";
import { parseFeed } from "./feed-parser";
import { mergeFeed } from "./feed-store";

const timestamp = z.number().int().nonnegative();
const snapshotMeta = z.object({
  id: z.string().uuid(),
  feedUrl: z.string().url().max(2048),
  url: z.string().url().max(2048),
  fetchedAt: timestamp,
  parts: z.number().int().min(0).max(125),
  size: timestamp.max(8_000_000),
});
const stateSchema = z.object({
  available: z.boolean(),
  account: z.string().min(20).max(100),
  revision: timestamp,
  interval: z.union([
    z.literal(0),
    z.literal(15),
    z.literal(30),
    z.literal(60),
  ]),
  hosts: z.array(z.string().max(253)).max(50),
  sourcePolicy: z
    .enum(["listed-hosts", "public-https"])
    .default("listed-hosts"),
  feeds: z
    .array(
      z.object({
        url: z.string().url().max(2048),
        nextAt: timestamp,
        lastSuccess: timestamp.nullable(),
        failures: timestamp.max(8),
        error: z.string().max(100),
      }),
    )
    .max(50),
  pending: z.array(snapshotMeta).max(100),
  bytes: timestamp.max(20_000_000),
  blocked: z.boolean(),
});
export type CloudCollectionState = z.infer<typeof stateSchema>;
class CloudRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export class CloudConnectionError extends Error {}
const connectionFailure =
  "クラウドに接続できません。取得済みの記事は保持しています。";
const errors: Record<string, string> = {
  "collection-conflict":
    "別の画面で設定が変わりました。クラウドの状態を確認してから再試行してください。",
  "collection-account-changed":
    "ログイン中のアカウントが変わりました。画面を再読み込みしてください。",
  "collection-unconfigured": "クラウド収集はまだ有効になっていません。",
  "feed-host-unsupported":
    "このURLはクラウドから取得できません。公開HTTPSのサイト・RSSを指定してください。内部アドレスやQuilna自身のURLは利用できません。",
  "collection-capacity":
    "クラウドの保存上限に達しました。取得済みの記事を取り込んでください。",
  "csrf-invalid": "ログインの状態を確認してから再試行してください。",
};
export class CloudCollectionClient {
  private failureAccount = "";
  private rejected = new Map<string, string>();
  constructor(
    private send: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  failures(state: CloudCollectionState) {
    if (state.account !== this.failureAccount) {
      this.rejected.clear();
      this.failureAccount = state.account;
    }
    const pending = new Set(state.pending.map((item) => item.id));
    for (const id of this.rejected.keys()) {
      if (!pending.has(id)) this.rejected.delete(id);
    }
    return state.pending.flatMap((item) => {
      const reason = this.rejected.get(item.id);
      return reason ? [{ ...item, reason }] : [];
    });
  }
  retryFailures() {
    this.rejected.clear();
  }
  private async request(
    path: string,
    options: {
      account?: string;
      body?: unknown;
      method?: string;
      csrf?: string;
    } = {},
  ) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 16000);
    try {
      const response = await this.send(path, {
        method: options.method ?? "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: {
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.account
            ? { "X-Collection-Account": options.account }
            : {}),
          ...(options.csrf ? { "X-CSRF-Token": options.csrf } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      if (response.status === 401)
        throw Error("クラウド収集にはログインが必要です。");
      if (response.status === 404)
        throw Error(
          "この環境ではクラウド収集を利用できません。現在は画面表示中の更新のみです。",
        );
      if ([408, 429].includes(response.status) || response.status >= 500) {
        // Configuration/auth failures require user action, even with a 503 status.
        const value = await response.json().catch(() => null);
        if (
          value?.status === "auth-unconfigured" ||
          value?.status === "collection-unconfigured"
        )
          throw Error(errors["collection-unconfigured"]);
        throw new CloudConnectionError(connectionFailure);
      }
      if (!response.headers.get("Content-Type")?.includes("application/json"))
        throw Error("クラウド収集サーバーに接続できません。");
      const value = await response.json();
      if (!response.ok)
        throw new CloudRequestError(
          value?.status ?? "unknown",
          errors[value?.status] ??
            "クラウド収集の処理に失敗しました。保存済みの記事は保持しています。",
        );
      if (options.account && value.account && value.account !== options.account)
        throw Error(errors["collection-account-changed"]);
      return value;
    } catch (error) {
      if (controller.signal.aborted)
        throw new CloudConnectionError(
          "クラウドの応答が時間内に届きませんでした。取得済みの記事は保持しています。",
        );
      if (error instanceof TypeError)
        throw new CloudConnectionError(connectionFailure);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async status() {
    return stateSchema.parse(await this.request("/api/collection"));
  }
  private async csrf() {
    const result = z
      .object({ csrfToken: z.string().min(20).max(100) })
      .parse(await this.request("/api/session"));
    return result.csrfToken;
  }
  async configure(
    state: CloudCollectionState,
    urls: string[],
    interval: 0 | 15 | 30 | 60,
  ) {
    const csrf = await this.csrf();
    return stateSchema.parse(
      await this.request("/api/collection", {
        method: "PUT",
        account: state.account,
        csrf,
        body: { expectedRevision: state.revision, urls, interval },
      }),
    );
  }
  async importPending(db: IDBDatabase, state: CloudCollectionState) {
    this.failures(state);
    const pending = state.pending
      .filter((item) => !this.rejected.has(item.id))
      .slice(0, 5);
    if (!pending.length) return 0;
    // At most five documents per pass; failed saves/ACKs leave the server copy.
    const csrf = await this.csrf();
    let count = 0;
    const ids: string[] = [];
    for (const meta of pending) {
      let response;
      try {
        response = await this.request(`/api/collection/snapshots/${meta.id}`, {
          account: state.account,
        });
      } catch (error) {
        // Another tab can acknowledge/delete a snapshot after our status read.
        if (
          error instanceof CloudRequestError &&
          error.code === "snapshot-missing"
        )
          continue;
        if (
          error instanceof CloudRequestError &&
          error.code === "snapshot-invalid"
        ) {
          this.rejected.set(
            meta.id,
            "保存された取得結果が破損しているため読み取れませんでした。",
          );
          continue;
        }
        throw error;
      }
      const result = snapshotMeta
        .extend({
          account: z.literal(state.account),
          xml: z.string().max(2_000_000),
        })
        .parse(response);
      if (result.id !== meta.id || result.feedUrl !== meta.feedUrl)
        throw Error("取得結果の配信元を確認できませんでした。");
      let parsed;
      try {
        parsed = parseFeed(result.xml, result.feedUrl, result.url);
      } catch (error) {
        this.rejected.set(
          meta.id,
          error instanceof Error
            ? error.message
            : "RSSを読み取れませんでした。",
        );
        continue;
      }
      const fetchedAt = new Date(result.fetchedAt).toISOString();
      parsed.feed.fetchedAt = fetchedAt;
      parsed.articles.forEach((article) => {
        article.fetchedAt = fetchedAt;
      });
      await mergeFeed(db, parsed.feed, parsed.articles);
      ids.push(meta.id);
      count++;
    }
    if (ids.length)
      await this.request("/api/collection/ack", {
        method: "POST",
        account: state.account,
        csrf,
        body: { ids },
      });
    return count;
  }
  async discard(state: CloudCollectionState, id: string) {
    if (!this.failures(state).some((item) => item.id === id))
      throw Error(
        "削除対象の取得結果を確認できませんでした。状態を確認してください。",
      );
    const csrf = await this.csrf();
    const next = stateSchema.parse(
      await this.request("/api/collection/discard", {
        method: "POST",
        account: state.account,
        csrf,
        body: { ids: [id] },
      }),
    );
    this.failures(next);
    return next;
  }
}
