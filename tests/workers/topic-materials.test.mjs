import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const bundle = await build({
  stdin: {
    contents: `export { verifyTopicMaterials, authorizeTopicMaterials } from './workers/topic-materials.mjs';
export { prepareTopicEvidence } from './workers/topic-preparation.mjs';
export { topicSourceSnapshot } from './workers/topic-public-sources.mjs';
export { documentIdentity, representationHash, versionIdentity } from './src/source-document.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  logLevel: "silent",
});
const dir = await mkdtemp(join(tmpdir(), "quilna-topic-materials-")),
  file = join(dir, "materials.mjs");
await writeFile(file, bundle.outputFiles[0].text);
const {
  verifyTopicMaterials,
  authorizeTopicMaterials,
  prepareTopicEvidence,
  topicSourceSnapshot,
  documentIdentity,
  representationHash,
  versionIdentity,
} = await import(pathToFileURL(file).href).finally(() =>
  rm(dir, { recursive: true, force: true }),
);
const url = "https://publisher.example.org/article",
  policy = "11111111-1111-4111-8111-111111111111";
async function fixture() {
  const scope = `shared:${policy}:1`,
    documentId = await documentIdentity(scope, url);
  const content = {
    url,
    title: "RSSの仕組み",
    text: "RSSは更新を配信します。保存した原文を再利用します。🌱",
    language: "ja",
    fetchedAt: "2026-11-18T00:00:00.000Z",
    info: { published: "2026-11-17T00:00:00.000Z" },
  };
  const representation = await representationHash(content);
  const version = {
    id: await versionIdentity(documentId, representation),
    documentId,
    scope,
    sourceURL: url,
    representationHash: representation,
    formatVersion: 1,
    createdAt: content.fetchedAt,
    content,
  };
  const state = {
    quota: true,
    keys: [],
    access: 0,
    reads: 0,
    revoked: false,
    revokeAt: Infinity,
    changedVersion: false,
    tampered: false,
  };
  const env = {
    APP_ORIGIN: "https://app.test",
    PUBLIC_DOCUMENTS_ENABLED: "true",
    DOCUMENTS_ENABLED: "true",
    PUBLIC_DOCUMENT_RATE_LIMITER: {
      limit: async ({ key }) => {
        state.keys.push(key);
        return { success: state.quota };
      },
    },
    DOCUMENT_ACCESS_DB: {
      withSession(mode) {
        assert.equal(mode, "first-primary");
        return {
          prepare() {
            return {
              bind() {
                return {
                  all: async () => ({
                    success: true,
                    results: [{ id: policy, source_url: url }],
                  }),
                  first: async () => {
                    state.access++;
                    return state.revoked || state.access >= state.revokeAt
                      ? null
                      : {
                          id: policy,
                          revision: 1,
                          expires: Date.now() + 60000,
                          publication_expires: Date.now() + 60000,
                          evidence: "synthetic source rights",
                          publication_evidence: "synthetic public rights",
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
      idFromName: (id) => id,
      get(id) {
        assert.equal(id, documentId);
        return {
          fetch: async (request) => {
            state.reads++;
            assert.equal(request.url, "https://document.internal/public-read");
            const input = await request.json();
            assert.deepEqual(input, {
              url,
              scope,
              ...(input.versionId ? { versionId: version.id } : {}),
            });
            const value = structuredClone(version);
            if (state.changedVersion) value.id = crypto.randomUUID();
            if (state.tampered) value.content.text += "改ざん";
            return Response.json(value);
          },
        };
      },
    },
  };
  const source = await topicSourceSnapshot(version, content.text);
  const request = {
    schemaVersion: 2,
    id: crypto.randomUUID(),
    topic: { id: crypto.randomUUID(), name: "RSS" },
    learningGoal: "更新の配信を理解する",
    sources: [source],
  };
  return {
    env,
    state,
    request,
    version,
    source,
    raw: () => JSON.stringify(request),
  };
}

test("公開資料の準備結果を保存原文と照合し、元サイトの取得なしで同じ出典を確認する", async () => {
  const f = await fixture();
  const prepared = await prepareTopicEvidence(
    "a".repeat(64),
    { topic: "RSS" },
    f.env,
  );
  assert.equal(prepared.sources.length, 1);
  f.request.sources = [prepared.sources[0].source];
  assert.deepEqual(await verifyTopicMaterials(f.raw(), f.env), f.request);
  assert.deepEqual(f.state.keys, [
    "topic-preparation",
    "topic-creation-material",
  ]);
  assert.equal(f.state.reads, 2);
});

for (const field of [
  "id",
  "title",
  "capturedAt",
  "publishedAt",
  "updatedAt",
  "sourceFingerprint",
  "excerpt",
  "url",
])
  test(`資料の ${field} の差し替えを許さない`, async () => {
    const f = await fixture(),
      source = f.request.sources[0];
    if (field === "id") source.id = crypto.randomUUID();
    if (field === "title") source.title = "別の題名";
    if (field === "capturedAt") source.capturedAt++;
    if (field === "publishedAt") source.publishedAt = null;
    if (field === "updatedAt") source.updatedAt = 1;
    if (field === "sourceFingerprint")
      source.sourceFingerprint = "0".repeat(64);
    if (field === "excerpt") {
      source.excerpt = "原文にない文章";
      Object.assign(
        source,
        await topicSourceSnapshot(f.version, source.excerpt),
      );
    }
    if (field === "url") source.url = "https://publisher.example.org/other";
    await assert.rejects(verifyTopicMaterials(f.raw(), f.env));
  });

for (const variant of [
  "revoke",
  "revoke-after-read",
  "revoke-at-final-check",
  "version",
  "representation",
])
  test(`公開資料の ${variant} を拒否する`, async () => {
    const f = await fixture();
    if (variant === "revoke") f.state.revoked = true;
    if (variant === "revoke-after-read") f.state.revokeAt = 2;
    if (variant === "revoke-at-final-check") f.state.revokeAt = 3;
    if (variant === "version") f.state.changedVersion = true;
    if (variant === "representation") f.state.tampered = true;
    await assert.rejects(verifyTopicMaterials(f.raw(), f.env));
  });

test("全体の流量枠を文書D1照会前に使い、枠不足/不正設定では保存資料を読まない", async () => {
  const f = await fixture();
  f.state.quota = false;
  await assert.rejects(verifyTopicMaterials(f.raw(), f.env), /rate-limit/);
  assert.equal(f.state.access, 0);
  assert.equal(f.state.reads, 0);
  f.state.quota = undefined;
  await assert.rejects(verifyTopicMaterials(f.raw(), f.env), /unavailable/);
  assert.equal(f.state.access, 0);
  delete f.env.PUBLIC_DOCUMENT_RATE_LIMITER;
  await assert.rejects(verifyTopicMaterials(f.raw(), f.env), /unconfigured/);
  assert.equal(f.state.access, 0);
});

test("記事依存の旧依頼と重複資料を作成の根拠として通さない", async () => {
  const f = await fixture();
  f.request.sources.push({ ...f.source });
  await assert.rejects(verifyTopicMaterials(f.raw(), f.env));
  f.request.schemaVersion = 1;
  delete f.request.topic;
  await assert.rejects(verifyTopicMaterials(f.raw(), f.env));
});

test("草案確認と送信直前の全体枠を分け、草案枠の不足で承認済みの送信枠を消費しない", async () => {
  const f = await fixture();
  f.env.PUBLIC_DOCUMENT_RATE_LIMITER.limit = async ({ key }) => {
    f.state.keys.push(key);
    return { success: key === "topic-creation-dispatch" };
  };
  await assert.rejects(verifyTopicMaterials(f.raw(), f.env), /rate-limit/);
  await verifyTopicMaterials(f.raw(), f.env, Date.now, { dispatch: true });
  assert.deepEqual(f.state.keys, [
    "topic-creation-material",
    "topic-creation-dispatch",
  ]);
});

test("段階の最大3回分の確認枠を最初に確保し、その後も現在の資料を読み直す", async () => {
  const f = await fixture();
  f.env.PUBLIC_DOCUMENT_RATE_LIMITER.limit = async ({ key }) => {
    assert.equal(f.state.access, 0);
    f.state.keys.push(key);
    return { success: true };
  };
  const verify = await authorizeTopicMaterials(f.raw(), f.env);
  assert.equal(f.state.reads, 0);
  assert.deepEqual(f.state.keys, Array(3).fill("topic-creation-dispatch"));
  const first = await verify();
  first.sources[0].title = "戻り値を変える";
  f.state.revoked = true;
  await assert.rejects(verify());
  f.state.revoked = false;
  assert.equal((await verify()).sources[0].title, f.source.title);
  await assert.rejects(verify(), /unavailable/);
  assert.equal(f.state.reads, 2);
});

test("段階の枠が途中までしか確保できなければ計数前に止め、文書DBへ触れない", async () => {
  const f = await fixture();
  let count = 0;
  f.env.PUBLIC_DOCUMENT_RATE_LIMITER.limit = async () => ({
    success: ++count < 3,
  });
  await assert.rejects(authorizeTopicMaterials(f.raw(), f.env), /rate-limit/);
  assert.equal(count, 3);
  assert.equal(f.state.access, 0);
  assert.equal(f.state.reads, 0);
});
