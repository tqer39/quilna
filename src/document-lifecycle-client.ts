import { documentIdentity, documentUUID } from "./source-document";
import { sourceURL } from "./feed-discovery";
import {
  lifecycleState,
  type LifecycleState,
  type LifecycleCommand,
} from "./document-lifecycle.mjs";

export type LifecycleContext = {
  target:
    | { audience: "private"; url: string }
    | { audience: "shared"; policyId: string; managementRevision: number };
  scope: string;
  url: string;
};
export type ReservationSummary = {
  reserved: boolean;
  token: string | null;
  revision: number;
  scopeCount: number;
  legacy: boolean;
  containsTarget: boolean;
};
export type LifecyclePreview = Omit<LifecycleState, "schema"> & {
  scope: string;
  sourceURL: string;
  expired: boolean;
  cleanupPending: boolean;
  catalogRevision: number;
  versionCount: number;
  bytes: number;
  reservation: ReservationSummary | { status: "unavailable" };
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown, max: number): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;

/** Keep unavailable accounting distinct from a validated reserved/unreserved summary. */
function validReservation(
  value: unknown,
  context: LifecycleContext,
): value is LifecyclePreview["reservation"] {
  if (object(value) && value.status === "unavailable")
    return Object.keys(value).length === 1;
  if (
    !object(value) ||
    typeof value.reserved !== "boolean" ||
    typeof value.legacy !== "boolean" ||
    typeof value.containsTarget !== "boolean" ||
    !count(value.revision, Number.MAX_SAFE_INTEGER - 1) ||
    !count(value.scopeCount, 100)
  )
    return false;
  if (!value.reserved)
    return (
      value.token === null &&
      value.revision === 0 &&
      value.scopeCount === 0 &&
      !value.legacy &&
      !value.containsTarget
    );
  if (value.token === null)
    return (
      value.revision === 0 &&
      (context.target.audience === "private"
        ? value.scopeCount === 1 && !value.legacy && value.containsTarget
        : value.scopeCount === 0 && value.legacy && !value.containsTarget)
    );
  return (
    documentUUID(value.token) &&
    value.revision > 0 &&
    (value.scopeCount > 0 || value.legacy) &&
    (!value.containsTarget || value.scopeCount > 0)
  );
}

/** Validate identity and replay the audit, rather than trusting a successful status. */
export async function lifecyclePreview(
  value: unknown,
  context: LifecycleContext,
): Promise<LifecyclePreview> {
  if (!object(value)) throw Error("Invalid lifecycle response");
  const id = await documentIdentity(context.scope, context.url);
  if (
    value.id !== id ||
    value.scope !== context.scope ||
    value.sourceURL !== sourceURL(context.url) ||
    !count(value.catalogRevision, Number.MAX_SAFE_INTEGER) ||
    !count(value.versionCount, 100) ||
    !count(value.bytes, 10_000_000) ||
    typeof value.expired !== "boolean" ||
    typeof value.cleanupPending !== "boolean" ||
    !validReservation(value.reservation, context)
  )
    throw Error("Invalid lifecycle identity or summary");
  const state = lifecycleState(
    {
      schema: 1,
      id,
      revision: value.revision,
      status: value.status,
      expiresAt: value.expiresAt,
      operations: value.operations,
    },
    id,
  );
  if (
    (state.status === "deleted" &&
      (value.bytes !== 0 || value.versionCount !== 0)) ||
    (state.expiresAt === null && value.expired) ||
    value.cleanupPending !==
      (value.expired && state.status !== "deleted" && value.versionCount > 0)
  )
    throw Error("Invalid lifecycle state");
  return {
    ...state,
    scope: context.scope,
    sourceURL: context.url,
    expired: value.expired,
    cleanupPending: value.cleanupPending,
    catalogRevision: value.catalogRevision,
    versionCount: value.versionCount,
    bytes: value.bytes,
    reservation: value.reservation,
  };
}

/** Compare acknowledged commands semantically, independent of JSON field order. */
export function sameLifecycleCommand(a: LifecycleCommand, b: LifecycleCommand) {
  return (
    a.operationId === b.operationId &&
    a.action === b.action &&
    a.expectedRevision === b.expectedRevision &&
    a.expectedCatalogRevision === b.expectedCatalogRevision &&
    a.expiresAt === b.expiresAt &&
    a.reason === b.reason
  );
}
