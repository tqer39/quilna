import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import fixtureBook from "../fixtures/shared-textbook-v2.json" with { type: "json" };
const decode = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
const record = JSON.parse(decode(fixtureBook.record));
const original = JSON.parse(decode(record.request));
const account = "a".repeat(64);
const quote = {
  modelId: "fixture-model",
  provider: "openai",
  model: "fixture",
  purpose: "book-addition",
  maxMilliYen: 1000,
  quoteDigest: "1".repeat(64),
  inputTokens: 8000,
  outputTokens: 2000,
  dataConditions: "合成応答による検証用。外部通信なし。",
  priceCheckedAt: "2026-11-17T00:00:00Z",
  costCheckedAt: "2026-11-17T00:00:00Z",
};
const hash = async (raw: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
async function fixture(context: BrowserContext) {
  const state = {
    proposals: [] as Record<string, string>[],
    lookups: 0,
    stored: new Map<string, object>(),
    negative: false,
    connected: true,
    held: false,
    rejectReview: false,
    rejectGenerate: false,
    unsentReview: false,
    csrfReject: false,
    reviewQuoteDigest: "2".repeat(64),
    generationQuoteDigest: "1".repeat(64),
  };
  await context.route("**/api/**", (route) =>
    route.fulfill({ status: 404, json: {} }),
  );
  await context.route("**/api/library/status", (route) =>
    route.fulfill({ json: { schema: 1, account, legacy: false } }),
  );
  await context.route(
    (url) => url.pathname === "/",
    async (route) => {
      const r = await route.fetch();
      await route.fulfill({
        response: r,
        body: (await r.text()).replace(
          "</head>",
          '<meta name="account-libraries" content="required"></head>',
        ),
      });
    },
  );
  await context.route("**/api/topic-textbooks/status", (route) =>
    route.fulfill({
      json: {
        account,
        mode: state.connected ? "test-only" : "unconnected",
        csrfToken: "synthetic-csrf-token-for-tests",
        quotes: state.connected
          ? [
              { ...quote, quoteDigest: state.generationQuoteDigest },
              {
                ...quote,
                purpose: "evidence-check",
                quoteDigest: state.reviewQuoteDigest,
              },
            ]
          : [],
        budget: {
          limitMilliYen: 500000,
          spentMilliYen: 0,
          heldMilliYen: 0,
          fixedMilliYen: 100000,
          safetyMilliYen: 100000,
        },
      },
    }),
  );
  await context.route(
    "**/api/topic-textbooks/{proposals,operations}",
    async (route) => {
      const input = route.request().postDataJSON();
      if (route.request().url().endsWith("operations")) {
        state.lookups++;
        return route.fulfill({
          json: state.stored.get(input.requestId) ?? {
            account,
            status: "not-found",
            draft: null,
          },
        });
      }
      state.proposals.push(input);
      expect(route.request().headers()["x-library-account"]).toBe(account);
      expect(route.request().headers()["x-csrf-token"]).toBe(
        "synthetic-csrf-token-for-tests",
      );
      expect(input.approvedMaxMilliYen).toBe(1000);
      const currentQuote =
        input.purpose === "book-addition"
          ? state.generationQuoteDigest
          : state.reviewQuoteDigest;
      if (input.approvedQuoteDigest !== currentQuote)
        return route.fulfill({ json: { account, status: "quote-changed" } });
      expect(input.approvedQuoteDigest).toBe(currentQuote);
      if (state.rejectReview && input.purpose === "evidence-check")
        return route.fulfill({ json: { account, status: "busy" } });
      if (state.csrfReject) {
        state.csrfReject = false;
        return route.fulfill({ status: 403, json: { status: "csrf-invalid" } });
      }
      if (state.rejectGenerate && input.purpose === "book-addition")
        return route.fulfill({ json: { account, status: "busy" } });
      if (state.unsentReview && input.purpose === "evidence-check") {
        const failure = {
          account,
          status: "rejected",
          draft: null,
          outcome: "credential-unavailable",
        };
        state.stored.set(input.requestId, { ...failure, retryable: true });
        return route.fulfill({ json: failure });
      }
      const request = JSON.parse(input.requestRaw);
      let raw: string;
      if (input.purpose === "book-addition")
        raw = decode(record.draft).replaceAll(
          original.sources[0].id,
          request.sources[0].id,
        );
      else {
        const review = JSON.parse(decode(record.review));
        review.requestDigest = await hash(input.requestRaw);
        review.draftDigest = await hash(input.draftRaw);
        if (state.negative) review.sections[0].checks[0].passed = false;
        raw = JSON.stringify(review);
      }
      const reply = {
        account,
        status: "complete",
        outcome: "complete",
        draft: {
          kind:
            input.purpose === "book-addition"
              ? "topic-textbook-draft"
              : "topic-textbook-review",
          requestDigest: await hash(input.requestRaw),
          draftDigest: await hash(
            input.purpose === "book-addition" ? raw : input.draftRaw,
          ),
          json: raw,
          invocation: {
            id: crypto.randomUUID(),
            provider: "openai",
            model: "fixture",
          },
          ...(input.purpose === "evidence-check"
            ? { allChecksPassed: !state.negative }
            : {}),
        },
      };
      state.stored.set(input.requestId, reply);
      return route.fulfill({
        json: state.held ? { account, status: "reserved", draft: null } : reply,
      });
    },
  );
  return state;
}
async function open(page: Page) {
  await page.goto("/?view=textbooks");
  await page.getByText("テーマの教材を作る", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "作成の控え", exact: true }),
  ).toBeVisible();
}
async function preview(page: Page) {
  await page
    .getByLabel("教材のテーマ", { exact: true })
    .fill(original.topic.name);
  await page
    .getByLabel("学習目標", { exact: true })
    .fill(original.learningGoal);
  await page.getByLabel("出典の題名").fill(original.sources[0].title);
  await page.getByLabel("公開資料のURL（任意）").fill(original.sources[0].url);
  await page.getByLabel("送ってよい原文抜粋").fill(original.sources[0].excerpt);
  await page
    .getByRole("button", { name: "送信内容と費用を確認", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "送信する内容", exact: true }),
  ).toBeVisible();
}
async function generate(page: Page) {
  await preview(page);
  await page.getByRole("checkbox", { name: /この上限内で生成/ }).check();
  await page
    .getByRole("button", { name: "確認した費用で生成する", exact: true })
    .click();
}
test("確認・生成・別の検証・保存・読書を明示操作で行い、再照会は生成しない", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await open(page);
  await preview(page);
  await page.screenshot({
    path: `.local-state/topic-creator-${test.info().project.name}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(state.proposals).toHaveLength(0);
  await page
    .getByRole("button", { name: "確認した費用で生成する", exact: true })
    .click();
  await expect(
    page.locator('[role="status"]').filter({ hasText: "確認が必要" }),
  ).toBeVisible();
  expect(state.proposals).toHaveLength(0);
  await page.getByRole("checkbox", { name: /この上限内で生成/ }).check();
  await page
    .getByRole("button", { name: "確認した費用で生成する", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "生成した候補", exact: true }),
  ).toBeVisible();
  expect(state.proposals).toHaveLength(1);
  await page.getByRole("checkbox", { name: /上限内で検証/ }).check();
  await page
    .getByRole("button", { name: "確認した費用で検証する", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "検証結果", exact: true }),
  ).toBeVisible();
  expect(state.proposals).toHaveLength(2);
  await page
    .getByRole("button", { name: "確認して教材を保存する", exact: true })
    .click();
  const read = page.getByRole("button", { name: /版 1を読む/ });
  await expect(read).toBeVisible();
  await page.reload();
  await page.getByText("テーマの教材を作る", { exact: true }).click();
  await page
    .getByRole("button", { name: "保存した結果を確認", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "検証結果", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "確認して教材を保存する", exact: true })
    .click();
  await expect(page.getByRole("button", { name: /版 1を読む/ })).toHaveCount(1);
  expect(state.proposals).toHaveLength(2);
  expect(state.lookups).toBe(2);
  await read.click();
  await expect(
    page.getByRole("main", { name: "共有教材の読書" }),
  ).toBeVisible();
});
test("否定された検証は保存できず、再読み込み後も自動で再検証しない", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.negative = true;
  await open(page);
  await generate(page);
  await page.getByRole("checkbox", { name: /上限内で検証/ }).check();
  await page
    .getByRole("button", { name: "確認した費用で検証する", exact: true })
    .click();
  await expect(page.getByText(/検証で修正が必要になりました/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "確認して教材を保存する", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await page.getByText("テーマの教材を作る", { exact: true }).click();
  await page
    .getByRole("button", { name: "保存した結果を確認", exact: true })
    .click();
  await expect(page.getByText(/検証で修正が必要になりました/)).toBeVisible();
  expect(state.proposals).toHaveLength(2);
});
test("控えが保存できなければ有料処理を送らず、再試行できる", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await open(page);
  await preview(page);
  await page.evaluate(() => {
    const native = IDBDatabase.prototype.transaction;
    let failOnce = true;
    IDBDatabase.prototype.transaction = function (
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      const tx = native.apply(this, args);
      if (
        failOnce &&
        this.name.includes("topic-generation") &&
        args[1] === "readwrite"
      ) {
        failOnce = false;
        tx.abort();
      }
      return tx;
    };
  });
  await page.getByRole("checkbox", { name: /この上限内で生成/ }).check();
  await page
    .getByRole("button", { name: "確認した費用で生成する", exact: true })
    .click();
  await expect(page.getByText(/作成の控えを読み書きできません/)).toBeVisible();
  expect(state.proposals).toHaveLength(0);
  await page
    .getByRole("button", { name: "確認した費用で生成する", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "生成した候補", exact: true }),
  ).toBeVisible();
  expect(state.proposals).toHaveLength(1);
});
test("処理中の控えを再読み込みで回収し、未接続でも照会できる", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.held = true;
  await open(page);
  await generate(page);
  await expect(page.getByText(/処理中です。控えから/)).toBeVisible();
  state.connected = false;
  await page.reload();
  await page.getByText("テーマの教材を作る", { exact: true }).click();
  await expect(page.getByText(/教材生成は未接続です/)).toBeVisible();
  await page
    .getByRole("button", { name: "保存した結果を確認", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "生成した候補", exact: true }),
  ).toBeVisible();
  expect(state.proposals).toHaveLength(1);
  expect(state.lookups).toBe(1);
});
test("閉じた控えDBを再取得し、二つ目の検証の控えを保存しない", async ({
  page,
  context,
}) => {
  await fixture(context);
  await open(page);
  await generate(page);
  await page.getByRole("checkbox", { name: /上限内で検証/ }).check();
  await page
    .getByRole("button", { name: "確認した費用で検証する", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "検証結果", exact: true }),
  ).toBeVisible();
  const result = await page.evaluate(async () => {
    const path = "/src/topic-generation-store.ts",
      store = await import(/* @vite-ignore */ path);
    (await store.openTopicOperations()).close();
    const before = await store.listTopicOperations();
    const review = before.find(
      (op: { input: { purpose: string } }) =>
        op.input.purpose === "evidence-check",
    );
    const id = crypto.randomUUID(),
      duplicate = { ...review, id, input: { ...review.input, requestId: id } };
    let refused = false;
    try {
      await store.retainTopicOperation(duplicate);
    } catch {
      refused = true;
    }
    return {
      refused,
      before: before.length,
      after: (await store.listTopicOperations()).length,
    };
  });
  expect(result).toEqual({ refused: true, before: 2, after: 2 });
});

test("予約前に拒否された検証は同じ控えのIDで明示的に再確認する", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.rejectReview = true;
  await open(page);
  await generate(page);
  await page.getByRole("checkbox", { name: /上限内で検証/ }).check();
  await page
    .getByRole("button", { name: "確認した費用で検証する", exact: true })
    .click();
  await expect(page.getByText(/別の処理が進行中か結果不明です/)).toBeVisible();
  const failed = state.proposals[1];
  state.rejectReview = false;
  state.reviewQuoteDigest = "3".repeat(64);
  await page
    .getByRole("button", { name: "保存した結果を確認", exact: true })
    .click();
  await expect(page.getByText(/同じ操作IDのまま費用を再確認/)).toBeVisible();
  expect(state.proposals).toHaveLength(2);
  await expect(
    page.getByRole("checkbox", { name: /上限内で検証/ }),
  ).not.toBeChecked();
  await page
    .getByRole("button", { name: "確認した費用で検証する", exact: true })
    .click();
  expect(state.proposals).toHaveLength(2);
  await page.getByRole("checkbox", { name: /上限内で検証/ }).check();
  await page
    .getByRole("button", { name: "確認した費用で検証する", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "検証結果", exact: true }),
  ).toBeVisible();
  expect(state.proposals).toHaveLength(3);
  expect(state.proposals[2].requestId).toBe(failed.requestId);
  expect(state.proposals[2].approvedQuoteDigest).toBe("3".repeat(64));
  expect(state.proposals[2].draftRaw).toBe(failed.draftRaw);
});

test("別タブで古い候補を開いていても二重の検証を送らない", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await open(page);
  await generate(page);
  const second = await context.newPage();
  await open(second);
  await second
    .getByRole("button", { name: "保存した結果を確認", exact: true })
    .click();
  await expect(
    second.getByRole("button", { name: "確認した費用で検証する", exact: true }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: /上限内で検証/ }).check();
  await page
    .getByRole("button", { name: "確認した費用で検証する", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "検証結果", exact: true }),
  ).toBeVisible();
  await second.getByRole("checkbox", { name: /上限内で検証/ }).check();
  await second
    .getByRole("button", { name: "確認した費用で検証する", exact: true })
    .click();
  await expect(
    second.getByText(/この候補には検証の控えがあります/),
  ).toBeVisible();
  expect(state.proposals).toHaveLength(2);
  await second.close();
});

test("未送信と確認した検証の失敗は同じIDで明示的にやり直す", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.unsentReview = true;
  await open(page);
  await generate(page);
  await page.getByRole("checkbox", { name: /上限内で検証/ }).check();
  await page
    .getByRole("button", { name: "確認した費用で検証する", exact: true })
    .click();
  await expect(
    page.getByText(/教材として採用できる結果がありません/),
  ).toBeVisible();
  state.unsentReview = false;
  const failed = state.proposals[1];
  await page
    .getByRole("button", { name: "保存した結果を確認", exact: true })
    .click();
  await page.getByRole("checkbox", { name: /上限内で検証/ }).check();
  await page
    .getByRole("button", { name: "確認した費用で検証する", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "検証結果", exact: true }),
  ).toBeVisible();
  expect(state.proposals[2].requestId).toBe(failed.requestId);
  expect(state.proposals[2].retryUnsent).toBe(true);
});
test("予約前に拒否された生成も新しい控えを増やさず再確認できる", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.rejectGenerate = true;
  await open(page);
  await generate(page);
  await expect(page.getByText(/別の処理が進行中か結果不明です/)).toBeVisible();
  state.rejectGenerate = false;
  state.generationQuoteDigest = "4".repeat(64);
  const first = state.proposals[0];
  await page
    .getByRole("button", { name: "保存した結果を確認", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "保存した生成依頼を再確認",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: /同じIDのままOpenAIへ/ }),
  ).not.toBeChecked();
  await page
    .getByRole("button", { name: "同じ依頼で生成を確認する", exact: true })
    .click();
  expect(state.proposals).toHaveLength(1);
  await page.getByRole("checkbox", { name: /同じIDのままOpenAIへ/ }).check();
  await page
    .getByRole("button", { name: "同じ依頼で生成を確認する", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "生成した候補", exact: true }),
  ).toBeVisible();
  expect(state.proposals[1].requestId).toBe(first.requestId);
  expect(state.proposals[1].requestRaw).toBe(first.requestRaw);
  await expect(
    page.getByRole("button", { name: "保存した結果を確認", exact: true }),
  ).toHaveCount(1);
});
test("CSRFだけの拒否では画面や別タブの入力を失わず控えを確認できる", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await open(page);
  await preview(page);
  const other = await context.newPage();
  await open(other);
  await other
    .getByLabel("教材のテーマ", { exact: true })
    .fill("別タブの下書き");
  state.csrfReject = true;
  await page.getByRole("checkbox", { name: /この上限内で生成/ }).check();
  await page
    .getByRole("button", { name: "確認した費用で生成する", exact: true })
    .click();
  await expect(page.getByText(/確認の有効期限が切れました/)).toBeVisible();
  await expect(other.getByLabel("教材のテーマ", { exact: true })).toHaveValue(
    "別タブの下書き",
  );
  await page
    .getByRole("button", { name: "保存した結果を確認", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "保存した生成依頼を再確認",
      exact: true,
    }),
  ).toBeVisible();
  expect(state.proposals).toHaveLength(1);
  await other.close();
});
test("追加した出典欄を外せて再び入力できる", async ({ page, context }) => {
  const state = await fixture(context);
  await open(page);
  await page.getByRole("button", { name: "出典を追加", exact: true }).click();
  await page.getByRole("button", { name: "出典を追加", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "出典を追加", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "この出典を外す", exact: true })
    .nth(2)
    .click();
  await page
    .getByRole("button", { name: "この出典を外す", exact: true })
    .nth(1)
    .click();
  await expect(
    page.getByRole("button", { name: "出典を追加", exact: true }),
  ).toBeEnabled();
  await preview(page);
  expect(state.proposals).toHaveLength(0);
});
test("見積り変更の上限では日本語の案内を出して控えを保持する", async ({
  page,
  context,
}) => {
  await fixture(context);
  await open(page);
  await generate(page);
  const result = await page.evaluate(async () => {
    const path = "/src/topic-generation-store.ts",
      store = await import(/* @vite-ignore */ path);
    const op = (await store.listTopicOperations())[0];
    const full = {
      ...op,
      previousQuotes: Array.from({ length: 20 }, () => op.quote),
    };
    const db = await store.openTopicOperations();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("operations", "readwrite");
      tx.objectStore("operations").put(full);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject();
    });
    let message = "";
    try {
      await store.renewTopicApproval(full, {
        ...op.quote,
        quoteDigest: "4".repeat(64),
      });
    } catch (e) {
      message = (e as Error).message;
    }
    const before = await store.listTopicOperations();
    await store.renewTopicApproval(full, op.quote);
    return {
      message,
      before: before[0].previousQuotes.length,
      after: (await store.listTopicOperations())[0].previousQuotes.length,
    };
  });
  expect(result).toEqual({
    message:
      "費用の再確認の上限20回に達しました。控えは保持しています。接続と設定を確認してください。",
    before: 20,
    after: 20,
  });
});
