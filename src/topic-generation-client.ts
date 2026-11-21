import { z } from "zod";
import {
  topicCreationPayloads,
  topicCreationReplySchema,
  topicCreationListSchema,
  topicCreationRemovedSchema,
  type TopicCreationAction,
  type TopicCreationInput,
  type TopicCreationReply,
} from "./topic-creation-protocol";
import {
  topicPreparationInputSchema,
  topicPreparationPageSchema,
} from "./topic-preparation-protocol";
import { sharedTextbookDigest } from "./shared-textbook-format";
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
  parseTextbookRequest,
  parseSharedTextbook,
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
  "topic-preparation-unconfigured",
  "topic-preparation-unavailable",
  "topic-preparation-topic",
  "topic-creations-unconfigured",
  "topic-creation-owner",
  "topic-author-forbidden",
  "topic-creation-conflict",
  "topic-creation-capacity",
  "topic-creation-active",
  "topic-creation-missing",
  "topic-creation-cursor",
  "topic-creation-unavailable",
  "topic-creation-invalid",
  "topic-materials-invalid",
  "topic-materials-request",
  "topic-materials-unconfigured",
  "topic-materials-unavailable",
  "document-unavailable",
  "document-unconfigured",
  "topic-job-retry-unavailable",
  "topic-job-capacity",
  "topic-job-conflict",
  "quote-changed",
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
            [
              "account-mismatch",
              "owner-mismatch",
              "topic-job-owner",
              "topic-creation-owner",
            ].includes(code.data))
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
    const raw = await this.request("status", signal);
    const bound = z
      .object({ account: z.string().regex(/^[a-f0-9]{64}$/) })
      .safeParse(raw);
    if (bound.success && bound.data.account !== this.account) {
      this.identityLost();
      throw new TopicClientError("account-mismatch");
    }
    const parsed = topicCapabilitiesSchema.safeParse(raw);
    this.check(signal);
    if (!parsed.success) throw new TopicClientError("invalid-response");
    this.csrf = parsed.data.csrfToken;
    this.mode = parsed.data.mode;
    return parsed.data;
  }
  /** 保存済みの公開資料をテーマから準備し、応答の所有者と原文を検査する。 */
  async prepare(input: { topic: string; after?: string }, signal: AbortSignal) {
    const command = topicPreparationInputSchema.safeParse(input);
    if (!command.success) throw new TopicClientError("invalid-request");
    await this.status(signal);
    const value = await this.request("preparations", signal, command.data);
    this.check(signal);
    const bound = z
      .object({ account: z.string().regex(/^[a-f0-9]{64}$/) })
      .safeParse(value);
    if (!bound.success) throw new TopicClientError("invalid-response");
    if (bound.data.account !== this.account) {
      this.csrf = "";
      this.identityLost();
      throw new TopicClientError("account-mismatch");
    }
    const parsed = topicPreparationPageSchema.safeParse(value);
    if (!parsed.success) throw new TopicClientError("invalid-response");
    if (
      parsed.data.topic !== command.data.topic ||
      (command.data.after && parsed.data.after === command.data.after)
    )
      throw new TopicClientError("invalid-response");
    for (const candidate of parsed.data.sources) {
      const digest = await sharedTextbookDigest(
        new TextEncoder().encode(candidate.source.excerpt),
      );
      this.check(signal);
      if (
        digest !== candidate.source.sourceFingerprint ||
        candidate.source.id !== candidate.versionId
      )
        throw new TopicClientError("invalid-response");
    }
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
  /** 作成APIは候補本文を返さず、完成版だけを再検査して取り込みへ渡す。 */
  async creations<A extends TopicCreationAction>(
    action: A,
    input: TopicCreationInput<A>,
    signal: AbortSignal,
  ): Promise<TopicCreationReply<A>> {
    const command = topicCreationPayloads[action].safeParse(input);
    if (!command.success) throw new TopicClientError("invalid-request");
    let expectedId = "id" in command.data ? command.data.id : undefined;
    if (action === "save" && "requestRaw" in command.data) {
      try {
        const request = await parseTextbookRequest(command.data.requestRaw);
        if (request.schemaVersion !== 2) throw Error();
        expectedId = request.id.toLowerCase();
      } catch {
        throw new TopicClientError("invalid-request");
      }
    }
    const capabilities = await this.status(signal);
    if (
      !capabilities.creations?.available ||
      (["approve", "retry", "review-again", "resume"].includes(action) &&
        !capabilities.creations.enabled)
    )
      throw new TopicClientError("topic-creations-unconfigured");
    const raw = await this.request(
      `creations/${action}`,
      signal,
      command.data,
      1048576,
    );
    this.check(signal);
    const bound = z
      .object({ account: z.string().regex(/^[a-f0-9]{64}$/) })
      .safeParse(raw);
    if (!bound.success) throw new TopicClientError("invalid-response");
    if (bound.data.account !== this.account) {
      this.csrf = "";
      this.identityLost();
      throw new TopicClientError("account-mismatch");
    }
    const parsed = (
      action === "list"
        ? topicCreationListSchema
        : action === "remove"
          ? topicCreationRemovedSchema
          : topicCreationReplySchema
    ).safeParse(raw);
    if (!parsed.success) throw new TopicClientError("invalid-response");
    const after = "after" in command.data ? command.data.after : undefined;
    if (
      "creations" in parsed.data &&
      after &&
      parsed.data.creations.some((r) => r.id === after)
    )
      throw new TopicClientError("invalid-response");
    if ("creation" in parsed.data && parsed.data.creation) {
      const c = parsed.data.creation;
      try {
        if (c.id !== expectedId) throw Error();
        if (
          action === "approve" &&
          "generation" in command.data &&
          "review" in command.data &&
          (!c.quotes ||
            JSON.stringify(c.quotes.generation) !==
              JSON.stringify(command.data.generation) ||
            JSON.stringify(c.quotes.review) !==
              JSON.stringify(command.data.review))
        )
          throw Error();
        if (
          ["retry", "review-again"].includes(action) &&
          "quote" in command.data &&
          (!c.quotes ||
            JSON.stringify(
              c.quotes[
                topicQuoteSchema.parse(command.data.quote).purpose ===
                "book-addition"
                  ? "generation"
                  : "review"
              ],
            ) !== JSON.stringify(command.data.quote))
        )
          throw Error();
        if (
          action === "review-again" &&
          "reviewRequestId" in command.data &&
          c.reviewRequestId !== command.data.reviewRequestId
        )
          throw Error();
        const request = await parseTextbookRequest(c.requestRaw);
        const revision = await sharedTextbookDigest(
          new TextEncoder().encode(JSON.stringify(c.requestRaw)),
        );
        if (
          request.schemaVersion !== 2 ||
          request.id.toLowerCase() !== c.id ||
          request.topic.name !== c.title ||
          request.learningGoal !== c.learningGoal ||
          revision !== c.revision ||
          ("expectedRevision" in command.data &&
            command.data.expectedRevision !== revision) ||
          ("requestRaw" in command.data &&
            command.data.requestRaw !== c.requestRaw)
        )
          throw Error();
        if (
          c.operation &&
          c.operation.id !==
            (c.stage === "generation" ? c.id : c.reviewRequestId)
        )
          throw Error();
        if (c.book) {
          const book = await parseSharedTextbook(c.book);
          const retained = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(
            Uint8Array.from(atob(book.record.request), (c) => c.charCodeAt(0)),
          );
          if (
            book.id !== `${c.bookID}:1` ||
            retained !== c.requestRaw ||
            !c.quotes ||
            book.record.generator.provider !== c.quotes.generation.provider ||
            book.record.generator.model !== c.quotes.generation.model ||
            book.record.reviewer.provider !== c.quotes.review.provider ||
            book.record.reviewer.model !== c.quotes.review.model
          )
            throw Error();
        }
      } catch {
        throw new TopicClientError("invalid-response");
      }
    } else if (
      ["save", "approve", "retry", "review-again", "resume"].includes(action)
    )
      throw new TopicClientError("invalid-response");
    this.check(signal);
    return parsed.data as TopicCreationReply<A>;
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
