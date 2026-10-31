import test from "node:test";
import assert from "node:assert/strict";
import {
  conditionalHeaders,
  validSourceValidators,
  responseValidators,
} from "../../src/http-validators.mjs";
import { fetchPublicFeed } from "../../server/feed-fetch.mjs";
import { fetchCloudFeed } from "../../workers/feed-fetch.mjs";
const url = "https://publisher.example.org/article";
const finalURL = "https://content.example.net/final";
const date = "Fri, 30 Oct 2026 00:00:00 GMT";
const validators = { url, etag: 'W/"one"', lastModified: date };

test("conditional request fields are bounded, standard and scoped to the exact representation URL", () => {
  assert.deepEqual(conditionalHeaders(url, validators), {
    "If-None-Match": 'W/"one"',
  });
  assert.deepEqual(conditionalHeaders(url, { url, lastModified: date }), {
    "If-Modified-Since": date,
  });
  assert.deepEqual(conditionalHeaders(url + "?edition=2", validators), {});
  for (const bad of [
    null,
    {},
    { ...validators, etag: "*" },
    { ...validators, etag: '"a"\r\nCookie: secret' },
    { ...validators, etag: '"' + "x".repeat(512) + '"' },
    { ...validators, lastModified: "tomorrow" },
    { ...validators, lastModified: "Thu, 30 Oct 2026 00:00:00 GMT" },
    { ...validators, authorization: "secret" },
    { ...validators, url: url + "#x" },
  ])
    assert.equal(validSourceValidators(bad), false);
  assert.equal(responseValidators(url, "bad", "bad"), undefined);
  assert.deepEqual(responseValidators(url, '"two"', date), {
    url,
    etag: '"two"',
    lastModified: date,
  });
});

for (const cloud of [false, true]) {
  const label = cloud ? "cloud" : "local";
  const run = async (source, options, respond) =>
    cloud
      ? fetchCloudFeed(source, { allowHTML: true, ...options, send: respond })
      : fetchPublicFeed(source, {
          allowHTML: true,
          resolve: async () => [{ address: "1.1.1.1", family: 4 }],
          ...options,
          send: async (address, _ip, _signal, _html, conditional) =>
            respond(address.href, {
              headers: conditionalHeaders(address.href, conditional),
            }),
        });
  const reply = (status, headers = {}, html = "body") =>
    cloud
      ? new Response(status === 200 ? html : null, {
          status,
          headers: { "Content-Type": "text/html", ...headers },
        })
      : status === 302
        ? { redirect: headers.Location }
        : status === 304
          ? {
              notModified: true,
              ...(headers.ETag
                ? {
                    validators: responseValidators(
                      url,
                      headers.ETag,
                      headers["Last-Modified"],
                    ),
                  }
                : {}),
            }
          : {
              html,
              ...(headers.ETag
                ? {
                    validators: responseValidators(
                      url,
                      headers.ETag,
                      headers["Last-Modified"],
                    ),
                  }
                : {}),
            };
  test(`${label} receives validators and accepts unchanged responses only after a matching conditional request`, async () => {
    const first = await run(url, {}, async () =>
      reply(200, { ETag: '"one"', "Last-Modified": date }),
    );
    assert.deepEqual(first.validators, {
      url,
      etag: '"one"',
      lastModified: date,
    });
    const result = await run(url, { validators }, async (address, init) => {
      assert.equal(address, url);
      assert.equal(init.headers["If-None-Match"], 'W/"one"');
      assert.equal(init.headers["If-Modified-Since"], undefined);
      assert.equal(init.headers.Cookie, undefined);
      return reply(304);
    });
    assert.deepEqual(result, { url, notModified: true });
    await assert.rejects(
      run(url, {}, async () => reply(304)),
      /feed-response/,
    );
    let calls = 0;
    await assert.rejects(
      run(
        url,
        { validators: { ...validators, etag: '"bad"\nsecret' } },
        async () => {
          calls++;
          return reply(200);
        },
      ),
      /feed-validators/,
    );
    assert.equal(calls, 0);
  });
  test(`${label} validators do not leak to another redirect target and unknown 304 is refused`, async () => {
    const calls = [];
    const result = await run(
      url,
      { validators: { url: finalURL, etag: '"final"' } },
      async (address, init) => {
        calls.push([address, init.headers["If-None-Match"]]);
        return address === url
          ? reply(302, { Location: finalURL })
          : reply(304);
      },
    );
    assert.deepEqual(calls, [
      [url, undefined],
      [finalURL, '"final"'],
    ]);
    assert.equal(result.notModified, true);
    await assert.rejects(
      run(url, { validators }, async (address, init) => {
        if (address === url) return reply(302, { Location: finalURL });
        assert.equal(init.headers["If-None-Match"], undefined);
        return reply(304);
      }),
      /feed-response/,
    );
    await assert.rejects(
      run(url, { validators }, async () =>
        reply(302, { Location: "https://127.0.0.1/private" }),
      ),
      /feed-(url|host-unsupported)/,
    );
  });
}
