import { acquireDocument } from "./source-document-store";
import { retainRemoteDocument } from "./remote-document-store";
import { sourceURL } from "./feed-discovery";
import {
  validSourceDocument,
  validDocumentVersion,
  versionContent,
  documentUUID,
} from "./source-document";

export const documentPreferenceKey = "quilna.document-acquisition.v1";
export type DocumentPreference =
  { mode: "browser" } | { mode: "private" | "shared"; account: string };
const accountHash = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function readDocumentPreference(): DocumentPreference {
  try {
    const raw = localStorage.getItem(documentPreferenceKey);
    if (raw === null) return { mode: "browser" };
    const p = JSON.parse(raw);
    if (p?.mode === "browser") return { mode: "browser" };
    if (
      (p?.mode === "private" || p?.mode === "shared") &&
      accountHash(p.account)
    )
      return { mode: p.mode, account: p.account };
  } catch {
    /* Invalid or unavailable preferences must not enable another audience. */
  }
  throw Error(
    "本文の取得先設定を読み込めません。設定で取得先を選び直してください。",
  );
}
const unchanged =
  "本文の取得先が変更されたため、取り込みを中止しました。再試行してください。";
const unavailable =
  "クラウドの本文取得は、この環境ではまだ利用できません。保存済みの本文は引き続き読めます。";
const accountChanged =
  "ログイン中のアカウントが取得先の設定と異なります。設定で接続を確認して選び直してください。";
const badResponse =
  "クラウドから取得した本文を確認できません。保存済みの本文は保持しています。";

export class DocumentAcquisition {
  private controller = new AbortController();
  private readonly changed = () => {
    this.controller.abort(Error(unchanged));
    this.controller = new AbortController();
  };
  constructor(
    private readonly send: typeof fetch = (input, init) => fetch(input, init),
  ) {
    window.addEventListener("storage", (e) => {
      if (e.key === null || e.key === documentPreferenceKey) this.changed();
    });
    window.addEventListener("pagehide", this.changed);
  }
  save(preference: DocumentPreference) {
    localStorage.setItem(documentPreferenceKey, JSON.stringify(preference));
    this.changed();
  }
  snapshot() {
    const preference = readDocumentPreference(),
      signal = this.controller.signal;
    const check = () => {
      signal.throwIfAborted();
      if (
        JSON.stringify(readDocumentPreference()) !== JSON.stringify(preference)
      )
        throw Error(unchanged);
    };
    return { preference, signal, check };
  }
  private async request(
    path: string,
    signal: AbortSignal,
    options: { account?: string; csrf?: string; body?: unknown } = {},
  ) {
    const timeout = new AbortController(),
      timer = setTimeout(() => timeout.abort(), 16000);
    const combined = AbortSignal.any([signal, timeout.signal]);
    try {
      const response = await this.send(path, {
        method: options.body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: combined,
        headers: {
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...(options.account ? { "X-Document-Account": options.account } : {}),
          ...(options.csrf ? { "X-CSRF-Token": options.csrf } : {}),
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      if (response.status === 401)
        throw Error(
          "クラウドの本文取得にはログインが必要です。保存済みの本文は引き続き読めます。",
        );
      if (response.status === 403)
        throw Error(
          "本文の取得権限を確認できません。ログインと取得先の設定を確認してください。",
        );
      if (response.status === 404)
        throw Error(
          "この本文はクラウドで利用できないか、共有対象として許可されていません。別の取得先へは自動で切り替えません。",
        );
      if (response.status === 429)
        throw Error(
          "本文の取得回数が上限に達しました。少し待ってから再試行してください。",
        );
      if (
        !response.headers.get("Content-Type")?.includes("application/json") ||
        !response.body
      )
        throw Error(badResponse);
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          combined.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 4_100_000) throw Error(badResponse);
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (value?.status === "document-unconfigured") throw Error(unavailable);
      if (!response.ok)
        throw Error(
          response.status === 409
            ? "本文の保存上限または保存状態を確認する必要があります。以前の本文は保持しています。"
            : "クラウドで本文を取得できませんでした。以前の本文は保持しています。時間を置いて再試行してください。",
        );
      if (options.account && value?.account !== options.account)
        throw Error(accountChanged);
      combined.throwIfAborted();
      return value;
    } catch (error) {
      if (signal.aborted) throw Error(unchanged);
      if (timeout.signal.aborted)
        throw Error(
          "クラウドの応答が時間内に届きませんでした。保存済みの本文は保持しています。",
        );
      if (error instanceof TypeError)
        throw Error(
          "クラウドに接続できません。保存済みの本文は引き続き読めます。",
        );
      if (error instanceof SyntaxError) throw Error(badResponse);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async status(signal = this.controller.signal) {
    const value = await this.request("/api/documents/status", signal);
    if (!accountHash(value?.account) || typeof value?.enabled !== "boolean")
      throw Error(unavailable);
    return {
      account: value.account as string,
      enabled: value.enabled as boolean,
    };
  }
  async acquire(url: string, force: boolean, snapshot = this.snapshot()) {
    const { preference, signal, check } = snapshot;
    check();
    if (preference.mode === "browser") return acquireDocument(url, { force });
    const status = await this.status(signal);
    check();
    if (!status.enabled) throw Error(unavailable);
    if (status.account !== preference.account) throw Error(accountChanged);
    const session = await this.request("/api/session", signal);
    if (
      typeof session?.csrfToken !== "string" ||
      session.csrfToken.length < 20 ||
      session.csrfToken.length > 100
    )
      throw Error("ログインの状態を確認してから再試行してください。");
    check();
    const normalized = sourceURL(url);
    const result = await this.request("/api/documents/acquire", signal, {
      account: preference.account,
      csrf: session.csrfToken,
      body: { url: normalized, audience: preference.mode, force },
    });
    check();
    if (result?.status === "pending")
      throw Error(
        "この本文は取得中です。しばらく待ってから「元サイトの更新を確認」または「本文の取得を再試行」で再試行してください。",
      );
    const d = result?.document,
      v = result?.version;
    const shared = typeof d?.scope === "string" ? d.scope.split(":") : [];
    if (
      result?.status !== "ready" ||
      typeof result.reused !== "boolean" ||
      !validSourceDocument(d) ||
      !validDocumentVersion(v) ||
      d.sourceURL !== normalized ||
      (preference.mode === "private"
        ? d.scope !== `private:${preference.account}`
        : shared.length !== 3 ||
          shared[0] !== "shared" ||
          !documentUUID(shared[1]) ||
          !/^[1-9]\d*$/.test(shared[2]))
    )
      throw Error(badResponse);
    // The server reauthorizes delivery. Recheck the current session before retaining a local copy.
    const latest = await this.status(signal);
    check();
    if (!latest.enabled || latest.account !== preference.account)
      throw Error(accountChanged);
    const retained = await retainRemoteDocument(d, v, signal);
    check();
    return {
      content: versionContent(retained.version),
      reused: result.reused,
      warning: undefined,
    };
  }
}
