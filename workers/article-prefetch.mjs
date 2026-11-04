/* global CompressionStream */
import { z } from "zod";
import { hash } from "./crypto.mjs";
import { cloudFeedURL, fetchCloudFeed } from "./feed-fetch.mjs";
import { validSourceValidators } from "../src/http-validators.mjs";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hostSpacing = 30_000;
const lease = 60_000;
const retryDelays = [5 * 60_000, 20 * 60_000];
const maxAttempts = 3;
const maxRetryAfter = 86_400;
const robotsLifetime = 86_400_000;
const entryLinks = 5;
const entryScan = 256_000;
const partSize = 16_000;
const stateSchema = z
  .object({
    version: z.literal(1),
    queue: z
      .array(
        z
          .object({
            url: z.string().max(1024),
            feedUrl: z.string().max(2048),
            attempts: integer.max(maxAttempts),
            notBefore: integer,
          })
          .strict(),
      )
      .max(100),
    pending: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            url: z.string().max(1024),
            feedUrl: z.string().max(2048),
            fetchedAt: integer,
            parts: integer.max(125),
            size: integer.max(2_000_000),
          })
          .strict(),
      )
      .max(100),
    bytes: integer.max(20_000_000),
    seen: z.array(z.string().max(16)).max(500),
    hosts: z.record(z.string().max(253), integer),
  })
  .strict();
const empty = () => ({
  version: 1,
  queue: [],
  pending: [],
  bytes: 0,
  seen: [],
  hosts: {},
});
const stateKey = "rss:articles";
const partKey = (id, part) => `rss:article:${id}:${part}`;
const robotsKey = (host) => `rss:robots:${host}`;
const byteLength = (value) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
const decodeEntities = (text) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const attribute = (tag, name) =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i")
    .exec(tag)
    ?.slice(1)
    .find((value) => value !== undefined);

const linkTag = /<link(?:\s[^>]{0,1100})?>/g;
/** Drop CDATA, which may quote markup, but keep a link's own wrapped value. */
function withoutCdata(text) {
  let out = "",
    position = 0;
  for (;;) {
    const start = text.indexOf("<![CDATA[", position);
    if (start < 0) return out + text.slice(position);
    const end = text.indexOf("]]>", start + 9);
    out += text.slice(position, start);
    if (end < 0) return out;
    if (/<link>\s*$/.test(out.slice(-64))) out += text.slice(start + 9, end);
    position = end + 3;
  }
}
/**
 * A deliberately small scan: full parsing stays in the browser, and a missed
 * link only means that article is fetched when it is opened, as before. Feeds
 * are untrusted, so the work stays linear in their size: no scan rescans input.
 */
export function articleLinks(xml, base) {
  const links = [];
  const open = /<(item|entry)(?:\s[^>]{0,256})?>/g;
  for (let match; links.length < entryLinks && (match = open.exec(xml));) {
    const close = `</${match[1]}>`;
    const end = xml.indexOf(close, open.lastIndex);
    if (end < 0) break;
    const body = withoutCdata(
      xml.slice(open.lastIndex, Math.min(end, open.lastIndex + entryScan)),
    );
    open.lastIndex = end + close.length;
    let link = "";
    for (const found of body.matchAll(linkTag)) {
      const tag = found[0];
      if (match[1] === "entry") {
        const rel = attribute(tag, "rel");
        if (rel && rel !== "alternate") continue;
        link = attribute(tag, "href") ?? "";
      } else if (!tag.endsWith("/>")) {
        const from = found.index + tag.length;
        const to = body.indexOf("</link>", from);
        if (to >= 0) link = body.slice(from, to);
      }
      break;
    }
    link = decodeEntities(link).trim();
    if (!link) continue;
    try {
      const url = new URL(link, base);
      url.hash = "";
      if (!links.includes(url.href)) links.push(url.href);
    } catch {
      /* A malformed link only loses the prefetch. */
    }
  }
  return links;
}

/** RFC 9309 groups, keeping only the group that applies to this client. */
export function parseRobots(text) {
  const groups = [];
  let group = null,
    agents = true;
  for (const raw of text.slice(0, 500_000).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const split = line.indexOf(":");
    if (split < 0) continue;
    const field = line.slice(0, split).trim().toLowerCase();
    const value = line.slice(split + 1).trim();
    if (field === "user-agent") {
      if (!agents || !group) {
        group = { agents: [], rules: [] };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
      agents = true;
    } else if (field === "allow" || field === "disallow") {
      agents = false;
      if (!group) {
        group = { agents: ["*"], rules: [] };
        groups.push(group);
      }
      if (value && group.rules.length < 200 && value.length <= 512)
        group.rules.push({ allow: field === "allow", path: value });
    }
  }
  const select = (name) =>
    groups.filter((item) => item.agents.includes(name)).flatMap((g) => g.rules);
  const own = groups.some((item) => item.agents.includes("quilna"));
  return select(own ? "quilna" : "*");
}
/** Wildcards match left to right without backtracking: rules are untrusted. */
function matches(pattern, path) {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  if (!path.startsWith(parts[0])) return false;
  let position = parts[0].length;
  for (const part of parts.slice(1, -1)) {
    const found = path.indexOf(part, position);
    if (found < 0) return false;
    position = found + part.length;
  }
  if (parts.length === 1) return !anchored || position === path.length;
  const last = parts.at(-1);
  if (anchored)
    return path.length - last.length >= position && path.endsWith(last);
  return path.indexOf(last, position) >= 0;
}
export function robotsAllows(rules, path) {
  let best = null;
  for (const rule of rules) {
    if (!matches(rule.path, path)) continue;
    if (
      !best ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow)
    )
      best = rule;
  }
  return best ? best.allow : true;
}
async function gzipBase64(text) {
  const compressed = new Uint8Array(
    await new Response(
      new Response(text).body.pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  let binary = "";
  // Apply in chunks: spreading a whole page overflows the call stack.
  for (let i = 0; i < compressed.length; i += 8192)
    binary += String.fromCharCode(...compressed.subarray(i, i + 8192));
  return btoa(binary);
}

// Pages are untrusted bytes held for the browser, which extracts them like any
// other fetch. Extraction here could exceed the CPU allowance of Workers Free.
export class ArticlePrefetch {
  constructor(
    storage,
    {
      blockedHosts = [],
      now = Date.now,
      fetchArticle = (url) =>
        fetchCloudFeed(url, { blockedHosts, allowHTML: true }),
      fetchRobots = async (url) =>
        (await fetchCloudFeed(url, { blockedHosts })).xml,
      articleBytesLimit = 20_000_000,
      articleSizeLimit = 1_500_000,
    } = {},
  ) {
    Object.assign(this, {
      storage,
      blockedHosts,
      now,
      fetchArticle,
      fetchRobots,
      articleBytesLimit,
      articleSizeLimit,
    });
  }
  async read(reader) {
    return stateSchema.parse((await reader.get(stateKey)) ?? empty());
  }
  full(state) {
    return (
      state.pending.length >= 100 ||
      // Keep room for the largest page: a fetched page is never discarded for space.
      state.bytes + this.articleSizeLimit + 10_000 > this.articleBytesLimit ||
      byteLength(state) > 200_000
    );
  }
  /** Hash outside the storage transaction, then enqueue with `add`. */
  async scan(xml, base) {
    return Promise.all(
      articleLinks(xml, base).flatMap((link) => {
        try {
          const url = cloudFeedURL(link, this.blockedHosts).href;
          if (url.length > 1024) return [];
          return [hash(url).then((key) => ({ url, key: key.slice(0, 16) }))];
        } catch {
          return [];
        }
      }),
    );
  }
  async add(tx, feedUrl, links) {
    const state = await this.read(tx);
    for (const { url, key } of links) {
      if (state.seen.includes(key)) continue;
      // Over capacity this item stays unseen, so a later feed change can retry.
      if (state.queue.length >= 100 || byteLength(state) > 200_000) break;
      state.seen = [...state.seen, key].slice(-500);
      state.queue.push({ url, feedUrl, attempts: 0, notBefore: this.now() });
    }
    await tx.put(stateKey, stateSchema.parse(state));
  }
  available(state, item) {
    return Math.max(
      item.notBefore,
      state.hosts[new URL(item.url).hostname] ?? 0,
    );
  }
  async nextAt(reader) {
    const state = await this.read(reader);
    if (this.full(state) || !state.queue.length) return Infinity;
    return Math.min(...state.queue.map((item) => this.available(state, item)));
  }
  /** Persist the lease and host spacing before any network operation. */
  async take(tx, feedUrls) {
    const state = await this.read(tx);
    const now = this.now();
    state.queue = state.queue.filter((item) => feedUrls.includes(item.feedUrl));
    for (const [host, until] of Object.entries(state.hosts))
      if (until <= now) delete state.hosts[host];
    const item = this.full(state)
      ? undefined
      : state.queue.find((entry) => this.available(state, entry) <= now);
    if (item) {
      item.notBefore = now + lease;
      state.hosts[new URL(item.url).hostname] = now + hostSpacing;
    }
    await tx.put(stateKey, stateSchema.parse(state));
    return item
      ? { url: item.url, feedUrl: item.feedUrl, lease: item.notBefore }
      : null;
  }
  async robots(url) {
    const host = url.hostname;
    const cached = await this.storage.get(robotsKey(host));
    if (cached && this.now() - cached.at < robotsLifetime)
      return { rules: cached.rules };
    let rules;
    try {
      rules = parseRobots(await this.fetchRobots(`${url.origin}/robots.txt`));
    } catch (error) {
      const status = error?.status;
      // RFC 9309: an unavailable file permits access; an unreachable one does not.
      // An empty file is rejected by the feed fetcher but permits everything.
      if (
        error?.message !== "feed-xml" &&
        (!status || status >= 500 || status === 429 || status === 408)
      )
        throw error;
      rules = [];
    }
    return { rules, save: { host, at: this.now(), rules } };
  }
  /** Network work happens outside every storage transaction. */
  async load(ticket) {
    let robots;
    try {
      const url = new URL(ticket.url);
      robots = await this.robots(url);
      if (!robotsAllows(robots.rules, url.pathname + url.search))
        return { kind: "drop", robots: robots.save };
      const result = await this.fetchArticle(ticket.url);
      if (typeof result.html !== "string")
        return { kind: "drop", robots: robots.save };
      const gzip = await gzipBase64(result.html);
      if (gzip.length > this.articleSizeLimit)
        return { kind: "drop", robots: robots.save };
      const validators = validSourceValidators(result.validators)
        ? result.validators
        : undefined;
      return {
        kind: "store",
        robots: robots.save,
        body: JSON.stringify({ finalUrl: result.url, validators, gzip }),
      };
    } catch (error) {
      const status = error?.status;
      const transient =
        !status || status >= 500 || status === 408 || status === 429;
      return transient
        ? {
            kind: "retry",
            robots: robots?.save,
            retryAfter: Math.min(
              maxRetryAfter,
              Math.max(0, Number(error?.retryAfter) || 0),
            ),
          }
        : { kind: "drop", robots: robots?.save };
    }
  }
  async commit(tx, ticket, outcome, feedUrls) {
    const state = await this.read(tx);
    if (outcome.robots)
      await tx.put(robotsKey(outcome.robots.host), {
        at: outcome.robots.at,
        rules: outcome.robots.rules,
      });
    const item = state.queue.find(
      (entry) => entry.url === ticket.url && entry.notBefore === ticket.lease,
    );
    if (!item) return;
    const remove = () => {
      state.queue = state.queue.filter((entry) => entry !== item);
    };
    if (!feedUrls.includes(item.feedUrl) || outcome.kind === "drop") remove();
    else if (outcome.kind === "retry") {
      item.attempts++;
      if (item.attempts >= maxAttempts) remove();
      else item.notBefore = this.now() + retryDelays[item.attempts - 1];
      const host = new URL(item.url).hostname;
      state.hosts[host] = Math.max(
        state.hosts[host] ?? 0,
        this.now() + outcome.retryAfter * 1000,
      );
    } else {
      remove();
      const size = new TextEncoder().encode(outcome.body).byteLength;
      const id = crypto.randomUUID();
      const parts = Math.ceil(outcome.body.length / partSize);
      for (let part = 0; part < parts; part++)
        await tx.put(
          partKey(id, part),
          outcome.body.slice(part * partSize, (part + 1) * partSize),
        );
      state.pending.push({
        id,
        url: item.url,
        feedUrl: item.feedUrl,
        fetchedAt: this.now(),
        parts,
        size,
      });
      state.bytes += size;
    }
    await tx.put(stateKey, stateSchema.parse(state));
  }
  async clearQueue(tx) {
    const state = await this.read(tx);
    state.queue = [];
    await tx.put(stateKey, stateSchema.parse(state));
  }
  async remove(tx, ids) {
    const state = await this.read(tx);
    for (const item of state.pending.filter((p) => ids.includes(p.id))) {
      for (let part = 0; part < item.parts; part++)
        await tx.delete(partKey(item.id, part));
      state.bytes -= item.size;
    }
    state.pending = state.pending.filter((item) => !ids.includes(item.id));
    await tx.put(stateKey, stateSchema.parse(state));
  }
  async summary(reader) {
    const state = await this.read(reader);
    return {
      articleQueued: state.queue.length,
      articlePending: state.pending,
      articleBytes: state.bytes,
    };
  }
  async article(id) {
    z.string().uuid().parse(id);
    return this.storage.transaction(async (tx) => {
      const state = await this.read(tx);
      const meta = state.pending.find((item) => item.id === id);
      if (!meta) throw Error("snapshot-missing");
      let body = "";
      for (let i = 0; i < meta.parts; i++) {
        const part = await tx.get(partKey(id, i));
        if (typeof part !== "string") throw Error("snapshot-invalid");
        body += part;
      }
      try {
        return { ...meta, ...JSON.parse(body) };
      } catch {
        throw Error("snapshot-invalid");
      }
    });
  }
}
