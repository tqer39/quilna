import { z } from "zod";

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const deadline = z.string().datetime().nullable();
export const lifecycleKey = "document:lifecycle:v1";
export const lifecycleCommand = z
  .object({
    operationId: z.string().uuid(),
    action: z.enum(["withdraw", "restore", "retention", "purge"]),
    expectedRevision: revision,
    expectedCatalogRevision: revision.optional(),
    expiresAt: deadline.optional(),
    reason: z.string().trim().min(1).max(200),
  })
  .strict()
  .refine(
    (v) =>
      (v.action === "purge") === (v.expectedCatalogRevision !== undefined) &&
      (v.action === "retention") === (v.expiresAt !== undefined),
  );
const schema = z
  .object({
    schema: z.literal(1),
    id: z.string().uuid(),
    revision,
    status: z.enum(["active", "withdrawn", "deleted"]),
    expiresAt: deadline,
    operations: z
      .array(
        z
          .object({ command: lifecycleCommand, at: z.string().datetime() })
          .strict(),
      )
      .max(64),
  })
  .strict();

/** Apply one recorded decision; deletion is a permanent tombstone in this scope. */
function transition(state, command, at) {
  if (state.status === "deleted") throw Error("document-unavailable");
  if (command.action === "purge") {
    if (
      state.status !== "withdrawn" &&
      (state.expiresAt === null || Date.parse(state.expiresAt) > Date.parse(at))
    )
      throw Error("document-conflict");
    state.status = "deleted";
  } else if (command.action === "retention") {
    state.expiresAt = command.expiresAt;
  } else {
    if (
      command.action === "restore" &&
      state.expiresAt !== null &&
      Date.parse(state.expiresAt) <= Date.parse(at)
    )
      throw Error("document-conflict");
    state.status = command.action === "withdraw" ? "withdrawn" : "active";
  }
}

/** Validate stored history as well as its materialized state; never reset corruption. */
export function lifecycleState(value, id) {
  const initial = {
    schema: 1,
    id,
    revision: 0,
    status: "active",
    expiresAt: null,
    operations: [],
  };
  if (value === undefined) return initial;
  try {
    const state = schema.parse(value);
    if (state.id !== id || state.revision !== state.operations.length)
      throw Error();
    const seen = new Set();
    for (const { command, at } of state.operations) {
      if (
        seen.has(command.operationId) ||
        command.expectedRevision !== initial.revision
      )
        throw Error();
      seen.add(command.operationId);
      transition(initial, command, at);
      initial.revision++;
    }
    if (
      state.status !== initial.status ||
      state.expiresAt !== initial.expiresAt
    )
      throw Error();
    return state;
  } catch {
    throw Error("document-invalid");
  }
}

/** Return an existing outcome or append one bounded, revision-checked decision. */
export function changeLifecycle(state, command, catalogRevision, now) {
  const previous = state.operations.find(
    (v) => v.command.operationId === command.operationId,
  );
  if (previous) {
    if (JSON.stringify(previous.command) !== JSON.stringify(command))
      throw Error("document-conflict");
    return { replayed: true, operation: previous };
  }
  if (
    command.expectedRevision !== state.revision ||
    (command.action === "purge" &&
      command.expectedCatalogRevision !== catalogRevision)
  )
    throw Error("document-conflict");
  // Reserve withdrawal and purge slots so an active document can still be removed.
  if (
    state.operations.length >= 64 ||
    (command.action !== "purge" && state.operations.length >= 63) ||
    (!["withdraw", "purge"].includes(command.action) &&
      state.operations.length >= 62)
  )
    throw Error("document-capacity");
  const operation = { command, at: new Date(now).toISOString() };
  transition(state, command, operation.at);
  state.revision++;
  state.operations.push(operation);
  // Bound UTF-8 bytes too, including multi-byte reasons and future schema edits.
  if (
    new globalThis.TextEncoder().encode(JSON.stringify(state)).byteLength >
    100_000
  )
    throw Error("document-capacity");
  return { replayed: false, operation };
}

/** Expiry controls delivery immediately; physical cleanup is a separate action. */
export function lifecycleExpired(state, now) {
  return state.expiresAt !== null && Date.parse(state.expiresAt) <= now;
}
