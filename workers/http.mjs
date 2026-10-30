import { z } from "zod";
import { hash, bytes } from "./crypto.mjs";
const principal = z
  .object({
    subject: z.string().min(1).max(300),
    sessionId: z.string().min(1).max(300),
  })
  .strict();
export function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export async function readBody(request) {
  if (
    request.headers.get("Content-Type") !== "application/json" ||
    !request.body
  )
    throw Error("invalid-body");
  const reader = request.body.getReader();
  let size = 0;
  let text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) throw Error("body-limit");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Production entry supplies no authenticator; only a separately bundled test entry injects a principal. */
export function createHandler({
  authenticate = null,
  credentialsEnabled = false,
} = {}) {
  return async (request, env) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/"))
      return env.ASSETS
        ? env.ASSETS.fetch(request)
        : json(404, { status: "not-found" });
    if (!authenticate)
      return json(503, {
        status: "auth-unconfigured",
        realKeyInputEnabled: false,
      });
    try {
      const origin = request.headers.get("Origin");
      const browserRead =
        request.method === "GET" &&
        origin === null &&
        request.headers.get("Sec-Fetch-Site") === "same-origin";
      if (
        url.origin !== env.APP_ORIGIN ||
        (origin !== env.APP_ORIGIN && !browserRead) ||
        url.search
      )
        return json(403, { status: "forbidden" });
      const verified = principal.safeParse(await authenticate(request));
      if (!verified.success) return json(401, { status: "unauthenticated" });
      const owner = await hash(verified.data.subject);
      const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(owner));
      if (url.pathname.startsWith("/api/documents/")) {
        const action = url.pathname.slice("/api/documents/".length);
        if (
          !(action === "status" && request.method === "GET") &&
          !(
            request.method === "POST" &&
            ["acquire", "read", "history"].includes(action)
          )
        )
          return json(404, { status: "not-found" });
        const expected = request.headers.get("X-Document-Account");
        if (expected && expected !== owner)
          return json(403, { status: "document-account-changed" });
        const result = await stub.fetch(
          new Request("https://account.internal/command", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: `document-${action}`,
              principal: verified.data,
              csrf: request.headers.get("X-CSRF-Token"),
              data: action === "status" ? null : await readBody(request),
            }),
          }),
        );
        const current = principal.safeParse(await authenticate(request));
        if (
          !current.success ||
          current.data.subject !== verified.data.subject ||
          current.data.sessionId !== verified.data.sessionId
        ) {
          await result.body?.cancel();
          return json(401, { status: "unauthenticated" });
        }
        return result;
      }
      if (url.pathname === "/api/feeds/fetch" && request.method === "POST") {
        const data = await readBody(request);
        return stub.fetch(
          new Request("https://account.internal/command", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "feed-fetch",
              principal: verified.data,
              data,
            }),
          }),
        );
      }
      if (
        url.pathname === "/api/collection" ||
        url.pathname.startsWith("/api/collection/")
      ) {
        const expectedAccount = request.headers.get("X-Collection-Account");
        if (expectedAccount && expectedAccount !== owner)
          return json(403, { status: "collection-account-changed" });
        const snapshot = /^\/api\/collection\/snapshots\/([a-f0-9-]{36})$/.exec(
          url.pathname,
        );
        const action =
          url.pathname === "/api/collection"
            ? { GET: "collection-status", PUT: "collection-configure" }[
                request.method
              ]
            : snapshot && request.method === "GET"
              ? "collection-snapshot"
              : ["/api/collection/ack", "/api/collection/discard"].includes(
                    url.pathname,
                  ) && request.method === "POST"
                ? url.pathname.endsWith("/discard")
                  ? "collection-discard"
                  : "collection-ack"
                : null;
        if (!action) return json(404, { status: "not-found" });
        const data = [
          "collection-configure",
          "collection-ack",
          "collection-discard",
        ].includes(action)
          ? await readBody(request)
          : null;
        return stub.fetch(
          new Request("https://account.internal/command", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action,
              principal: verified.data,
              csrf: request.headers.get("X-CSRF-Token"),
              data,
              id: snapshot?.[1],
            }),
          }),
        );
      }
      let action;
      let provider;
      const match = /^\/api\/credentials\/(openai|anthropic)$/.exec(
        url.pathname,
      );
      const check = /^\/api\/credentials\/(openai|anthropic)\/check$/.exec(
        url.pathname,
      );
      if (request.method === "GET" && url.pathname === "/api/session")
        action = "session";
      else if (request.method === "GET" && url.pathname === "/api/budget")
        action = "budget";
      else if (check && request.method === "POST") {
        provider = check[1];
        action = "check";
      } else if (match) {
        provider = match[1];
        action = {
          GET: "status",
          POST: "register",
          PUT: "replace",
          DELETE: "delete",
          PATCH: "model",
        }[request.method];
      } else if (request.method === "POST" && url.pathname === "/api/proposals")
        action = "propose";
      if (!action) return json(404, { status: "not-found" });
      const mutating = !["session", "budget", "status"].includes(action);
      if (mutating && !credentialsEnabled)
        return json(503, {
          status: "credentials-unconfigured",
          realKeyInputEnabled: false,
        });
      const data = mutating ? await readBody(request) : null;
      return stub.fetch(
        new Request("https://account.internal/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            provider,
            principal: verified.data,
            csrf: request.headers.get("X-CSRF-Token"),
            data,
          }),
        }),
      );
    } catch {
      return json(503, { status: "held" });
    }
  };
}
export async function handleAccount(core, request, collector, documents) {
  try {
    const command = await readBody(request);
    // Internal binding only. No browser-selected owner or credential handles.
    const owner = await core.authorize(
      command.principal,
      command.csrf,
      ![
        "session",
        "budget",
        "status",
        "collection-status",
        "collection-snapshot",
        "feed-fetch",
        "document-status",
      ].includes(command.action),
    );
    if (command.action?.startsWith("document-")) {
      if (!documents) return json(503, { status: "document-unconfigured" });
      return documents.handle(
        owner,
        command.action.slice("document-".length),
        command.data,
      );
    }
    if (command.action === "feed-fetch") {
      if (!collector) throw Error("collection-unconfigured");
      return json(200, await collector.source(command.data));
    }
    if (command.action?.startsWith("collection-")) {
      if (!collector) throw Error("collection-unconfigured");
      let value;
      if (command.action === "collection-status")
        value = await collector.status();
      else if (command.action === "collection-configure")
        value = await collector.configure(command.data);
      else if (command.action === "collection-snapshot")
        value = await collector.snapshot(command.id);
      else if (command.action === "collection-ack")
        value = await collector.acknowledge(command.data);
      else if (command.action === "collection-discard")
        value = await collector.acknowledge(
          z
            .object({ ids: z.array(z.string().uuid()).length(1) })
            .strict()
            .parse(command.data),
        );
      else throw Error("collection-command");
      return json(200, { ...value, account: owner });
    }
    let value;
    if (command.action === "session")
      value = await core.session(command.principal);
    else if (command.action === "status")
      value = await core.status(owner, command.provider);
    else if (command.action === "budget") value = await core.budget(owner);
    else if (command.action === "check")
      value = await core.check(owner, command.provider, command.data);
    else if (command.action === "propose")
      value = await core.propose(owner, command.data);
    else
      value = await core.mutate(
        owner,
        command.provider,
        command.action,
        command.data,
      );
    // Bound responses contain metadata/validated proposal only; never plaintext or ciphertext.
    if (bytes(JSON.stringify(value)).byteLength > 20000)
      throw Error("response-limit");
    return json(200, value);
  } catch (error) {
    const known = [
      "csrf-invalid",
      "owner-mismatch",
      "rate-limit",
      "revision-conflict",
      "id-conflict",
      "state-conflict",
      "model-unapproved",
      "encryption-unconfigured",
      "credential-unavailable",
      "mutation-limit",
      "collection-unconfigured",
      "collection-conflict",
      "collection-capacity",
      "feed-host-unsupported",
      "snapshot-missing",
      "snapshot-invalid",
    ];
    return json(
      error.message === "csrf-invalid" || error.message === "owner-mismatch"
        ? 403
        : error.message === "rate-limit"
          ? 429
          : 409,
      { status: known.includes(error.message) ? error.message : "held" },
    );
  }
}
