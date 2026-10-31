import { documentUUID } from "./source-document";
import { sourceURL } from "./feed-discovery";

export type PolicyAlias = {
  url: string;
  enabled: boolean;
  expires: number;
  evidence: string;
  policyRevision: number;
};
export type PolicyMetadata = {
  id: string;
  url: string;
  enabled: boolean;
  expires: number;
  evidence: string;
  policyRevision: number;
  managementRevision: number;
  updated: number;
};
export type DocumentPolicy = PolicyMetadata & {
  members: string[];
  aliases: PolicyAlias[];
};
export type PolicyHistoryEntry = {
  revision: number;
  actor: string | null;
  recorded: number;
  kind: "baseline" | "create" | "update";
};
export type PolicyInput = Pick<
  DocumentPolicy,
  "url" | "enabled" | "expires" | "evidence" | "members" | "aliases"
>;
export class PolicyError extends Error {
  constructor(
    message: string,
    readonly locked = false,
  ) {
    super(message);
  }
}
const invalid = () =>
  new PolicyError("共有設定の応答を確認できません。編集内容は保持しています。");
const changed = () =>
  new PolicyError(
    "管理者のログインを確認できません。同じアカウントで接続し直してください。",
    true,
  );
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export const policyAccount = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isSafeInteger(v) &&
  v > 0 &&
  v < Number.MAX_SAFE_INTEGER;
const evidence = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length >= 5 && v.length <= 2000;
const url = (v: unknown): v is string => {
  try {
    return (
      typeof v === "string" &&
      v.length <= 2048 &&
      v.startsWith("https://") &&
      sourceURL(v) === v
    );
  } catch {
    return false;
  }
};
function metadata(v: unknown): v is PolicyMetadata {
  return (
    object(v) &&
    documentUUID(v.id) &&
    url(v.url) &&
    typeof v.enabled === "boolean" &&
    integer(v.expires) &&
    evidence(v.evidence) &&
    integer(v.policyRevision) &&
    integer(v.managementRevision) &&
    Number.isSafeInteger(v.updated) &&
    (v.updated as number) >= 0
  );
}
function policy(v: unknown): v is DocumentPolicy {
  if (!metadata(v)) return false;
  const p = v as DocumentPolicy;
  return (
    Array.isArray(p.members) &&
    p.members.length <= 100 &&
    p.members.every(policyAccount) &&
    new Set(p.members).size === p.members.length &&
    Array.isArray(p.aliases) &&
    p.aliases.length <= 50 &&
    p.aliases.every(
      (a) =>
        object(a) &&
        url(a.url) &&
        typeof a.enabled === "boolean" &&
        integer(a.expires) &&
        evidence(a.evidence) &&
        integer(a.policyRevision),
    ) &&
    new Set(p.aliases.map((a) => a.url)).size === p.aliases.length
  );
}
/** Validate history metadata, requiring an unknown actor only for legacy baselines. */
function historyEntry(v: unknown): v is PolicyHistoryEntry {
  return (
    object(v) &&
    integer(v.revision) &&
    integer(v.recorded) &&
    (v.kind === "baseline"
      ? v.actor === null
      : (v.kind === "create" || v.kind === "update") && policyAccount(v.actor))
  );
}
// Validate the explicit draft, never infer permission from a reachable URL.
export function validatePolicyInput(input: PolicyInput, revision: number) {
  if (
    !url(input.url) ||
    !evidence(input.evidence) ||
    !integer(input.expires) ||
    input.expires > 8.64e15 ||
    input.members.length > 100 ||
    !input.members.every(policyAccount) ||
    new Set(input.members).size !== input.members.length ||
    input.aliases.length > 50
  )
    throw new PolicyError(
      "URL・期限・共有の根拠・利用者IDを確認してください。根拠は5〜2,000文字、利用者は100人までです。",
    );
  if (
    new Set(input.aliases.map((a) => a.url)).size !== input.aliases.length ||
    input.aliases.some(
      (a) =>
        !url(a.url) ||
        a.url === input.url ||
        !evidence(a.evidence) ||
        !integer(a.expires) ||
        a.expires > 8.64e15 ||
        !integer(a.policyRevision) ||
        (a.enabled && a.policyRevision !== revision),
    )
  )
    throw new PolicyError(
      "別名URL・期限・根拠を確認し、有効な別名が同じ記事を指すことを確認してください。同じURLは重複登録できません。",
    );
  if (
    input.enabled &&
    (input.expires <= Date.now() ||
      input.aliases.some(
        (a) =>
          a.enabled && (a.expires <= Date.now() || a.expires > input.expires),
      ))
  )
    throw new PolicyError(
      "有効な共有と別名には未来の期限が必要です。別名の期限は共有本文の期限以内にしてください。",
    );
  if (new TextEncoder().encode(JSON.stringify(input)).length > 250000)
    throw new PolicyError(
      "入力が大きすぎます。根拠や別名の数を減らしてください。",
    );
}

export class DocumentPolicyClient {
  account: string | null = null;
  constructor(private readonly send: typeof fetch = (i, o) => fetch(i, o)) {}
  private async request(
    path: string,
    signal: AbortSignal,
    body?: unknown,
    csrf?: string,
  ) {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 16000);
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      const response = await this.send(path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: combined,
        headers: {
          ...(this.account ? { "X-Document-Account": this.account } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if ([401, 403].includes(response.status)) throw changed();
      if (response.status === 404)
        throw new PolicyError(
          "この共有設定を利用できません。権限と登録状況を確認してください。",
        );
      if (response.status === 409)
        throw new PolicyError(
          "別の編集が保存されたか、URLの重複・保存上限があります。最新の設定を確認してから編集し直してください。",
        );
      if (response.status === 429)
        throw new PolicyError(
          "操作が続いています。少し待ってから確認してください。",
        );
      if (!response.ok)
        throw new PolicyError(
          "共有設定の操作を確認できません。保存中だった場合は結果を読み直してください。",
        );
      if (
        !response.body ||
        !response.headers.get("Content-Type")?.includes("application/json")
      )
        throw invalid();
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          combined.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 1_000_000) throw invalid();
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of chunks) {
        bytes.set(part, offset);
        offset += part.length;
      }
      const result: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      combined.throwIfAborted();
      if (!object(result)) throw invalid();
      if (
        path !== "/api/session" &&
        this.account &&
        result.account !== this.account
      )
        throw changed();
      return result;
    } catch (error) {
      if (error instanceof PolicyError) throw error;
      throw new PolicyError(
        "接続を確認できません。編集内容は保持しています。保存中だった場合は結果を読み直してください。",
      );
    } finally {
      clearTimeout(timer);
    }
  }
  async connect(signal: AbortSignal) {
    const result = await this.request("/api/documents/admin-status", signal);
    if (!policyAccount(result.account) || typeof result.enabled !== "boolean")
      throw invalid();
    if (!result.enabled)
      throw new PolicyError(
        "このアカウントでは共有本文の管理を利用できません。",
        true,
      );
    this.account = result.account;
    return this.account;
  }
  private async command(action: string, body: unknown, signal: AbortSignal) {
    if (!this.account) throw changed();
    await this.connect(signal);
    const session = await this.request("/api/session", signal);
    if (
      typeof session.csrfToken !== "string" ||
      session.csrfToken.length < 20 ||
      session.csrfToken.length > 100
    )
      throw changed();
    // Session lookup can itself outlive a login change. Check before mutation too.
    await this.connect(signal);
    const result = await this.request(
      "/api/documents/admin-" + action,
      signal,
      body,
      session.csrfToken,
    );
    await this.connect(signal);
    return result;
  }
  async list(after: string | null, signal: AbortSignal) {
    const result = await this.command("list", after ? { after } : {}, signal);
    if (
      !Array.isArray(result.policies) ||
      result.policies.length > 20 ||
      !result.policies.every(metadata) ||
      new Set(result.policies.map((p) => p.id)).size !==
        result.policies.length ||
      !(result.after === null || documentUUID(result.after)) ||
      (result.after !== null && result.after !== result.policies.at(-1)?.id)
    )
      throw invalid();
    return {
      policies: result.policies as PolicyMetadata[],
      after: result.after as string | null,
    };
  }
  async read(id: string, signal: AbortSignal) {
    const result = await this.command("read", { id }, signal);
    if (!policy(result.policy) || result.policy.id !== id) throw invalid();
    return result.policy;
  }
  /**
   * Read at most 20 history entries for a policy, newest first.
   * A null cursor starts at the newest entry; otherwise revisions precede it.
   * Reject mismatched identities, invalid metadata, ordering or pagination.
   */
  async history(id: string, before: number | null, signal: AbortSignal) {
    const result = await this.command(
      "history",
      { id, ...(before ? { before } : {}) },
      signal,
    );
    if (
      result.id !== id ||
      !Array.isArray(result.entries) ||
      result.entries.length > 20 ||
      !result.entries.every(historyEntry) ||
      !result.entries.every(
        (e, i, rows) =>
          e.revision <
          (i ? rows[i - 1].revision : (before ?? Number.MAX_SAFE_INTEGER)),
      ) ||
      !(
        result.before === null ||
        (result.entries.length === 20 &&
          result.before === result.entries.at(-1)?.revision)
      )
    )
      throw invalid();
    return {
      entries: result.entries as PolicyHistoryEntry[],
      before: result.before as number | null,
    };
  }
  /**
   * Read one immutable policy snapshot without changing the current policy.
   * Reject a response unless its policy ID and both revisions match the request.
   */
  async revision(id: string, revision: number, signal: AbortSignal) {
    const result = await this.command("revision", { id, revision }, signal);
    if (
      !historyEntry(result.entry) ||
      result.entry.revision !== revision ||
      !policy(result.policy) ||
      result.policy.id !== id ||
      result.policy.managementRevision !== revision
    )
      throw invalid();
    return { entry: result.entry, policy: result.policy };
  }
  async save(
    input: PolicyInput,
    previous: DocumentPolicy | null,
    signal: AbortSignal,
  ) {
    const { url: address, ...fields } = input;
    const revision = previous
      ? previous.policyRevision + Number(previous.evidence !== input.evidence)
      : 1;
    validatePolicyInput(input, revision);
    const result = await this.command(
      previous ? "update" : "create",
      previous
        ? {
            ...fields,
            id: previous.id,
            expectedRevision: previous.managementRevision,
          }
        : input,
      signal,
    );
    if (
      !policy(result.policy) ||
      result.policy.url !== address ||
      result.policy.policyRevision !== revision ||
      result.policy.managementRevision !==
        (previous?.managementRevision ?? 0) + 1 ||
      (previous && result.policy.id !== previous.id)
    )
      throw invalid();
    // A successful HTTP status is not sufficient to acknowledge different content.
    const p = result.policy;
    const aliases = (values: PolicyAlias[]) =>
      values
        .map((a) => [a.url, a.enabled, a.expires, a.evidence, a.policyRevision])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    if (
      p.enabled !== input.enabled ||
      p.expires !== input.expires ||
      p.evidence !== input.evidence ||
      JSON.stringify([...p.members].sort()) !==
        JSON.stringify([...input.members].sort()) ||
      JSON.stringify(aliases(p.aliases)) !==
        JSON.stringify(aliases(input.aliases))
    )
      throw invalid();
    return p;
  }
}
