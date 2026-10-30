import { z } from "zod";
import { cloudFeedURL } from "./feed-fetch.mjs";
import { validSourceValidators } from "../src/http-validators.mjs";
import {
  documentIdentity,
  versionIdentity,
  representationHash,
  sourceContent,
  validDocumentContent,
  validDocumentVersion,
  verifyDocumentIdentity,
} from "../src/source-document.ts";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const retained = z
  .object({
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    size: integer.max(4_000_000),
    parts: integer.min(1).max(250),
  })
  .strict();
const schema = z
  .object({
    schema: z.literal(1),
    id: z.string().uuid(),
    scope: z.string().min(1).max(200),
    sourceURL: z.string().max(2048),
    revision: integer,
    checkedAt: z.string().datetime().nullable(),
    currentVersionId: z.string().uuid().nullable(),
    validators: z.custom(validSourceValidators).optional(),
    lease: z
      .object({ token: z.string().uuid(), expiresAt: integer })
      .strict()
      .nullable(),
    versions: z.array(retained).max(100),
    bytes: integer.max(10_000_000),
  })
  .strict();
const key = "document:catalog:v1";
const partKey = (id, part) => `document:version:${id}:${part}`;
const sizeOf = (value) => new TextEncoder().encode(value).byteLength;

// One durable storage object per server-selected scope/source. This is an
// internal core, not an HTTP endpoint: callers must supply trusted authorization
// and acquisition adapters. Never pass a request's body as the loader result.
export class DocumentCatalog {
  constructor(storage, { scope, sourceURL, authorize, load, now = Date.now }) {
    if (
      typeof scope !== "string" ||
      !scope ||
      scope.length > 200 ||
      typeof authorize !== "function" ||
      typeof load !== "function"
    )
      throw Error("document-unconfigured");
    Object.assign(this, {
      storage,
      scope,
      sourceURL: cloudFeedURL(sourceURL).href,
      authorize,
      load,
      now,
    });
    this.identity = documentIdentity(scope, this.sourceURL);
  }
  async access(principal) {
    if (
      typeof principal !== "string" ||
      !principal ||
      (await this.authorize(principal, this.scope, this.sourceURL)) !== true
    )
      throw Error("document-unavailable");
  }
  state(value, id) {
    const state = schema.parse(
      value === undefined
        ? {
            schema: 1,
            id,
            scope: this.scope,
            sourceURL: this.sourceURL,
            revision: 0,
            checkedAt: null,
            currentVersionId: null,
            lease: null,
            versions: [],
            bytes: 0,
          }
        : value,
    );
    if (
      state.id !== id ||
      state.scope !== this.scope ||
      state.sourceURL !== this.sourceURL ||
      new Set(state.versions.map((v) => v.id)).size !== state.versions.length ||
      state.bytes !== state.versions.reduce((sum, v) => sum + v.size, 0) ||
      (state.currentVersionId === null
        ? state.versions.length !== 0 ||
          state.checkedAt !== null ||
          state.revision !== 0 ||
          state.validators !== undefined
        : !state.versions.some((v) => v.id === state.currentVersionId) ||
          state.checkedAt === null ||
          state.revision === 0)
    )
      throw Error("document-invalid");
    return state;
  }
  async stored(tx, state, id) {
    const meta = state.versions.find((v) => v.id === id);
    if (!meta) throw Error("document-unavailable");
    let text = "";
    for (let part = 0; part < meta.parts; part++) {
      const chunk = await tx.get(partKey(id, part));
      if (typeof chunk !== "string" || chunk.length > 16000)
        throw Error("document-invalid");
      text += chunk;
    }
    if (sizeOf(text) !== meta.size) throw Error("document-invalid");
    const value = JSON.parse(text);
    if (
      !validDocumentVersion(value) ||
      value.id !== id ||
      value.documentId !== state.id ||
      value.scope !== this.scope ||
      value.sourceURL !== this.sourceURL ||
      value.createdAt !== meta.createdAt ||
      (id === state.currentVersionId &&
        state.validators &&
        state.validators.url !== value.content.url)
    )
      throw Error("document-invalid");
    return value;
  }
  async verified(version) {
    if (version && !(await verifyDocumentIdentity(version)))
      throw Error("document-invalid");
    return version;
  }
  result(state, version, reused) {
    return {
      status: "ready",
      reused,
      document: {
        id: state.id,
        scope: state.scope,
        sourceURL: state.sourceURL,
        currentVersionId: state.currentVersionId,
        checkedAt: state.checkedAt,
        revision: state.revision,
        ...(state.validators ? { validators: state.validators } : {}),
      },
      version,
    };
  }
  async release(token) {
    const id = await this.identity;
    await this.storage.transaction(async (tx) => {
      const state = this.state(await tx.get(key), id);
      if (state.lease?.token === token) {
        state.lease = null;
        await tx.put(key, state);
      }
    });
  }
  async acquire(principal, { force = false } = {}) {
    // Authorization precedes even cache/lease lookups; IDs are not capabilities.
    await this.access(principal);
    if (typeof force !== "boolean") throw Error("document-request");
    const id = await this.identity;
    const work = await this.storage.transaction(async (tx) => {
      const state = this.state(await tx.get(key), id),
        now = this.now();
      if (state.lease && state.lease.expiresAt > now)
        return { pending: state.lease.expiresAt };
      const current = state.currentVersionId
        ? await this.stored(tx, state, state.currentVersionId)
        : null;
      if (
        !force &&
        current &&
        Date.parse(state.checkedAt) > now - 86_400_000 &&
        Date.parse(state.checkedAt) <= now
      )
        return { state, current };
      state.lease = { token: crypto.randomUUID(), expiresAt: now + 30_000 };
      await tx.put(key, state);
      return { state, current, token: state.lease.token };
    });
    if (work.pending) {
      await this.access(principal);
      return { status: "pending", retryAt: work.pending };
    }
    try {
      await this.verified(work.current);
      if (!work.token) {
        await this.access(principal);
        return this.result(work.state, work.current, true);
      }
      // No network or digest work inside storage transactions. The persisted
      // token fences a late completion even after process death and lease expiry.
      const fetched = await this.load(
        this.sourceURL,
        work.current
          ? {
              content: structuredClone(work.current.content),
              validators:
                work.state.validators && structuredClone(work.state.validators),
            }
          : undefined,
      );
      if (
        fetched?.notModified !== undefined &&
        typeof fetched.notModified !== "boolean"
      )
        throw Error("document-response");
      let content;
      if (fetched?.notModified === true) {
        if (
          !work.current ||
          !work.state.validators ||
          fetched.url !== work.current.content.url ||
          fetched.content !== undefined
        )
          throw Error("document-response");
        content = work.current.content;
      } else {
        if (!validDocumentContent(fetched?.content))
          throw Error("document-response");
        content = sourceContent(fetched.content);
      }
      cloudFeedURL(content.url);
      const validators =
        fetched.validators !== undefined
          ? fetched.validators
          : fetched.notModified === true
            ? work.state.validators
            : undefined;
      if (
        validators !== undefined &&
        (!validSourceValidators(validators) || validators.url !== content.url)
      )
        throw Error("document-response");
      const digest = await representationHash(content),
        versionId = await versionIdentity(id, digest),
        createdAt = new Date(this.now()).toISOString(),
        version = {
          id: versionId,
          documentId: id,
          scope: this.scope,
          sourceURL: this.sourceURL,
          representationHash: digest,
          formatVersion: 1,
          createdAt,
          content,
        },
        serialized = JSON.stringify(version),
        size = sizeOf(serialized),
        parts = Math.ceil(serialized.length / 16000);
      if (size > 4_000_000 || parts > 250) throw Error("document-capacity");
      await this.access(principal);
      return await this.storage.transaction(async (tx) => {
        const state = this.state(await tx.get(key), id);
        if (
          state.lease?.token !== work.token ||
          state.lease.expiresAt <= this.now()
        )
          throw Error("document-conflict");
        const exists = state.versions.some((v) => v.id === versionId);
        // An existing immutable version wins, including its original timestamp.
        const retainedVersion = exists
          ? await this.stored(tx, state, versionId)
          : version;
        if (
          retainedVersion.representationHash !== digest ||
          JSON.stringify(
            sourceContent({
              ...retainedVersion.content,
              fetchedAt: content.fetchedAt,
            }),
          ) !== JSON.stringify(content)
        )
          throw Error("document-invalid");
        if (!exists) {
          if (state.versions.length >= 100 || state.bytes + size > 10_000_000)
            throw Error("document-capacity");
          for (let part = 0; part < parts; part++)
            await tx.put(
              partKey(versionId, part),
              serialized.slice(part * 16000, (part + 1) * 16000),
            );
          state.versions.push({ id: versionId, createdAt, size, parts });
          state.bytes += size;
        }
        state.currentVersionId = versionId;
        state.checkedAt = createdAt;
        state.revision++;
        state.lease = null;
        if (validators) state.validators = validators;
        else delete state.validators;
        await tx.put(key, schema.parse(state));
        return this.result(state, retainedVersion, exists);
      });
    } catch (error) {
      if (work.token) await this.release(work.token).catch(() => {});
      throw error;
    }
  }
  async read(principal, versionId) {
    await this.access(principal);
    const id = await this.identity;
    const version = await this.storage.transaction(async (tx) => {
      const state = this.state(await tx.get(key), id);
      return this.stored(tx, state, versionId ?? state.currentVersionId);
    });
    await this.verified(version);
    await this.access(principal);
    return version;
  }
  async history(principal, after) {
    await this.access(principal);
    const id = await this.identity;
    const result = await this.storage.transaction(async (tx) => {
      const state = this.state(await tx.get(key), id),
        versions = [...state.versions].reverse();
      const start =
        after === undefined ? 0 : versions.findIndex((v) => v.id === after) + 1;
      if (after !== undefined && !start) throw Error("document-unavailable");
      const page = versions
        .slice(start, start + 20)
        .map(({ id, createdAt }) => ({ id, createdAt }));
      return { versions: page, more: start + page.length < versions.length };
    });
    await this.access(principal);
    return result;
  }
}
