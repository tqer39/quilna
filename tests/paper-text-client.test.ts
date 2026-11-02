import { afterEach, expect, it, vi } from "vitest";
import fixture from "./fixtures/crossref-work.json";
import { crossrefMetadata, paperSnapshot } from "../src/paper-format";
import { PaperTextClient } from "../src/paper-text-client";
import { paperTextEndpoint } from "../src/paper-text-format";
afterEach(() => vi.unstubAllGlobals());
/** Coordinate only a synthetic profile and clock; no provider, account or credentials are contacted. */
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
const paper = () =>
  paperSnapshot(crossrefMetadata(fixture, fixture.message.DOI));
it("rejects invalid archive identifiers and aborted submissions before dispatch", async () => {
  environment();
  const send = vi.fn(async () => new Response("missing", { status: 404 })),
    client = new PaperTextClient(send),
    observation = await paper();
  await expect(
    client.lookup(
      "https://publisher.invalid/",
      observation,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  const abort = new AbortController();
  abort.abort();
  await expect(
    client.lookup("PMC1234567", observation, abort.signal),
  ).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});
it("dispatches only the PMCID to a fixed endpoint without cookies, referrer, contact parameters or redirect following", async () => {
  const values = environment();
  values.set("PRIVATE_EMAIL", "private@example.invalid");
  const send = vi.fn(
    async (input: RequestInfo | URL, options?: RequestInit) => {
      void input;
      void options;
      return new Response("unavailable", { status: 404 });
    },
  );
  await expect(
    new PaperTextClient(send).lookup(
      "PMC1234567",
      await paper(),
      new AbortController().signal,
    ),
  ).rejects.toThrow("公開本文を取得できません");
  expect(send).toHaveBeenCalledTimes(1);
  const [url, options] = send.mock.calls[0];
  expect(url).toBe(paperTextEndpoint("PMC1234567"));
  expect(options).toMatchObject({
    credentials: "omit",
    referrerPolicy: "no-referrer",
    redirect: "error",
    cache: "no-store",
    headers: { Accept: "application/xml" },
  });
  expect(String(url)).not.toContain(fixture.message.DOI);
  expect(values.get("PRIVATE_EMAIL")).toBe("private@example.invalid");
});
it("shares a conservative manual boundary across client instances and retains Retry-After without retrying", async () => {
  const values = environment(),
    now = Date.parse("2026-11-03T00:00:00Z"),
    observation = await paper(),
    signal = new AbortController().signal;
  const send = vi.fn(
    async () =>
      new Response("limited", {
        status: 429,
        headers: { "retry-after": "120" },
      }),
  );
  await expect(
    new PaperTextClient(send, () => now).lookup(
      "PMC1234567",
      observation,
      signal,
    ),
  ).rejects.toThrow("要求上限");
  await expect(
    new PaperTextClient(send, () => now).lookup(
      "PMC7654321",
      observation,
      signal,
    ),
  ).rejects.toThrow("以降");
  expect(send).toHaveBeenCalledTimes(1);
  expect(Number(values.get("quilna.europepmc-rate.v1"))).toBe(now + 120000);
});
it("keeps a 60-second minimum after service unavailability without replaying the body request", async () => {
  const values = environment(),
    now = Date.parse("2026-11-03T00:00:00Z"),
    send = vi.fn(
      async () =>
        new Response("private provider diagnostics", {
          status: 503,
          headers: { "retry-after": "1" },
        }),
    );
  await expect(
    new PaperTextClient(send, () => now).lookup(
      "PMC1234567",
      await paper(),
      new AbortController().signal,
    ),
  ).rejects.toThrow("公開本文を取得できません");
  expect(Number(values.get("quilna.europepmc-rate.v1"))).toBe(now + 60000);
  expect(send).toHaveBeenCalledTimes(1);
});
it("bounds bytes read from the stream and cancels an oversized response before XML parsing", async () => {
  environment();
  const cancel = vi.fn(),
    stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(2000001)));
      },
      cancel,
    }),
    send = vi.fn(
      async () =>
        new Response(stream, {
          headers: { "content-type": "application/xml" },
        }),
    );
  await expect(
    new PaperTextClient(send).lookup(
      "PMC1234567",
      await paper(),
      new AbortController().signal,
    ),
  ).rejects.toThrow("2,000,000バイト");
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
});
it("refuses invalid UTF-8, HTML/JSON responses and empty successful replies without exposing provider diagnostics", async () => {
  for (const response of [
    new Response(Uint8Array.from([255]), {
      headers: { "content-type": "application/xml" },
    }),
    new Response("PRIVATE_HTML", { headers: { "content-type": "text/html" } }),
    new Response('{"private":"diagnostics"}', {
      headers: { "content-type": "application/json" },
    }),
    new Response(null, {
      status: 204,
      headers: { "content-type": "application/xml" },
    }),
  ]) {
    environment();
    const send = vi.fn(async () => response),
      client = new PaperTextClient(send);
    await expect(
      client.lookup("PMC1234567", await paper(), new AbortController().signal),
    ).rejects.toThrow(
      /Europe PMCへの接続または本文応答を確認できません|Europe PMCの本文応答形式を確認できません/,
    );
    expect(send).toHaveBeenCalledTimes(1);
  }
});
it("rejects a late response when a transport ignores the abort signal", async () => {
  environment();
  const abort = new AbortController(),
    send = vi.fn(async () => {
      abort.abort();
      return new Response("PRIVATE_XML", {
        headers: { "content-type": "application/xml" },
      });
    });
  await expect(
    new PaperTextClient(send).lookup("PMC1234567", await paper(), abort.signal),
  ).rejects.toThrow("確認を中止しました");
  expect(send).toHaveBeenCalledTimes(1);
});
it("refuses a browser without Web Locks before any provider dispatch", async () => {
  environment();
  vi.stubGlobal("navigator", {});
  const send = vi.fn(async () => new Response("PRIVATE_XML"));
  await expect(
    new PaperTextClient(send).lookup(
      "PMC1234567",
      await paper(),
      new AbortController().signal,
    ),
  ).rejects.toThrow("要求調整を利用できません");
  expect(send).not.toHaveBeenCalled();
});
