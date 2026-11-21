import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const bundle = await build({
  stdin: {
    contents:
      'export { prepareTopicEvidence } from "./workers/topic-preparation.mjs"; export { documentIdentity, representationHash, versionIdentity } from "./src/source-document.ts"; export { parseTextbookRequest } from "./src/shared-textbook-format.ts";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  logLevel: "silent",
});
const directory = await mkdtemp(join(tmpdir(), "quilna-topic-preparation-"));
const file = join(directory, "preparation.mjs");
await writeFile(file, bundle.outputFiles[0].text);
const {
  prepareTopicEvidence,
  documentIdentity,
  representationHash,
  versionIdentity,
  parseTextbookRequest,
} = await import(pathToFileURL(file).href).finally(() =>
  rm(directory, { recursive: true, force: true }),
);
const owner = "a".repeat(64),
  policy = "11111111-1111-4111-8111-111111111111",
  url = "https://publisher.example.org/rss";
async function fixture() {
  const scope = `shared:${policy}:1`,
    documentId = await documentIdentity(scope, url);
  const content = {
    url,
    title: "RSSの仕組み",
    text: "RSSは更新を配信します。キャッシュしたデータを再利用します。",
    language: "ja",
    fetchedAt: "2026-11-18T00:00:00.000Z",
  };
  const digest = await representationHash(content);
  const version = {
    id: await versionIdentity(documentId, digest),
    documentId,
    scope,
    sourceURL: url,
    representationHash: digest,
    formatVersion: 1,
    createdAt: content.fetchedAt,
    content,
  };
  const state = {
    access: 0,
    reads: 0,
    revoked: false,
    invalid: false,
    failed: false,
    rows: [{ id: policy, source_url: url }],
    queries: [],
  };
  const env = {
    APP_ORIGIN: "https://app.test",
    PUBLIC_DOCUMENTS_ENABLED: "true",
    PUBLIC_DOCUMENT_RATE_LIMITER: {
      limit: async ({ key }) => {
        assert.equal(key, "topic-preparation");
        return { success: true };
      },
    },
    DOCUMENTS_ENABLED: "true",
    DOCUMENT_ACCESS_DB: {
      withSession(mode) {
        assert.equal(mode, "first-primary");
        return {
          prepare(sql) {
            return {
              bind(...values) {
                state.queries.push({ sql, values });
                return {
                  async all() {
                    if (state.failed) throw Error("D1 unavailable");
                    return { success: true, results: state.rows };
                  },
                  async first() {
                    state.access++;
                    if (state.revoked) return null;
                    return {
                      id: policy,
                      revision: state.revision ?? 1,
                      expires: Date.now() + 100000,
                      publication_expires: Date.now() + 100000,
                      evidence: "synthetic public policy",
                      publication_evidence: "synthetic publication",
                    };
                  },
                };
              },
            };
          },
        };
      },
    },
    DOCUMENTS: {
      idFromName(id) {
        assert.equal(id, documentId);
        return id;
      },
      get() {
        return {
          async fetch(request) {
            state.reads++;
            assert.equal(request.url, "https://document.internal/public-read");
            assert.deepEqual(await request.json(), { url, scope });
            return Response.json(
              state.invalid
                ? { ...version, content: { ...content, text: "changed text" } }
                : version,
            );
          },
        };
      },
    },
  };
  return { env, state, version };
}
test("公開の保存本文からテーマの原文とfingerprintを準備し、サイト取得・生成へ進めない", async () => {
  const f = await fixture();
  const result = await prepareTopicEvidence(
    owner,
    { topic: "RSSの仕組み" },
    f.env,
  );
  assert.equal(result.account, owner);
  assert.equal(result.inspected, 1);
  assert.equal(result.unavailable, 0);
  assert.equal(f.state.reads, 1);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].source.excerpt, f.version.content.text);
  await parseTextbookRequest(
    JSON.stringify({
      schemaVersion: 2,
      id: crypto.randomUUID(),
      topic: { id: crypto.randomUUID(), name: "RSS" },
      learningGoal: "仕組みを理解する",
      sources: result.sources.map((c) => c.source),
    }),
  );
  assert.equal(f.state.queries[0].values[0], "");
  assert.match(
    f.state.queries[0].sql,
    /source_revision = p.publication_revision/,
  );
});
test("公開設定なし・読めないDB・壊れた本文・失効した公開許可を候補へ混ぜない", async () => {
  const f = await fixture();
  await assert.rejects(
    prepareTopicEvidence(
      owner,
      { topic: "RSS" },
      { ...f.env, PUBLIC_DOCUMENTS_ENABLED: "false" },
    ),
    /unconfigured/,
  );
  f.state.failed = true;
  await assert.rejects(prepareTopicEvidence(owner, { topic: "RSS" }, f.env));
  f.state.failed = false;
  f.state.invalid = true;
  const invalid = await prepareTopicEvidence(owner, { topic: "RSS" }, f.env);
  assert.equal(invalid.sources.length, 0);
  assert.equal(invalid.unavailable, 1);
  f.state.invalid = false;
  f.state.revoked = true;
  const denied = await prepareTopicEvidence(owner, { topic: "RSS" }, f.env);
  assert.equal(denied.sources.length, 0);
  assert.equal(denied.unavailable, 1);
});
test("候補の最終確認までに許可が取り消された場合も返さない", async () => {
  const f = await fixture();
  const original = f.env.DOCUMENT_ACCESS_DB.withSession;
  f.env.DOCUMENT_ACCESS_DB.withSession = (...args) => {
    if (f.state.access >= 2) f.state.revoked = true;
    return original(...args);
  };
  const result = await prepareTopicEvidence(owner, { topic: "RSS" }, f.env);
  assert.equal(result.sources.length, 0);
  assert.equal(result.unavailable, 1);
});
test("曖昧な一般語、所有者注入、異常なカーソル順序を拒否する", async () => {
  const f = await fixture();
  await assert.rejects(
    prepareTopicEvidence(owner, { topic: "について" }, f.env),
    /topic-preparation-topic/,
  );
  await assert.rejects(
    prepareTopicEvidence(owner, { topic: "RSS", owner }, f.env),
  );
  f.state.rows.push({ ...f.state.rows[0] });
  await assert.rejects(
    prepareTopicEvidence(owner, { topic: "RSS" }, f.env),
    /unavailable/,
  );
});
for (const change of ["revoked", "scope"])
  test(`保存本文を読んだ直後の${change}変更でも根拠を返さない`, async () => {
    const f = await fixture();
    const original = f.env.DOCUMENTS.get;
    f.env.DOCUMENTS.get = (...args) => {
      const stub = original(...args);
      return {
        async fetch(request) {
          const response = await stub.fetch(request);
          if (change === "revoked") f.state.revoked = true;
          else f.state.revision = 2;
          return response;
        },
      };
    };
    const page = await prepareTopicEvidence(owner, { topic: "RSS" }, f.env);
    assert.equal(page.sources.length, 0);
    assert.equal(page.unavailable, 1);
    assert.equal(f.state.reads, 1);
  });
test("探索全体の流量制限はD1に触れる前に適用し、匿名閲覧と異なる固定枠を使う", async () => {
  const f = await fixture();
  let reads = 0;
  for (const [limiter, expected] of [
    [undefined, /unconfigured/],
    [
      {
        limit: async ({ key }) => {
          assert.equal(key, "topic-preparation");
          return { success: false };
        },
      },
      /rate-limit/,
    ],
    [
      {
        limit: async ({ key }) => {
          assert.equal(key, "topic-preparation");
          return {};
        },
      },
      /unavailable/,
    ],
  ]) {
    const env = Object.create(f.env);
    env.PUBLIC_DOCUMENT_RATE_LIMITER = limiter;
    Object.defineProperty(env, "DOCUMENT_ACCESS_DB", {
      get() {
        reads++;
        throw Error("DBへ到達してはいけません");
      },
    });
    await assert.rejects(
      prepareTopicEvidence(owner, { topic: "RSS" }, env),
      expected,
    );
  }
  assert.equal(reads, 0);
});
test("識別できる1資料の壊れたURLは他の資料の準備を止めない", async () => {
  const f = await fixture();
  f.state.rows.unshift({
    id: "00000001-1111-4111-8111-111111111111",
    source_url: "x".repeat(3000),
  });
  const result = await prepareTopicEvidence(owner, { topic: "RSS" }, f.env);
  assert.equal(result.inspected, 2);
  assert.equal(result.unavailable, 1);
  assert.equal(result.sources.length, 1);
});
