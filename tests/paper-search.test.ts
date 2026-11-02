import { afterEach, expect, it, vi } from "vitest";
import fixture from "./fixtures/crossref-work.json";
import {
  paperQuery,
  paperSearchEndpoint,
  parsePaperSearch,
} from "../src/paper-search";
import { PaperClient } from "../src/paper-client";
const list = (items: unknown[], total = items.length) => ({
  status: "ok",
  "message-type": "work-list",
  message: { items, "total-results": total },
});
afterEach(() => vi.unstubAllGlobals());
it("bounds and encodes one bibliographic query without adding contact or paging parameters", () => {
  const query = "学習 & mailto=secret@example.org";
  const url = new URL(paperSearchEndpoint(` ${query} `));
  expect(url.origin + url.pathname).toBe("https://api.crossref.org/works");
  const keys: string[] = [];
  url.searchParams.forEach((_value, key) => keys.push(key));
  expect(keys).toEqual(["query.bibliographic", "rows", "select"]);
  expect(url.searchParams.get("query.bibliographic")).toBe(query);
  expect(url.searchParams.get("rows")).toBe("20");
  expect(paperQuery("a".repeat(200))).toHaveLength(200);
  for (const value of [
    "",
    "  ",
    "a".repeat(201),
    "a\nb",
    "a\u0000b",
    "a\u007fb",
  ])
    expect(() => paperQuery(value)).toThrow();
});
it("selects only bibliographic summaries, preserves date precision and counts identical normalized DOI duplicates", () => {
  const work = {
    ...fixture.message,
    abstract: "PRIVATE_ABSTRACT",
    relation: "unselected invalid relation",
    URL: "not a URL",
    resource: false,
  };
  const value = parsePaperSearch(
    list(
      [
        work,
        { ...work, DOI: work.DOI.toUpperCase() },
        { DOI: "10.5555/missing" },
      ],
      100,
    ),
  );
  expect(value.total).toBe(100);
  expect(value.duplicates).toBe(1);
  expect(value.items).toHaveLength(2);
  expect(value.items[0].published.parts).toEqual([2026, 10]);
  expect(value.items[1].titles).toEqual([]);
  expect(JSON.stringify(value)).not.toMatch(
    /PRIVATE_ABSTRACT|relation|capturedAt|endpoint|schemaVersion/,
  );
});
it("rejects invalid or conflicting list results without publishing partial summaries", () => {
  for (const value of [
    null,
    { ...list([]), "message-type": "work" },
    list([], -1),
    list([], 0.5),
    list(Array(21).fill(fixture.message)),
    list([fixture.message], 0),
    list([{ DOI: "wrong" }]),
    list([
      { DOI: "10.5555/date", published: { "date-parts": [[2026, 2, 30]] } },
    ]),
    list([fixture.message, { ...fixture.message, title: ["conflicting"] }]),
  ])
    expect(() => parsePaperSearch(value)).toThrow();
  expect(parsePaperSearch(list([]))).toEqual({
    items: [],
    total: 0,
    duplicates: 0,
  });
});
/** Share one profile's provider boundary across search and DOI lookup without network access. */
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
it("shares list and singleton cooldowns and sends only an explicit credential-free query", async () => {
  environment();
  let now = Date.parse("2026-11-03T00:00:00Z");
  const send = vi.fn(
    async (input: RequestInfo | URL, options?: RequestInit) => {
      void options;
      return new Response(
        JSON.stringify(
          String(input).includes("?") ? list([fixture.message]) : fixture,
        ),
        { headers: { "content-type": "application/json" } },
      );
    },
  );
  const client = new PaperClient(send, () => now),
    signal = new AbortController().signal;
  await expect(client.search("synthetic", signal)).resolves.toMatchObject({
    total: 1,
  });
  const [endpoint, options] = send.mock.calls[0];
  expect(endpoint).toBe(paperSearchEndpoint("synthetic"));
  expect(options).toMatchObject({
    credentials: "omit",
    referrerPolicy: "no-referrer",
    redirect: "error",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  await expect(
    new PaperClient(send, () => now).lookup(fixture.message.DOI, signal),
  ).rejects.toThrow("以降");
  expect(send).toHaveBeenCalledTimes(1);
  now += 1000;
  await client.lookup(fixture.message.DOI, signal);
  await expect(client.search("again", signal)).rejects.toThrow("以降");
  expect(send).toHaveBeenCalledTimes(2);
});
it("bounds failed list responses and carries provider backoff into subsequent DOI lookup without retries", async () => {
  const signal = new AbortController().signal,
    now = Date.parse("2026-11-03T00:00:00Z");
  for (const response of [
    new Response("limited", { status: 429 }),
    new Response("failed", { status: 503, headers: { "retry-after": "120" } }),
    new Response("x".repeat(1_000_001), {
      headers: { "content-type": "application/json" },
    }),
    new Response(Uint8Array.from([255]), {
      headers: { "content-type": "application/json" },
    }),
    new Response(JSON.stringify(list([{ DOI: "bad" }])), {
      headers: { "content-type": "application/json" },
    }),
  ]) {
    const values = environment(),
      send = vi.fn(async () => response),
      client = new PaperClient(send, () => now);
    await expect(client.search("synthetic", signal)).rejects.toThrow();
    await expect(client.lookup(fixture.message.DOI, signal)).rejects.toThrow(
      "以降",
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      Number(values.get("quilna.crossref-rate.v1")),
    ).toBeGreaterThanOrEqual(
      now +
        (response.status === 429
          ? 60000
          : response.status === 503
            ? 120000
            : 1000),
    );
  }
});
