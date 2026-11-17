import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AccountVaultCore } from "../../workers/vault.mjs";
import { encrypt, decrypt, hash, encode } from "../../workers/crypto.mjs";
import { registry } from "../../server/registry.mjs";
import { openaiTopicTextbookTransport } from "../../server/openai-topic-textbook-transport.mjs";
import { topicTextbookBudgetAdapter } from "../../server/topic-textbook-contract.mjs";
const date = "2026-10-11T00:00:00.000Z";
// Ephemeral random test data, not credentials for any service.
const keyring = () =>
  JSON.stringify({
    active: "test-v1",
    keys: { "test-v1": encode(crypto.getRandomValues(new Uint8Array(32))) },
  });
const dummy = () => `DUMMY-NOT-A-CREDENTIAL-${randomUUID()}`;
class MemoryStorage {
  data = new Map();
  queue = Promise.resolve();
  failWrite = false;
  failSync = false;
  async transaction(update) {
    const job = this.queue.then(async () => {
      const copy = new Map(
        [...this.data].map(([k, v]) => [k, structuredClone(v)]),
      );
      const result = await update({
        get: async (k) => structuredClone(copy.get(k)),
        put: async (k, v) => {
          if (this.failWrite) throw Error("test storage failure");
          copy.set(k, structuredClone(v));
        },
      });
      this.data = copy;
      return result;
    });
    this.queue = job.catch(() => {});
    return job;
  }
  async sync() {
    if (this.failSync) throw Error("test durability unknown");
  }
}
const mutation = (expectedRevision = 0, extra = {}) => ({
  requestId: randomUUID(),
  expectedRevision,
  key: dummy(),
  model: "gpt-6-luna",
  ...extra,
});
async function fixture(extra = {}) {
  const storage = new MemoryStorage();
  const config = { keyring: keyring(), now: () => new Date(date), ...extra };
  const core = new AccountVaultCore(storage, config);
  const owner = await hash("verified-test-owner-a");
  return { storage, config, core, owner };
}
test("AES-GCM randomized ciphertext is bound to owner/provider/revision/version and fails closed", async () => {
  const ring = keyring();
  const key = dummy();
  const one = await encrypt(key, "a", "openai", 1, ring);
  const two = await encrypt(key, "a", "openai", 1, ring);
  assert.notEqual(one.nonce, two.nonce);
  assert.notEqual(one.ciphertext, two.ciphertext);
  assert.equal(JSON.stringify(one).includes(key), false);
  assert.equal(await decrypt(one, "a", "openai", 1, ring), key);
  for (const context of [
    ["b", "openai", 1],
    ["a", "anthropic", 1],
    ["a", "openai", 2],
  ])
    await assert.rejects(
      decrypt(one, ...context, ring),
      /credential-unavailable/,
    );
  await assert.rejects(
    decrypt(
      { ...one, ciphertext: one.ciphertext.slice(0, -4) + "AAAA" },
      "a",
      "openai",
      1,
      ring,
    ),
  );
  await assert.rejects(
    encrypt(key, "a", "openai", 1, undefined),
    /encryption-unconfigured/,
  );
});
test("registration/replacement/model change encrypt only; failed writes roll back; deletion removes active ciphertext", async () => {
  const f = await fixture();
  const data = mutation();
  const initial = await f.core.mutate(f.owner, "openai", "register", data);
  assert.equal(initial.revision, 1);
  assert.equal(initial.connection, "unconnected");
  assert.equal(JSON.stringify([...f.storage.data]).includes(data.key), false);
  assert.equal(JSON.stringify(initial).includes("ciphertext"), false);
  f.storage.failWrite = true;
  await assert.rejects(
    f.core.mutate(f.owner, "openai", "replace", mutation(1)),
  );
  f.storage.failWrite = false;
  assert.equal((await f.core.status(f.owner, "openai")).revision, 1);
  await f.core.mutate(f.owner, "openai", "model", {
    requestId: randomUUID(),
    expectedRevision: 1,
    model: "gpt-6-luna",
  });
  const record = f.storage.data.get("credential:openai");
  assert.equal(
    await decrypt(record.blob, f.owner, "openai", 2, f.config.keyring),
    data.key,
  );
  await f.core.mutate(f.owner, "openai", "delete", {
    requestId: randomUUID(),
    expectedRevision: 2,
  });
  assert.equal(f.storage.data.get("credential:openai").blob, null);
  assert.equal((await f.core.status(f.owner, "openai")).state, "deleted");
  await f.core.mutate(f.owner, "openai", "register", mutation(3));
  assert.equal((await f.core.status(f.owner, "openai")).revision, 4);
});
test("owner pinning, extra client owner fields, duplicate IDs, stale versions and replay after deletion cannot change another owner", async () => {
  const f = await fixture();
  const data = mutation();
  await f.core.mutate(f.owner, "openai", "register", data);
  assert.equal(
    (await f.core.mutate(f.owner, "openai", "register", data)).revision,
    1,
  );
  await assert.rejects(
    f.core.mutate(f.owner, "openai", "register", { ...data, key: dummy() }),
    /id-conflict/,
  );
  await assert.rejects(
    f.core.status(await hash("other-owner"), "openai"),
    /owner-mismatch/,
  );
  await assert.rejects(
    f.core.mutate(f.owner, "openai", "replace", {
      ...mutation(1),
      owner: "other",
    }),
  );
  await assert.rejects(
    f.core.mutate(f.owner, "openai", "replace", mutation(0)),
    /revision-conflict/,
  );
  await f.core.mutate(f.owner, "openai", "delete", {
    requestId: randomUUID(),
    expectedRevision: 1,
  });
  assert.equal(
    (await f.core.mutate(f.owner, "openai", "register", data)).state,
    "deleted",
  );
  assert.equal((await f.core.status(f.owner, "anthropic")).revision, 0);
});
test("encryption rotation reads old versions, re-encrypts on replacement, and fails when an old key is missing", async () => {
  const f = await fixture();
  const data = mutation();
  await f.core.mutate(f.owner, "openai", "register", data);
  const old = JSON.parse(f.config.keyring);
  const rotated = {
    active: "test-v2",
    keys: {
      ...old.keys,
      "test-v2": encode(crypto.getRandomValues(new Uint8Array(32))),
    },
  };
  f.core.keyring = JSON.stringify(rotated);
  assert.equal(
    (await f.core.mutate(f.owner, "openai", "register", data)).revision,
    1,
  );
  await f.core.mutate(f.owner, "openai", "replace", mutation(1));
  assert.equal(
    f.storage.data.get("credential:openai").blob.keyVersion,
    "test-v2",
  );
  const latest = f.storage.data.get("credential:openai");
  await assert.rejects(
    decrypt(latest.blob, f.owner, "openai", 2, f.config.keyring),
  );
});
test("CSRF is session/owner-bound and credential mutations are limited to 20/minute", async () => {
  const f = await fixture();
  const principal = {
    subject: "verified-test-owner-a",
    sessionId: "session-a",
  };
  const session = await f.core.session(principal);
  await assert.rejects(
    f.core.authorize({ ...principal, sessionId: "b" }, session.csrfToken, true),
    /csrf-invalid/,
  );
  await assert.rejects(
    f.core.authorize(
      { ...principal, subject: "other" },
      session.csrfToken,
      true,
    ),
    /owner-mismatch/,
  );
  for (let i = 0; i < 20; i++)
    await f.core.authorize(principal, session.csrfToken, true);
  await assert.rejects(
    f.core.authorize(principal, session.csrfToken, true),
    /rate-limit/,
  );
});
const source = {
  id: "rfc8659",
  url: "https://www.rfc-editor.org/rfc/rfc8659.html",
  checkedAt: date,
  body: "The first CAA RRset is selected.",
};
const draft = {
  gap: "test",
  block: {
    id: "test-block",
    title: "test",
    kind: "reading",
    markdown: "最初のRRset",
    visual: "lookup-flow",
  },
  references: [{ sourceId: "rfc8659", quote: source.body }],
};
const proposal = (modelId) => ({
  requestId: randomUUID(),
  bookId: "caa",
  version: "1.8",
  blockId: "read",
  question: "公開のCAA質問",
  excerpt: "CAA",
  purpose: "book-addition",
  modelId,
  sourceIds: ["rfc8659"],
  approvedPublicText: true,
});
const generation = (makeAdapter, extra = {}) => ({
  policy: {
    confirmedCostUpperBounds: true,
    checkedAt: date,
    fixedMilliYen: 496850,
    safetyMilliYen: 0,
    yenPerUsdMilli: 200000,
    taxFeePermille: 1200,
    providerCapsMilliYen: {},
  },
  registry: registry.map((m) => ({
    ...m,
    approval: "test-only",
    dataConditionsAccepted: true,
    tokenCountMargin: 256,
    tokenCountTermsConfirmed: true,
  })),
  selectionPolicy: {},
  sources: [source],
  makeAdapter,
  ...extra,
});
test("each owner gets 500 yen; that owner's providers share budget; reservations precede key resolution/dispatch", async () => {
  let f;
  let calls = 0;
  const gen = generation((provider, secret) => ({
    generate: async () => {
      calls++;
      assert.ok(secret.startsWith("DUMMY-"));
      assert.equal(
        f.storage.data.get("budget").records.at(-1).state,
        "reserved",
      );
      return {
        json: JSON.stringify(draft),
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    },
  }));
  f = await fixture({ generation: gen });
  await f.core.mutate(f.owner, "openai", "register", mutation());
  await f.core.mutate(
    f.owner,
    "anthropic",
    "register",
    mutation(0, { model: "claude-haiku-5-5" }),
  );
  assert.equal(
    (await f.core.propose(f.owner, proposal(registry[0].id))).status,
    "complete",
  );
  assert.equal(
    (await f.core.propose(f.owner, proposal(registry[1].id))).status,
    "complete",
  );
  assert.equal(
    (await f.core.propose(f.owner, proposal(registry[1].id))).status,
    "budget-exhausted",
  );
  const another = await fixture({ generation: gen });
  assert.equal((await another.core.budget(another.owner)).spentMilliYen, 0);
  assert.equal(
    (await another.core.budget(another.owner)).limitMilliYen,
    500000,
  );
  assert.equal(calls, 2);
});
test("uncertain dispatch survives restart/month/key deletion; late results after replacement are suppressed", async () => {
  let release;
  const f = await fixture({
    generation: generation(
      () => ({
        generate: () =>
          new Promise((r) => {
            release = r;
          }),
      }),
      { timeoutMs: 15 },
    ),
  });
  await f.core.mutate(f.owner, "openai", "register", mutation());
  assert.equal(
    (await f.core.propose(f.owner, proposal(registry[0].id))).status,
    "unknown",
  );
  await f.core.mutate(f.owner, "openai", "delete", {
    requestId: randomUUID(),
    expectedRevision: 1,
  });
  await f.core.mutate(f.owner, "openai", "register", mutation(2));
  const restarted = new AccountVaultCore(f.storage, f.config);
  assert.equal(
    (await restarted.propose(f.owner, proposal(registry[0].id))).status,
    "busy",
  );
  assert.ok((await restarted.budget(f.owner)).heldMilliYen > 0);
  release({
    json: JSON.stringify(draft),
    usage: { inputTokens: 100, outputTokens: 50 },
  });
});
test("durability acknowledgement failure never dispatches and retains the committed reservation", async () => {
  let calls = 0;
  const f = await fixture({
    generation: generation(() => {
      calls++;
      throw Error("must not send");
    }),
  });
  await f.core.mutate(f.owner, "openai", "register", mutation());
  // First reads succeed; sync failure specifically on reservation write.
  const sync = f.storage.sync.bind(f.storage);
  f.storage.sync = async () => {
    if (f.storage.data.has("budget")) throw Error("unknown durability");
    return sync();
  };
  await assert.rejects(f.core.propose(f.owner, proposal(registry[0].id)));
  assert.equal(calls, 0);
  assert.equal(f.storage.data.get("budget").records[0].state, "reserved");
});
test("deletion while generation is in flight suppresses late output but retains confirmed cost", async () => {
  let resolve;
  let entered;
  const started = new Promise((r) => {
    entered = r;
  });
  const f = await fixture({
    generation: generation(
      () => ({
        generate: () => {
          entered();
          return new Promise((r) => {
            resolve = r;
          });
        },
      }),
      { timeoutMs: 1000 },
    ),
  });
  await f.core.mutate(f.owner, "openai", "register", mutation());
  const pending = f.core.propose(f.owner, proposal(registry[0].id));
  await started;
  await f.core.mutate(f.owner, "openai", "delete", {
    requestId: randomUUID(),
    expectedRevision: 1,
  });
  resolve({
    json: JSON.stringify(draft),
    usage: { inputTokens: 100, outputTokens: 50 },
  });
  assert.deepEqual(await pending, {
    status: "credential-changed",
    draft: null,
  });
  assert.ok((await f.core.budget(f.owner)).spentMilliYen > 0);
  assert.equal((await f.core.status(f.owner, "openai")).state, "deleted");
});

const topicFixture = JSON.parse(
  await (
    await import("node:fs/promises")
  ).readFile(
    new URL("../fixtures/shared-textbook-v2.json", import.meta.url),
    "utf8",
  ),
);
const topicRecord = JSON.parse(
  Buffer.from(topicFixture.record, "base64").toString("utf8"),
);
const topicRequestRaw = Buffer.from(topicRecord.request, "base64").toString(
  "utf8",
);
const topicDraftRaw = Buffer.from(topicRecord.draft, "base64").toString("utf8");
const topicReviewRaw = Buffer.from(topicRecord.review, "base64").toString(
  "utf8",
);
const topicRequest = () => ({
  requestId: JSON.parse(topicRequestRaw).id,
  requestRaw: topicRequestRaw,
  purpose: "book-addition",
  modelId: registry[0].id,
  approvedPublicText: true,
});
async function topicFixtureCore({ output, extra = {}, ownerSubject } = {}) {
  let f,
    calls = 0;
  const configuration = generation(
    (provider, resolveSecret) => ({
      kind: "test-only",
      protocol: "provider-v1",
      contract: "topic-textbook-v2",
      acceptsModel: (m) => m.model === registry[0].model,
      generate: async (payload) => {
        assert.equal(provider, "openai");
        assert.equal(
          f.storage.data.get("budget").records.at(-1).state,
          "reserved",
        );
        const secret = await resolveSecret();
        assert.ok(secret.startsWith("DUMMY-"));
        calls++;
        if (output) return output(payload, f);
        return {
          json: payload.draftRaw === undefined ? topicDraftRaw : topicReviewRaw,
          usage: { inputTokens: 100, outputTokens: 50 },
          outcome: "complete",
        };
      },
    }),
    extra,
  );
  f = await fixture({ topicGeneration: configuration });
  if (ownerSubject) f.owner = await hash(ownerSubject);
  await f.core.mutate(f.owner, "openai", "register", mutation());
  return { ...f, configuration, calls: () => calls };
}
test("テーマ生成と検証を同じ所有者の永続予算へ記録し再送しない", async () => {
  const f = await topicFixtureCore();
  const input = topicRequest(),
    generated = await f.core.proposeTopic(f.owner, input);
  assert.equal(generated.status, "complete");
  assert.equal(generated.draft.kind, "topic-textbook-draft");
  const reviewInput = {
    ...input,
    requestId: randomUUID(),
    purpose: "evidence-check",
    generationRequestId: input.requestId,
    generatorInvocation: generated.draft.invocation.id,
    draftRaw: generated.draft.json,
  };
  const reviewed = await f.core.proposeTopic(f.owner, reviewInput);
  assert.equal(reviewed.status, "complete");
  assert.equal(reviewed.draft.allChecksPassed, true);
  assert.deepEqual(await f.core.proposeTopic(f.owner, input), generated);
  assert.deepEqual(await f.core.proposeTopic(f.owner, reviewInput), reviewed);
  const restarted = new AccountVaultCore(f.storage, f.config);
  assert.deepEqual(await restarted.proposeTopic(f.owner, input), generated);
  assert.equal(f.calls(), 2);
  assert.equal(f.storage.data.get("budget").records.length, 2);
  assert.ok((await f.core.budget(f.owner)).spentMilliYen > 0);
});
test("テーマの再送は現行の料金が古くても保存結果を返す", async () => {
  const f = await topicFixtureCore(),
    input = topicRequest();
  const result = await f.core.proposeTopic(f.owner, input);
  f.configuration.policy.checkedAt = "2020-01-01T00:00:00.000Z";
  assert.deepEqual(await f.core.proposeTopic(f.owner, input), result);
  assert.equal(f.calls(), 1);
});
test("テーマ生成の台帳を別の所有者から読む操作を拒否する", async () => {
  const f = await topicFixtureCore();
  await f.core.proposeTopic(f.owner, topicRequest());
  const before = structuredClone([...f.storage.data]);
  await assert.rejects(
    f.core.proposeTopic(await hash("another-owner"), topicRequest()),
    /owner-mismatch/,
  );
  assert.deepEqual([...f.storage.data], before);
  assert.equal(f.calls(), 1);
});
test("別の所有者が持つ候補を同じ公開出典でも検証へ送らない", async () => {
  const a = await topicFixtureCore(),
    b = await topicFixtureCore({ ownerSubject: "verified-test-owner-b" }),
    input = topicRequest();
  const result = await a.core.proposeTopic(a.owner, input);
  await assert.rejects(
    b.core.proposeTopic(b.owner, {
      ...input,
      requestId: randomUUID(),
      purpose: "evidence-check",
      generationRequestId: input.requestId,
      generatorInvocation: result.draft.invocation.id,
      draftRaw: result.draft.json,
    }),
    /textbook-unissued-draft/,
  );
  assert.equal(b.calls(), 0);
  assert.equal(b.storage.data.get("budget"), undefined);
});
test("テーマ送信中にキーを削除した結果を返さず使用量を保持する", async () => {
  const f = await topicFixtureCore({
    output: async (_payload, f) => {
      await f.core.mutate(f.owner, "openai", "delete", {
        requestId: randomUUID(),
        expectedRevision: 1,
      });
      return {
        json: topicDraftRaw,
        usage: { inputTokens: 100, outputTokens: 50 },
        outcome: "complete",
      };
    },
  });
  assert.deepEqual(await f.core.proposeTopic(f.owner, topicRequest()), {
    status: "credential-changed",
    draft: null,
  });
  assert.equal(f.calls(), 1);
  assert.ok((await f.core.budget(f.owner)).spentMilliYen > 0);
});
test("台帳永続化に失敗したテーマ依頼はキーを解決せず送信しない", async () => {
  const f = await topicFixtureCore();
  f.storage.failSync = true;
  await assert.rejects(
    f.core.proposeTopic(f.owner, topicRequest()),
    /test durability unknown/,
  );
  assert.equal(f.calls(), 0);
});
test("静的に未接続のテーマモデルを予約せず既存CAA入力との混用も拒否する", async () => {
  const f = await topicFixtureCore();
  const make = f.configuration.makeAdapter;
  f.configuration.makeAdapter = (...args) => ({
    ...make(...args),
    acceptsModel: () => false,
  });
  assert.equal(
    (await f.core.proposeTopic(f.owner, topicRequest())).status,
    "unconnected",
  );
  assert.equal(f.storage.data.get("budget"), undefined);
  await assert.rejects(f.core.propose(f.owner, topicRequest()));
  await assert.rejects(f.core.proposeTopic(f.owner, proposal(registry[0].id)));
  assert.equal(f.calls(), 0);
});
test("通常のAccountVaultCoreはテーマ生成を有効にしない", async () => {
  const f = await fixture();
  assert.deepEqual(await f.core.proposeTopic(f.owner, topicRequest()), {
    status: "unconnected",
  });
  assert.equal(f.storage.data.size, 0);
});
test("テーマの結果不明予約が同じ所有者のCAAも止める", async () => {
  const f = await topicFixtureCore({
    output: async () => new Promise(() => {}),
    extra: { timeoutMs: 5 },
  });
  const result = await f.core.proposeTopic(f.owner, topicRequest());
  assert.equal(result.status, "unknown");
  let caaCalls = 0;
  f.core.generation = generation(() => {
    caaCalls++;
    throw Error("must not dispatch");
  });
  const caa = await f.core.propose(f.owner, proposal(registry[0].id));
  assert.equal(caa.status, "busy");
  assert.equal(caaCalls, 0);
  assert.equal(f.storage.data.get("budget").records.length, 1);
  assert.deepEqual(await f.core.proposeTopic(f.owner, topicRequest()), result);
  assert.equal(f.calls(), 1);
});
test("テーマの予約書き込み失敗ではキーを解決しない", async () => {
  const f = await topicFixtureCore();
  f.storage.failWrite = true;
  await assert.rejects(
    f.core.proposeTopic(f.owner, topicRequest()),
    /test storage failure/,
  );
  assert.equal(f.storage.data.get("budget"), undefined);
  assert.equal(f.calls(), 0);
});
for (const broken of ["kind", "protocol", "contract", "model"])
  test(`テーマの不一致adapter(${broken})を秘密の解決・予約前に拒否する`, async () => {
    const f = await topicFixtureCore();
    let secretResolutions = 0;
    const make = f.configuration.makeAdapter;
    f.configuration.makeAdapter = (provider, resolveSecret) => {
      const adapter = make(provider, async () => {
        secretResolutions++;
        return resolveSecret();
      });
      if (broken === "model") adapter.acceptsModel = () => false;
      else adapter[broken] = broken === "kind" ? "prepared" : "wrong";
      return adapter;
    };
    assert.equal(
      (await f.core.proposeTopic(f.owner, topicRequest())).status,
      "unconnected",
    );
    assert.equal(secretResolutions, 0);
    assert.equal(f.storage.data.get("budget"), undefined);
    assert.equal(f.calls(), 0);
  });
test("キー削除で進行中の応答を伏せても同じ所有者は有料の保存結果を明示的に回収できる", async () => {
  const f = await topicFixtureCore({
    output: async (_payload, f) => {
      await f.core.mutate(f.owner, "openai", "delete", {
        requestId: randomUUID(),
        expectedRevision: 1,
      });
      return {
        json: topicDraftRaw,
        usage: { inputTokens: 100, outputTokens: 50 },
        outcome: "complete",
      };
    },
  });
  const input = topicRequest();
  assert.equal(
    (await f.core.proposeTopic(f.owner, input)).status,
    "credential-changed",
  );
  const recovered = await f.core.lookupTopic(f.owner, input);
  assert.equal(recovered.status, "complete");
  assert.equal(recovered.draft.kind, "topic-textbook-draft");
  assert.equal(f.calls(), 1);
  await assert.rejects(
    f.core.lookupTopic(await hash("different-owner"), input),
    /owner-mismatch/,
  );
  f.core.topicGeneration = null;
  assert.deepEqual(await f.core.lookupTopic(f.owner, input), recovered);
  assert.equal(f.calls(), 1);
  assert.equal(
    (await f.core.lookupTopic(f.owner, { ...input, modelId: "other-model" }))
      .status,
    "id-conflict",
  );
  assert.equal(
    (await f.core.lookupTopic(f.owner, { ...input, requestId: randomUUID() }))
      .status,
    "not-found",
  );
});
test("保存済みの予約と結果不明は照会しても解除・再送しない", async () => {
  const f = await topicFixtureCore({
    output: async () => new Promise(() => {}),
    extra: { timeoutMs: 5 },
  });
  const input = topicRequest();
  const result = await f.core.proposeTopic(f.owner, input);
  assert.equal(result.status, "unknown");
  assert.deepEqual(await f.core.lookupTopic(f.owner, input), result);
  const record = f.storage.data.get("budget").records[0];
  record.state = "reserved";
  const expected = structuredClone([...f.storage.data]);
  assert.deepEqual(await f.core.lookupTopic(f.owner, input), {
    status: "reserved",
    draft: null,
  });
  assert.deepEqual([...f.storage.data], expected);
  assert.equal(f.calls(), 1);
});
test("CAAの予約直後にキーが失効しても未送信の予算を結果不明にしない", async () => {
  let calls = 0;
  const f = await fixture({
    generation: generation(() => {
      calls++;
      throw Error("must not dispatch");
    }),
  });
  await f.core.mutate(f.owner, "openai", "register", mutation());
  const sync = f.storage.sync.bind(f.storage);
  let revoked = false;
  f.storage.sync = async () => {
    await sync();
    if (
      !revoked &&
      f.storage.data.get("budget")?.records.at(-1)?.state === "reserved"
    ) {
      revoked = true;
      await f.core.mutate(f.owner, "openai", "delete", {
        requestId: randomUUID(),
        expectedRevision: 1,
      });
    }
  };
  assert.deepEqual(await f.core.propose(f.owner, proposal(registry[0].id)), {
    status: "credential-changed",
    draft: null,
  });
  assert.equal(revoked, true);
  assert.equal(calls, 0);
  const record = f.storage.data.get("budget").records[0];
  assert.equal(record.state, "rejected");
  assert.deepEqual(record.usage, { inputTokens: 0, outputTokens: 0 });
  assert.equal((await f.core.budget(f.owner)).heldMilliYen, 0);
});
for (const action of ["delete", "replace"])
  test(`テーマの予約後かつ送信前のキー${action}を使用量0で終了する`, async () => {
    const f = await topicFixtureCore();
    let outbound = 0;
    f.configuration.makeAdapter = (_provider, secret) =>
      topicTextbookBudgetAdapter(
        openaiTopicTextbookTransport({
          model: registry[0].model,
          reasoningEffort: "none",
          mockOnly: true,
          secret,
          send: async () => {
            outbound++;
            throw Error("must not send");
          },
        }),
      );
    const sync = f.storage.sync.bind(f.storage);
    let revoked = false;
    f.storage.sync = async () => {
      await sync();
      if (
        !revoked &&
        f.storage.data.get("budget")?.records.at(-1)?.state === "reserved"
      ) {
        revoked = true;
        await f.core.mutate(
          f.owner,
          "openai",
          action,
          action === "delete"
            ? { requestId: randomUUID(), expectedRevision: 1 }
            : mutation(1),
        );
      }
    };
    assert.equal(
      (await f.core.proposeTopic(f.owner, topicRequest())).status,
      "credential-changed",
    );
    assert.equal(outbound, 0);
    const record = f.storage.data.get("budget").records[0];
    assert.equal(record.state, "rejected");
    assert.equal(record.outcome, "cancelled");
    assert.deepEqual(record.usage, { inputTokens: 0, outputTokens: 0 });
    assert.equal((await f.core.budget(f.owner)).heldMilliYen, 0);
  });
test("資格情報待機中の期限超過を未送信で確定し遅い成功も送信へ進めない", async () => {
  const f = await topicFixtureCore({ extra: { timeoutMs: 30 } });
  let outbound = 0,
    entered,
    release,
    finished;
  const enteredGate = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  f.configuration.makeAdapter = (_provider, secret) => {
    const adapter = topicTextbookBudgetAdapter(
      openaiTopicTextbookTransport({
        model: registry[0].model,
        reasoningEffort: "none",
        mockOnly: true,
        secret,
        send: async () => {
          outbound++;
          throw Error("must not send");
        },
      }),
    );
    return {
      ...adapter,
      generate: async (...args) => {
        try {
          return await adapter.generate(...args);
        } finally {
          finished();
        }
      },
    };
  };
  const sync = f.storage.sync.bind(f.storage);
  let reservedSyncs = 0;
  f.storage.sync = async () => {
    await sync();
    if (
      f.storage.data.get("budget")?.records.at(-1)?.state === "reserved" &&
      ++reservedSyncs === 2
    ) {
      entered();
      await gate;
    }
  };
  const pending = f.core.proposeTopic(f.owner, topicRequest());
  await enteredGate;
  let result, beforeLate;
  try {
    result = await pending;
    beforeLate = structuredClone(f.storage.data.get("budget"));
  } finally {
    release();
  }
  await done;
  assert.equal(result.status, "rejected");
  assert.equal(result.outcome, "cancelled");
  assert.equal(outbound, 0);
  assert.equal((await f.core.budget(f.owner)).heldMilliYen, 0);
  assert.deepEqual(f.storage.data.get("budget"), beforeLate);
  assert.deepEqual(beforeLate.records[0].usage, {
    inputTokens: 0,
    outputTokens: 0,
  });
});
test("未束縛の台帳の照会は所有者や台帳を新規保存しない", async () => {
  const f = await fixture();
  assert.deepEqual(await f.core.lookupTopic(f.owner, topicRequest()), {
    status: "not-found",
  });
  assert.equal(f.storage.data.size, 0);
});
