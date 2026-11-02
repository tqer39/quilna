import { z } from "zod";
import { hash } from "./crypto.mjs";

const principalSchema = z
  .object({
    subject: z.string().min(1).max(300),
    sessionId: z.string().min(1).max(300),
  })
  .strict();
const accountPattern = /^[a-f0-9]{64}$/;
function response(status, value) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    },
  });
}

/**
 * Return a server-verified local-library assignment without accessing library
 * content or granting access to shared documents. Browser namespacing must opt
 * in separately; this endpoint alone does not isolate existing browser data.
 */
export async function libraryStatus(request, env, authenticate) {
  if (env.LIBRARY_ISOLATION_ENABLED !== "true")
    return response(404, { status: "not-found" });
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const browserRead =
    request.method === "GET" &&
    origin === null &&
    request.headers.get("Sec-Fetch-Site") === "same-origin";
  if (
    url.origin !== env.APP_ORIGIN ||
    url.search ||
    (origin !== env.APP_ORIGIN && !browserRead)
  )
    return response(403, { status: "forbidden" });
  if (request.method !== "GET")
    return response(405, { status: "method-not-allowed" });
  if (
    typeof env.LIBRARY_LEGACY_OWNER_HASH !== "string" ||
    !accountPattern.test(env.LIBRARY_LEGACY_OWNER_HASH) ||
    typeof authenticate !== "function"
  )
    return response(503, { status: "library-unconfigured" });
  try {
    const before = principalSchema.safeParse(await authenticate(request));
    if (!before.success) return response(401, { status: "unauthenticated" });
    const account = await hash(before.data.subject);
    const expected = request.headers.get("X-Library-Account");
    if (expected !== null && expected !== account)
      return response(403, { status: "account-mismatch" });
    // Recheck after the asynchronous hash, including the session, not just user.
    const after = principalSchema.safeParse(await authenticate(request));
    if (!after.success) return response(401, { status: "unauthenticated" });
    if (
      before.data.subject !== after.data.subject ||
      before.data.sessionId !== after.data.sessionId
    )
      return response(403, { status: "account-mismatch" });
    return response(200, {
      schema: 1,
      account,
      legacy: account === env.LIBRARY_LEGACY_OWNER_HASH,
    });
  } catch {
    return response(503, { status: "library-unavailable" });
  }
}
