/* global DecompressionStream, performance */
import test from "node:test";
import assert from "node:assert/strict";
import { FeedCollector } from "../../workers/feed-collector.mjs";
import {
  articleLinks,
  robotsAllows,
  parseRobots,
} from "../../workers/article-prefetch.mjs";

class Storage {
  data = new Map();
  queue = Promise.resolve();
  get(key) {
    return Promise.resolve(structuredClone(this.data.get(key)));
  }
  transaction(update) {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      const result = await update({
        get: async (key) => structuredClone(next.get(key)),
        put: async (key, value) => {
          next.set(key, structuredClone(value));
        },
        delete: async (key) => {
          next.delete(key);
        },
        setAlarm: async (time) => {
          next.set("alarm", time);
        },
        deleteAlarm: async () => {
          next.delete("alarm");
        },
      });
      this.data = next;
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
const feed = "https://zenn.dev/feed";
const rss = (...links) =>
  `<rss><channel><title>Example</title>${links
    .map((link) => `<item><title>t</title><link>${link}</link></item>`)
    .join("")}</channel></rss>`;
const page = "<html><body><article>本文の内容 body</article></body></html>";
const a = "https://news.example.com/a";
const b = "https://news.example.com/b";
const c = "https://other.example.org/c";
function fixture(extra = {}) {
  const storage = new Storage();
  let time = 1_800_000_000_000;
  const fetched = [];
  const robots = [];
  const state = { xml: rss(a) };
  const options = {
    enabled: true,
    now: () => time,
    fetchFeed: async (url) => ({ url, xml: state.xml }),
    fetchArticle: async (url) => {
      fetched.push(url);
      return { url, html: page };
    },
    fetchRobots: async (url) => {
      robots.push(url);
      return "";
    },
    ...extra,
  };
  const collector = new FeedCollector(storage, options);
  return {
    storage,
    collector,
    state,
    fetched,
    robots,
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
    restart: () => new FeedCollector(storage, options),
  };
}
const enable = (f, articles = true) =>
  f.collector.configure({
    expectedRevision: 0,
    interval: 15,
    urls: [feed],
    articles,
  });
const gunzip = async (base64) =>
  new Response(
    new Response(
      Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
    ).body.pipeThrough(new DecompressionStream("gzip")),
  ).text();

test("article links come from entries, not channel or embedded markup", () => {
  assert.deepEqual(
    articleLinks(
      `<rss><channel><link>https://zenn.dev/</link><item>
        <description><![CDATA[<link>https://evil.example.com/x</link>]]></description>
        <link><![CDATA[ https://news.example.com/a?x=1&y=2 ]]></link>
      </item><item><link>/relative?a=1&amp;b=2#frag</link></item><item><link></link></item></channel></rss>`,
      "https://news.example.com/feed",
    ),
    [
      "https://news.example.com/a?x=1&y=2",
      "https://news.example.com/relative?a=1&b=2",
    ],
  );
  assert.deepEqual(
    articleLinks(
      `<feed><link href="https://zenn.dev/"/><entry><link rel="self" href="https://x.example.com/self"/>
      <link rel="alternate" href="https://x.example.com/a"/><summary>&lt;link href="https://bad.example.com"/&gt;</summary></entry>
      <entry><link href="https://x.example.com/b"></link></entry></feed>`,
      "https://x.example.com/feed",
    ),
    ["https://x.example.com/a", "https://x.example.com/b"],
  );
  assert.equal(
    articleLinks(
      rss(...Array.from({ length: 9 }, (_, i) => `https://x.example.com/${i}`)),
      feed,
    ).length,
    5,
  );
  assert.deepEqual(articleLinks("<rss>not closed", feed), []);
});

test("robots rules use the most specific agent and longest match", () => {
  const rules = parseRobots(`
    User-agent: *
    Disallow: /private
    Allow: /private/open
    Disallow: /*.pdf$

    User-agent: other
    Disallow: /
  `);
  assert.equal(robotsAllows(rules, "/public"), true);
  assert.equal(robotsAllows(rules, "/private/x"), false);
  assert.equal(robotsAllows(rules, "/private/open/x"), true);
  assert.equal(robotsAllows(rules, "/doc.pdf"), false);
  assert.equal(robotsAllows(rules, "/doc.pdf?x=1"), true);
  const own = parseRobots(
    "User-agent: *\nDisallow: /\n\nUser-agent: Quilna\nDisallow: /own\n",
  );
  assert.equal(robotsAllows(own, "/anything"), true);
  assert.equal(robotsAllows(own, "/own/x"), false);
  assert.equal(robotsAllows(parseRobots("Disallow:\n"), "/x"), true);
});

test("hostile feeds and robots rules finish quickly", () => {
  const size = 2_000_000;
  for (const xml of [
    "<item>".repeat(size / 6),
    "<item ".repeat(size / 6),
    `<item>${"<link>".repeat(size / 6)}</item>`,
    `<item>${"<link ".repeat(size / 6)}</item>`,
    `<item>${"<![CDATA[".repeat(size / 9)}</item>`,
    `<entry>${"<link ".repeat(size / 6)}</entry>`,
  ]) {
    const started = performance.now();
    assert.deepEqual(articleLinks(xml, feed), []);
    assert.ok(performance.now() - started < 1000, xml.slice(0, 20));
  }
  const started = performance.now();
  const rules = parseRobots(
    `User-agent: *\n${`Disallow: /${"*a".repeat(250)}b\n`.repeat(200)}`,
  );
  assert.equal(rules.length, 200);
  assert.equal(robotsAllows(rules, "/" + "a".repeat(1000)), true);
  assert.ok(performance.now() - started < 1000);
});

test("robots wildcards match the same paths as the specification", () => {
  const allow = (rule, path) =>
    robotsAllows(parseRobots(`User-agent: *\nDisallow: ${rule}\n`), path);
  assert.equal(allow("/a*c", "/abbc"), false);
  assert.equal(allow("/a*c", "/ab"), true);
  assert.equal(allow("/a*c$", "/abc"), false);
  assert.equal(allow("/a*c$", "/abcd"), true);
  assert.equal(allow("/a$", "/a"), false);
  assert.equal(allow("/a$", "/ab"), true);
  assert.equal(allow("*.pdf", "/x/y.pdf"), false);
  assert.equal(allow("/a*", "/a"), false);
  assert.equal(allow("/*a*", "/b"), true);
  assert.equal(allow("/*/secret", "/x/secret/y"), false);
});

test("prefetch stays off until a browser configures it, including after older states", async () => {
  const f = fixture();
  await f.collector.configure({
    expectedRevision: 0,
    interval: 15,
    urls: [feed],
  });
  await f.collector.alarm();
  f.advance(60_000);
  await f.collector.alarm();
  assert.deepEqual(f.fetched, []);
  const status = await f.collector.status();
  assert.equal(status.articles, false);
  assert.deepEqual(status.articlePending, []);
});

test("collected pages stay queued as compressed HTML until acknowledged, without a browser", async () => {
  const f = fixture({
    fetchArticle: async (url) => ({
      url: url + "?final",
      html: page,
      validators: { url: url + "?final", etag: '"v1"' },
    }),
  });
  await enable(f);
  await f.restart().alarm();
  assert.equal((await f.collector.status()).pending.length, 1);
  assert.notEqual(await f.storage.get("alarm"), undefined);
  f.advance(1000);
  await f.restart().alarm();
  const status = await f.restart().status();
  assert.equal(status.articlePending.length, 1);
  const meta = status.articlePending[0];
  assert.equal(meta.url, a);
  assert.equal(meta.feedUrl, feed);
  const article = await f.restart().article(meta.id);
  assert.equal(article.finalUrl, a + "?final");
  assert.equal(article.validators.etag, '"v1"');
  assert.equal(await gunzip(article.gzip), page);
  // A lost response is redelivered; a lost ACK response is safe to retry.
  assert.equal((await f.restart().article(meta.id)).gzip, article.gzip);
  await f.collector.acknowledge({ ids: [meta.id] });
  await f.collector.acknowledge({ ids: [meta.id] });
  const after = await f.collector.status();
  assert.deepEqual(after.articlePending, []);
  assert.equal(after.articleBytes, 0);
  await assert.rejects(f.collector.article(meta.id), /snapshot-missing/);
  assert.deepEqual(
    [...f.storage.data.keys()].filter((k) => k.startsWith("rss:article:")),
    [],
  );
});

test("one host is fetched at most every 30 seconds while other hosts continue", async () => {
  const f = fixture();
  f.state.xml = rss(a, b, c);
  await enable(f);
  await f.collector.alarm();
  f.advance(1000);
  await f.collector.alarm();
  assert.deepEqual(f.fetched, [a]);
  f.advance(1000);
  await f.collector.alarm();
  assert.deepEqual(f.fetched, [a, c]); // b waits for a's host, c does not.
  f.advance(1000);
  await f.collector.alarm();
  assert.deepEqual(f.fetched, [a, c]);
  const alarm = await f.storage.get("alarm");
  assert.ok(alarm > f.now() && alarm <= f.now() + 30_000);
  f.advance(30_000);
  await f.collector.alarm();
  assert.deepEqual(f.fetched, [a, c, b]);
});

test("an article already seen is not fetched again when the feed changes", async () => {
  const f = fixture();
  await enable(f);
  await f.collector.alarm();
  f.advance(1000);
  await f.collector.alarm();
  f.state.xml = rss(b, a);
  f.advance(15 * 60_000);
  await f.collector.alarm();
  f.advance(31_000);
  await f.collector.alarm();
  f.advance(31_000);
  await f.collector.alarm();
  assert.deepEqual(f.fetched, [a, b]);
});

test("Retry-After and failures back off, then give up without affecting RSS", async () => {
  let failures = 0;
  const f = fixture({
    fetchArticle: async () => {
      failures++;
      throw Object.assign(Error("feed-response"), {
        status: 429,
        retryAfter: 3600,
      });
    },
  });
  await enable(f);
  await f.collector.alarm();
  f.advance(1000);
  await f.collector.alarm();
  assert.equal(failures, 1);
  f.advance(20 * 60_000);
  await f.collector.alarm(); // RSS still runs; the host is still waiting.
  assert.equal(failures, 1);
  assert.equal((await f.collector.status()).feeds[0].error, "");
  f.advance(45 * 60_000);
  await f.collector.alarm();
  assert.equal(failures, 2);
  f.advance(2 * 3600_000);
  await f.collector.alarm();
  assert.equal(failures, 3);
  f.advance(24 * 3600_000);
  await f.collector.alarm();
  f.advance(24 * 3600_000);
  await f.collector.alarm();
  assert.equal(failures, 3); // Reading falls back to a fetch on open.
  assert.equal((await f.collector.status()).articleQueued, 0);
});

test("permanent responses are dropped without a retry", async () => {
  let calls = 0;
  const f = fixture({
    fetchArticle: async () => {
      calls++;
      throw Object.assign(Error("feed-response"), { status: 404 });
    },
  });
  await enable(f);
  await f.collector.alarm();
  f.advance(1000);
  await f.collector.alarm();
  f.advance(3600_000);
  await f.collector.alarm();
  assert.equal(calls, 1);
  assert.equal((await f.collector.status()).articleQueued, 0);
});

test("robots.txt is honoured and cached per host for a day", async () => {
  const blocked = fixture({
    fetchRobots: async () => "User-agent: *\nDisallow: /a\n",
  });
  blocked.state.xml = rss(a, b);
  await enable(blocked);
  await blocked.collector.alarm();
  blocked.advance(1000);
  await blocked.collector.alarm();
  blocked.advance(31_000);
  await blocked.collector.alarm();
  assert.deepEqual(blocked.fetched, [b]);

  const cached = fixture();
  cached.state.xml = rss(a, b);
  await enable(cached);
  await cached.collector.alarm();
  cached.advance(1000);
  await cached.collector.alarm();
  cached.advance(31_000);
  await cached.collector.alarm();
  assert.equal(cached.robots.length, 1);
  assert.equal(cached.robots[0], "https://news.example.com/robots.txt");

  const missing = fixture({
    fetchRobots: async () => {
      throw Object.assign(Error("feed-response"), { status: 404 });
    },
  });
  await enable(missing);
  await missing.collector.alarm();
  missing.advance(1000);
  await missing.collector.alarm();
  assert.deepEqual(missing.fetched, [a]); // No policy published.

  const blank = fixture({
    fetchRobots: async () => {
      throw Error("feed-xml");
    },
  });
  await enable(blank);
  await blank.collector.alarm();
  blank.advance(1000);
  await blank.collector.alarm();
  assert.deepEqual(blank.fetched, [a]); // An empty file permits everything.

  const outage = fixture({
    fetchRobots: async () => {
      throw Object.assign(Error("feed-response"), { status: 503 });
    },
  });
  await enable(outage);
  await outage.collector.alarm();
  outage.advance(1000);
  await outage.collector.alarm();
  assert.deepEqual(outage.fetched, []); // Unknown policy means no fetch yet.
  assert.equal((await outage.collector.status()).articleQueued, 1);
});

test("a full article queue pauses only prefetch and resumes after acknowledgement", async () => {
  const html = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(60000))),
  );
  const urls = Array.from(
    { length: 5 },
    (_, i) => `https://h${i}.example.com/a`,
  );
  const fetched = [];
  const f = fixture({
    fetchArticle: async (url) => {
      fetched.push(url);
      return { url, html };
    },
    articleBytesLimit: 200_000,
    articleSizeLimit: 90_000,
  });
  f.state.xml = rss(...urls);
  await enable(f);
  await f.collector.alarm();
  for (let i = 0; i < 5; i++) {
    f.advance(1000);
    await f.collector.alarm();
  }
  const full = await f.collector.status();
  assert.equal(full.articlePending.length, 2);
  assert.ok(full.articleQueued > 0);
  assert.equal(full.blocked, false);
  const count = fetched.length;
  f.advance(1000);
  await f.collector.alarm();
  assert.equal(fetched.length, count);
  f.state.xml = rss(...urls, "https://h9.example.com/a");
  f.advance(15 * 60_000);
  await f.collector.alarm();
  assert.ok((await f.collector.status()).feeds[0].lastSuccess >= f.now());
  await f.collector.acknowledge({
    ids: full.articlePending.map((item) => item.id),
  });
  f.advance(1000);
  await f.collector.alarm();
  assert.equal(fetched.length, count + 1);
});

test("turning prefetch off clears the queue, keeps delivered pages and discards late results", async () => {
  let release;
  const f = fixture({
    fetchArticle: async (url) => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return { url, html: page };
    },
  });
  await enable(f);
  await f.collector.alarm();
  f.advance(1000);
  const running = f.collector.alarm();
  while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
  await f.collector.configure({
    expectedRevision: 1,
    interval: 15,
    urls: [feed],
    articles: false,
  });
  release();
  await running;
  const status = await f.collector.status();
  assert.equal(status.articles, false);
  assert.equal(status.articleQueued, 0);
  assert.deepEqual(status.articlePending, []);
});

test("unsubscribing drops queued pages from that feed; a stopped schedule fetches nothing", async () => {
  const other = "https://blog.cloudflare.com/rss/";
  const f = fixture();
  await f.collector.configure({
    expectedRevision: 0,
    interval: 15,
    urls: [feed],
    articles: true,
  });
  await f.collector.alarm();
  await f.collector.configure({
    expectedRevision: 1,
    interval: 15,
    urls: [other],
    articles: true,
  });
  f.state.xml = rss();
  f.advance(1000);
  await f.collector.alarm();
  assert.deepEqual(f.fetched, []);
  assert.equal((await f.collector.status()).articleQueued, 0);
});

test("pages beyond the delivery limit are dropped instead of stored", async () => {
  const noise = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(60000))),
  );
  const f = fixture({
    fetchArticle: async (url) => ({ url, html: noise }),
    articleSizeLimit: 1000,
  });
  await enable(f);
  await f.collector.alarm();
  f.advance(1000);
  await f.collector.alarm();
  const status = await f.collector.status();
  assert.deepEqual(status.articlePending, []);
  assert.equal(status.articleQueued, 0);
});
