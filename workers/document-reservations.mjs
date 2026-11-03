import { z } from "zod";
import { hash } from "./crypto.mjs";

const keyFor = async (owner, url, audience) =>
  "documents:source:" + (await hash([owner, url, audience]));
const countKey = "documents:source-count";
const recordSchema = z
  .object({
    schema: z.literal(1),
    token: z.string().uuid(),
    revision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER - 1),
    scopes: z.array(z.string().min(1).max(200)).max(100),
    legacy: z.boolean(),
  })
  .strict();
const validScope = (owner, audience, scope) => {
  if (audience === "private") return scope === `private:${owner}`;
  const match = /^shared:([^:]+):([1-9][0-9]*)$/.exec(scope);
  return (
    audience === "shared" &&
    !!match &&
    z.string().uuid().safeParse(match[1]).success &&
    Number.isSafeInteger(Number(match[2])) &&
    Number(match[2]) < Number.MAX_SAFE_INTEGER
  );
};

/** Account-owned reservations track every acquired scope before forwarding a request. */
export class DocumentReservations {
  constructor(storage) {
    this.storage = storage;
  }
  /** Validate the count and exact reservation without repairing ambiguous legacy data. */
  async read(tx, key, owner, audience) {
    const count = await tx.get(countKey),
      raw = await tx.get(key);
    if (
      count !== undefined &&
      (!Number.isInteger(count) || count < 0 || count > 1000)
    )
      throw Error("document-invalid");
    if (raw === undefined) return { count: count ?? 0, record: null };
    if (!count) throw Error("document-invalid");
    if (raw === true) return { count, record: true };
    try {
      const record = recordSchema.parse(raw);
      if (
        (!record.legacy && !record.scopes.length) ||
        new Set(record.scopes).size !== record.scopes.length ||
        !record.scopes.every((scope) => validScope(owner, audience, scope))
      )
        throw Error();
      return { count, record };
    } catch {
      throw Error("document-invalid");
    }
  }
  /** Reserve a scope atomically, returning a rollback receipt only for a new scope. */
  async reserve(owner, url, audience, scope) {
    if (!validScope(owner, audience, scope)) throw Error("document-invalid");
    const key = await keyFor(owner, url, audience);
    return this.storage.transaction(async (tx) => {
      const { count, record } = await this.read(tx, key, owner, audience);
      if (!record && count >= 1000) throw Error("document-capacity");
      if (record && record !== true && record.scopes.includes(scope)) return;
      const next =
        record && record !== true
          ? record
          : {
              schema: 1,
              token: crypto.randomUUID(),
              revision: 0,
              scopes: [],
              legacy: record === true && audience === "shared",
            };
      if (
        next.scopes.length >= 100 ||
        next.revision >= Number.MAX_SAFE_INTEGER - 1
      )
        throw Error("document-capacity");
      next.scopes.push(scope);
      next.revision++;
      await tx.put(key, next);
      if (!record) await tx.put(countKey, count + 1);
      // A legacy reservation predates this request, even when migrated here.
      if (record !== true)
        return { token: next.token, revision: next.revision };
    });
  }
  /** Report known scopes separately from legacy shared inventory that remains unknown. */
  summary(record, scope) {
    // Legacy private reservations always had exactly this account's one scope.
    const legacyPrivate = record === true && scope.startsWith("private:");
    return {
      reserved: record !== null,
      token: record && record !== true ? record.token : null,
      revision: record && record !== true ? record.revision : 0,
      scopeCount:
        record && record !== true
          ? record.scopes.length
          : Number(legacyPrivate),
      legacy: (record === true && !legacyPrivate) || !!record?.legacy,
      containsTarget:
        legacyPrivate ||
        (record && record !== true ? record.scopes.includes(scope) : false),
    };
  }

  /** Read reservation metadata without allocating, releasing or resetting a slot. */
  async inspect(owner, url, audience, scope) {
    const key = await keyFor(owner, url, audience);
    return this.storage.transaction(async (tx) =>
      this.summary((await this.read(tx, key, owner, audience)).record, scope),
    );
  }
  /** Called only after the exact target has a verified permanent deletion record. */
  async releaseDeleted(owner, url, audience, scope, expected) {
    const key = await keyFor(owner, url, audience);
    return this.storage.transaction(async (tx) => {
      const { count, record } = await this.read(tx, key, owner, audience);
      if (!record) return this.summary(null, scope);
      if (
        record === true &&
        audience === "private" &&
        scope === `private:${owner}` &&
        expected.token === null &&
        expected.revision === 0
      ) {
        await tx.delete(key);
        await tx.put(countKey, count - 1);
        return this.summary(null, scope);
      }
      if (
        record === true ||
        record.token !== expected.token ||
        record.revision !== expected.revision
      )
        throw Error("document-conflict");
      if (!record.scopes.includes(scope)) return this.summary(record, scope);
      if (record.revision >= Number.MAX_SAFE_INTEGER - 1)
        throw Error("document-capacity");
      record.scopes = record.scopes.filter((value) => value !== scope);
      record.revision++;
      if (!record.scopes.length && !record.legacy) {
        await tx.delete(key);
        await tx.put(countKey, count - 1);
        return this.summary(null, scope);
      }
      await tx.put(key, record);
      return this.summary(record, scope);
    });
  }
}
