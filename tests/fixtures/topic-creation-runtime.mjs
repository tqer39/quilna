import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode, hash } from "../../workers/crypto.mjs";
const script = (
  await build({
    entryPoints: ["tests/workers/topic-creation-api-entry.mjs"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    external: ["cloudflare:workers"],
    logLevel: "silent",
  })
).outputFiles[0].text;
export const url = "https://publisher.example.org/model",
  policy = "11111111-1111-4111-8111-111111111111";
export async function creationRuntime(
  after,
  {
    scenario,
    origin = "http://creation.test",
    server = {},
    bindings = {},
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "quilna-creation-api-")),
    owner = await hash("better-auth:creation-fixture-user");
  let originCalls = 0,
    sourceRevision = 1;
  const options = {
    ...server,
    modules: true,
    script,
    compatibilityDate: "2026-10-11",
    resourcePersistencePath: directory,
    d1Databases: {
      AUTH_DB: "creation-auth",
      DOCUMENT_ACCESS_DB: "creation-documents",
    },
    durableObjects: {
      ACCOUNTS: { className: "AccountVault", useSQLite: true },
      DOCUMENTS: { className: "SourceDocument", useSQLite: true },
      TOPIC_TEXTBOOK_CREATIONS: { className: "Creations", useSQLite: true },
    },
    ratelimits: {
      PUBLIC_DOCUMENT_RATE_LIMITER: {
        namespace_id: "9001",
        simple: { limit: 1000, period: 60 },
      },
    },
    bindings: {
      ...bindings,
      APP_ORIGIN: origin,
      GOOGLE_ALLOWED_EMAIL: "creation@example.test",
      DOCUMENTS_ENABLED: "true",
      PUBLIC_DOCUMENTS_ENABLED: "true",
      TOPIC_TEXTBOOK_CREATIONS_ENABLED: "true",
      TEST_INSTANCE_ID: "before-restart",
      FIXTURE_REVOKE_REVIEW_COUNT:
        scenario === "review-after-count" ? "true" : "false",
      FIXTURE_NEGATIVE_REVIEW:
        scenario === "negative-review" ? "true" : "false",
      FIXTURE_BLOCK_REVIEW: scenario === "retry-review" ? "true" : "false",
      FIXTURE_REVOKE_AFTER_COUNT: scenario === "after-count" ? "true" : "false",
      BYOK_ENCRYPTION_KEYRING: JSON.stringify({
        active: "fixture",
        keys: {
          fixture: encode(crypto.getRandomValues(new Uint8Array(32))),
        },
      }),
    },
    outboundService: async (request) => {
      assert.equal(request.url, url);
      assert.equal(request.headers.get("Authorization"), null);
      assert.equal(request.headers.get("Cookie"), null);
      originCalls++;
      return new Response(
        `<article><h1>モデルと保存</h1><p>${"モデルは文章を出力します。保存の成功は保存処理の結果で確認します。".repeat(20)}</p><p>原文の版${sourceRevision}</p></article>`,
        {
          headers: {
            "Content-Type": "text/html",
            ETag: `"${sourceRevision}"`,
          },
        },
      );
    },
  };
  let mf = new Miniflare(convertV4MiniflareOptions(options));
  after(async () => {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const auth = await mf.getD1Database("AUTH_DB");
  await auth.exec(
    (await readFile("migrations/auth/0001_better_auth.sql", "utf8")).replaceAll(
      "\n",
      " ",
    ),
  );
  await auth
    .prepare(
      'INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)',
    )
    .bind("creation-fixture-user", "Fixture", "creation@example.test", 1, 0, 0)
    .run();
  const database = await mf.getD1Database("DOCUMENT_ACCESS_DB");
  for (const name of [
    "0001_access.sql",
    "0002_source_aliases.sql",
    "0003_policy_management.sql",
    "0004_policy_history.sql",
    "0005_publications.sql",
    "0006_publication_management.sql",
  ])
    await database.exec(
      (await readFile("migrations/documents/" + name, "utf8"))
        .replace(/^--.*$/gm, "")
        .replaceAll("\n", " "),
    );
  await database
    .prepare(
      "INSERT INTO document_policies(id,source_url,revision,enabled,expires,evidence) VALUES(?,?,1,1,?,?)",
    )
    .bind(
      policy,
      url,
      Date.now() + 3600000,
      "Synthetic source permits fixture reuse",
    )
    .run();
  await database
    .prepare("INSERT INTO document_members(policy_id,owner_hash) VALUES(?,?)")
    .bind(policy, owner)
    .run();
  await database
    .prepare(
      "INSERT INTO document_publications(policy_id,policy_revision,enabled,expires,evidence) VALUES(?,1,1,?,?)",
    )
    .bind(policy, Date.now() + 3600000, "Synthetic public rights")
    .run();
  let csrf;
  const request = async (path, body, extra = {}) =>
    mf.dispatchFetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        Origin: origin,
        "X-Test-Principal": "owner",
        "X-Library-Account": owner,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const call = async (path, body) => {
    const response = await request(path, body);
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  csrf = (await call("/api/session")).csrfToken;
  await call("/api/credentials/openai", {
    requestId: crypto.randomUUID(),
    expectedRevision: 0,
    key: "DUMMY-CREATION-API",
    model: "gpt-6-luna",
  });
  await call("/api/documents/acquire", { url, audience: "shared" });
  async function restart(bindings) {
    await mf.dispose();
    Object.assign(options.bindings, bindings);
    mf = new Miniflare(convertV4MiniflareOptions(options));
    await mf.ready;
  }
  return {
    owner,
    database,
    call,
    request,
    restart,
    get originCalls() {
      return originCalls;
    },
    updateSource() {
      sourceRevision++;
    },
    get runtime() {
      return mf;
    },
  };
}
