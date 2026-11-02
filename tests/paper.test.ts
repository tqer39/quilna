import { afterEach, expect, it, vi } from "vitest";
import fixture from "./fixtures/crossref-work.json";
import {
  crossrefMetadata,
  paperDOI,
  paperEndpoint,
  paperSnapshot,
  parsePaper,
} from "../src/paper-format";
import { PaperClient } from "../src/paper-client";

afterEach(() => vi.unstubAllGlobals());
it("reports malformed JSON in Japanese instead of leaking a parser diagnostic into the import UI", async () => {
  await expect(parsePaper("{not-json")).rejects.toThrow("書誌情報の形式");
});
it("normalizes DOI case and exact resolver paths without changing literal suffix delimiters", () => {
  expect(paperDOI("  DOI:10.5555/ABC  ")).toBe("10.5555/abc");
  expect(paperDOI("https://doi.org/10.5555%2FABC%3Fx%23z")).toBe(
    "10.5555/abc?x#z",
  );
  expect(paperEndpoint("10.5555/a?x#z")).toBe(
    "https://api.crossref.org/works/10.5555%2Fa%3Fx%23z",
  );
  for (const value of [
    "https://doi.org.evil.test/10.5555/x",
    "https://a@doi.org/10.5555/x",
    "https://doi.org/10.5555/x?token=private",
    "http://doi.org/10.5555/x",
    "10.5555/has space",
    "10.1/x",
    "10.5555/x\nsecret",
  ])
    expect(() => paperDOI(value)).toThrow();
});
it("round-trips the selected version, partial dates and deposited relationships without importing abstract/private data", async () => {
  const metadata = crossrefMetadata(fixture, fixture.message.DOI),
    p = await paperSnapshot(metadata, "2026-11-03T00:00:00.000Z");
  expect(metadata.version).toBe("2");
  expect(metadata.dates.published.parts).toEqual([2026, 10]);
  expect(metadata.dates.print).toEqual({ parts: null, timestamp: null });
  expect(metadata.relations[0].kind).toBe("is-preprint-of");
  expect(metadata.updates[0].date).toEqual([2026, 10, 30]);
  expect(metadata.publisherURL).toBe(
    "https://publisher.example.org/preprint/v2",
  );
  const raw = JSON.stringify(p);
  expect(raw).not.toMatch(/COPYRIGHTED|UNSELECTED|PRIVATE/);
  expect(await parsePaper(raw)).toEqual(p);
  const reversed = JSON.parse(raw);
  reversed.metadata = Object.fromEntries(
    Object.entries(reversed.metadata).reverse(),
  );
  expect(await parsePaper(JSON.stringify(reversed))).toEqual(p);
  const recaptured = await paperSnapshot(metadata, "2026-11-04T00:00:00.000Z");
  expect(recaptured.digest).toBe(p.digest);
  const revised = structuredClone(metadata);
  revised.version = "3";
  expect((await paperSnapshot(revised)).digest).not.toBe(p.digest);
});
it("keeps absent fields unknown and refuses mismatched DOI, malformed dates and excessive collections", () => {
  const m = crossrefMetadata(
    { status: "ok", "message-type": "work", message: { DOI: "10.5555/x" } },
    "10.5555/x",
  );
  expect(m.titles).toEqual([]);
  expect(m.authors).toEqual([]);
  expect(m.version).toBeNull();
  for (const modify of [
    (f: typeof fixture) => {
      f.message.DOI = "10.5555/other";
    },
    (f: typeof fixture) => {
      f.message.published["date-parts"] = [[2025, 2, 29]];
    },
    (f: typeof fixture) => {
      f.message.published["date-parts"] = [[2026, 13]];
    },
    (f: typeof fixture) => {
      f.message.title = Array(33).fill("a");
    },
    (f: typeof fixture) => {
      f.message.author = Array(501).fill(f.message.author[0]);
    },
  ]) {
    const f = structuredClone(fixture);
    modify(f);
    expect(() => crossrefMetadata(f, fixture.message.DOI)).toThrow();
  }
});
it("refuses altered, future, oversized or private-bearing portable observations", async () => {
  const p = await paperSnapshot(crossrefMetadata(fixture, fixture.message.DOI));
  for (const mutate of [
    (v: Record<string, unknown>) => {
      v.schemaVersion = 2;
    },
    (v: Record<string, unknown>) => {
      v.answers = ["secret"];
    },
    (v: Record<string, unknown>) => {
      (v.metadata as Record<string, unknown>).titles = ["altered"];
    },
    (v: Record<string, unknown>) => {
      (v.metadata as Record<string, unknown>).abstract = "not allowed";
    },
    (v: Record<string, unknown>) => {
      v.endpoint = "https://other.example/";
    },
    (v: Record<string, unknown>) => {
      v.capturedAt = "2026-02-30T00:00:00.000Z";
    },
  ]) {
    const v = structuredClone(p) as unknown as Record<string, unknown>;
    mutate(v);
    await expect(parsePaper(JSON.stringify(v))).rejects.toThrow();
  }
  await expect(parsePaper(" ".repeat(1_000_001))).rejects.toThrow();
});

/** Isolate the transport's cross-tab coordination and clock without any network or credentials. */
function environment() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _name: string,
        options: { signal: AbortSignal },
        run: () => Promise<unknown>,
      ) => {
        options.signal.throwIfAborted();
        return run();
      },
    },
  });
  return values;
}
it("dispatches only the exact DOI without cookies/referrer and honors advertised cooldown across clients", async () => {
  environment();
  let clock = Date.parse("2026-11-03T00:00:00Z");
  const send = vi.fn(
    async () =>
      new Response(JSON.stringify(fixture), {
        headers: {
          "Content-Type": "application/json",
          "x-rate-limit-limit": "1",
          "x-rate-limit-interval": "10s",
          "x-rate-limit-type": "single",
        },
      }),
  );
  const client = new PaperClient(send, () => clock),
    signal = new AbortController().signal;
  await client.lookup(fixture.message.DOI, signal);
  expect(send).toHaveBeenCalledTimes(1);
  const [endpoint, options] = send.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(endpoint).toBe(paperEndpoint(fixture.message.DOI));
  expect(options.credentials).toBe("omit");
  expect(options.referrerPolicy).toBe("no-referrer");
  expect(options.redirect).toBe("error");
  expect(options.headers).toEqual({ Accept: "application/json" });
  await expect(
    new PaperClient(send, () => clock).lookup(fixture.message.DOI, signal),
  ).rejects.toThrow("以降");
  expect(send).toHaveBeenCalledTimes(1);
  clock += 10000;
  await client.lookup(fixture.message.DOI, signal);
  expect(send).toHaveBeenCalledTimes(2);
});
it("stops on 429 without retries, retaining Retry-After as a shared manual retry boundary", async () => {
  const values = environment(),
    now = Date.parse("2026-11-03T00:00:00Z"),
    send = vi.fn(
      async () =>
        new Response("limited", {
          status: 429,
          headers: { "retry-after": "120" },
        }),
    );
  await expect(
    new PaperClient(send, () => now).lookup(
      fixture.message.DOI,
      new AbortController().signal,
    ),
  ).rejects.toThrow("要求上限");
  expect(send).toHaveBeenCalledTimes(1);
  expect(Number(values.get("quilna.crossref-rate.v1"))).toBe(now + 120000);
});
it("refuses failed, mismatched, oversized and invalid UTF-8 provider responses", async () => {
  for (const response of [
    new Response("missing", { status: 404 }),
    new Response("failure", { status: 503 }),
    new Response(
      JSON.stringify({
        ...fixture,
        message: { ...fixture.message, DOI: "10.5555/other" },
      }),
      { headers: { "Content-Type": "application/json" } },
    ),
    new Response("x".repeat(1_000_001), {
      headers: { "Content-Type": "application/json" },
    }),
    new Response(Uint8Array.from([0xff]), {
      headers: { "Content-Type": "application/json" },
    }),
  ]) {
    environment();
    const send = vi.fn(async () => response);
    await expect(
      new PaperClient(send).lookup(
        fixture.message.DOI,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  }
});
it("rejects a late provider success after cancellation even when transport ignores the signal", async () => {
  environment();
  let release!: (r: Response) => void;
  const pending = new Promise<Response>((resolve) => {
      release = resolve;
    }),
    c = new AbortController(),
    send = vi.fn(() => pending);
  const result = new PaperClient(send).lookup(fixture.message.DOI, c.signal);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  c.abort();
  release(
    new Response(JSON.stringify(fixture), {
      headers: { "Content-Type": "application/json" },
    }),
  );
  await expect(result).rejects.toThrow("中止");
});
