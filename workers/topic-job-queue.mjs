import { z } from "zod";
import { hash } from "./crypto.mjs";
import { topicTextbookContract } from "../server/topic-textbook-contract.mjs";
import {
  topicGenerationInputSchema,
  topicGenerationReplySchema,
} from "../src/topic-generation-protocol.ts";

const ownerSchema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const indexSchema = z
  .object({
    version: z.literal(1),
    owner: ownerSchema,
    ids: z
      .array(idSchema)
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
const recordSchema = z
  .object({
    version: z.literal(1),
    id: idSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    parts: z.number().int().min(1).max(24),
    state: z.enum([
      "queued",
      "running",
      "complete",
      "rejected",
      "held",
      "cancelled",
    ]),
    createdAt: time,
    updatedAt: time,
    checkAt: time.nullable(),
    attempt: idSchema.nullable(),
    resultParts: z.number().int().min(0).max(20),
    resultDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    reason: z.enum([
      "",
      "operation-unconfirmed",
      "stored-input-unavailable",
      "access-unavailable",
    ]),
    confirmedUnsent: z.boolean().optional(),
  })
  .strict()
  .refine((record) => record.updatedAt >= record.createdAt)
  .refine(
    (record) =>
      !record.confirmedUnsent ||
      (record.resultParts > 0 && ["held", "rejected"].includes(record.state)),
  )
  .refine(
    (record) => (record.resultParts === 0) === (record.resultDigest === null),
  )
  .refine(
    (record) =>
      !["complete", "rejected"].includes(record.state) ||
      record.resultParts > 0,
  )
  .refine((record) =>
    ["queued", "cancelled"].includes(record.state)
      ? record.attempt === null &&
        record.checkAt === null &&
        record.resultParts === 0
      : record.attempt !== null &&
        (record.state === "running"
          ? record.checkAt !== null
          : record.checkAt === null),
  );
const indexKey = "topic-jobs:index";
const key = (id) => `topic-jobs:record:${id}`;
const part = (id, kind, n) => `topic-jobs:${kind}:${id}:${n}`;
const bytes = (s) => new TextEncoder().encode(s).byteLength;
const invalidData = (error) =>
  error instanceof z.ZodError ||
  error instanceof SyntaxError ||
  error.message === "topic-job-invalid";
const stored = (schema, value) => {
  try {
    return schema.parse(value);
  } catch {
    throw Error("topic-job-invalid");
  }
};

/** 生成の再実行と結果の再照会を分け、alarmの再配送で有料処理を繰り返さない。 */
export class TopicJobQueue {
  constructor(
    storage,
    {
      enabled = false,
      run,
      lookup,
      now = Date.now,
      nextWake = async () => null,
      terminalStatuses = [],
    } = {},
  ) {
    Object.assign(this, { storage, enabled, run, lookup, now, nextWake });
    this.terminalStatuses = new Set(terminalStatuses);
  }
  async index(tx, owner) {
    const raw = await tx.get(indexKey);
    if (raw === undefined) return null;
    const index = stored(indexSchema, raw);
    if (index.owner !== owner) throw Error("topic-job-owner");
    return index;
  }
  async record(tx, id) {
    const value = stored(recordSchema, await tx.get(key(id)));
    if (value.id !== id) throw Error("topic-job-invalid");
    return value;
  }
  async availableRecord(tx, id) {
    try {
      return await this.record(tx, id);
    } catch (error) {
      if (!invalidData(error)) throw error;
      return null;
    }
  }
  async unreserved(tx, owner, id) {
    return (
      !(await this.index(tx, owner))?.ids.includes(id) &&
      (await tx.get(key(id))) === undefined
    );
  }
  async pending(tx, index) {
    let count = 0;
    for (const id of index.ids) {
      const record = await this.availableRecord(tx, id);
      if (record && ["queued", "running"].includes(record.state)) count++;
    }
    return count;
  }
  async writeParts(tx, id, kind, value, maxBytes) {
    const raw = JSON.stringify(value);
    if (bytes(raw) > maxBytes)
      throw Error(
        kind === "input" ? "topic-job-input-limit" : "topic-job-invalid",
      );
    const count = Math.ceil(raw.length / 16000);
    for (let n = 0; n < count; n++)
      await tx.put(part(id, kind, n), raw.slice(n * 16000, (n + 1) * 16000));
    return count;
  }
  async readParts(tx, id, kind, count, maxBytes) {
    let raw = "";
    for (let n = 0; n < count; n++) {
      const value = await tx.get(part(id, kind, n));
      if (typeof value !== "string" || value.length > 16000)
        throw Error("topic-job-invalid");
      raw += value;
    }
    if (bytes(raw) > maxBytes) throw Error("topic-job-invalid");
    try {
      return JSON.parse(raw);
    } catch {
      throw Error("topic-job-invalid");
    }
  }
  async deleteParts(tx, id, kind, count) {
    for (let n = 0; n < count; n++) await tx.delete(part(id, kind, n));
  }
  async schedule(tx, index) {
    let next = Infinity;
    if (this.enabled) {
      const extra = await this.nextWake(tx);
      if (extra !== null) {
        if (!Number.isSafeInteger(extra) || extra < 0)
          throw Error("topic-job-invalid");
        next = extra;
      }
      for (const id of index?.ids ?? []) {
        const record = await this.availableRecord(tx, id);
        if (!record) continue;
        if (record.state === "queued") next = Math.min(next, this.now() + 1000);
        if (record.state === "running")
          next = Math.min(next, record.checkAt ?? this.now() + 1000);
      }
    }
    if (Number.isFinite(next))
      await tx.setAlarm(Math.max(this.now() + 1000, next));
    else await tx.deleteAlarm();
  }
  async view(tx, record, owner) {
    const result = record.resultParts
      ? stored(
          topicGenerationReplySchema,
          await this.readParts(
            tx,
            record.id,
            "result",
            record.resultParts,
            262144,
          ),
        )
      : null;
    if (result && result.account !== owner) throw Error("topic-job-owner");
    if (result && (await hash(result)) !== record.resultDigest)
      throw Error("topic-job-invalid");
    return {
      id: record.id,
      state: record.state,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      reason: record.reason,
      result,
    };
  }
  async enqueue(owner, value, { onQueued } = {}) {
    if (!this.enabled) throw Error("topic-jobs-unconfigured");
    ownerSchema.parse(owner);
    const input = topicGenerationInputSchema.parse(value);
    if (input.approvedMaxMilliYen === undefined || !input.approvedQuoteDigest)
      throw Error("cost-unapproved");
    const digest = await hash(input);
    return this.storage.transaction(async (tx) => {
      const index = (await this.index(tx, owner)) ?? {
        version: 1,
        owner,
        ids: [],
      };
      if (index.ids.includes(input.requestId)) {
        const record = await this.record(tx, input.requestId);
        if (record.digest !== digest) throw Error("topic-job-conflict");
        await this.schedule(tx, index);
        return this.view(tx, record, owner);
      }
      if (index.ids.length >= 200) throw Error("topic-job-capacity");
      if ((await this.pending(tx, index)) >= 20)
        throw Error("topic-job-capacity");
      const at = this.now();
      const record = recordSchema.parse({
        version: 1,
        id: input.requestId,
        digest,
        parts: await this.writeParts(
          tx,
          input.requestId,
          "input",
          input,
          384000,
        ),
        state: "queued",
        createdAt: at,
        updatedAt: at,
        checkAt: null,
        attempt: null,
        resultParts: 0,
        resultDigest: null,
        reason: "",
        confirmedUnsent: false,
      });
      index.ids.push(record.id);
      await tx.put(key(record.id), record);
      await tx.put(indexKey, indexSchema.parse(index));
      if (onQueued) await onQueued(tx);
      await this.schedule(tx, index);
      return this.view(tx, record, owner);
    });
  }
  async read(owner, id) {
    ownerSchema.parse(owner);
    id = idSchema.parse(id);
    return this.storage.transaction(async (tx) => {
      const index = await this.index(tx, owner);
      return index?.ids.includes(id)
        ? this.view(tx, await this.record(tx, id), owner)
        : null;
    });
  }
  async list(owner, after) {
    ownerSchema.parse(owner);
    if (after !== undefined) after = idSchema.parse(after);
    return this.storage.transaction(async (tx) => {
      const index = await this.index(tx, owner);
      const ids = [...(index?.ids ?? [])].reverse();
      const start = after === undefined ? 0 : ids.indexOf(after) + 1;
      if (after !== undefined && start === 0) throw Error("topic-job-cursor");
      const selected = ids.slice(start, start + 20),
        jobs = [];
      for (const id of selected) {
        const record = await this.availableRecord(tx, id);
        if (!record) {
          jobs.push({ id, state: "unavailable" });
          continue;
        }
        jobs.push({
          id,
          state: record.state,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          reason: record.reason,
        });
      }
      return {
        jobs,
        after: start + selected.length < ids.length ? selected.at(-1) : null,
      };
    });
  }
  async refresh(owner, id) {
    ownerSchema.parse(owner);
    id = idSchema.parse(id);
    const ticket = await this.storage.transaction(async (tx) => {
      const index = await this.index(tx, owner);
      if (!index?.ids.includes(id)) return null;
      const record = await this.record(tx, id);
      if (!["running", "held"].includes(record.state)) return null;
      const input = stored(
        topicGenerationInputSchema,
        await this.readParts(tx, id, "input", record.parts, 384000),
      );
      if (input.requestId !== id || (await hash(input)) !== record.digest)
        throw Error("topic-job-invalid");
      return {
        owner,
        id,
        attempt: record.attempt,
        input,
        recovering: true,
        manual: true,
      };
    });
    if (ticket) await this.perform(ticket);
    return this.read(owner, id);
  }
  async retry(owner, value, { onQueued } = {}) {
    if (!this.enabled) throw Error("topic-jobs-unconfigured");
    ownerSchema.parse(owner);
    let input = topicGenerationInputSchema.parse(value);
    if (input.approvedMaxMilliYen === undefined || !input.approvedQuoteDigest)
      throw Error("cost-unapproved");
    const previous = await this.storage.transaction(async (tx) => {
      const index = await this.index(tx, owner);
      if (!index?.ids.includes(input.requestId))
        throw Error("topic-job-missing");
      const record = await this.record(tx, input.requestId);
      if (!["held", "rejected"].includes(record.state))
        throw Error("topic-job-retry-unavailable");
      const old = stored(
        topicGenerationInputSchema,
        await this.readParts(tx, record.id, "input", record.parts, 384000),
      );
      if (
        (await hash(old)) !== record.digest ||
        (await topicTextbookContract.identity(old)) !==
          (await topicTextbookContract.identity(input))
      )
        throw Error("topic-job-conflict");
      return record;
    });
    const proof = stored(
      topicGenerationReplySchema,
      await this.lookup(owner, input),
    );
    if (proof.account !== owner) throw Error("topic-job-owner");
    if (
      proof.status !== "not-found" &&
      !(proof.status === "rejected" && proof.retryable === true)
    )
      throw Error("topic-job-retry-unavailable");
    input = { ...input };
    if (proof.status === "rejected") input.retryUnsent = true;
    else delete input.retryUnsent;
    input = topicGenerationInputSchema.parse(input);
    const digest = await hash(input);
    return this.storage.transaction(async (tx) => {
      const index = await this.index(tx, owner),
        record = await this.record(tx, input.requestId);
      if (
        record.attempt !== previous.attempt ||
        record.digest !== previous.digest ||
        !["held", "rejected"].includes(record.state)
      )
        throw Error("topic-job-conflict");
      if ((await this.pending(tx, index)) >= 20)
        throw Error("topic-job-capacity");
      for (const kind of ["input", "result"])
        for (
          let n = 0;
          n < (kind === "input" ? record.parts : record.resultParts);
          n++
        )
          await tx.delete(part(record.id, kind, n));
      Object.assign(record, {
        digest,
        parts: await this.writeParts(tx, record.id, "input", input, 384000),
        state: "queued",
        updatedAt: Math.max(record.updatedAt, this.now()),
        checkAt: null,
        attempt: null,
        resultParts: 0,
        resultDigest: null,
        reason: "",
        confirmedUnsent: false,
      });
      await tx.put(key(record.id), recordSchema.parse(record));
      if (onQueued) await onQueued(tx);
      await this.schedule(tx, index);
      return this.view(tx, record, owner);
    });
  }
  async remove(owner, id) {
    ownerSchema.parse(owner);
    id = idSchema.parse(id);
    return this.storage.transaction((tx) =>
      this.removeInTransaction(tx, owner, id),
    );
  }
  async discardUnsent(owner, id, onDiscard) {
    ownerSchema.parse(owner);
    id = idSchema.parse(id);
    const previous = await this.storage.transaction(async (tx) => {
      const index = await this.index(tx, owner);
      if (!index?.ids.includes(id)) throw Error("topic-job-missing");
      const record = await this.record(tx, id);
      await this.view(tx, record, owner);
      if (record.state !== "held" || record.confirmedUnsent !== true)
        throw Error("topic-job-active");
      const input = stored(
        topicGenerationInputSchema,
        await this.readParts(tx, id, "input", record.parts, 384000),
      );
      if (input.requestId !== id || (await hash(input)) !== record.digest)
        throw Error("topic-job-invalid");
      return { record, input };
    });
    const proof = stored(
      topicGenerationReplySchema,
      await this.lookup(owner, previous.input),
    );
    if (proof.account !== owner) throw Error("topic-job-owner");
    if (
      proof.status !== "not-found" &&
      !(proof.status === "rejected" && proof.retryable === true)
    )
      throw Error("topic-job-active");
    return this.storage.transaction(async (tx) => {
      const record = await this.record(tx, id);
      if (
        record.state !== "held" ||
        record.attempt !== previous.record.attempt ||
        record.digest !== previous.record.digest ||
        record.resultDigest !== previous.record.resultDigest
      )
        throw Error("topic-job-conflict");
      record.state = "rejected";
      await tx.put(key(id), recordSchema.parse(record));
      await onDiscard(tx);
    });
  }
  async removeInTransaction(tx, owner, id, { schedule = true } = {}) {
    ownerSchema.parse(owner);
    id = idSchema.parse(id);
    const index = await this.index(tx, owner);
    if (!index?.ids.includes(id)) return;
    const record = await this.record(tx, id);
    if (!["complete", "rejected", "cancelled"].includes(record.state))
      throw Error("topic-job-active");
    for (const kind of ["input", "result"])
      for (
        let n = 0;
        n < (kind === "input" ? record.parts : record.resultParts);
        n++
      )
        await tx.delete(part(id, kind, n));
    await tx.delete(key(id));
    index.ids = index.ids.filter((value) => value !== id);
    await tx.put(indexKey, index);
    if (schedule) await this.schedule(tx, index);
  }
  async cancel(owner, id) {
    ownerSchema.parse(owner);
    id = idSchema.parse(id);
    return this.storage.transaction(async (tx) => {
      const index = await this.index(tx, owner);
      if (!index?.ids.includes(id)) throw Error("topic-job-missing");
      const record = await this.record(tx, id);
      if (!["queued", "cancelled"].includes(record.state))
        throw Error("topic-job-active");
      record.state = "cancelled";
      record.updatedAt = Math.max(record.updatedAt, this.now());
      await tx.put(key(id), recordSchema.parse(record));
      await this.schedule(tx, index);
      return this.view(tx, record, owner);
    });
  }
  async resume(owner, id) {
    if (!this.enabled) throw Error("topic-jobs-unconfigured");
    ownerSchema.parse(owner);
    id = idSchema.parse(id);
    return this.storage.transaction(async (tx) => {
      const index = await this.index(tx, owner);
      if (!index?.ids.includes(id)) throw Error("topic-job-missing");
      const record = await this.record(tx, id);
      if (record.state !== "queued") throw Error("topic-job-active");
      const input = stored(
        topicGenerationInputSchema,
        await this.readParts(tx, id, "input", record.parts, 384000),
      );
      if (input.requestId !== id || (await hash(input)) !== record.digest)
        throw Error("topic-job-invalid");
      await this.schedule(tx, index);
      return this.view(tx, record, owner);
    });
  }
  async alarm() {
    const ticket = await this.storage.transaction(async (tx) => {
      const raw = await tx.get(indexKey);
      if (raw === undefined) {
        await this.schedule(tx, null);
        return null;
      }
      const index = stored(indexSchema, raw);
      if (!this.enabled) {
        await tx.deleteAlarm();
        return null;
      }
      for (const id of index.ids) {
        const record = await this.availableRecord(tx, id);
        if (!record) continue;
        if (
          record.state !== "queued" &&
          !(record.state === "running" && record.checkAt <= this.now())
        )
          continue;
        let input;
        try {
          input = stored(
            topicGenerationInputSchema,
            await this.readParts(tx, id, "input", record.parts, 384000),
          );
          if ((await hash(input)) !== record.digest || input.requestId !== id)
            throw Error("topic-job-invalid");
        } catch (error) {
          if (!invalidData(error)) throw error;
          Object.assign(record, {
            state: "held",
            attempt: record.attempt ?? crypto.randomUUID(),
            checkAt: null,
            reason: "stored-input-unavailable",
            updatedAt: Math.max(record.updatedAt, this.now()),
          });
          await tx.put(key(id), recordSchema.parse(record));
          continue;
        }
        const recovering = record.state === "running";
        record.state = "running";
        record.attempt ??= crypto.randomUUID();
        record.checkAt = this.now() + 60000;
        record.updatedAt = Math.max(record.updatedAt, this.now());
        await tx.put(key(id), recordSchema.parse(record));
        await this.schedule(tx, index);
        return {
          owner: index.owner,
          id,
          attempt: record.attempt,
          recovering,
          input,
        };
      }
      await this.schedule(tx, index);
      return null;
    });
    if (!ticket) return;
    await this.perform(ticket);
  }
  async perform(ticket) {
    let result = null;
    try {
      result = topicGenerationReplySchema.parse(
        await (ticket.recovering ? this.lookup : this.run)(
          ticket.owner,
          ticket.input,
        ),
      );
      if (result.account !== ticket.owner) throw Error("topic-job-owner");
    } catch {
      result = null;
    }
    await this.storage.transaction(async (tx) => {
      const index = await this.index(tx, ticket.owner);
      const record = await this.record(tx, ticket.id);
      // 遅い実行完了は同じ試行だけへ反映し、別の仕事や結果を置き換えない。
      if (
        record.attempt !== ticket.attempt ||
        !["running", "held"].includes(record.state)
      )
        return;
      const keepRunning =
        ticket.manual &&
        record.state === "running" &&
        result?.status !== "complete" &&
        result?.status !== "rejected" &&
        !this.terminalStatuses.has(result?.status);
      record.state = keepRunning
        ? "running"
        : result?.status === "complete"
          ? "complete"
          : ["rejected", "account-forbidden"].includes(result?.status) ||
              this.terminalStatuses.has(result?.status)
            ? "rejected"
            : "held";
      record.reason =
        result?.status === "account-forbidden"
          ? "access-unavailable"
          : ["complete", "rejected"].includes(record.state)
            ? ""
            : "operation-unconfirmed";
      // not-foundの再照会でも事前拒否の証拠を保ち、新しい予約では必ずリセットする。
      if (!ticket.recovering && result?.status === "materials-unavailable")
        record.confirmedUnsent = true;
      else if (
        record.confirmedUnsent &&
        result &&
        result.status !== "not-found"
      )
        record.confirmedUnsent = false;
      record.updatedAt = Math.max(record.updatedAt, this.now());
      if (!keepRunning) record.checkAt = null;
      if (result) {
        const previousParts = record.resultParts;
        record.resultParts = await this.writeParts(
          tx,
          ticket.id,
          "result",
          result,
          262144,
        );
        for (let n = record.resultParts; n < previousParts; n++)
          await tx.delete(part(ticket.id, "result", n));
        record.resultDigest = await hash(result);
      }
      await tx.put(key(ticket.id), recordSchema.parse(record));
      await this.schedule(tx, index);
    });
  }
}
