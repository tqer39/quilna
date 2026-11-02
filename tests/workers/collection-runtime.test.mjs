import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

test("real DO alarm collects without browser traffic, persists, isolates owners and requires CSRF for changes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "quilna-collection-test-"));
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
  const origin = "http://collection.test",
    url = "https://publisher.example.org/feed";
  const xml = `<rss><channel><title>Cloud</title><item><guid>one</guid><title>Collected while closed</title><description>${"😀".repeat(18000)}</description></item></channel></rss>`;
  let outbound = 0,
    iconFetches = 0;
  const options = {
    modules: true,
    script,
    compatibilityDate: "2026-10-11",
    compatibilityFlags: ["global_fetch_strictly_public"],
    durableObjects: {
      ACCOUNTS: { className: "AccountVault", useSQLite: true },
    },
    resourcePersistencePath: dir,
    bindings: { APP_ORIGIN: origin, RSS_COLLECTION_ENABLED: "true" },
    outboundService: (request) => {
      if (request.url === "https://publisher.example.org/favicon.ico") {
        iconFetches++;
        assert.equal(request.headers.get("Cookie"), null);
        return new Response(
          Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
          { headers: { "Content-Type": "image/png" } },
        );
      }
      assert.equal(request.url, url);
      assert.equal(request.headers.get("Cookie"), null);
      outbound++;
      if (request.headers.get("If-None-Match") === '"article-v1"')
        return new Response(null, { status: 304 });
      if (request.headers.get("Accept").includes("text/html"))
        return new Response(
          "<!DOCTYPE html><title>Public article</title><article>Readable content</article>",
          { headers: { "Content-Type": "text/html", ETag: '"article-v1"' } },
        );
      return new Response(xml, {
        headers: { "Content-Type": "application/rss+xml" },
      });
    },
  };
  let mf = new Miniflare(convertV4MiniflareOptions(options));
  t.after(async () => {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  async function api(
    path,
    {
      user = "test-a",
      method = "GET",
      body,
      csrf,
      requestOrigin = origin,
    } = {},
  ) {
    const response = await mf.dispatchFetch(origin + path, {
      method,
      headers: {
        Origin: requestOrigin,
        "X-Test-Principal": user,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, value: await response.json() };
  }
  const csrf = (await api("/api/session")).value.csrfToken;
  const config = { expectedRevision: 0, interval: 15, urls: [url] };
  assert.equal(
    (await api("/api/collection", { user: "untrusted" })).status,
    401,
  );
  assert.equal(
    (
      await api("/api/collection", {
        requestOrigin: "https://foreign.example.org",
      })
    ).status,
    403,
  );
  assert.equal(
    (await api("/api/collection", { method: "PUT", body: config })).status,
    403,
  );
  assert.equal(outbound, 0);
  const configured = await api("/api/collection", {
    method: "PUT",
    body: config,
    csrf,
  });
  assert.equal(configured.status, 200);
  assert.equal(configured.value.interval, 15);
  assert.equal(configured.value.sourcePolicy, "public-https");
  // No dispatchFetch/browser request during this period: the runtime alarm wakes it.
  await delay(1800);
  assert.equal(outbound, 1);
  let status = (await api("/api/collection")).value;
  assert.equal(status.pending.length, 1);
  const id = status.pending[0].id;
  const wrongAccount = await mf.dispatchFetch(origin + "/api/collection", {
    headers: {
      Origin: origin,
      "X-Test-Principal": "test-a",
      "X-Collection-Account": "another-account",
    },
  });
  assert.equal(wrongAccount.status, 403);
  assert.equal((await api(`/api/collection/snapshots/${id}`)).value.xml, xml);
  assert.equal(
    (
      await api("/api/collection/discard", {
        method: "POST",
        body: { ids: [id] },
        csrf: "forged",
      })
    ).status,
    403,
  );
  const otherCsrf = (await api("/api/session", { user: "test-b" })).value
    .csrfToken;
  assert.equal(
    (
      await api("/api/collection/discard", {
        method: "POST",
        body: { ids: [id] },
        csrf: otherCsrf,
        user: "test-b",
      })
    ).status,
    200,
  );
  assert.equal((await api(`/api/collection/snapshots/${id}`)).value.xml, xml);
  for (const ids of [[], [id, id]]) {
    assert.equal(
      (
        await api("/api/collection/discard", {
          method: "POST",
          body: { ids },
          csrf,
        })
      ).status,
      409,
    );
  }
  assert.equal(
    (await api(`/api/collection/snapshots/${id}`, { user: "test-b" })).value
      .status,
    "snapshot-missing",
  );
  assert.equal(
    (await api("/api/collection", { user: "test-b" })).value.pending.length,
    0,
  );
  const stop = { expectedRevision: 1, interval: 0, urls: [url] };
  assert.equal(
    (await api("/api/collection", { method: "PUT", body: stop, csrf })).status,
    200,
  );
  await mf.dispose();
  mf = new Miniflare(convertV4MiniflareOptions(options));
  status = (await api("/api/collection")).value;
  assert.equal(status.interval, 0);
  assert.equal(status.pending.length, 1);
  assert.equal((await api(`/api/collection/snapshots/${id}`)).value.xml, xml);
  assert.equal(
    (
      await api("/api/collection/ack", {
        method: "POST",
        body: { ids: [id] },
        csrf: "forged",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api("/api/collection/discard", {
        method: "POST",
        body: { ids: [id] },
        csrf,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await api("/api/collection/ack", {
        method: "POST",
        body: { ids: [id] },
        csrf,
      })
    ).status,
    200,
  );
  assert.equal((await api("/api/collection")).value.pending.length, 0);
  assert.equal(
    (await api(`/api/collection/snapshots/${id}`)).value.status,
    "snapshot-missing",
  );
  assert.equal(
    (
      await api("/api/collection/discard", {
        method: "POST",
        body: { ids: [id] },
        csrf,
      })
    ).status,
    200,
  );
  assert.equal(outbound, 1);
  assert.equal(
    (
      await api("/api/feeds/fetch", {
        method: "POST",
        body: { url },
        user: "untrusted",
      })
    ).status,
    401,
  );
  const foreground = await api("/api/feeds/fetch", {
    method: "POST",
    body: { url },
  });
  assert.equal(foreground.status, 200);
  assert.equal(foreground.value.xml, xml);
  assert.equal(outbound, 2);
  const article = await api("/api/feeds/fetch", {
    method: "POST",
    body: { url, discover: true },
  });
  assert.equal(article.status, 200);
  assert.match(article.value.html, /Public article/);
  assert.equal(outbound, 3);
  assert.deepEqual(article.value.validators, { url, etag: '"article-v1"' });
  const unchanged = await api("/api/feeds/fetch", {
    method: "POST",
    body: { url, discover: true, validators: article.value.validators },
  });
  assert.equal(unchanged.status, 200);
  assert.deepEqual(unchanged.value, { url, notModified: true });
  assert.equal(outbound, 4);
  const refused = await api("/api/feeds/fetch", {
    method: "POST",
    body: {
      url,
      discover: true,
      validators: { url, etag: '"bad"\r\nCookie: secret' },
    },
  });
  assert.equal(refused.status, 409);
  assert.equal(outbound, 4);
  for (let i = 0; i < 8; i++) {
    const icon = await api("/api/feeds/fetch", {
      method: "POST",
      body: { url, icon: true },
    });
    assert.equal(icon.status, 200);
    assert.equal(icon.value.url, "https://publisher.example.org/favicon.ico");
    assert.match(icon.value.icon, /^data:image\/png;base64,/);
  }
  assert.equal(
    (
      await api("/api/feeds/fetch", {
        method: "POST",
        body: { url, icon: true },
      })
    ).status,
    429,
  );
  assert.equal(iconFetches, 8);
  assert.equal(
    (await api("/api/feeds/fetch", { method: "POST", body: { url } })).status,
    200,
  );
});
