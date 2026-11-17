import { it, expect, vi } from "vitest";
import fixture from "./fixtures/shared-textbook-v2.json";
import { TopicGenerationClient } from "../src/topic-generation-client";
import { parseTextbookCandidate } from "../src/shared-textbook-format";
import type {
  TopicQuote,
  TopicGenerationInput,
} from "../src/topic-generation-protocol";
const decode = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
const record = JSON.parse(decode(fixture.record));
const requestRaw = decode(record.request),
  draftRaw = decode(record.draft),
  reviewRaw = decode(record.review);
const candidate = await parseTextbookCandidate(requestRaw, draftRaw);
const account = "a".repeat(64);
const quote: TopicQuote = {
  modelId: "fixture-model",
  provider: "openai",
  model: "fixture",
  purpose: "book-addition",
  maxMilliYen: 1000,
  quoteDigest: "1".repeat(64),
  inputTokens: 8000,
  outputTokens: 2000,
  dataConditions: "検証用の設定",
  priceCheckedAt: "2026-11-17T00:00:00Z",
  costCheckedAt: "2026-11-17T00:00:00Z",
};
const input: TopicGenerationInput = {
  requestId: candidate.request.id.toLowerCase(),
  requestRaw,
  modelId: quote.modelId,
  purpose: "book-addition",
  approvedPublicText: true,
  approvedMaxMilliYen: quote.maxMilliYen,
  approvedQuoteDigest: quote.quoteDigest,
};
const capabilities = {
  account,
  mode: "test-only",
  csrfToken: "synthetic-csrf-token-for-tests",
  quotes: [quote],
  budget: {
    limitMilliYen: 500000,
    spentMilliYen: 0,
    heldMilliYen: 0,
    fixedMilliYen: 100000,
    safetyMilliYen: 100000,
  },
};
const result = () => ({
  account,
  status: "complete",
  outcome: "complete",
  draft: {
    kind: "topic-textbook-draft",
    requestDigest: candidate.requestDigest,
    draftDigest: candidate.draftDigest,
    json: draftRaw,
    invocation: {
      id: record.generator.id.toLowerCase(),
      provider: "openai",
      model: "fixture",
    },
  },
});
const signal = () => new AbortController().signal;
function setup(
  reply: () => Promise<Response> | Response = () => Response.json(result()),
  status = capabilities,
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let owner: string | null = account,
    lost = 0;
  const client = new TopicGenerationClient(
    account,
    () => owner,
    () => {
      lost++;
    },
    async (url, init) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith("/status") ? Response.json(status) : reply();
    },
  );
  return {
    client,
    calls,
    owner: (value: string | null) => {
      owner = value;
    },
    lost: () => lost,
  };
}
it("所有者・CSRF・見積りを固定し、テーマ候補のhashを検査して一度だけ送る", async () => {
  const f = setup();
  const reply = await f.client.operate("proposals", input, quote, signal());
  expect(reply).toEqual(result());
  expect(f.calls.map((c) => c.url)).toEqual([
    "/api/topic-textbooks/status",
    "/api/topic-textbooks/proposals",
  ]);
  expect(JSON.parse(String(f.calls[1].init?.body))).toEqual(input);
  expect(f.calls[1].init).toMatchObject({
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers: {
      "X-Library-Account": account,
      "X-CSRF-Token": capabilities.csrfToken,
    },
  });
});
it("同意した上限やモデルが変わると本文を送らない", async () => {
  const f = setup();
  await expect(
    f.client.operate(
      "proposals",
      { ...input, approvedMaxMilliYen: 999 },
      quote,
      signal(),
    ),
  ).rejects.toHaveProperty("code", "cost-unapproved");
  await expect(
    f.client.operate(
      "proposals",
      { ...input, modelId: "other" },
      quote,
      signal(),
    ),
  ).rejects.toHaveProperty("code", "cost-unapproved");
  expect(f.calls).toHaveLength(0);
});
it("別の所有者の応答や現在の文脈の変更を受け付けない", async () => {
  const f = setup(() =>
    Response.json({ ...result(), account: "b".repeat(64) }),
  );
  await expect(
    f.client.operate("proposals", input, quote, signal()),
  ).rejects.toHaveProperty("code", "account-mismatch");
  expect(f.lost()).toBe(1);
  const g = setup();
  g.owner("b".repeat(64));
  await expect(g.client.status(signal())).rejects.toHaveProperty(
    "code",
    "account-mismatch",
  );
  expect(g.calls).toHaveLength(0);
});
it("中止を無視する送信処理の遅い応答も採用せず再送しない", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = setup(async () => {
    entered();
    await gate;
    return Response.json(result());
  });
  const controller = new AbortController();
  const pending = f.client.operate(
    "proposals",
    input,
    quote,
    controller.signal,
  );
  await waiting;
  controller.abort();
  release();
  await expect(pending).rejects.toHaveProperty("code", "cancelled");
  expect(f.calls).toHaveLength(2);
});
it("候補の照合中の中止も採用せず、受け取った誤った本文を拒否する", async () => {
  let release!: () => void,
    entered!: () => void,
    active = false,
    held = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = setup(() => {
    active = true;
    return Response.json(result());
  });
  const original = crypto.subtle.digest.bind(crypto.subtle);
  const mock = vi
    .spyOn(crypto.subtle, "digest")
    .mockImplementation(async (...args) => {
      const value = original(...args);
      if (active && !held) {
        held = true;
        entered();
        await gate;
      }
      return value;
    });
  const controller = new AbortController();
  try {
    const pending = f.client.operate(
      "proposals",
      input,
      quote,
      controller.signal,
    );
    await waiting;
    controller.abort();
    release();
    await expect(pending).rejects.toHaveProperty("code", "cancelled");
  } finally {
    release();
    mock.mockRestore();
  }
  const invalid = result();
  invalid.draft.json = draftRaw.replace("モデル", "異なる本文");
  const g = setup(() => Response.json(invalid));
  await expect(
    g.client.operate("proposals", input, quote, signal()),
  ).rejects.toHaveProperty("code", "invalid-response");
});
it("キーの接続が無効でも、元の操作を照会して費用を増やさない", async () => {
  const f = setup(() => Response.json(result()), {
    ...capabilities,
    mode: "unconnected",
    quotes: [],
  });
  await expect(
    f.client.operate("proposals", input, quote, signal()),
  ).rejects.toHaveProperty("code", "unconnected");
  expect(await f.client.operate("operations", input, quote, signal())).toEqual(
    result(),
  );
  expect(f.calls.map((c) => c.url)).toEqual([
    "/api/topic-textbooks/status",
    "/api/topic-textbooks/status",
    "/api/topic-textbooks/operations",
  ]);
});
it("否定された検証を成功判定へ変えず、検証flagの不整合を拒否する", async () => {
  const review = JSON.parse(reviewRaw);
  review.sections[0].checks[0].passed = false;
  const approved = {
    ...quote,
    purpose: "evidence-check" as const,
    quoteDigest: "2".repeat(64),
  };
  const reviewInput = {
    ...input,
    requestId: record.reviewer.id.toLowerCase(),
    purpose: "evidence-check" as const,
    approvedQuoteDigest: approved.quoteDigest,
    generationRequestId: input.requestId,
    generatorInvocation: record.generator.id.toLowerCase(),
    draftRaw,
  };
  const body = {
    account,
    status: "complete",
    outcome: "complete",
    draft: {
      kind: "topic-textbook-review",
      requestDigest: candidate.requestDigest,
      draftDigest: candidate.draftDigest,
      json: JSON.stringify(review),
      invocation: {
        id: record.reviewer.id.toLowerCase(),
        provider: "openai",
        model: "fixture",
      },
      allChecksPassed: false,
    },
  };
  const f = setup(() => Response.json(body));
  expect(
    await f.client.operate("operations", reviewInput, approved, signal()),
  ).toEqual(body);
  body.draft.allChecksPassed = true;
  await expect(
    f.client.operate("operations", reviewInput, approved, signal()),
  ).rejects.toHaveProperty("code", "invalid-response");
});
it("大きすぎる応答を最後まで読まず破棄する", async () => {
  let cancelled = false;
  const f = setup(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(262145));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  );
  await expect(
    f.client.operate("proposals", input, quote, signal()),
  ).rejects.toHaveProperty("code", "invalid-response");
  expect(cancelled).toBe(true);
});

it("CSRFだけの失効は所有者を無効化せず、明示的な次の操作で再取得する", async () => {
  let posts = 0;
  const f = setup(() =>
    ++posts === 1
      ? Response.json({ status: "csrf-invalid" }, { status: 403 })
      : Response.json(result()),
  );
  await expect(
    f.client.operate("proposals", input, quote, signal()),
  ).rejects.toHaveProperty("code", "csrf-invalid");
  expect(f.lost()).toBe(0);
  expect(await f.client.operate("operations", input, quote, signal())).toEqual(
    result(),
  );
  expect(f.calls.filter((c) => c.url.endsWith("/status"))).toHaveLength(2);
});
