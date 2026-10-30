import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import {
  conditionalHeaders,
  responseValidators,
  validSourceValidators,
} from "../src/http-validators.mjs";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  blocked.addSubnet(address, prefix);
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
])
  blocked.addSubnet(address, prefix, "ipv6");

export function publicAddress(address) {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 &&
        global6.check(address, "ipv6") &&
        !blocked.check(address, "ipv6");
}
export function feedURL(value) {
  if (typeof value !== "string" || value.length > 2048) throw Error("feed-url");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
    !url.hostname.includes(".") ||
    /\.(localhost|local|internal|test|invalid|example)\.?$/i.test(url.hostname)
  )
    throw Error("feed-url");
  url.hash = "";
  return url;
}

// The validated address is pinned to this TLS connection; the original hostname
// is still used for certificate validation. Each redirect gets a fresh check.
function exchange(url, address, signal, allowHTML = false, validators) {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        signal,
        agent: false,
        family: address.family,
        lookup: (_host, _options, done) =>
          done(null, address.address, address.family),
        headers: {
          ...conditionalHeaders(url.href, validators),
          Accept:
            "application/atom+xml, application/rss+xml, application/xml, text/xml" +
            (allowHTML ? ", text/html, application/xhtml+xml" : ""),
          "Accept-Encoding": "identity",
          "User-Agent": "Quilna-RSS/0.1",
        },
      },
      (res) => {
        const received = responseValidators(
          url.href,
          res.headers.etag,
          res.headers["last-modified"],
        );
        if (res.statusCode === 304) {
          res.destroy();
          resolve({
            notModified: true,
            ...(received ? { validators: received } : {}),
          });
          return;
        }
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.destroy();
          resolve({ redirect: res.headers.location });
          return;
        }
        if (
          res.statusCode !== 200 ||
          (res.headers["content-encoding"] &&
            res.headers["content-encoding"] !== "identity")
        ) {
          res.destroy();
          reject(Error("feed-response"));
          return;
        }
        const type = res.headers["content-type"] ?? "";
        const html = /^(text\/html|application\/xhtml\+xml)(;|$)/i.test(type);
        if (
          !(allowHTML && html) &&
          !/^(application\/(rss\+xml|atom\+xml|xml)|text\/(xml|plain))(;|$)/i.test(
            type,
          )
        ) {
          res.destroy();
          reject(Error("feed-type"));
          return;
        }
        let size = 0;
        const chunks = [];
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 2_000_000) {
            res.destroy(Error("feed-size"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const data = Buffer.concat(chunks);
            const charset =
              /charset=["']?([^;\s"']+)/i.exec(type)?.[1] ??
              /encoding=["']([^"']+)/i.exec(
                data.subarray(0, 180).toString(),
              )?.[1] ??
              "utf-8";
            resolve({
              ...(html && received ? { validators: received } : {}),
              [html ? "html" : "xml"]: new TextDecoder(charset, {
                fatal: true,
              }).decode(data),
            });
          } catch {
            reject(Error("feed-encoding"));
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export async function fetchPublicFeed(
  value,
  {
    resolve = lookup,
    send = exchange,
    timeout = 12000,
    allowHTML = false,
    validators,
  } = {},
) {
  if (
    validators !== undefined &&
    (!allowHTML || !validSourceValidators(validators))
  )
    throw Error("feed-validators");
  const controller = new AbortController();
  const { signal } = controller;
  let rejectDeadline;
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(Error("feed-timeout"));
  }, timeout);
  try {
    return await Promise.race([
      deadline,
      (async () => {
        let url = feedURL(value);
        for (let redirects = 0; redirects <= 3; redirects++) {
          const addresses = await resolve(url.hostname, {
            all: true,
            verbatim: true,
          });
          signal.throwIfAborted();
          if (
            !addresses.length ||
            addresses.some((a) => !publicAddress(a.address))
          )
            throw Error("feed-address");
          const condition = conditionalHeaders(url.href, validators);
          const result = await send(
            url,
            addresses[0],
            signal,
            allowHTML,
            Object.keys(condition).length ? validators : undefined,
          );
          signal.throwIfAborted();
          const received = result.validators;
          if (
            received !== undefined &&
            (!validSourceValidators(received) || received.url !== url.href)
          )
            throw Error("feed-validators");
          if (result.notModified === true) {
            if (!Object.keys(condition).length) throw Error("feed-response");
            return {
              url: url.href,
              notModified: true,
              ...(received ? { validators: received } : {}),
            };
          }
          if (allowHTML && typeof result.html === "string") {
            if (result.html.length > 2_000_000) throw Error("feed-size");
            return {
              url: url.href,
              html: result.html,
              ...(received ? { validators: received } : {}),
            };
          }
          if (typeof result.xml === "string") {
            if (
              result.xml.length > 2_000_000 ||
              /<!\s*(DOCTYPE|ENTITY)/i.test(result.xml)
            )
              throw Error("feed-xml");
            return { url: url.href, xml: result.xml };
          }
          if (typeof result.redirect !== "string") throw Error("feed-redirect");
          url = feedURL(new URL(result.redirect, url).href);
        }
        throw Error("feed-redirect");
      })(),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function feedMiddleware({
  fetchFeed = fetchPublicFeed,
  fetchSource = (url, validators) =>
    fetchPublicFeed(url, { allowHTML: true, validators }),
} = {}) {
  let active = 0;
  return async (req, res, next) => {
    if (req.url?.split("?")[0] !== "/api/feeds/fetch") return next();
    const send = (code, body) => {
      res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(body));
    };
    if (
      !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? "") ||
      req.headers.origin !== `http://${req.headers.host}` ||
      !["127.0.0.1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) ||
      req.headers["x-forwarded-for"] ||
      req.headers["x-forwarded-host"]
    )
      return send(403, { error: "origin" });
    if (req.method !== "POST") return send(405, { error: "method" });
    if (req.headers["content-type"] !== "application/json")
      return send(415, { error: "json" });
    if (active >= 4) return send(429, { error: "busy" });
    active++;
    const timer = setTimeout(() => req.destroy(), 15000);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) return send(413, { error: "size" });
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
        feedURL(body?.url);
        if (
          body.validators !== undefined &&
          (body.discover !== true || !validSourceValidators(body.validators))
        )
          throw Error("feed-validators");
      } catch {
        return send(400, { error: "url" });
      }
      const result = await (body.discover === true ? fetchSource : fetchFeed)(
        body.url,
        body.validators,
      );
      return send(200, result);
    } catch {
      if (!res.destroyed) send(502, { error: "fetch" });
    } finally {
      active--;
      clearTimeout(timer);
    }
  };
}
