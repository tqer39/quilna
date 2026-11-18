import { z } from "zod";
import {
  topicJobListSchema,
  topicJobReplySchema,
  topicJobRemovedSchema,
  topicJobReadInputSchema,
  topicJobListInputSchema,
  topicJobConfirmInputSchema,
} from "./topic-job-protocol";
import {
  parseSharedJSON,
  parseTextbookCandidate,
  parseReviewedTextbookCandidate,
} from "./shared-textbook-format";
import {
  topicCapabilitiesSchema,
  topicGenerationInputSchema,
  topicGenerationReplySchema,
  topicQuoteSchema,
  type TopicCapabilities,
  type TopicGenerationInput,
  type TopicGenerationReply,
  type TopicQuote,
} from "./topic-generation-protocol";

const errors = z.enum([
  "auth-unconfigured",
  "credentials-unconfigured",
  "unauthenticated",
  "forbidden",
  "account-mismatch",
  "owner-mismatch",
  "csrf-invalid",
  "invalid-request",
  "invalid-stage",
  "cost-unapproved",
  "json-required",
  "body-limit",
  "unissued-draft",
  "response-limit",
  "rate-limit",
  "held",
  "topic-jobs-unconfigured",
  "topic-job-owner",
  "topic-job-active",
  "topic-job-missing",
  "topic-job-cursor",
  "topic-job-unavailable",
  "topic-job-request",
  "not-found",
]);
export class TopicClientError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** 固定したライブラリーの確認を各awaitの後にも行い、別の所有者へ候補を渡さない。 */
export class TopicGenerationClient {
  private csrf = "";
  private mode: "unconnected" | "test-only" = "unconnected";
  constructor(
    readonly account: string,
    private readonly currentAccount: () => string | null,
    private readonly identityLost: () => void,
    private readonly send: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  private check(signal: AbortSignal) {
    if (signal.aborted) throw new TopicClientError("cancelled");
    try {
      if (this.currentAccount() !== this.account) throw Error();
    } catch {
      this.csrf = "";
      this.identityLost();
      throw new TopicClientError("account-mismatch");
    }
  }
  private async request(
    path: string,
    signal: AbortSignal,
    input?: unknown,
    responseLimit = 262144,
  ) {
    this.check(signal);
    const timeout = new AbortController(),
      timer = setTimeout(() => timeout.abort(), 30000);
    const combined = AbortSignal.any([signal, timeout.signal]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let response: Response | undefined;
    try {
      response = await this.send(`/api/topic-textbooks/${path}`, {
        method: input ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: combined,
        headers: {
          "X-Library-Account": this.account,
          ...(input
            ? { "Content-Type": "application/json", "X-CSRF-Token": this.csrf }
            : {}),
        },
        body: input ? JSON.stringify(input) : undefined,
      });
      this.check(combined);
      if (
        !response.headers.get("Content-Type")?.includes("application/json") ||
        !response.body
      )
        throw new TopicClientError("invalid-response");
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let raw = "",
        size = 0;
      for (;;) {
        const chunk = await reader.read();
        this.check(combined);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > responseLimit)
          throw new TopicClientError("invalid-response");
        raw += decoder.decode(chunk.value, { stream: true });
      }
      raw += decoder.decode();
      const value = parseSharedJSON(raw);
      if (!response.ok) {
        const code = errors.safeParse(
          value && typeof value === "object" && "status" in value
            ? value.status
            : undefined,
        );
        if (
          response.status === 401 ||
          (response.status === 403 &&
            code.success &&
            ["account-mismatch", "owner-mismatch", "topic-job-owner"].includes(
              code.data,
            ))
        ) {
          this.csrf = "";
          this.identityLost();
        }
        if (code.success && code.data === "csrf-invalid") this.csrf = "";
        throw new TopicClientError(code.success ? code.data : "held");
      }
      return value;
    } catch (error) {
      if (error instanceof TopicClientError) {
        if (
          error.code === "cancelled" &&
          !signal.aborted &&
          timeout.signal.aborted
        )
          throw new TopicClientError("held");
        throw error;
      }
      if (combined.aborted)
        throw new TopicClientError(signal.aborted ? "cancelled" : "held");
      throw new TopicClientError("held");
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      if (!reader) await response?.body?.cancel().catch(() => {});
    }
  }
  async status(signal: AbortSignal): Promise<TopicCapabilities> {
    this.csrf = "";
    this.mode = "unconnected";
    const parsed = topicCapabilitiesSchema.safeParse(
      await this.request("status", signal),
    );
    this.check(signal);
    if (!parsed.success) throw new TopicClientError("invalid-response");
    if (parsed.data.account !== this.account) {
      this.identityLost();
      throw new TopicClientError("account-mismatch");
    }
    this.csrf = parsed.data.csrfToken;
    this.mode = parsed.data.mode;
    return parsed.data;
  }
  /** 結果の回収は生成と分離し、通信失敗時も予約・再送を行わない。 */
  async jobs(
    action: "list",
    input: { after?: string },
    signal: AbortSignal,
  ): Promise<z.infer<typeof topicJobListSchema>>;
  async jobs(
    action: "read" | "refresh" | "cancel",
    input: { id: string; confirm?: true },
    signal: AbortSignal,
  ): Promise<z.infer<typeof topicJobReplySchema>>;
  async jobs(
    action: "remove",
    input: { id: string; confirm: true },
    signal: AbortSignal,
  ): Promise<z.infer<typeof topicJobRemovedSchema>>;
  async jobs(
    action: "list" | "read" | "refresh" | "cancel" | "remove",
    input: unknown,
    signal: AbortSignal,
  ) {
    const schema =
      action === "list"
        ? topicJobListInputSchema
        : ["cancel", "remove"].includes(action)
          ? topicJobConfirmInputSchema
          : topicJobReadInputSchema;
    const command = schema.safeParse(input);
    if (!command.success) throw new TopicClientError("invalid-request");
    await this.status(signal);
    const raw = await this.request(
      `jobs/${action}`,
      signal,
      command.data,
      270336,
    );
    this.check(signal);
    const parsed = (
      action === "list"
        ? topicJobListSchema
        : action === "remove"
          ? topicJobRemovedSchema
          : topicJobReplySchema
    ).safeParse(raw);
    if (!parsed.success) throw new TopicClientError("invalid-response");
    const after = "after" in command.data ? command.data.after : undefined;
    if (
      "jobs" in parsed.data &&
      after &&
      parsed.data.jobs.some((job) => job.id === after)
    )
      throw new TopicClientError("invalid-response");
    if (
      parsed.data.account !== this.account ||
      ("job" in parsed.data &&
        parsed.data.job?.result &&
        parsed.data.job.result.account !== this.account)
    ) {
      this.csrf = "";
      this.identityLost();
      throw new TopicClientError("account-mismatch");
    }
    if (
      "job" in parsed.data &&
      parsed.data.job &&
      "id" in command.data &&
      parsed.data.job.id !== command.data.id
    )
      throw new TopicClientError("invalid-response");
    if (
      action === "cancel" &&
      (!("job" in parsed.data) || parsed.data.job?.state !== "cancelled")
    )
      throw new TopicClientError("invalid-response");
    return parsed.data;
  }
  async operate(
    path: "proposals" | "operations",
    input: TopicGenerationInput,
    quote: TopicQuote,
    signal: AbortSignal,
  ): Promise<TopicGenerationReply> {
    const parsedInput = topicGenerationInputSchema.safeParse(input);
    if (!parsedInput.success) throw new TopicClientError("invalid-request");
    const retained = parsedInput.data;
    const parsedQuote = topicQuoteSchema.safeParse(quote);
    if (!parsedQuote.success) throw new TopicClientError("cost-unapproved");
    const approved = parsedQuote.data;
    if (
      approved.modelId !== retained.modelId ||
      approved.purpose !== retained.purpose ||
      retained.approvedMaxMilliYen !== approved.maxMilliYen ||
      retained.approvedQuoteDigest !== approved.quoteDigest
    )
      throw new TopicClientError("cost-unapproved");
    await this.status(signal);
    this.check(signal);
    if (path === "proposals" && this.mode !== "test-only")
      throw new TopicClientError("unconnected");
    const parsed = topicGenerationReplySchema.safeParse(
      await this.request(path, signal, retained),
    );
    this.check(signal);
    if (!parsed.success) throw new TopicClientError("invalid-response");
    const reply = parsed.data;
    if (reply.account !== this.account) {
      this.csrf = "";
      this.identityLost();
      throw new TopicClientError("account-mismatch");
    }
    if (reply.status === "complete") {
      try {
        if (
          reply.draft.invocation.provider !== approved.provider ||
          reply.draft.invocation.model !== approved.model
        )
          throw Error();
        if (retained.purpose === "book-addition") {
          if (reply.draft.kind !== "topic-textbook-draft") throw Error();
          const candidate = await parseTextbookCandidate(
            retained.requestRaw,
            reply.draft.json,
          );
          if (
            candidate.request.schemaVersion !== 2 ||
            candidate.request.id.toLowerCase() !== retained.requestId ||
            candidate.requestDigest !== reply.draft.requestDigest ||
            candidate.draftDigest !== reply.draft.draftDigest
          )
            throw Error();
        } else {
          if (
            reply.draft.kind !== "topic-textbook-review" ||
            !retained.draftRaw ||
            !retained.generatorInvocation ||
            reply.draft.invocation.id.toLowerCase() ===
              retained.generatorInvocation.toLowerCase()
          )
            throw Error();
          const reviewed = await parseReviewedTextbookCandidate(
            retained.requestRaw,
            retained.draftRaw,
            reply.draft.json,
          );
          if (
            reviewed.request.schemaVersion !== 2 ||
            reviewed.request.id.toLowerCase() !==
              retained.generationRequestId ||
            reviewed.requestDigest !== reply.draft.requestDigest ||
            reviewed.draftDigest !== reply.draft.draftDigest ||
            reviewed.allChecksPassed !== reply.draft.allChecksPassed
          )
            throw Error();
        }
      } catch {
        throw new TopicClientError("invalid-response");
      }
    }
    this.check(signal);
    return reply;
  }
}
