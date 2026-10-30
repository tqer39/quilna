import { z } from "zod";
import { hash } from "./crypto.mjs";
import { cloudFeedURL, fetchCloudFeed } from "./feed-fetch.mjs";
import { validSourceValidators } from "../src/http-validators.mjs";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const feedSchema = z
  .object({
    url: z.string().max(2048),
    nextAt: integer,
    lastSuccess: integer.nullable(),
    failures: integer.max(8),
    error: z.string().max(100),
    digest: z.string().max(100),
  })
  .strict();
const snapshotSchema = z
  .object({
    id: z.string().uuid(),
    feedUrl: z.string().max(2048),
    url: z.string().max(2048),
    fetchedAt: integer,
    parts: integer.max(125),
    size: integer.max(8_000_000),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    revision: integer,
    interval: z.union([
      z.literal(0),
      z.literal(15),
      z.literal(30),
      z.literal(60),
    ]),
    feeds: z.array(feedSchema).max(50),
    pending: z.array(snapshotSchema).max(100),
    bytes: integer.max(20_000_000),
    blocked: z.boolean(),
  })
  .strict();
const empty = () => ({
  version: 1,
  revision: 0,
  interval: 0,
  feeds: [],
  pending: [],
  bytes: 0,
  blocked: false,
});
const configSchema = z
  .object({
    expectedRevision: integer,
    interval: stateSchema.shape.interval,
    urls: z.array(z.string().max(2048)).max(50),
  })
  .strict();
const stateKey = "rss:state";
const partKey = (id, part) => `rss:snapshot:${id}:${part}`;
const byteLength = (value) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

// AccountVault owns this collector. All state and alarm changes use the same
// durable transaction. Browser acknowledgement is separate from delivery.
export class FeedCollector {
  constructor(
    storage,
    {
      enabled = false,
      blockedHosts = [],
      now = Date.now,
      fetchFeed = (url) => fetchCloudFeed(url, { blockedHosts }),
    } = {},
  ) {
    Object.assign(this, { storage, enabled, blockedHosts, now, fetchFeed });
  }
  async transaction(update) {
    return this.storage.transaction(async (tx) => {
      const state = stateSchema.parse((await tx.get(stateKey)) ?? empty());
      const result = await update(state, tx);
      if (byteLength(state) > 110_000) throw Error("collection-capacity");
      await tx.put(stateKey, stateSchema.parse(state));
      return result;
    });
  }
  async schedule(state, tx) {
    if (
      !this.enabled ||
      !state.interval ||
      !state.feeds.length ||
      state.blocked
    ) {
      await tx.deleteAlarm();
      return;
    }
    await tx.setAlarm(
      Math.max(
        this.now() + 1000,
        Math.min(...state.feeds.map((f) => f.nextAt)),
      ),
    );
  }
  summary(state) {
    return {
      available: this.enabled,
      revision: state.revision,
      interval: state.interval,
      sourcePolicy: "public-https",
      hosts: [],
      feeds: state.feeds.map((feed) => ({
        url: feed.url,
        nextAt: feed.nextAt,
        lastSuccess: feed.lastSuccess,
        failures: feed.failures,
        error: feed.error,
      })),
      pending: state.pending,
      bytes: state.bytes,
      blocked: state.blocked,
    };
  }
  async status() {
    const state = stateSchema.parse(
      (await this.storage.get(stateKey)) ?? empty(),
    );
    return this.summary(state);
  }
  async source(input) {
    if (!this.enabled) throw Error("collection-unconfigured");
    const request = z
      .object({
        url: z.string().max(2048),
        discover: z.boolean().optional(),
        validators: z.custom(validSourceValidators).optional(),
      })
      .strict()
      .parse(input);
    cloudFeedURL(request.url, this.blockedHosts);
    await this.storage.transaction(async (tx) => {
      const recent = ((await tx.get("rss:requests")) ?? []).filter(
        (time) => time > this.now() - 60_000,
      );
      if (recent.length >= 20) throw Error("rate-limit");
      await tx.put("rss:requests", [...recent, this.now()]);
    });
    return fetchCloudFeed(request.url, {
      blockedHosts: this.blockedHosts,
      allowHTML: request.discover === true,
      validators: request.validators,
    });
  }
  async configure(input) {
    if (!this.enabled) throw Error("collection-unconfigured");
    const config = configSchema.parse(input);
    const urls = [
      ...new Set(
        config.urls.map((url) => cloudFeedURL(url, this.blockedHosts).href),
      ),
    ];
    if (byteLength(urls) > 16_000) throw Error("collection-capacity");
    return this.transaction(async (state, tx) => {
      if (state.revision !== config.expectedRevision)
        throw Error("collection-conflict");
      state.revision++;
      state.interval = config.interval;
      state.feeds = urls.map(
        (url) =>
          state.feeds.find((feed) => feed.url === url) ?? {
            url,
            nextAt: this.now(),
            lastSuccess: null,
            failures: 0,
            error: "",
            digest: "",
          },
      );
      await this.schedule(state, tx);
      return this.summary(state);
    });
  }
  async snapshot(id) {
    z.string().uuid().parse(id);
    // Read metadata and parts in one transaction, including concurrent ACKs.
    return this.storage.transaction(async (tx) => {
      const state = stateSchema.parse((await tx.get(stateKey)) ?? empty());
      const meta = state.pending.find((item) => item.id === id);
      if (!meta) throw Error("snapshot-missing");
      let xml = "";
      for (let i = 0; i < meta.parts; i++) {
        const part = await tx.get(partKey(id, i));
        if (typeof part !== "string") throw Error("snapshot-invalid");
        xml += part;
      }
      if (new TextEncoder().encode(xml).byteLength !== meta.size)
        throw Error("snapshot-invalid");
      return { ...meta, xml };
    });
  }
  async acknowledge(input) {
    const { ids } = z
      .object({ ids: z.array(z.string().uuid()).max(100) })
      .strict()
      .parse(input);
    return this.transaction(async (state, tx) => {
      const removed = state.pending.filter((item) => ids.includes(item.id));
      for (const item of removed) {
        for (let part = 0; part < item.parts; part++)
          await tx.delete(partKey(item.id, part));
        state.bytes -= item.size;
      }
      state.pending = state.pending.filter((item) => !ids.includes(item.id));
      if (removed.length) state.blocked = false;
      await this.schedule(state, tx);
      return this.summary(state);
    });
  }
  async alarm() {
    const work = await this.transaction(async (state, tx) => {
      if (!this.enabled || !state.interval || state.blocked) {
        await this.schedule(state, tx);
        return [];
      }
      const due = state.feeds
        .filter((feed) => feed.nextAt <= this.now())
        .slice(0, 2);
      // Persist a recovery alarm before any network operation. Re-delivery or
      // process death cannot start the same feed again during this lease.
      for (const feed of due) feed.nextAt = this.now() + 60_000;
      await this.schedule(state, tx);
      return due.map((feed) => ({
        url: feed.url,
        revision: state.revision,
        lease: feed.nextAt,
      }));
    });
    await Promise.all(
      work.map(async (ticket) => {
        let result, digest, failure;
        try {
          result = await this.fetchFeed(ticket.url);
          cloudFeedURL(result.url, this.blockedHosts);
          if (
            typeof result.xml !== "string" ||
            result.xml.length > 2_000_000 ||
            /<!\s*(DOCTYPE|ENTITY)/i.test(result.xml)
          )
            throw Error();
          digest = await hash(result.url + "\n" + result.xml);
        } catch {
          failure = "feed-fetch-failed";
        }
        await this.transaction(async (state, tx) => {
          const feed = state.feeds.find((item) => item.url === ticket.url);
          if (
            state.revision !== ticket.revision ||
            !state.interval ||
            !feed ||
            feed.nextAt !== ticket.lease
          )
            return;
          if (failure) {
            feed.failures = Math.min(8, feed.failures + 1);
            feed.error = failure;
            feed.nextAt =
              this.now() + Math.min(60, 5 * 2 ** (feed.failures - 1)) * 60_000;
          } else {
            if (feed.digest !== digest) {
              const size = new TextEncoder().encode(result.xml).byteLength;
              const id = crypto.randomUUID();
              const parts = Math.ceil(result.xml.length / 16000);
              const meta = {
                id,
                feedUrl: feed.url,
                url: result.url,
                fetchedAt: this.now(),
                parts,
                size,
              };
              if (
                state.pending.length >= 100 ||
                state.bytes + size > 20_000_000 ||
                byteLength({ ...state, pending: [...state.pending, meta] }) >
                  109_000
              ) {
                state.blocked = true;
                feed.error = "collection-capacity";
                await this.schedule(state, tx);
                return;
              }
              for (let part = 0; part < parts; part++)
                await tx.put(
                  partKey(id, part),
                  result.xml.slice(part * 16000, (part + 1) * 16000),
                );
              state.pending.push(meta);
              state.bytes += size;
              feed.digest = digest;
            }
            feed.lastSuccess = this.now();
            feed.failures = 0;
            feed.error = "";
            feed.nextAt = this.now() + state.interval * 60_000;
          }
          await this.schedule(state, tx);
        });
      }),
    );
  }
}
