import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test(
  "real durable catalog retains chunked immutable bodies across restart, coalesces users, and separates scopes",
  { timeout: 20_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "quilna-catalog-test-"));
    const script = (
      await build({
        entryPoints: ["tests/workers/document-catalog-entry.mjs"],
        bundle: true,
        write: false,
        format: "esm",
        platform: "neutral",
        target: "es2022",
        external: ["cloudflare:workers"],
        logLevel: "silent",
      })
    ).outputFiles[0].text;
    let failExtraction = false;
    let outbound = 0,
      release,
      started;
    const gate = new Promise((r) => {
        release = r;
      }),
      entered = new Promise((r) => {
        started = r;
      });
    const content = {
      text: "😀\n".repeat(60_000),
      url: "https://publisher.example.org/article",
      title: "Shared fixture",
      language: "en",
      fetchedAt: "2026-10-30T00:00:00.000Z",
      structure: { version: 1, links: [], headings: [] },
      codeRanges: [{ start: 0, end: 180000, block: true }],
    };
    const html = `<html lang="en"><title>Shared fixture</title><body><article><pre>${content.text}</pre></article></body></html>`;
    const options = {
      modules: true,
      script,
      compatibilityDate: "2026-10-11",
      compatibilityFlags: ["global_fetch_strictly_public"],
      resourcePersistencePath: dir,
      durableObjects: {
        CATALOG: { className: "CatalogFixture", useSQLite: true },
      },
      outboundService: async (request) => {
        assert.equal(request.url, content.url);
        assert.equal(request.headers.get("Cookie"), null);
        outbound++;
        if (outbound === 1) {
          started();
          await gate;
        }
        if (failExtraction)
          return new Response("<h1>Sign in</h1><form>Password</form>", {
            headers: { "Content-Type": "text/html" },
          });
        if (request.headers.get("If-None-Match") === '"runtime-v1"')
          return new Response(null, { status: 304 });
        return new Response(html, {
          headers: { "Content-Type": "text/html", ETag: '"runtime-v1"' },
        });
      },
    };
    let mf = new Miniflare(convertV4MiniflareOptions(options));
    t.after(async () => {
      release();
      await mf.dispose();
      await rm(dir, { recursive: true, force: true });
    });
    const call = async (path, principal = "alice") => {
      const response = await mf.dispatchFetch("https://catalog.test" + path, {
        headers: { "X-Test-Principal": principal },
      });
      return { status: response.status, value: await response.json() };
    };
    assert.equal((await call("/shared/read", "eve")).status, 404);
    const firstRequest = call("/shared/acquire");
    await entered;
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => call("/shared/acquire", "bob")),
    );
    assert.ok(concurrent.every((r) => r.value.status === "pending"));
    assert.equal(outbound, 1);
    release();
    const first = await firstRequest;
    assert.equal(first.status, 200);
    content.fetchedAt = first.value.version.content.fetchedAt;
    assert.deepEqual(first.value.version.content, content);
    const second = await call("/shared/acquire", "bob");
    assert.deepEqual(second.value.version, first.value.version);
    assert.equal(outbound, 1);
    await mf.dispose();
    mf = new Miniflare(convertV4MiniflareOptions(options));
    const restored = await call("/shared/acquire", "bob");
    assert.deepEqual(restored.value.version, first.value.version);
    assert.equal(outbound, 1);
    const unchanged = await call("/shared/acquire?force", "bob");
    assert.deepEqual(unchanged.value.version, first.value.version);
    assert.equal(outbound, 2);
    assert.equal((await call("/shared/history")).value.versions.length, 1);
    failExtraction = true;
    const failed = await call("/shared/acquire?force", "bob");
    assert.equal(failed.status, 409);
    assert.deepEqual((await call("/shared/read")).value, first.value.version);
    assert.equal((await call("/shared/history")).value.versions.length, 1);
    failExtraction = false;
    assert.deepEqual(
      (await call("/shared/acquire?force", "bob")).value.version,
      first.value.version,
    );
    assert.equal(outbound, 4);
    const privateDoc = await call("/private/acquire");
    assert.equal(outbound, 5);
    assert.notEqual(privateDoc.value.document.id, first.value.document.id);
    assert.deepEqual(
      { ...privateDoc.value.version.content, fetchedAt: content.fetchedAt },
      content,
    );
    assert.equal((await call("/private/read", "bob")).status, 404);
    assert.equal((await call("/shared/read", "eve")).status, 404);
  },
);
