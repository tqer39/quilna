import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["workers/document-catalog.mjs"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  logLevel: "silent",
});
const { DocumentCatalog } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const url = "https://publisher.example.org/article";
const key = "document:catalog:v1";
const body = (n = 1) => ({
  text: `Article ${n}\nconst x = 1;`,
  title: "Article",
  url,
  language: "en",
  fetchedAt: "2026-10-30T00:00:00.000Z",
  structure: { version: 1, links: [], headings: [] },
  codeRanges: [{ start: 10, end: 22, block: true }],
});
const gate = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
class Storage {
  data = new Map();
  queue = Promise.resolve();
  puts = 0;
  failAt = Infinity;
  reads = 0;
  transaction(update) {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      const result = await update({
        get: async (key) => {
          this.reads++;
          return structuredClone(next.get(key));
        },
        put: async (key, value) => {
          if (++this.puts === this.failAt) throw Error("disk-full");
          next.set(key, structuredClone(value));
        },
      });
      this.data = next;
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
function fixture(extra = {}) {
  let time = Date.parse("2026-10-30T01:00:00Z"),
    calls = 0;
  const storage = new Storage();
  const options = {
    scope: "shared:approved-fixture",
    sourceURL: url,
    now: () => time,
    authorize: async (p) => ["alice", "bob"].includes(p),
    load: async () => {
      calls++;
      return { content: body(), validators: { url, etag: '"one"' } };
    },
    ...extra,
  };
  return {
    storage,
    options,
    catalog: new DocumentCatalog(storage, options),
    calls: () => calls,
    advance: (ms) => {
      time += ms;
    },
    restart: () => new DocumentCatalog(storage, options),
  };
}

test("two authorized users reuse one document/version without retaining personal state; unauthorized lookups reveal no cache state", async () => {
  const f = fixture();
  for (const run of [
    () => f.catalog.acquire("eve"),
    () => f.catalog.read("eve"),
    () => f.catalog.history("eve"),
  ])
    await assert.rejects(run(), /document-unavailable/);
  assert.equal(f.storage.reads, 0);
  const a = await f.catalog.acquire("alice"),
    b = await f.restart().acquire("bob");
  assert.equal(f.calls(), 1);
  assert.equal(a.reused, false);
  assert.equal(b.reused, true);
  assert.deepEqual(b.version, a.version);
  assert.deepEqual(b.document, a.document);
  const reads = f.storage.reads;
  await assert.rejects(
    f.catalog.read("eve", a.version.id),
    /document-unavailable/,
  );
  assert.equal(f.storage.reads, reads);
  assert.ok(!JSON.stringify([...f.storage.data]).includes("alice"));
  const privateScope = fixture({
    scope: "private:alice",
    authorize: async (p) => p === "alice",
  });
  const privateBody = await privateScope.catalog.acquire("alice");
  assert.notEqual(privateBody.document.id, a.document.id);
  await assert.rejects(
    privateScope.catalog.read("bob", privateBody.version.id),
    /document-unavailable/,
  );
  const wrongObject = new DocumentCatalog(f.storage, {
    ...f.options,
    scope: "private:alice",
  });
  const before = structuredClone(f.storage.data);
  await assert.rejects(wrongObject.acquire("alice"), /document-invalid/);
  assert.deepEqual(f.storage.data, before);
});

test("concurrent acquisition has one durable lease; restart and expiry fence late results", async () => {
  const started = gate(),
    finish = gate();
  let calls = 0;
  const f = fixture({
    load: async () => {
      calls++;
      if (calls === 1) {
        started.resolve();
        await finish.promise;
        return { content: body(1) };
      }
      return { content: body(2) };
    },
  });
  const first = f.catalog.acquire("alice");
  const lateResult = assert.rejects(first, /document-conflict/);
  await started.promise;
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () => f.restart().acquire("bob")),
  );
  assert.ok(concurrent.every((v) => v.status === "pending"));
  assert.equal(calls, 1);
  f.advance(30_001);
  const recovered = await f.restart().acquire("bob");
  assert.equal(calls, 2);
  finish.resolve();
  await lateResult;
  assert.equal(recovered.version.content.text, body(2).text);
  assert.deepEqual(await f.catalog.read("alice"), recovered.version);
  assert.equal((await f.catalog.history("bob")).versions.length, 1);
});

test("unchanged revalidation retains immutable data; changed and reverted bodies retain all original versions", async () => {
  let phase = 0;
  const f = fixture({
    load: async (_url, previous) => {
      if (phase === 1) {
        assert.equal(previous.validators.etag, '"one"');
        return { notModified: true, url };
      }
      return {
        content: {
          ...body(phase === 2 ? 2 : 1),
          fetchedAt: new Date(
            Date.parse(body().fetchedAt) + phase * 1000,
          ).toISOString(),
        },
        ...(phase === 0 ? { validators: { url, etag: '"one"' } } : {}),
      };
    },
  });
  const first = await f.catalog.acquire("alice");
  phase = 1;
  f.advance(1000);
  const same = await f.restart().acquire("bob", { force: true });
  assert.deepEqual(same.version, first.version);
  assert.notEqual(same.document.checkedAt, first.document.checkedAt);
  phase = 2;
  f.advance(1000);
  const changed = await f.catalog.acquire("alice", { force: true });
  assert.notEqual(changed.version.id, first.version.id);
  assert.equal(changed.document.validators, undefined);
  assert.deepEqual(
    await f.catalog.read("bob", first.version.id),
    first.version,
  );
  phase = 3;
  f.advance(1000);
  const reverted = await f.catalog.acquire("bob", { force: true });
  assert.deepEqual(reverted.version, first.version);
  assert.equal((await f.catalog.history("alice")).versions.length, 2);
});

test("fetch failure, mismatched conditional response and revoked access preserve the last version", async () => {
  let mode = "ok",
    allowed = true;
  const f = fixture({
    authorize: async (p) => p === "bob" || (p === "alice" && allowed),
    load: async () => {
      if (mode === "fail") throw Error("network-failed");
      if (mode === "wrong304")
        return { notModified: true, url: url + "?other" };
      if (mode === "revoke") allowed = false;
      return {
        content: body(mode === "revoke" ? 2 : 1),
        validators: { url, etag: '"one"' },
      };
    },
  });
  const first = await f.catalog.acquire("alice");
  for (const variant of ["fail", "wrong304", "revoke"]) {
    mode = variant;
    await assert.rejects(f.catalog.acquire("alice", { force: true }));
    assert.deepEqual(await f.catalog.read("bob"), first.version);
    assert.equal(f.storage.data.get(key).checkedAt, first.document.checkedAt);
    assert.equal(f.storage.data.get(key).lease, null);
  }
  await assert.rejects(f.catalog.acquire("alice"), /document-unavailable/);
  mode = "ok";
  assert.equal((await f.catalog.acquire("bob", { force: true })).reused, true);
});

test("failed multi-part writes roll back with the pointer and can retry without partial versions", async () => {
  let phase = 0;
  const f = fixture({
    load: async () => ({
      content: phase
        ? { ...body(), text: "😀\n".repeat(60_000), codeRanges: [] }
        : body(),
    }),
  });
  const first = await f.catalog.acquire("alice");
  const before = structuredClone(f.storage.data);
  phase = 1;
  f.storage.failAt = f.storage.puts + 4;
  await assert.rejects(
    f.catalog.acquire("alice", { force: true }),
    /disk-full/,
  );
  assert.deepEqual(f.storage.data, before);
  assert.deepEqual(await f.restart().read("bob"), first.version);
  const updated = await f.catalog.acquire("bob", { force: true });
  assert.equal(updated.version.content.text.length, 180_000);
  assert.deepEqual(await f.restart().read("alice"), updated.version);
  assert.equal((await f.catalog.history("alice")).versions.length, 2);
});

test("history is bounded and paged; capacity failure does not evict evidence and identical versions remain reusable", async () => {
  let n = 0;
  const f = fixture({
    load: async () => ({ content: { ...body(), title: `Version ${n}` } }),
  });
  const ids = [];
  for (n = 0; n < 100; n++) {
    f.advance(1);
    ids.push((await f.catalog.acquire("alice", { force: true })).version.id);
  }
  await assert.rejects(
    f.catalog.acquire("bob", { force: true }),
    /document-capacity/,
  );
  assert.equal((await f.catalog.read("alice")).id, ids.at(-1));
  const seen = [];
  let after;
  do {
    const page = await f.catalog.history("bob", after);
    assert.equal(page.versions.length, 20);
    seen.push(...page.versions.map((v) => v.id));
    if (!page.more) break;
    after = page.versions.at(-1).id;
  } while (seen.length <= 100);
  assert.deepEqual(seen, [...ids].reverse());
  n = 0;
  assert.equal(
    (await f.catalog.acquire("alice", { force: true })).version.id,
    ids[0],
  );
  assert.deepEqual(await f.catalog.history("bob", ids[0]), {
    versions: [],
    more: false,
  });
});

test("unknown schema, altered content and stored source mismatch fail without overwriting evidence", async () => {
  for (const corruption of ["schema", "content", "source", "null"]) {
    const f = fixture();
    const first = await f.catalog.acquire("alice");
    if (corruption === "schema") f.storage.data.get(key).schema = 2;
    if (corruption === "null") f.storage.data.set(key, null);
    if (corruption === "source") f.storage.data.get(key).sourceURL += "?other";
    if (corruption === "content") {
      const part = `document:version:${first.version.id}:0`;
      f.storage.data.set(
        part,
        f.storage.data.get(part).replace("Article 1", "Article X"),
      );
    }
    const before = structuredClone(f.storage.data);
    await assert.rejects(f.catalog.acquire("bob"));
    await assert.rejects(f.catalog.read("alice"));
    assert.deepEqual(f.storage.data, before);
  }
});

test("identical text at different query URLs is not merged and malformed loader output cannot create a version", async () => {
  const first = await fixture().catalog.acquire("alice");
  const second = await fixture({
    sourceURL: url + "?edition=2",
  }).catalog.acquire("alice");
  assert.notEqual(first.document.id, second.document.id);
  for (const value of [
    { notModified: true, url },
    { content: body(), notModified: "true" },
    { content: body(), validators: null },
    { content: { ...body(), document: first.document } },
    {
      content: {
        ...body(),
        codeRanges: [{ start: 0, end: 9999, block: true }],
      },
    },
    { content: body(), validators: { url: url + "?other", etag: '"one"' } },
  ]) {
    const f = fixture({ load: async () => value });
    await assert.rejects(f.catalog.acquire("alice"), /document-response/);
    assert.deepEqual((await f.catalog.history("bob")).versions, []);
  }
});

test("a corrupted old immutable version cannot become current on a later reversion", async () => {
  let phase = 1;
  const f = fixture({ load: async () => ({ content: body(phase) }) });
  const first = await f.catalog.acquire("alice");
  phase = 2;
  const second = await f.catalog.acquire("alice", { force: true });
  const part = `document:version:${first.version.id}:0`;
  f.storage.data.set(
    part,
    f.storage.data.get(part).replace("Article 1", "Article X"),
  );
  const before = structuredClone(f.storage.data);
  phase = 1;
  await assert.rejects(
    f.catalog.acquire("bob", { force: true }),
    /document-invalid/,
  );
  assert.deepEqual(f.storage.data, before);
  assert.deepEqual(await f.catalog.read("bob"), second.version);
});

test("the byte budget and expired leases preserve existing versions without silent eviction", async () => {
  let n = 0;
  const f = fixture({
    load: async () => ({
      content: {
        ...body(),
        text: "😀".repeat(90_000),
        codeRanges: [],
        title: String(n++),
      },
    }),
  });
  let last;
  for (let i = 0; i < 27; i++)
    last = await f.catalog.acquire("alice", { force: true });
  await assert.rejects(
    f.catalog.acquire("bob", { force: true }),
    /document-capacity/,
  );
  assert.deepEqual(await f.catalog.read("bob"), last.version);
  assert.equal(f.storage.data.get(key).versions.length, 27);
  assert.ok(f.storage.data.get(key).bytes < 10_000_000);
  const slow = fixture({
    load: async () => {
      slow.advance(30_001);
      return { content: body() };
    },
  });
  await assert.rejects(slow.catalog.acquire("alice"), /document-conflict/);
  assert.deepEqual((await slow.catalog.history("bob")).versions, []);
  assert.equal(slow.storage.data.get(key).lease, null);
  const denied = fixture({ authorize: async () => ({ allowed: true }) });
  await assert.rejects(denied.catalog.acquire("alice"), /document-unavailable/);
  assert.equal(denied.storage.reads, 0);
});

test("explicit revalidation of legacy formatting fetches HTML once and retains the prior immutable version", async () => {
  let calls = 0;
  const legacy = body();
  delete legacy.structure;
  const f = fixture({
    load: async (_url, previous) => {
      calls++;
      if (calls === 1)
        return { content: legacy, validators: { url, etag: '"same"' } };
      assert.equal(previous.validators, undefined);
      return { content: body(), validators: { url, etag: '"same"' } };
    },
  });
  const first = await f.catalog.acquire("alice");
  await f.catalog.acquire("bob");
  assert.equal(calls, 1);
  const enriched = await f.catalog.acquire("alice", { force: true });
  assert.notEqual(enriched.version.id, first.version.id);
  assert.equal(enriched.version.content.text, first.version.content.text);
  assert.deepEqual(
    (await f.catalog.read("alice", first.version.id)).content,
    legacy,
  );
});
