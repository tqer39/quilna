import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const source = (
  await build({
    entryPoints: ["workers/document-gateway.mjs"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  })
).outputFiles[0].text;
const { DocumentGateway } = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);

test("source quota is atomic across simultaneous reservations, survives reconstruction and never resets corrupt state", async () => {
  const data = new Map();
  let tail = Promise.resolve();
  const storage = {
    transaction: (update) => {
      const work = tail.then(() =>
        update({
          get: async (k) => data.get(k),
          put: async (k, v) => {
            data.set(k, v);
          },
        }),
      );
      tail = work.catch(() => {});
      return work;
    },
  };
  let gateway = new DocumentGateway(storage, {});
  const same = "https://publisher.example.org/same";
  await Promise.all(
    Array.from({ length: 8 }, () =>
      gateway.reserve("owner", same, "private", "private:owner"),
    ),
  );
  assert.equal(data.get("documents:source-count"), 1);
  const attempts = await Promise.allSettled(
    Array.from({ length: 1000 }, (_, i) =>
      gateway.reserve(
        "owner",
        `https://publisher.example.org/${i}`,
        "private",
        "private:owner",
      ),
    ),
  );
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 999);
  assert.equal(
    attempts.filter((r) => r.status === "rejected")[0].reason.message,
    "document-capacity",
  );
  assert.equal(data.get("documents:source-count"), 1000);
  gateway = new DocumentGateway(storage, {});
  await gateway.reserve("owner", same, "private", "private:owner");
  await assert.rejects(
    gateway.reserve(
      "owner",
      "https://publisher.example.org/new",
      "private",
      "private:owner",
    ),
    /document-capacity/,
  );
  data.set("documents:source-count", null);
  await assert.rejects(
    gateway.reserve("owner", same, "private", "private:owner"),
    /document-invalid/,
  );
  assert.equal(data.get("documents:source-count"), null);
});

for (const failure of ["corrupt-count", "storage-failure"]) {
  test(`${failure} does not hide a committed lifecycle result or its preview`, async () => {
    const owner = "a".repeat(64),
      url = "https://publisher.example.org/article";
    const data = new Map([["documents:source-count", null]]);
    let writes = 0,
      commits = 0,
      current;
    const storage = {
      transaction: async (fn) =>
        fn({
          get: async (key) => {
            if (failure === "storage-failure") throw Error("disk-unavailable");
            return data.get(key);
          },
          put: async () => {
            writes++;
          },
          delete: async () => {
            writes++;
          },
        }),
    };
    const env = {
      DOCUMENTS_ENABLED: "true",
      DOCUMENT_ADMIN_ENABLED: "true",
      DOCUMENT_ADMIN_OWNER_HASH: owner,
      DOCUMENT_ACCESS_DB: { withSession() {} },
      DOCUMENTS: {
        idFromName: (id) => id,
        get: (id) => ({
          fetch: async (request) => {
            const { request: input } = await request.json();
            if (input.action === "change") {
              commits++;
              current = {
                id,
                scope: `private:${owner}`,
                sourceURL: url,
                revision: 1,
                status: "withdrawn",
                expiresAt: null,
                expired: false,
                cleanupPending: false,
                catalogRevision: 1,
                versionCount: 1,
                bytes: 1234,
                operations: [
                  { command: input.command, at: "2026-11-03T00:00:00.000Z" },
                ],
              };
              return Response.json({
                current,
                operation: current.operations[0],
                replayed: false,
              });
            }
            return Response.json(current);
          },
        }),
      },
    };
    const gateway = new DocumentGateway(storage, env);
    const target = { audience: "private", url };
    const response = await gateway.handle(owner, "admin-document-change", {
      target,
      command: {
        operationId: crypto.randomUUID(),
        action: "withdraw",
        expectedRevision: 0,
        reason: "Stop delivery",
      },
    });
    assert.equal(commits, 1);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.current, {
      ...current,
      reservation: { status: "unavailable" },
    });
    assert.deepEqual(result.operation, current.operations[0]);
    const preview = await gateway.handle(owner, "admin-document-preview", {
      target,
    });
    assert.equal(preview.status, 200);
    assert.deepEqual(await preview.json(), {
      ...current,
      reservation: { status: "unavailable" },
      account: owner,
    });
    assert.equal(writes, 0);
    assert.equal(data.get("documents:source-count"), null);
  });
}

test("acquire releases only its new reservation with exact permanent-deletion proof", async () => {
  for (const scenario of [
    "exact",
    "missing",
    "wrong-id",
    "wrong-scope",
    "wrong-source",
    "existing",
    "legacy",
    "reallocated",
    "other-source",
  ]) {
    const owner = "a".repeat(64),
      url = "https://publisher.example.org/purged";
    const data = new Map();
    const storage = {
      transaction: async (fn) =>
        fn({
          get: async (key) => structuredClone(data.get(key)),
          put: async (key, value) => data.set(key, structuredClone(value)),
          delete: async (key) => data.delete(key),
        }),
    };
    let gateway;
    const env = {
      DOCUMENTS_ENABLED: "true",
      DOCUMENTS: {
        idFromName: (id) => id,
        get: (id) => ({
          fetch: async () => {
            const deletion = { id, scope: `private:${owner}`, sourceURL: url };
            if (scenario === "wrong-id") deletion.id = crypto.randomUUID();
            if (scenario === "wrong-scope")
              deletion.scope = `private:${"b".repeat(64)}`;
            if (scenario === "wrong-source") deletion.sourceURL += "/other";
            if (scenario === "reallocated") {
              const key = [...data.keys()].find((k) =>
                k.startsWith("documents:source:"),
              );
              data.get(key).token = crypto.randomUUID();
            }
            if (scenario === "other-source")
              await gateway.reserve(
                owner,
                url + "/other",
                "private",
                `private:${owner}`,
              );
            return Response.json(
              {
                status: "document-unavailable",
                ...(scenario === "missing" ? {} : { deletion }),
              },
              { status: 404 },
            );
          },
        }),
      },
    };
    gateway = new DocumentGateway(storage, env);
    if (["existing", "legacy"].includes(scenario)) {
      await gateway.reserve(owner, url, "private", `private:${owner}`);
      if (scenario === "legacy") {
        const key = [...data.keys()].find((k) =>
          k.startsWith("documents:source:"),
        );
        data.set(key, true);
      }
    }
    const response = await gateway.handle(owner, "acquire", {
      url,
      audience: "private",
    });
    assert.equal(response.status, 404, scenario);
    assert.deepEqual(
      await response.json(),
      { status: "document-unavailable", account: owner },
      scenario,
    );
    assert.equal(
      data.get("documents:source-count"),
      scenario === "exact" ? 0 : 1,
      scenario,
    );
  }
});
