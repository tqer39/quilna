import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  fetchPublicFeed,
  feedURL,
  publicAddress,
  feedMiddleware,
} from "../../server/feed-fetch.mjs";

test("feed boundary rejects private, mapped, metadata and reserved addresses and URLs", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "172.17.0.1",
    "192.168.1.2",
    "100.100.100.200",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::ffff:8.8.8.8",
    "fc00::1",
    "fe80::1",
    "2002:7f00:1::",
    "2001:db8::1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
    assert.equal(publicAddress(ip), true, ip);
  for (const url of [
    "http://example.com/rss",
    "https://user:pass@example.com/rss",
    "https://example.com:8443/rss",
    "https://127.1/rss",
    "https://[::1]/rss",
    "https://localhost/rss",
    "https://x.local/rss",
    "file:///etc/passwd",
  ])
    assert.throws(() => feedURL(url), undefined, url);
});

test("feed redirects revalidate DNS and pin the checked public address", async () => {
  const calls = [];
  const result = await fetchPublicFeed("https://feeds.example.org/rss", {
    resolve: async () => [{ address: "1.1.1.1", family: 4 }],
    send: async (url, address) => {
      calls.push([url.href, address.address]);
      return calls.length === 1 ? { redirect: "/atom" } : { xml: "<feed/>" };
    },
  });
  assert.equal(result.url, "https://feeds.example.org/atom");
  assert.deepEqual(calls, [
    ["https://feeds.example.org/rss", "1.1.1.1"],
    ["https://feeds.example.org/atom", "1.1.1.1"],
  ]);
  let sends = 0;
  await assert.rejects(
    fetchPublicFeed("https://feeds.example.org/rss", {
      resolve: async (host) => [
        {
          address: host === "private.example.org" ? "127.0.0.1" : "1.1.1.1",
          family: 4,
        },
      ],
      send: async () => {
        sends++;
        return { redirect: "https://private.example.org/private" };
      },
    }),
    /feed-address/,
  );
  assert.equal(sends, 1);
  await assert.rejects(
    fetchPublicFeed("https://feeds.example.org/rss", {
      resolve: async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "::1", family: 6 },
      ],
      send: () => {
        throw Error("must not connect");
      },
    }),
    /feed-address/,
  );
});

test("feed fetch caps redirects, XML entities, output and total DNS/fetch duration", async () => {
  const resolve = async () => [{ address: "1.1.1.1", family: 4 }];
  for (const xml of [
    '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>',
    "x".repeat(2_000_001),
  ])
    await assert.rejects(
      fetchPublicFeed("https://feeds.example.org/rss", {
        resolve,
        send: async () => ({ xml }),
      }),
      /feed-xml/,
    );
  let count = 0;
  await assert.rejects(
    fetchPublicFeed("https://feeds.example.org/rss", {
      resolve,
      send: async () => {
        count++;
        return { redirect: "/again" };
      },
    }),
    /feed-redirect/,
  );
  assert.equal(count, 4);
  await assert.rejects(
    fetchPublicFeed("https://feeds.example.org/rss", {
      resolve: () => new Promise(() => {}),
      timeout: 20,
    }),
    /feed-timeout/,
  );
});

test("local feed API is same-origin only, bounds JSON and never accepts arbitrary proxy options", async (t) => {
  const calls = [];
  const discoveries = [];
  const middleware = feedMiddleware({
    fetchFeed: async (url) => {
      calls.push(url);
      return { xml: "<rss/>", url };
    },
    fetchSource: async (url) => {
      discoveries.push(url);
      return { html: "<!doctype html><title>A site</title>", url };
    },
  });
  const server = createServer((req, res) => {
    void middleware(req, res, () => {
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (body, extra = {}) =>
    fetch(`${origin}/api/feeds/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...extra },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  assert.equal(
    (
      await post({
        url: "https://feeds.example.org/rss",
        headers: { Authorization: "ignored" },
      })
    ).status,
    200,
  );
  assert.deepEqual(calls, ["https://feeds.example.org/rss"]);
  assert.equal(
    (
      await post(
        { url: "https://feeds.example.org/rss" },
        { Origin: "https://evil.example.org" },
      )
    ).status,
    403,
  );
  assert.equal((await post({ url: "https://127.0.0.1/private" })).status, 400);
  assert.equal((await post("x".repeat(4097))).status, 413);
  assert.equal((await post("{")).status, 400);
  assert.equal(
    (
      await post(
        { url: "https://feeds.example.org/rss" },
        { "X-Forwarded-For": "127.0.0.1" },
      )
    ).status,
    403,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    (await post({ url: "https://publisher.example.org/", discover: true }))
      .status,
    200,
  );
  assert.deepEqual(discoveries, ["https://publisher.example.org/"]);
  assert.equal(
    (await post({ url: "https://127.0.0.1/private", discover: true })).status,
    400,
  );
  assert.equal(
    (
      await post(
        { url: "https://publisher.example.org/", discover: true },
        { Origin: "https://evil.example.org" },
      )
    ).status,
    403,
  );
  assert.equal(discoveries.length, 1);
});

test("HTML discovery keeps the feed transport DNS, redirect, size and deadline restrictions", async () => {
  const resolve = async () => [{ address: "1.1.1.1", family: 4 }];
  const html =
    "<!DOCTYPE html><title>Blog</title><link rel='alternate' type='application/rss+xml' href='/feed/'>";
  let count = 0;
  const result = await fetchPublicFeed("https://publisher.example.org/story", {
    allowHTML: true,
    resolve,
    send: async (url, address, signal, allowHTML) => {
      assert.equal(allowHTML, true);
      assert.equal(address.address, "1.1.1.1");
      assert.equal(signal.aborted, false);
      return ++count === 1 ? { redirect: "/blog/" } : { html };
    },
  });
  assert.deepEqual(result, {
    url: "https://publisher.example.org/blog/",
    html,
  });
  await assert.rejects(
    fetchPublicFeed("https://publisher.example.org/", {
      resolve,
      send: async () => ({ html }),
    }),
  );
  await assert.rejects(
    fetchPublicFeed("https://publisher.example.org/", {
      allowHTML: true,
      resolve,
      send: async () => ({ html: "x".repeat(2_000_001) }),
    }),
    /feed-size/,
  );
  let sends = 0;
  await assert.rejects(
    fetchPublicFeed("https://publisher.example.org/", {
      allowHTML: true,
      resolve: async (host) => [
        {
          address: host === "private.example.org" ? "192.168.0.1" : "1.1.1.1",
          family: 4,
        },
      ],
      send: async () => {
        sends++;
        return { redirect: "https://private.example.org/" };
      },
    }),
    /feed-address/,
  );
  assert.equal(sends, 1);
  await assert.rejects(
    fetchPublicFeed("https://publisher.example.org/", {
      allowHTML: true,
      resolve: () => new Promise(() => {}),
      timeout: 20,
    }),
    /feed-timeout/,
  );
  await assert.rejects(
    fetchPublicFeed("https://publisher.example.org/", {
      allowHTML: true,
      resolve,
      send: async () => ({
        xml: '<!DOCTYPE rss SYSTEM "https://example.org/entity"><rss/>',
      }),
    }),
    /feed-xml/,
  );
});

test("favicon requests retain DNS pinning and reject private redirects and incompatible modes", async () => {
  const icon = "data:image/png;base64,iVBORw0KGgo=";
  const result = await fetchPublicFeed("https://example.org/favicon.ico", {
    allowIcon: true,
    resolve: async () => [{ address: "1.1.1.1", family: 4 }],
    send: async (_url, ip, _signal, html, validators, allowIcon) => {
      assert.equal(ip.address, "1.1.1.1");
      assert.equal(html, false);
      assert.equal(validators, undefined);
      assert.equal(allowIcon, true);
      return { icon };
    },
  });
  assert.equal(result.icon, icon);
  await assert.rejects(
    fetchPublicFeed("https://example.org/favicon.ico", {
      allowIcon: true,
      resolve: async (host) => [
        {
          address: host === "private.example.org" ? "127.0.0.1" : "1.1.1.1",
          family: 4,
        },
      ],
      send: async () => ({
        redirect: "https://private.example.org/favicon.ico",
      }),
    }),
    /feed-address/,
  );
  await assert.rejects(
    fetchPublicFeed("https://example.org/favicon.ico", {
      allowIcon: true,
      allowHTML: true,
    }),
    /feed-validators/,
  );
});
