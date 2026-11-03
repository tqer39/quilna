import { z } from "zod";
import { DocumentPolicyAdmin } from "./document-policy-admin.mjs";
import { lifecycleCommand } from "../src/document-lifecycle.mjs";

const target = z.discriminatedUnion("audience", [
  z
    .object({ audience: z.literal("private"), url: z.string().max(2048) })
    .strict(),
  z
    .object({
      audience: z.literal("shared"),
      policyId: z.string().uuid(),
      managementRevision: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER - 1),
    })
    .strict(),
]);
export const lifecycleRequest = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("reconcile"),
      target,
      reservation: z
        .object({
          token: z.string().uuid().nullable(),
          revision: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER - 1),
        })
        .strict()
        .refine((value) => (value.token === null) === (value.revision === 0)),
    })
    .strict(),
  z.object({ action: z.literal("preview"), target }).strict(),
  z
    .object({ action: z.literal("change"), target, command: lifecycleCommand })
    .strict(),
]);

/** Resolve a management target without granting access to its retained bodies. */
export async function documentLifecycleAccess(
  env,
  owner,
  rawTarget,
  { restore = false, now = Date.now } = {},
) {
  const admin = new DocumentPolicyAdmin(env, now);
  if (!admin.enabled(owner)) throw Error("document-unavailable");
  const input = target.parse(rawTarget);
  if (input.audience === "private")
    return {
      url: admin.url(input.url),
      scope: `private:${owner}`,
      audience: "private",
    };
  const read = async (action, data) => {
    const response = await admin.handle(owner, action, data);
    const value = await response.json();
    if (response.status !== 200 || value.account !== owner || !value.policy)
      throw Error(
        response.status === 404 ? "document-unavailable" : "document-invalid",
      );
    return value.policy;
  };
  // Administrative history remains available after a delivery grant expires or
  // changes generation. The client never chooses a raw scope or another owner.
  const current = await read("admin-read", { id: input.policyId });
  const policy =
    input.managementRevision === current.managementRevision
      ? current
      : await read("admin-revision", {
          id: input.policyId,
          revision: input.managementRevision,
        });
  if (!admin.enabled(owner)) throw Error("document-unavailable");
  if (
    restore &&
    (!current.enabled ||
      current.expires <= now() ||
      current.policyRevision !== policy.policyRevision)
  )
    throw Error("document-unavailable");
  return {
    url: policy.url,
    scope: `shared:${policy.id}:${policy.policyRevision}`,
    audience: "shared",
  };
}
