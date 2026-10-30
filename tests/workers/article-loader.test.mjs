import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const script = (
  await build({
    entryPoints: ["workers/article-loader.mjs"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
  })
).outputFiles[0].text;
const { createArticleLoader } = await import(
  "data:text/javascript;base64," + Buffer.from(script).toString("base64")
);
const fixtures = JSON.parse(
  await readFile("tests/fixtures/article-extraction.json", "utf8"),
);
const url = "https://publisher.example.org/article";
const response = (html, headers = {}) =>
  new Response(html, { headers: { "Content-Type": "text/html", ...headers } });

test("trusted loader extracts text/code without executing scripts, loading resources or installing globals", async () => {
  for (const fixture of fixtures) {
    const calls = [];
    const before = {
      document: globalThis.document,
      Node: globalThis.Node,
      ran: globalThis.__articleScriptRan,
    };
    const loader = createArticleLoader({
      send: async (...args) => {
        calls.push(args);
        return response(fixture.html);
      },
    });
    const { content } = await loader(url);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], url);
    assert.equal(calls[0][1].headers.Cookie, undefined);
    assert.equal(calls[0][1].headers.Authorization, undefined);
    assert.deepEqual(
      content.codeRanges.map((r) => content.text.slice(r.start, r.end)),
      fixture.codes,
      fixture.name,
    );
    assert.doesNotMatch(content.text, /UNWANTED_|__articleScriptRan/);
    assert.ok(content.title);
    assert.equal(content.url, url);
    assert.deepEqual(
      {
        document: globalThis.document,
        Node: globalThis.Node,
        ran: globalThis.__articleScriptRan,
      },
      before,
    );
  }
});

test("redirected revalidation returns 304 only for the saved final URL; 200 clears absent validators", async () => {
  const final = "https://destination.example.org/article";
  const seen = [];
  let changed = false;
  const load = createArticleLoader({
    send: async (target, options) => {
      seen.push({ target, headers: options.headers });
      if (target === url)
        return new Response(null, {
          status: 302,
          headers: { Location: final },
        });
      if (options.headers["If-None-Match"] && !changed)
        return new Response(null, { status: 304 });
      return response(fixtures[0].html, changed ? {} : { ETag: '"v1"' });
    },
  });
  const first = await load(url);
  assert.equal(first.content.url, final);
  const second = await load(url, first);
  assert.deepEqual(second, { url: final, notModified: true });
  assert.equal(seen[2].headers["If-None-Match"], undefined);
  assert.equal(seen[3].headers["If-None-Match"], '"v1"');
  changed = true;
  assert.equal((await load(url, first)).validators, undefined);
});

test("unsafe and self-host redirects are blocked, and arbitrary 304/feeds/login/oversize bodies are not catalog originals", async () => {
  for (const target of [
    "http://publisher.example.org/",
    "https://127.0.0.1/",
    "https://user:pass@publisher.example.org/",
    "https://quilna.example.org/",
  ]) {
    const calls = [];
    const load = createArticleLoader({
      blockedHosts: ["quilna.example.org"],
      send: async (u) => {
        calls.push(u);
        return new Response(null, {
          status: 302,
          headers: { Location: target },
        });
      },
    });
    await assert.rejects(load(url));
    assert.deepEqual(calls, [url]);
  }
  const bad = [
    () => new Response(null, { status: 304 }),
    () =>
      new Response("<rss/>", {
        headers: { "Content-Type": "application/rss+xml" },
      }),
    () => response("<h1>Sign in</h1><form>password</form>"),
    () => response("x".repeat(2_000_001)),
    () => response("<article><p>" + "x".repeat(200_001) + "</p></article>"),
    () =>
      response("<div>".repeat(300) + fixtures[0].html + "</div>".repeat(300)),
    () => response("<span>x</span>".repeat(20_001)),
    () => new Response(null, { status: 403 }),
  ];
  for (const send of bad)
    await assert.rejects(createArticleLoader({ send })(url));
  let calls = 0;
  const load = createArticleLoader({
    send: async () => {
      calls++;
      return response(fixtures[0].html);
    },
  });
  await assert.rejects(load(url, null), /document-previous/);
  await assert.rejects(
    load(url, { content: { text: "browser-supplied" } }),
    /document-previous/,
  );
  assert.equal(calls, 0);
});

test("structural limits fail explicitly before Readability recursion", async () => {
  for (const html of [
    "<div>".repeat(300) + fixtures[0].html + "</div>".repeat(300),
    "<span>x</span>".repeat(20001),
  ]) {
    await assert.rejects(
      createArticleLoader({ send: async () => response(html) })(url),
      /記事の構造が大きすぎる/,
    );
  }
});
