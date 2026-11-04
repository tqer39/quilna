/* global DecompressionStream */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { setTimeout as delay } from "node:timers/promises";

test("a real DO alarm queues a compressed page without a browser and honours robots.txt", async (t) => {
  const script = (
    await build({
      entryPoints: ["tests/workers/collection-entry.mjs"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      external: ["cloudflare:workers"],
      logLevel: "silent",
    })
  ).outputFiles[0].text;
  const origin = "http://collection.test";
  const feed = "https://publisher.example.org/feed";
  const allowed = "https://publisher.example.org/open";
  const denied = "https://blocked.example.org/closed";
  const html = `<!doctype html><title>Page</title><article>${"Readable 本文 ".repeat(2000)}</article>`;
  const requests = [];
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-10-11",
      compatibilityFlags: ["global_fetch_strictly_public"],
      durableObjects: {
        ACCOUNTS: { className: "AccountVault", useSQLite: true },
      },
      bindings: { APP_ORIGIN: origin, RSS_COLLECTION_ENABLED: "true" },
      outboundService: (request) => {
        requests.push(request.url);
        assert.equal(request.headers.get("Cookie"), null);
        if (request.url === feed)
          return new Response(
            `<rss><channel><title>Cloud</title><item><guid>a</guid><title>Open</title><link>${allowed}</link></item><item><guid>b</guid><title>Closed</title><link>${denied}</link></item></channel></rss>`,
            { headers: { "Content-Type": "application/rss+xml" } },
          );
        if (request.url === "https://publisher.example.org/robots.txt")
          return new Response("not found", { status: 404 });
        if (request.url === "https://blocked.example.org/robots.txt")
          return new Response("User-agent: *\nDisallow: /\n", {
            headers: { "Content-Type": "text/plain" },
          });
        if (request.url === allowed)
          return new Response(html, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              ETag: '"page-v1"',
            },
          });
        return new Response("unexpected", { status: 500 });
      },
    }),
  );
  t.after(() => mf.dispose());
  const api = async (path, { method = "GET", body, csrf } = {}) => {
    const response = await mf.dispatchFetch(origin + path, {
      method,
      headers: {
        Origin: origin,
        "X-Test-Principal": "test-a",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, value: await response.json() };
  };
  const csrf = (await api("/api/session")).value.csrfToken;
  const configured = await api("/api/collection", {
    method: "PUT",
    csrf,
    body: { expectedRevision: 0, interval: 15, urls: [feed], articles: true },
  });
  assert.equal(configured.status, 200);
  assert.equal(configured.value.articles, true);
  // No request reaches the Worker while waiting: only runtime alarms run.
  let status;
  for (let i = 0; i < 40; i++) {
    await delay(500);
    if (
      requests.includes(allowed) &&
      requests.includes("https://blocked.example.org/robots.txt")
    ) {
      status = (await api("/api/collection")).value;
      if (status.articleQueued === 0 && status.articlePending.length) break;
    }
  }
  assert.equal(status?.articlePending.length, 1);
  assert.equal(requests.includes(denied), false);
  const meta = status.articlePending[0];
  assert.equal(meta.url, allowed);
  assert.ok(meta.size < html.length / 4, "stored compressed");
  const { status: code, value } = await api(
    `/api/collection/articles/${meta.id}`,
  );
  assert.equal(code, 200);
  assert.equal(value.account, status.account);
  assert.equal(value.finalUrl, allowed);
  assert.equal(value.validators.etag, '"page-v1"');
  const inflated = await new Response(
    new Response(
      Uint8Array.from(atob(value.gzip), (c) => c.charCodeAt(0)),
    ).body.pipeThrough(new DecompressionStream("gzip")),
  ).text();
  assert.equal(inflated, html);
  const denyWrite = await api("/api/collection/ack", {
    method: "POST",
    body: { ids: [meta.id] },
  });
  assert.equal(denyWrite.status, 403);
  const acknowledged = await api("/api/collection/ack", {
    method: "POST",
    csrf,
    body: { ids: [meta.id] },
  });
  assert.equal(acknowledged.status, 200);
  assert.deepEqual(acknowledged.value.articlePending, []);
  assert.equal(
    (await api(`/api/collection/articles/${meta.id}`)).status >= 400,
    true,
  );
});
