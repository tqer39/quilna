import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { hash } from "../../workers/crypto.mjs";
const bundle = await build({
  entryPoints: ["workers/document-reservations.mjs"],
  bundle: true,
  write: false,
  platform: "neutral",
  format: "esm",
  logLevel: "silent",
});
const { DocumentReservations } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const owner = "a".repeat(64),
  url = "https://publisher.example.org/article",
  id = "12345678-1234-4234-8234-123456789abc";
const scope = (n) => `shared:${id}:${n}`;
const countKey = "documents:source-count";
function fixture() {
  const data = new Map();
  let tail = Promise.resolve(),
    writes = 0,
    failAt = Infinity;
  const storage = {
    transaction(update) {
      const work = tail.then(async () => {
        const next = structuredClone(data);
        const result = await update({
          get: async (k) => structuredClone(next.get(k)),
          put: async (k, v) => {
            if (++writes === failAt) throw Error("disk-full");
            next.set(k, structuredClone(v));
          },
          delete: async (k) => {
            if (++writes === failAt) throw Error("disk-full");
            next.delete(k);
          },
        });
        data.clear();
        for (const [k, v] of next) data.set(k, v);
        return result;
      });
      tail = work.catch(() => {});
      return work;
    },
  };
  return {
    data,
    storage,
    reservations: new DocumentReservations(storage),
    failAfter: (n) => {
      failAt = writes + n;
    },
  };
}
test("recovery never releases another generation and rejects a stale reservation preview", async () => {
  const f = fixture(),
    r = f.reservations;
  const first = await r.reserve(owner, url, "shared", scope(1));
  assert.equal(typeof first.token, "string");
  assert.equal(await r.reserve(owner, url, "shared", scope(1)), undefined);
  await r.reserve(owner, url, "shared", scope(2));
  const before = structuredClone(f.data);
  await assert.rejects(
    r.releaseDeleted(owner, url, "shared", scope(1), first),
    /document-conflict/,
  );
  assert.deepEqual(f.data, before);
  const current = await r.inspect(owner, url, "shared", scope(1));
  const one = await r.releaseDeleted(owner, url, "shared", scope(1), current);
  assert.equal(one.reserved, true);
  assert.equal(one.scopeCount, 1);
  assert.equal(f.data.get(countKey), 1);
  const two = await r.releaseDeleted(owner, url, "shared", scope(2), one);
  assert.equal(two.reserved, false);
  assert.equal(f.data.get(countKey), 0);
  assert.deepEqual(
    await new DocumentReservations(f.storage).releaseDeleted(
      owner,
      url,
      "shared",
      scope(2),
      one,
    ),
    two,
  );
  await r.reserve(owner, url, "shared", scope(2));
  await assert.rejects(
    r.releaseDeleted(owner, url, "shared", scope(2), one),
    /document-conflict/,
  );
  assert.equal(f.data.get(countKey), 1);
});
test("quota recovery rolls back a failed count update and never touches a different source", async () => {
  const f = fixture(),
    r = f.reservations;
  await r.reserve(owner, url, "shared", scope(1));
  await r.reserve(owner, url + "/other", "shared", scope(1));
  const expected = await r.inspect(owner, url, "shared", scope(1));
  const before = structuredClone(f.data);
  f.failAfter(2);
  await assert.rejects(
    r.releaseDeleted(owner, url, "shared", scope(1), expected),
    /disk-full/,
  );
  assert.deepEqual(f.data, before);
  await r.releaseDeleted(owner, url, "shared", scope(1), expected);
  assert.equal(f.data.get(countKey), 1);
  assert.equal(
    (await r.inspect(owner, url + "/other", "shared", scope(1))).reserved,
    true,
  );
});
test("legacy reservations retain their unknown generations and corrupt accounting is never reset", async () => {
  const f = fixture(),
    r = f.reservations;
  const key = "documents:source:" + (await hash([owner, url, "shared"]));
  f.data.set(key, true);
  f.data.set(countKey, 1);
  assert.equal((await r.inspect(owner, url, "shared", scope(1))).legacy, true);
  await r.reserve(owner, url, "shared", scope(2));
  const expected = await r.inspect(owner, url, "shared", scope(2));
  assert.equal(expected.legacy, true);
  const held = await r.releaseDeleted(owner, url, "shared", scope(2), expected);
  assert.equal(held.reserved, true);
  assert.equal(held.scopeCount, 0);
  assert.equal(held.legacy, true);
  assert.equal(f.data.get(countKey), 1);
  for (const bad of [null, -1, 1001, 0]) {
    f.data.set(countKey, bad);
    const before = structuredClone(f.data);
    await assert.rejects(
      r.inspect(owner, url, "shared", scope(2)),
      /document-invalid/,
    );
    assert.deepEqual(f.data, before);
  }
});

test("scope tracking is bounded without evicting prior generations or accepting malformed scopes", async () => {
  const f = fixture(),
    r = f.reservations;
  for (let n = 1; n <= 100; n++)
    await r.reserve(owner, url, "shared", scope(n));
  const before = structuredClone(f.data);
  await assert.rejects(
    r.reserve(owner, url, "shared", scope(101)),
    /document-capacity/,
  );
  for (const bad of [
    "shared:" + "-".repeat(36) + ":1",
    scope(0),
    scope(Number.MAX_SAFE_INTEGER),
    "private:other",
  ])
    await assert.rejects(
      r.reserve(owner, url, "shared", bad),
      /document-invalid/,
    );
  assert.deepEqual(f.data, before);
  assert.equal(f.data.get(countKey), 1);
  assert.equal(
    (await r.inspect(owner, url, "shared", scope(1))).scopeCount,
    100,
  );
});

test("a legacy private reservation has one provable scope and can be recovered without acquiring again", async () => {
  const f = fixture(),
    r = f.reservations;
  const key = "documents:source:" + (await hash([owner, url, "private"]));
  f.data.set(key, true);
  f.data.set(countKey, 1);
  const expected = await r.inspect(owner, url, "private", `private:${owner}`);
  assert.deepEqual(expected, {
    reserved: true,
    token: null,
    revision: 0,
    scopeCount: 1,
    legacy: false,
    containsTarget: true,
  });
  await r.releaseDeleted(owner, url, "private", `private:${owner}`, expected);
  assert.equal(f.data.has(key), false);
  assert.equal(f.data.get(countKey), 0);
  await r.releaseDeleted(owner, url, "private", `private:${owner}`, expected);
  assert.equal(f.data.get(countKey), 0);
});
