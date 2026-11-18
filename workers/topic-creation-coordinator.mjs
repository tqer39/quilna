import { z } from "zod";
import { hash } from "./crypto.mjs";
import { TopicJobQueue } from "./topic-job-queue.mjs";
import {
  parseTextbookRequest,
  parseSharedTextbook,
  parseReviewedTextbookCandidate,
} from "../src/shared-textbook-format.ts";
import {
  topicQuoteSchema,
  topicGenerationFailureStatusSchema,
  topicGenerationReplySchema,
} from "../src/topic-generation-protocol.ts";
import {
  createTopicTextbookEdition,
  validateTopicDraft,
} from "../src/topic-textbook-edition.ts";

const ownerSchema = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const quotesSchema = z
  .object({ generation: topicQuoteSchema, review: topicQuoteSchema })
  .strict()
  .refine(
    (q) =>
      q.generation.purpose === "book-addition" &&
      q.review.purpose === "evidence-check" &&
      q.generation.maxMilliYen + q.review.maxMilliYen <= 500000,
  );
const indexKey = "topic-creations:index";
const key = (id) => `topic-creations:record:${id}`;
const indexSchema = z
  .object({
    version: z.literal(1),
    owner: ownerSchema,
    ids: z
      .array(uuid)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
const recordSchema = z
  .object({
    version: z.literal(1),
    id: uuid,
    bookID: uuid,
    reviewId: uuid,
    previousReviewIds: z.array(uuid).max(20).optional(),
    requestDigest: digest,
    requestParts: z.number().int().min(1).max(12),
    state: z.enum([
      "draft",
      "generation",
      "review",
      "ready",
      "held",
      "rejected",
    ]),
    stage: z.enum(["generation", "review"]),
    createdAt: time,
    updatedAt: time,
    quotes: quotesSchema.nullable(),
    approvedPublicText: z.literal(true).nullable(),
    bookParts: z.number().int().min(0).max(40),
    bookDigest: digest.nullable(),
    reason: z.enum([
      "",
      "operation-unconfirmed",
      "stage-rejected",
      "invalid-result",
      "capacity",
    ]),
  })
  .strict()
  .refine(
    (r) =>
      r.id !== r.reviewId &&
      new Set([r.id, r.reviewId, ...(r.previousReviewIds ?? [])]).size ===
        2 + (r.previousReviewIds?.length ?? 0) &&
      r.updatedAt >= r.createdAt &&
      (r.state === "draft"
        ? r.quotes === null && r.approvedPublicText === null
        : r.quotes !== null && r.approvedPublicText === true) &&
      (r.state === "ready"
        ? r.bookParts > 0 && r.bookDigest !== null
        : r.bookParts === 0 && r.bookDigest === null) &&
      (!["generation", "review"].includes(r.state) || r.state === r.stage),
  );
const stored = (schema, raw) => {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw Error("topic-creation-invalid");
  return parsed.data;
};
const active = (r) => ["generation", "review"].includes(r.state);

/** 承認済みの二段階を永続化し、生成の再送なしで検証・不変版保存まで進める内部エンジン。 */
export class TopicCreationCoordinator {
  constructor(storage, { enabled = false, run, lookup, now = Date.now } = {}) {
    Object.assign(this, { storage, enabled, now });
    this.queue = new TopicJobQueue(storage, {
      enabled,
      run,
      lookup,
      now,
      nextWake: (tx) => this.nextWake(tx),
      // キー変更は有料処理後にも返り得るため、台帳から回収するまで保留する。
      terminalStatuses: topicGenerationFailureStatusSchema.options.filter(
        (status) =>
          ![
            "not-found",
            "credential-changed",
            "materials-unavailable",
          ].includes(status),
      ),
    });
  }
  async index(tx, owner) {
    const raw = await tx.get(indexKey);
    if (raw === undefined) return null;
    const index = stored(indexSchema, raw);
    if (index.owner !== owner) throw Error("topic-creation-owner");
    return index;
  }
  async record(tx, id) {
    const r = stored(recordSchema, await tx.get(key(id)));
    if (r.id !== id) throw Error("topic-creation-invalid");
    return r;
  }
  async request(tx, r) {
    const raw = await this.queue.readParts(
      tx,
      r.id,
      "creation-request",
      r.requestParts,
      192000,
    );
    if (typeof raw !== "string" || (await hash(raw)) !== r.requestDigest)
      throw Error("topic-creation-invalid");
    let request;
    try {
      request = await parseTextbookRequest(raw);
    } catch {
      throw Error("topic-creation-invalid");
    }
    if (request.schemaVersion !== 2 || request.id.toLowerCase() !== r.id)
      throw Error("topic-creation-invalid");
    return { raw, request };
  }
  async view(tx, r) {
    const { raw, request } = await this.request(tx, r);
    let book = null;
    if (r.state === "ready") {
      book = await this.queue.readParts(
        tx,
        r.id,
        "creation-book",
        r.bookParts,
        1080000,
      );
      if (typeof book !== "string" || (await hash(book)) !== r.bookDigest)
        throw Error("topic-creation-invalid");
      const parsed = await parseSharedTextbook(book);
      if (
        parsed.id !== `${r.bookID}:1` ||
        parsed.request.id.toLowerCase() !== r.id ||
        parsed.record.request !==
          btoa(
            Array.from(new TextEncoder().encode(raw), (n) =>
              String.fromCharCode(n),
            ).join(""),
          )
      )
        throw Error("topic-creation-invalid");
    }
    return {
      id: r.id,
      bookID: r.bookID,
      revision: r.requestDigest,
      reviewRequestId: r.reviewId,
      state: r.state,
      stage: r.stage,
      title: request.topic.name,
      learningGoal: request.learningGoal,
      requestRaw: raw,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      quotes: r.quotes,
      reason: r.reason,
      operation: await this.operation(tx, r),
      book,
    };
  }
  async operation(tx, r) {
    const index = stored(indexSchema, await tx.get(indexKey));
    const id = r.stage === "generation" ? r.id : r.reviewId;
    if (!(await this.queue.index(tx, index.owner))?.ids.includes(id))
      return null;
    const record = await this.queue.availableRecord(tx, id);
    if (!record) return { id, state: "unavailable" };
    let saved;
    try {
      saved = await this.queue.view(tx, record, index.owner);
    } catch (error) {
      if (error.message !== "topic-job-invalid") throw error;
      return { id, state: "unavailable" };
    }
    return {
      id,
      state: record.state,
      reason: record.reason,
      status: saved.result?.status ?? null,
      outcome: saved.result?.outcome ?? null,
      confirmedUnsent: record.confirmedUnsent === true,
      reviewPassed:
        saved.result?.status === "complete" &&
        saved.result.draft.kind === "topic-textbook-review"
          ? saved.result.draft.allChecksPassed
          : null,
    };
  }
  async save(owner, requestRaw) {
    ownerSchema.parse(owner);
    const request = await parseTextbookRequest(requestRaw);
    if (request.schemaVersion !== 2) throw Error("topic-creation-invalid");
    const id = uuid.parse(request.id),
      requestDigest = await hash(requestRaw);
    return this.storage.transaction(async (tx) => {
      const index = (await this.index(tx, owner)) ?? {
        version: 1,
        owner,
        ids: [],
      };
      if (index.ids.includes(id)) {
        const old = await this.record(tx, id);
        if (old.requestDigest !== requestDigest)
          throw Error("topic-creation-conflict");
        return this.view(tx, old);
      }
      if (index.ids.length >= 100) throw Error("topic-creation-capacity");
      for (const other of index.ids) {
        const record = await tx.get(key(other));
        if (record?.reviewId === id) throw Error("topic-creation-conflict");
      }
      const at = this.now();
      const record = stored(recordSchema, {
        version: 1,
        id,
        bookID: crypto.randomUUID(),
        reviewId: crypto.randomUUID(),
        requestDigest,
        requestParts: await this.queue.writeParts(
          tx,
          id,
          "creation-request",
          requestRaw,
          192000,
        ),
        state: "draft",
        stage: "generation",
        createdAt: at,
        updatedAt: at,
        quotes: null,
        approvedPublicText: null,
        bookParts: 0,
        bookDigest: null,
        reason: "",
      });
      index.ids.push(id);
      await tx.put(key(id), record);
      await tx.put(indexKey, stored(indexSchema, index));
      return this.view(tx, record);
    });
  }
  async approve(owner, id, approval, currentQuotes) {
    if (!this.enabled) throw Error("topic-creations-unconfigured");
    ownerSchema.parse(owner);
    id = uuid.parse(id);
    const { generation, review, expectedRevision } = z
      .object({
        confirm: z.literal(true),
        approvedPublicText: z.literal(true),
        expectedRevision: digest.optional(),
        generation: topicQuoteSchema,
        review: topicQuoteSchema,
      })
      .strict()
      .parse(approval);
    const quotes = quotesSchema.parse({ generation, review });
    const fingerprint = await hash(quotes);
    const current = await Promise.all(
      z.array(topicQuoteSchema).max(40).parse(currentQuotes).map(hash),
    );
    return this.storage.transaction(async (tx) => {
      const index = await this.index(tx, owner);
      if (!index?.ids.includes(id)) throw Error("topic-creation-missing");
      const r = await this.record(tx, id);
      if (
        expectedRevision !== undefined &&
        r.requestDigest !== expectedRevision
      )
        throw Error("topic-creation-conflict");
      await this.request(tx, r);
      if (r.quotes !== null) {
        if ((await hash(r.quotes)) !== fingerprint)
          throw Error("topic-creation-conflict");
        await this.queue.schedule(tx, await this.queue.index(tx, owner));
        return this.view(tx, r);
      }
      if (
        !current.includes(await hash(quotes.generation)) ||
        !current.includes(await hash(quotes.review))
      )
        throw Error("quote-changed");
      let pending = 0;
      for (const other of index.ids) {
        try {
          const record = await this.record(tx, other);
          if (active(record) || record.state === "held") pending++;
        } catch (error) {
          if (error.message !== "topic-creation-invalid") throw error;
          // 状態不明の一件も枠を使うものとして数え、正常な依頼の承認は続ける。
          pending++;
        }
      }
      if (pending >= 20) throw Error("topic-creation-capacity");
      Object.assign(r, {
        state: "generation",
        quotes,
        approvedPublicText: true,
        updatedAt: Math.max(r.updatedAt, this.now()),
      });
      await tx.put(key(id), stored(recordSchema, r));
      await this.queue.schedule(tx, await this.queue.index(tx, owner));
      return this.view(tx, r);
    });
  }
  async retry(owner, id, approval, currentQuotes) {
    if (!this.enabled) throw Error("topic-creations-unconfigured");
    ownerSchema.parse(owner);
    id = uuid.parse(id);
    const { quote, expectedRevision } = z
      .object({
        confirm: z.literal(true),
        approvedPublicText: z.literal(true),
        expectedRevision: digest,
        quote: topicQuoteSchema,
      })
      .strict()
      .parse(approval);
    const snapshot = await this.storage.transaction(async (tx) => {
      const index = await this.index(tx, owner);
      if (!index?.ids.includes(id)) throw Error("topic-creation-missing");
      const r = await this.record(tx, id);
      if (r.requestDigest !== expectedRevision)
        throw Error("topic-creation-conflict");
      if (!["held", "rejected"].includes(r.state))
        throw Error("topic-creation-active");
      return { r, ...(await this.request(tx, r)) };
    });
    const { r, raw } = snapshot,
      oldQuote = r.quotes[r.stage];
    if (
      quote.modelId !== oldQuote.modelId ||
      quote.provider !== oldQuote.provider ||
      quote.model !== oldQuote.model ||
      quote.purpose !== oldQuote.purpose
    )
      throw Error("topic-creation-conflict");
    const fingerprint = await hash(quote),
      previous = await hash(r.quotes);
    const current = await Promise.all(
      z.array(topicQuoteSchema).max(40).parse(currentQuotes).map(hash),
    );
    if (!current.includes(fingerprint)) throw Error("quote-changed");
    const quotes = quotesSchema.parse({ ...r.quotes, [r.stage]: quote });
    let draft;
    if (r.stage === "review") {
      const generated = await this.queue.read(owner, r.id);
      if (
        generated?.state !== "complete" ||
        generated.result?.status !== "complete"
      )
        throw Error("topic-creation-invalid");
      draft = await validateTopicDraft(
        raw,
        generated.result.draft,
        r.quotes.generation,
      );
    }
    const input = this.input({ ...r, quotes }, raw, draft);
    await this.queue.retry(owner, input, {
      onQueued: async (tx) => {
        const index = await this.index(tx, owner),
          latest = await this.record(tx, id);
        if (
          !index?.ids.includes(id) ||
          latest.state !== r.state ||
          latest.stage !== r.stage ||
          latest.requestDigest !== expectedRevision ||
          (await hash(latest.quotes)) !== previous
        )
          throw Error("topic-creation-conflict");
        let count = 0;
        for (const other of index.ids.filter((value) => value !== id)) {
          try {
            const record = await this.record(tx, other);
            if (active(record) || record.state === "held") count++;
          } catch (error) {
            if (error.message !== "topic-creation-invalid") throw error;
            count++;
          }
        }
        if (count >= 20) throw Error("topic-creation-capacity");
        Object.assign(latest, {
          quotes,
          state: latest.stage,
          reason: "",
          updatedAt: Math.max(latest.updatedAt, this.now()),
        });
        await tx.put(key(id), stored(recordSchema, latest));
      },
    });
    return this.read(owner, id);
  }
  async reviewAgain(owner, id, approval, currentQuotes) {
    if (!this.enabled) throw Error("topic-creations-unconfigured");
    ownerSchema.parse(owner);
    id = uuid.parse(id);
    const { expectedRevision, reviewRequestId, quote } = z
      .object({
        expectedRevision: digest,
        reviewRequestId: uuid,
        quote: topicQuoteSchema,
        confirm: z.literal(true),
        approvedPublicText: z.literal(true),
      })
      .strict()
      .parse(approval);
    const snapshot = await this.storage.transaction(async (tx) => {
      const index = await this.index(tx, owner);
      if (!index?.ids.includes(id)) throw Error("topic-creation-missing");
      const r = await this.record(tx, id);
      if (r.requestDigest !== expectedRevision)
        throw Error("topic-creation-conflict");
      return { r, ...(await this.request(tx, r)) };
    });
    const { r, raw } = snapshot;
    if (
      r.reviewId === reviewRequestId &&
      r.previousReviewIds?.length &&
      (await hash(r.quotes?.review)) === (await hash(quote))
    )
      return this.read(owner, id);
    if (r.state !== "rejected" || r.stage !== "review")
      throw Error("topic-creation-active");
    if ((r.previousReviewIds?.length ?? 0) >= 20)
      throw Error("topic-creation-capacity");
    if (
      [r.id, r.reviewId, ...(r.previousReviewIds ?? [])].includes(
        reviewRequestId,
      ) ||
      quote.purpose !== "evidence-check"
    )
      throw Error("topic-creation-conflict");
    const current = await Promise.all(
      z.array(topicQuoteSchema).max(40).parse(currentQuotes).map(hash),
    );
    if (!current.includes(await hash(quote))) throw Error("quote-changed");
    const quotes = quotesSchema.parse({ ...r.quotes, review: quote });
    const generated = await this.queue.read(owner, r.id);
    if (
      generated?.state !== "complete" ||
      generated.result?.status !== "complete"
    )
      throw Error("topic-creation-invalid");
    const draft = await validateTopicDraft(
      raw,
      generated.result.draft,
      r.quotes.generation,
    );
    const proof = topicGenerationReplySchema.parse(
      await this.queue.lookup(owner, this.input(r, raw, draft)),
    );
    if (proof.account !== owner) throw Error("topic-creation-owner");
    const priorStage = await this.queue.read(owner, r.reviewId);
    const rejectedBeforeDispatch =
      proof.status === "not-found" &&
      priorStage?.state === "rejected" &&
      this.queue.terminalStatuses.has(priorStage.result?.status);
    if (
      proof.status === "complete" &&
      proof.draft.kind === "topic-textbook-review" &&
      !proof.draft.allChecksPassed
    ) {
      const result = await parseReviewedTextbookCandidate(
        raw,
        draft.json,
        proof.draft.json,
      );
      if (
        result.allChecksPassed ||
        result.requestDigest !== proof.draft.requestDigest ||
        result.draftDigest !== proof.draft.draftDigest
      )
        throw Error("topic-creation-invalid");
    } else if (proof.status !== "rejected" && !rejectedBeforeDispatch)
      throw Error("topic-job-retry-unavailable");
    const previous = await hash(r.quotes);
    await this.queue.enqueue(
      owner,
      this.input({ ...r, reviewId: reviewRequestId, quotes }, raw, draft),
      {
        onQueued: async (tx) => {
          const latest = await this.record(tx, id);
          if (
            latest.state !== r.state ||
            latest.reviewId !== r.reviewId ||
            latest.requestDigest !== expectedRevision ||
            (await hash(latest.quotes)) !== previous
          )
            throw Error("topic-creation-conflict");
          const index = await this.index(tx, owner);
          let pending = 0;
          for (const other of index.ids.filter((value) => value !== id)) {
            try {
              const entry = await this.record(tx, other);
              if (active(entry) || entry.state === "held") pending++;
            } catch (error) {
              if (error.message !== "topic-creation-invalid") throw error;
              pending++;
            }
          }
          if (pending >= 20) throw Error("topic-creation-capacity");
          Object.assign(latest, {
            reviewId: reviewRequestId,
            previousReviewIds: [
              ...(latest.previousReviewIds ?? []),
              latest.reviewId,
            ],
            quotes,
            state: "review",
            reason: "",
            updatedAt: Math.max(latest.updatedAt, this.now()),
          });
          await tx.put(key(id), stored(recordSchema, latest));
        },
      },
    );
    const saved = await this.read(owner, id);
    if (saved.reviewRequestId !== reviewRequestId)
      throw Error("topic-creation-conflict");
    return saved;
  }
  async read(owner, id) {
    ownerSchema.parse(owner);
    id = uuid.parse(id);
    return this.storage.transaction(async (tx) => {
      const index = await this.index(tx, owner);
      return index?.ids.includes(id)
        ? this.view(tx, await this.record(tx, id))
        : null;
    });
  }
  async list(owner, after) {
    ownerSchema.parse(owner);
    if (after !== undefined) after = uuid.parse(after);
    return this.storage.transaction(async (tx) => {
      const index = await this.index(tx, owner);
      const ids = [...(index?.ids ?? [])].reverse();
      const start = after === undefined ? 0 : ids.indexOf(after) + 1;
      if (after !== undefined && start === 0)
        throw Error("topic-creation-cursor");
      const selected = ids.slice(start, start + 20),
        creations = [];
      for (const id of selected) {
        try {
          const r = await this.record(tx, id),
            { request } = await this.request(tx, r);
          creations.push({
            id,
            title: request.topic.name,
            state: r.state,
            stage: r.stage,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            reason: r.reason,
          });
        } catch (error) {
          if (
            !["topic-creation-invalid", "topic-job-invalid"].includes(
              error.message,
            )
          )
            throw error;
          creations.push({ id, state: "unavailable" });
        }
      }
      return {
        creations,
        next: start + selected.length < ids.length ? selected.at(-1) : null,
      };
    });
  }
  async refresh(owner, id) {
    const previous = await this.read(owner, id);
    if (!previous || !["held", "generation", "review"].includes(previous.state))
      return previous;
    const snapshot = await this.storage.transaction((tx) =>
      this.record(tx, previous.id),
    );
    const stageId =
      snapshot.stage === "generation" ? snapshot.id : snapshot.reviewId;
    const stage = await this.queue.refresh(owner, stageId);
    if (stage && ["complete", "rejected", "cancelled"].includes(stage.state)) {
      if (snapshot.state === "held")
        await this.update(owner, snapshot, async (_tx, current) => {
          current.state = current.stage;
          current.reason = "";
        });
      await this.advanceSafely(owner, previous.id);
    }
    return this.read(owner, previous.id);
  }
  async resume(owner, id, confirm) {
    z.literal(true).parse(confirm);
    if (!this.enabled) throw Error("topic-creations-unconfigured");
    ownerSchema.parse(owner);
    id = uuid.parse(id);
    return this.storage.transaction(async (tx) => {
      const index = await this.index(tx, owner);
      if (!index?.ids.includes(id)) throw Error("topic-creation-missing");
      const r = await this.record(tx, id);
      if (r.state === "held" && r.reason === "capacity") {
        r.state = r.stage;
        r.reason = "";
        r.updatedAt = Math.max(r.updatedAt, this.now());
        await tx.put(key(id), stored(recordSchema, r));
      } else if (!active(r)) throw Error("topic-creation-active");
      await this.queue.schedule(tx, await this.queue.index(tx, owner));
      return this.view(tx, r);
    });
  }
  async remove(owner, id, confirm, discardGeneratedResult = false) {
    z.literal(true).parse(confirm);
    ownerSchema.parse(owner);
    id = uuid.parse(id);
    const snapshot = await this.storage.transaction(async (tx) => {
      const index = await this.index(tx, owner);
      return index?.ids.includes(id) ? this.record(tx, id) : null;
    });
    if (snapshot?.state === "held" && discardGeneratedResult === true) {
      const stageId =
        snapshot.stage === "generation" ? snapshot.id : snapshot.reviewId;
      if (snapshot.reason === "capacity")
        return this.storage.transaction(async (tx) => {
          const r = await this.record(tx, id);
          if (
            (await hash(r)) !== (await hash(snapshot)) ||
            !(await this.queue.unreserved(tx, owner, stageId))
          )
            throw Error("topic-creation-conflict");
          // 予約が存在しないことを同時に確認し、送信済みの段階を取り下げない。
          r.state = "rejected";
          await tx.put(key(id), stored(recordSchema, r));
          await this.removeInTransaction(tx, owner, id);
        });
      return this.queue.discardUnsent(owner, stageId, async (tx) => {
        const r = await this.record(tx, id);
        if (
          r.state !== snapshot.state ||
          r.stage !== snapshot.stage ||
          r.requestDigest !== snapshot.requestDigest
        )
          throw Error("topic-creation-conflict");
        r.state = "rejected";
        await tx.put(key(id), stored(recordSchema, r));
        await this.removeInTransaction(tx, owner, id);
      });
    }
    return this.storage.transaction((tx) =>
      this.removeInTransaction(tx, owner, id),
    );
  }
  async removeInTransaction(tx, owner, id) {
    const index = await this.index(tx, owner);
    if (!index?.ids.includes(id)) return;
    const r = await this.record(tx, id);
    if (!["draft", "ready", "rejected"].includes(r.state))
      throw Error("topic-creation-active");
    for (const stageId of [r.id, r.reviewId, ...(r.previousReviewIds ?? [])])
      await this.queue.removeInTransaction(tx, owner, stageId, {
        schedule: false,
      });
    await this.queue.deleteParts(tx, id, "creation-request", r.requestParts);
    await this.queue.deleteParts(tx, id, "creation-book", r.bookParts);
    await tx.delete(key(id));
    index.ids = index.ids.filter((value) => value !== id);
    await tx.put(indexKey, index);
    await this.queue.schedule(tx, await this.queue.index(tx, owner));
  }
  async nextWake(tx) {
    const raw = await tx.get(indexKey);
    if (raw === undefined) return null;
    const parsed = indexSchema.safeParse(raw);
    // 作成目録の障害で、すでに送信済みの段階の結果保存を巻き戻さない。
    if (!parsed.success) return null;
    const index = parsed.data;
    for (const id of index.ids) {
      let r;
      try {
        r = await this.record(tx, id);
      } catch (error) {
        if (error.message !== "topic-creation-invalid") throw error;
        continue;
      }
      if (!active(r)) continue;
      const stageId = r.stage === "generation" ? r.id : r.reviewId;
      const stage = await this.queue.availableRecord(tx, stageId);
      // 存在する壊れた段階を未予約として再作成したり、毎秒起こし続けたりしない。
      if (
        !stage &&
        (await this.queue.index(tx, index.owner))?.ids.includes(stageId)
      )
        continue;
      if (!stage || !["queued", "running"].includes(stage.state))
        return this.now() + 1000;
    }
    return null;
  }
  async update(owner, snapshot, change) {
    return this.storage.transaction(async (tx) => {
      const index = await this.index(tx, owner);
      if (!index?.ids.includes(snapshot.id))
        throw Error("topic-creation-missing");
      const r = await this.record(tx, snapshot.id);
      if (r.state !== snapshot.state || r.stage !== snapshot.stage) return;
      await change(tx, r);
      r.updatedAt = Math.max(r.updatedAt, this.now());
      await tx.put(key(r.id), stored(recordSchema, r));
      await this.queue.schedule(tx, await this.queue.index(tx, owner));
    });
  }
  input(r, raw, draft) {
    const generation = r.stage === "generation",
      quote = generation ? r.quotes.generation : r.quotes.review;
    return {
      requestId: generation ? r.id : r.reviewId,
      purpose: generation ? "book-addition" : "evidence-check",
      modelId: quote.modelId,
      requestRaw: raw,
      approvedPublicText: r.approvedPublicText,
      approvedMaxMilliYen: quote.maxMilliYen,
      approvedQuoteDigest: quote.quoteDigest,
      ...(generation
        ? {}
        : {
            generationRequestId: r.id,
            generatorInvocation: draft.invocation.id.toLowerCase(),
            draftRaw: draft.json,
          }),
    };
  }
  async advanceOne(owner, id) {
    const snapshot = await this.storage.transaction(async (tx) => {
      const r = await this.record(tx, id);
      return { r, ...(active(r) ? await this.request(tx, r) : {}) };
    });
    const { r, raw } = snapshot;
    if (!active(r)) return;
    const generated =
      r.stage === "review" ? await this.queue.read(owner, r.id) : null;
    let draft;
    try {
      if (r.stage === "review") {
        if (
          generated?.state !== "complete" ||
          generated.result?.status !== "complete"
        )
          throw Error("topic-edition-invalid");
        draft = await validateTopicDraft(
          raw,
          generated.result.draft,
          r.quotes.generation,
        );
      }
    } catch {
      await this.update(owner, r, async (_tx, current) =>
        Object.assign(current, { state: "rejected", reason: "invalid-result" }),
      );
      return;
    }
    const input = this.input(r, raw, draft);
    const stage = await this.queue.read(owner, input.requestId);
    if (!stage) {
      await this.queue.enqueue(owner, input);
      return;
    }
    if (["queued", "running"].includes(stage.state)) return;
    if (stage.state !== "complete") {
      await this.update(owner, r, async (_tx, current) =>
        Object.assign(current, {
          state: stage.state === "held" ? "held" : "rejected",
          reason:
            stage.state === "held" ? "operation-unconfirmed" : "stage-rejected",
        }),
      );
      return;
    }
    let book;
    try {
      if (stage.result?.status !== "complete")
        throw Error("topic-edition-invalid");
      if (r.stage === "generation")
        await validateTopicDraft(raw, stage.result.draft, r.quotes.generation);
      else
        book = await createTopicTextbookEdition({
          bookID: r.bookID,
          createdAt: new Date(r.createdAt).toISOString(),
          requestRaw: raw,
          draft,
          checked: stage.result.draft,
          generationQuote: r.quotes.generation,
          reviewQuote: r.quotes.review,
        });
    } catch {
      await this.update(owner, r, async (_tx, current) =>
        Object.assign(current, { state: "rejected", reason: "invalid-result" }),
      );
      return;
    }
    await this.update(owner, r, async (tx, current) => {
      if (book) {
        current.bookParts = await this.queue.writeParts(
          tx,
          r.id,
          "creation-book",
          book.raw,
          1080000,
        );
        current.bookDigest = await hash(book.raw);
        current.state = "ready";
      } else Object.assign(current, { state: "review", stage: "review" });
    });
  }
  async advance() {
    if (!this.enabled) return;
    const raw = await this.storage.get(indexKey);
    if (raw === undefined) return;
    const index = stored(indexSchema, raw);
    for (const id of index.ids) await this.advanceSafely(index.owner, id);
  }
  async advanceSafely(owner, id) {
    try {
      await this.advanceOne(owner, id);
    } catch (error) {
      // 壊れた一件を消さず、他の正常な依頼の進行を妨げない。
      if (
        ![
          "topic-creation-invalid",
          "topic-job-invalid",
          "topic-job-capacity",
        ].includes(error.message)
      )
        throw error;
      const snapshot = await this.storage
        .transaction((tx) => this.record(tx, id))
        .catch((problem) => {
          if (problem.message !== "topic-creation-invalid") throw problem;
          return null;
        });
      if (snapshot && active(snapshot))
        await this.update(owner, snapshot, async (_tx, current) => {
          current.state = "held";
          current.reason =
            error.message === "topic-job-capacity"
              ? "capacity"
              : "invalid-result";
        });
    }
  }
  async alarm() {
    await this.advance();
    await this.queue.alarm();
    await this.advance();
  }
}
