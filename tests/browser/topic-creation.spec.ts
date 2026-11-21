import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import fixtureBook from "../fixtures/shared-textbook-v2.json" with { type: "json" };
import {
  parseSharedTextbook,
  sharedTextbookDigest,
} from "../../src/shared-textbook-format";
import type { TopicCreation } from "../../src/topic-creation-protocol";
const decode = (s: string) =>
    new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))),
  encode = (s: string) =>
    btoa(
      Array.from(new TextEncoder().encode(s), (c) =>
        String.fromCharCode(c),
      ).join(""),
    );
const original = JSON.parse(decode(fixtureBook.record)),
  originalRequest = JSON.parse(decode(original.request));
const account = "a".repeat(64),
  hash = (s: string) => sharedTextbookDigest(new TextEncoder().encode(s));
const generation = {
  provider: "openai" as const,
  modelId: "fixture",
  model: "fixture",
  purpose: "book-addition" as const,
  maxMilliYen: 1000,
  quoteDigest: "c".repeat(64),
  inputTokens: 8000,
  outputTokens: 2000,
  dataConditions: "合成応答のみ。外部送信なし。",
  priceCheckedAt: "2026-11-18T00:00:00Z",
  costCheckedAt: "2026-11-18T00:00:00Z",
};
const review = {
  ...generation,
  purpose: "evidence-check" as const,
  quoteDigest: "d".repeat(64),
  maxMilliYen: 2000,
};
async function fixture(context: BrowserContext) {
  const state = {
    creation: null as TopicCreation | null,
    calls: [] as { action: string; input: Record<string, unknown> }[],
    enabled: true,
    mode: "test-only",
    budget: {
      limitMilliYen: 500000,
      spentMilliYen: 0,
      heldMilliYen: 0,
      fixedMilliYen: null as number | null,
      safetyMilliYen: null as number | null,
    },
    dropSave: false,
    dropApprove: false,
    deferApprove: false,
    reviewQuote: { ...review },
    finishApproval: null as (() => void) | null,
    dropReview: false,
    saveError: null as string | null,
  };
  await context.route("**/api/**", (r) => r.fulfill({ status: 404, json: {} }));
  await context.route("**/api/library/status", (r) =>
    r.fulfill({ json: { schema: 1, account, legacy: false } }),
  );
  await context.route(
    (u) => u.pathname === "/",
    async (r) => {
      const response = await r.fetch();
      await r.fulfill({
        response,
        body: (await response.text()).replace(
          "</head>",
          '<meta name="account-libraries" content="required"></head>',
        ),
      });
    },
  );
  await context.route("**/api/topic-textbooks/status", (r) =>
    r.fulfill({
      json: {
        account,
        mode: state.mode,
        csrfToken: "synthetic-csrf-token-for-tests",
        quotes: [generation, state.reviewQuote],
        creations: { available: true, enabled: state.enabled, canAuthor: true },
        budget: state.budget,
      },
    }),
  );
  await context.route("**/api/topic-textbooks/preparations", (r) =>
    r.fulfill({
      json: {
        account,
        topic: r.request().postDataJSON().topic,
        after: null,
        inspected: originalRequest.sources.length,
        unavailable: 0,
        sources: originalRequest.sources.map((source: object, i: number) => ({
          source,
          documentId: `0000000${i + 1}-1111-4111-8111-111111111111`,
          versionId: (source as { id: string }).id,
          score: 10,
          matchedTerms: ["モデル"],
        })),
      },
    }),
  );
  await context.route("**/api/topic-textbooks/creations/*", async (r) => {
    const action = new URL(r.request().url()).pathname.split("/").at(-1)!,
      input = r.request().postDataJSON();
    state.calls.push({ action, input });
    expect(r.request().headers()["x-library-account"]).toBe(account);
    expect(r.request().headers()["x-csrf-token"]).toBe(
      "synthetic-csrf-token-for-tests",
    );
    if (action === "save") {
      if (state.saveError)
        return r.fulfill({
          status: 409,
          json: { account, status: state.saveError },
        });
      const request = JSON.parse(input.requestRaw);
      state.creation = {
        id: request.id,
        bookID: crypto.randomUUID(),
        reviewRequestId: crypto.randomUUID(),
        revision: await hash(JSON.stringify(input.requestRaw)),
        state: "draft",
        stage: "generation",
        title: request.topic.name,
        learningGoal: request.learningGoal,
        requestRaw: input.requestRaw,
        createdAt: 1800000000000,
        updatedAt: 1800000000000,
        quotes: null,
        reason: "",
        operation: null,
        book: null,
      };
      if (state.dropSave) {
        state.dropSave = false;
        return r.abort("failed");
      }
    } else if (action === "list") {
      const c = state.creation;
      return r.fulfill({
        json: {
          account,
          next: null,
          creations: c
            ? [
                {
                  id: c.id,
                  title: c.title,
                  state: c.state,
                  stage: c.stage,
                  createdAt: c.createdAt,
                  updatedAt: c.updatedAt,
                  reason: c.reason,
                },
              ]
            : [],
        },
      });
    } else if (action === "approve" && state.creation) {
      if (state.deferApprove) {
        const target = state.creation;
        state.finishApproval = () => {
          target.state = "generation";
          target.quotes = {
            generation: input.generation,
            review: input.review,
          };
        };
        return r.abort("failed");
      }
      state.creation.state = "generation";
      state.creation.quotes = {
        generation: input.generation,
        review: input.review,
      };
      if (state.dropApprove) {
        state.dropApprove = false;
        return r.abort("failed");
      }
    } else if (action === "remove") {
      state.creation = null;
      return r.fulfill({ json: { account, removed: true } });
    } else if (action === "retry" && state.creation) {
      state.creation.state = state.creation.stage;
      state.creation.reason = "";
    } else if (action === "review-again" && state.creation) {
      state.creation.state = "review";
      state.creation.reviewRequestId = input.reviewRequestId;
      state.creation.operation = null;
      state.creation.reason = "";
      state.creation.quotes!.review = input.quote;
      if (state.dropReview) {
        state.dropReview = false;
        return r.abort("failed");
      }
    }
    return r.fulfill({ json: { account, creation: state.creation } });
  });
  async function ready() {
    const c = state.creation!,
      record = {
        ...original,
        version: 1,
        bookID: c.bookID,
        request: encode(c.requestRaw),
        generator: { ...original.generator, provider: "openai" },
        reviewer: { ...original.reviewer, provider: "openai" },
      };
    const reviewed = JSON.parse(decode(original.review));
    reviewed.requestDigest = await hash(c.requestRaw);
    reviewed.draftDigest = await hash(decode(record.draft));
    record.review = encode(JSON.stringify(reviewed));
    const book = JSON.stringify({
      ...fixtureBook,
      record: encode(JSON.stringify(record)),
    });
    await parseSharedTextbook(book);
    c.book = book;
    c.state = "ready";
    c.stage = "review";
  }
  return { state, ready };
}
async function prepare(page: Page) {
  await page.goto("/?view=textbooks");
  const root = page.locator(".topic-creation"),
    prep = root.locator(".topic-preparation");
  await prep.locator("summary").first().click();
  await prep.getByLabel("学びたいテーマ").fill("モデルと実行の役割分担");
  await prep.getByRole("button", { name: "資料を探す", exact: true }).click();
  await expect(
    prep.getByRole("button", { name: "この資料で教科書を準備する" }),
  ).toBeVisible();
  await expect(prep).not.toHaveAttribute("aria-busy", "true");
  await prep
    .getByRole("button", { name: "この資料で教科書を準備する" })
    .click();
  await root
    .getByLabel("学習目的", { exact: true })
    .fill("モデルの出力と保存処理を区別する");
  return root;
}
async function save(page: Page) {
  const root = await prepare(page);
  await root.getByRole("button", { name: "依頼を保存して費用を確認" }).click();
  return root;
}
async function approve(root: ReturnType<Page["locator"]>) {
  await root
    .getByRole("button", { name: "モデルと費用を確認", exact: true })
    .click();
  await expect(root.getByText(/今回の上限 合計3円/)).toBeVisible();
  await expect(root.getByText(/表示額はテスト用の見積り/)).toBeVisible();
  await expect(root.getByRole("checkbox")).toHaveAccessibleName(/模擬処理/);
  await root.getByRole("checkbox").check();
  await root
    .getByRole("button", { name: "この費用上限で作成を始める" })
    .click();
}
test("テーマ準備から両段階の費用承認と完成版の取り込み・再読み込みまで進める", async ({
  page,
  context,
}) => {
  const f = await fixture(context),
    root = await save(page);
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "まだ生成していません",
  );
  expect(f.state.calls.map((c) => c.action)).toEqual(["save"]);
  await expect(root.getByLabel("学習目的", { exact: true })).toHaveCount(0);
  await approve(root);
  await expect(root.getByText("教科書を生成中", { exact: true })).toBeVisible();
  expect(f.state.calls.map((c) => c.action)).toEqual(["save", "approve"]);
  expect(f.state.calls[1].input).toMatchObject({
    id: f.state.creation!.id,
    expectedRevision: f.state.creation!.revision,
    approvedPublicText: true,
    confirm: true,
    generation,
    review,
  });
  await f.ready();
  await root.getByRole("button", { name: "最新の状態を確認" }).click();
  await root
    .getByRole("button", { name: "完成版をこのブラウザに取り込む" })
    .click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "取り込みました",
  );
  const books = page.getByRole("region", { name: "保存した教材" });
  await expect(
    books.getByRole("button", { name: /テーマ別の合成教材：モデルと実行/ }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole("region", { name: "保存した教材" })
      .getByRole("button", { name: /テーマ別の合成教材：モデルと実行/ }),
  ).toBeVisible();
  expect(f.state.calls.filter((c) => c.action === "approve")).toHaveLength(1);
});
test("保存応答の喪失後は同じ受付IDを復元し、再読み込みで作成を始めない", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  f.state.dropSave = true;
  const root = await save(page);
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "自動では送信し直しません",
  );
  const id = f.state.creation!.id;
  await page.reload();
  expect(f.state.calls.map((c) => c.action)).toEqual(["save"]);
  await page.getByRole("button", { name: "未確認の受付を確認" }).click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "現在の状態",
  );
  expect(f.state.calls.at(-1)).toEqual({ action: "read", input: { id } });
  expect(f.state.calls.filter((c) => c.action === "save")).toHaveLength(1);
  await expect(
    root.getByRole("button", { name: "モデルと費用を確認", exact: true }),
  ).toBeVisible();
});
test("承認応答が不明なら再送を止め、同じ依頼の結果を確認する", async ({
  page,
  context,
}) => {
  const f = await fixture(context),
    root = await save(page);
  f.state.dropApprove = true;
  await approve(root);
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "自動では送信し直しません",
  );
  await root
    .getByRole("button", { name: "この費用上限で作成を始める" })
    .click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "前の操作が未確認",
  );
  expect(f.state.calls.filter((c) => c.action === "approve")).toHaveLength(1);
  await root.getByRole("button", { name: "未確認の受付を確認" }).click();
  await expect(root.getByText("教科書を生成中", { exact: true })).toBeVisible();
});
test("固定費・安全枠・保留額を引いた残額で生成と検証の不足を区別する", async ({
  page,
  context,
}) => {
  const f = await fixture(context),
    root = await save(page);
  const quote = root.getByRole("button", {
    name: "モデルと費用を確認",
    exact: true,
  });
  const submit = root.getByRole("button", {
    name: "この費用上限で作成を始める",
  });
  Object.assign(f.state.budget, {
    spentMilliYen: 485000,
    heldMilliYen: 2000,
    fixedMilliYen: 9000,
    safetyMilliYen: 3500,
  });
  await quote.click();
  await expect(root.getByText(/月の残り目安 0.5円/)).toBeVisible();
  await expect(submit).toBeDisabled();
  f.state.budget.spentMilliYen -= 500;
  await quote.click();
  await expect(
    root.getByText(/月の残り目安 1円.*検証の予算が不足/),
  ).toBeVisible();
  await expect(submit).toBeEnabled();
  f.state.budget.spentMilliYen -= 2000;
  await quote.click();
  await expect(root.getByText(/月の残り目安 3円/)).toBeVisible();
  await expect(root.getByText(/検証の予算が不足/)).toHaveCount(0);
  expect(f.state.calls.filter((c) => c.action === "approve")).toHaveLength(0);
});
test("資料の拒否では入力を保ち、受付未設定や停止中は費用承認を送らない", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  f.state.saveError = "topic-materials-invalid";
  const root = await save(page);
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "資料を準備し直してください",
  );
  await expect(root.getByLabel("学習目的", { exact: true })).toHaveValue(
    "モデルの出力と保存処理を区別する",
  );
  await expect(root.getByLabel("学習目的", { exact: true })).toBeEditable();
  f.state.saveError = null;
  await root.getByRole("button", { name: "依頼を保存して費用を確認" }).click();
  await expect(
    root.getByRole("button", { name: "モデルと費用を確認", exact: true }),
  ).toBeVisible();
  f.state.enabled = false;
  await root
    .getByRole("button", { name: "モデルと費用を確認", exact: true })
    .click();
  await expect(
    root.getByText(
      "この接続先では新しい生成・検証を開始できません。保存した結果の確認はできます。",
    ),
  ).toBeVisible();
  expect(f.state.calls.filter((c) => c.action === "approve")).toHaveLength(0);
});
test("未接続では見積りが残っていても模擬生成を承認できない", async ({
  page,
  context,
}) => {
  const f = await fixture(context),
    root = await save(page);
  f.state.mode = "unconnected";
  await root
    .getByRole("button", { name: "モデルと費用を確認", exact: true })
    .click();
  await expect(
    root.getByText(/この接続先では新しい生成・検証を開始できません/),
  ).toBeVisible();
  await expect(
    root.getByRole("button", { name: "この費用上限で作成を始める" }),
  ).toHaveCount(0);
  expect(f.state.calls.filter((c) => c.action === "approve")).toHaveLength(0);
});
test("未送信保留の取り下げは未保存結果の損失を説明して確認する", async ({
  page,
  context,
}) => {
  const f = await fixture(context),
    root = await save(page);
  await approve(root);
  await expect(root.getByText("教科書を生成中", { exact: true })).toBeVisible();
  const c = f.state.creation!;
  c.state = "held";
  c.reason = "capacity";
  await root.getByRole("button", { name: "最新の状態を確認" }).click();
  await root.getByRole("button", { name: "この依頼を取り下げる" }).click();
  await expect(root.getByText(/未取り込みの教材を削除します/)).toBeVisible();
  expect(f.state.calls.filter((c) => c.action === "remove")).toHaveLength(0);
  await root.getByRole("button", { name: "確認して削除", exact: true }).click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "作成控えを削除しました",
  );
  expect(f.state.calls.find((c) => c.action === "remove")?.input).toEqual({
    id: c.id,
    confirm: true,
    discardGeneratedResult: true,
  });
});
test("完成版を未取り込みのまま控えを再表示し、320pxで確認できる", async ({
  page,
  context,
}) => {
  const f = await fixture(context),
    root = await save(page);
  await approve(root);
  await expect(root.getByText("教科書を生成中", { exact: true })).toBeVisible();
  await f.ready();
  await page.reload();
  await root.getByText("保存した作成依頼", { exact: true }).click();
  await root.getByRole("button", { name: "依頼を確認", exact: true }).click();
  await expect(
    root.getByRole("button", { name: "完成版をこのブラウザに取り込む" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `.local-state/experience-review/creation-ui-ready-${test.info().project.name}.png`,
    fullPage: true,
  });
  expect(f.state.calls.filter((c) => c.action === "approve")).toHaveLength(1);
});

test("検証不合格は完成扱いせず、追加検証だけを新しいIDと追加費用で承認する", async ({
  page,
  context,
}) => {
  const f = await fixture(context),
    root = await save(page);
  await approve(root);
  await expect(root.getByText("教科書を生成中", { exact: true })).toBeVisible();
  const c = f.state.creation!,
    oldReviewId = c.reviewRequestId,
    raw = c.requestRaw;
  c.state = "rejected";
  c.stage = "review";
  c.reason = "stage-rejected";
  c.operation = {
    id: c.reviewRequestId,
    state: "complete",
    reason: "",
    status: "complete",
    outcome: "complete",
    confirmedUnsent: false,
    reviewPassed: false,
  };
  await root.getByRole("button", { name: "最新の状態を確認" }).click();
  await expect(root.getByText(/内容の検証で不合格/)).toBeVisible();
  await expect(
    root.getByRole("button", { name: "完成版をこのブラウザに取り込む" }),
  ).toHaveCount(0);
  await root.getByRole("button", { name: "追加検証の費用を確認" }).click();
  await expect(root.getByText(/今回の上限 合計2円/)).toBeVisible();
  expect(f.state.calls.filter((c) => c.action === "review-again")).toHaveLength(
    0,
  );
  await root.getByRole("checkbox").check();
  await root
    .getByRole("button", { name: "この費用上限で追加検証する" })
    .click();
  await expect(root.getByText("内容を検証中", { exact: true })).toBeVisible();
  const again = f.state.calls.find((c) => c.action === "review-again")!;
  expect(again.input.reviewRequestId).not.toBe(oldReviewId);
  expect(again.input).toMatchObject({
    id: c.id,
    quote: review,
    confirm: true,
    approvedPublicText: true,
  });
  expect(f.state.creation!.requestRaw).toBe(raw);
  expect(f.state.calls.filter((c) => c.action === "approve")).toHaveLength(1);
});
test("結果不明は照会へ案内し、未送信の確認後だけ同じ段階を再予約する", async ({
  page,
  context,
}) => {
  const f = await fixture(context),
    root = await save(page);
  await approve(root);
  await expect(root.getByText("教科書を生成中", { exact: true })).toBeVisible();
  const c = f.state.creation!;
  c.state = "held";
  c.reason = "operation-unconfirmed";
  c.operation = {
    id: c.id,
    state: "held",
    reason: "operation-unconfirmed",
    status: "unknown",
    outcome: null,
    confirmedUnsent: false,
    reviewPassed: null,
  };
  await root.getByRole("button", { name: "最新の状態を確認" }).click();
  await expect(
    root.getByRole("button", { name: "再予約の費用を確認" }),
  ).toHaveCount(0);
  await expect(
    root.getByRole("button", { name: "この依頼を取り下げる" }),
  ).toHaveCount(0);
  await expect(
    root.getByRole("button", { name: "処理結果を照会" }),
  ).toBeVisible();
  c.operation.status = "materials-unavailable";
  c.operation.confirmedUnsent = true;
  await root.getByRole("button", { name: "処理結果を照会" }).click();
  await root.getByRole("button", { name: "再予約の費用を確認" }).click();
  await expect(root.getByText(/今回の上限 合計1円/)).toBeVisible();
  await root.getByRole("checkbox").check();
  await root
    .getByRole("button", { name: "未送信を確認して再予約する" })
    .click();
  await expect(root.getByText("教科書を生成中", { exact: true })).toBeVisible();
  expect(f.state.calls.find((c) => c.action === "retry")?.input).toMatchObject({
    id: c.id,
    quote: generation,
    expectedRevision: c.revision,
  });
});
test("停止後の続きは既に承認した費用で確認付き再開し、取消では送らない", async ({
  page,
  context,
}) => {
  const f = await fixture(context),
    root = await save(page);
  await approve(root);
  await expect(root.getByText("教科書を生成中", { exact: true })).toBeVisible();
  await root.getByRole("button", { name: "続きを再開", exact: true }).click();
  await root.getByRole("button", { name: "取り消す", exact: true }).click();
  expect(f.state.calls.filter((c) => c.action === "resume")).toHaveLength(0);
  await root.getByRole("button", { name: "続きを再開", exact: true }).click();
  await root.getByRole("button", { name: "確認して再開", exact: true }).click();
  await expect
    .poll(() => f.state.calls.filter((c) => c.action === "resume").length)
    .toBe(1);
  expect(f.state.calls.find((c) => c.action === "resume")?.input).toEqual({
    id: f.state.creation!.id,
    confirm: true,
  });
});

test("保存が届かなかった受付は、生成せず準備へ戻れる", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  let block = true;
  await context.route(
    "**/api/topic-textbooks/creations/save",
    async (route) => {
      if (block) return route.abort("failed");
      return route.fallback();
    },
  );
  const root = await save(page);
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "自動では送信し直しません",
  );
  expect(f.state.creation).toBeNull();
  await page.reload();
  await root.getByRole("button", { name: "未確認の受付を確認" }).click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "見つかりませんでした",
  );
  await root.getByRole("button", { name: "作成せず準備に戻る" }).click();
  await expect(
    root.getByRole("button", { name: "未確認の受付を確認" }),
  ).toBeHidden();
  expect(f.state.calls.filter((c) => c.action === "approve")).toHaveLength(0);
  block = false;
  const prep = root.locator(".topic-preparation");
  await prep.locator("summary").first().click();
  await prep.getByLabel("学びたいテーマ").fill("モデル");
  await prep.getByRole("button", { name: "資料を探す", exact: true }).click();
  await expect(prep).not.toHaveAttribute("aria-busy", "true");
  await prep
    .getByRole("button", { name: "この資料で教科書を準備する" })
    .click();
  await root.getByLabel("学習目的", { exact: true }).fill("役割を理解する");
  await root.getByRole("button", { name: "依頼を保存して費用を確認" }).click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "まだ生成していません",
  );
});
test("結果照会の制限では未確認の承認を忘れず、別の受付番号も消さない", async ({
  page,
  context,
}) => {
  const f = await fixture(context),
    root = await save(page);
  f.state.dropApprove = true;
  await approve(root);
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "自動では送信し直しません",
  );
  const ownId = f.state.creation!.id;
  let refuse = true;
  await context.route("**/api/topic-textbooks/creations/read", (route) =>
    refuse
      ? route.fulfill({ status: 429, json: { account, status: "rate-limit" } })
      : route.fallback(),
  );
  await root.getByRole("button", { name: "未確認の受付を確認" }).click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "操作が集中",
  );
  await expect(
    root.getByRole("button", { name: "未確認の受付を確認" }),
  ).toBeVisible();
  await root
    .getByRole("button", { name: "この費用上限で作成を始める" })
    .click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "前の操作が未確認",
  );
  expect(f.state.calls.filter((c) => c.action === "approve")).toHaveLength(1);
  const other = crypto.randomUUID(),
    prefix = `quilna.topic-creation.pending.${account}.`;
  await page.evaluate(
    ({ key }) => localStorage.setItem(key, JSON.stringify({ kind: "save" })),
    {
      key: prefix + other,
    },
  );
  refuse = false;
  await root.getByRole("button", { name: "未確認の受付を確認" }).click();
  await expect(root.getByText("教科書を生成中", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(({ key }) => localStorage.getItem(key), {
      key: prefix + ownId,
    }),
  ).toBeNull();
  expect(
    await page.evaluate(({ key }) => localStorage.getItem(key), {
      key: prefix + other,
    }),
  ).toBe(JSON.stringify({ kind: "save" }));
  await expect(
    root.getByRole("button", { name: "未確認の受付を確認" }),
  ).toBeVisible();
});
test("読めない記録を強制削除せず、保持と管理確認を案内する", async ({
  page,
  context,
}) => {
  await fixture(context);
  const id = crypto.randomUUID();
  await context.route("**/api/topic-textbooks/creations/list", (route) =>
    route.fulfill({
      json: { account, next: null, creations: [{ id, state: "unavailable" }] },
    }),
  );
  await context.route("**/api/topic-textbooks/creations/read", (route) =>
    route.fulfill({
      status: 503,
      json: { account, status: "topic-creation-invalid" },
    }),
  );
  await page.goto("/?view=textbooks");
  const root = page.locator(".topic-creation");
  await root.getByText("保存した作成依頼", { exact: true }).click();
  await root.getByRole("button", { name: "依頼を確認", exact: true }).click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "管理者による確認",
  );
  await expect(
    root.getByRole("button", { name: "この作成控えを削除" }),
  ).toHaveCount(0);
});

test("読書の表示設定を教材にも適用し、費用確認を320pxとキーボードで操作する", async ({
  page,
  context,
}) => {
  await fixture(context);
  const root = await save(page);
  await expect(page.locator("html")).toHaveAttribute(
    "data-reader-design",
    "studio",
  );
  await root
    .getByRole("button", { name: "モデルと費用を確認", exact: true })
    .click();
  await expect(root.getByLabel("生成モデル", { exact: true })).toHaveValue("0");
  await root
    .getByRole("heading", { name: "送信前の確認", exact: true })
    .evaluate((node) => node.scrollIntoView({ block: "start" }));
  await page.screenshot({
    path: `.local-state/experience-review/creation-ui-cost-overview-${test.info().project.name}.png`,
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await root.getByLabel("生成モデル", { exact: true }).focus();
  await expect(root.getByLabel("生成モデル", { exact: true })).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `.local-state/experience-review/creation-ui-cost-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.evaluate(({ key }) => localStorage.setItem(key, "focus"), {
    key: `quilna.reader.design.v1.account.${account}`,
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-reader-design",
    "focus",
  );
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).backgroundColor,
    ),
  ).toBe("rgb(17, 24, 32)");
  await root.getByText("保存した作成依頼", { exact: true }).click();
  await root.getByRole("button", { name: "依頼を確認", exact: true }).click();
  await expect(
    root.getByRole("button", { name: "モデルと費用を確認", exact: true }),
  ).toBeVisible();
});

test("承認がまだ処理中なら作成前の応答でも未確認を保ち、遅れた開始を照合する", async ({
  page,
  context,
}) => {
  const f = await fixture(context),
    root = await save(page);
  f.state.deferApprove = true;
  await approve(root);
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "自動では送信し直しません",
  );
  await root.getByRole("button", { name: "未確認の受付を確認" }).click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "遅れて処理が始まる場合",
  );
  await expect(
    root.getByRole("button", { name: "未確認の受付を確認" }),
  ).toBeVisible();
  await root
    .getByRole("button", { name: "モデルと費用を確認", exact: true })
    .click();
  await expect(
    root.getByText(/以前の費用上限で遅れて処理が始まる場合/),
  ).toBeVisible();
  f.state.finishApproval!();
  await root.getByRole("button", { name: "未確認の受付を確認" }).click();
  await expect(root.getByText("教科書を生成中", { exact: true })).toBeVisible();
  await expect(
    root.getByRole("button", { name: "未確認の受付を確認" }),
  ).toBeHidden();
  expect(f.state.calls.filter((c) => c.action === "approve")).toHaveLength(1);
});
test("追加検証の応答喪失後も同じ検証IDを照合し、新しい検証を再送しない", async ({
  page,
  context,
}) => {
  const f = await fixture(context),
    root = await save(page);
  await approve(root);
  await expect(root.getByText("教科書を生成中", { exact: true })).toBeVisible();
  const c = f.state.creation!;
  c.state = "rejected";
  c.stage = "review";
  c.reason = "stage-rejected";
  c.operation = {
    id: c.reviewRequestId,
    state: "complete",
    reason: "",
    status: "complete",
    outcome: "complete",
    confirmedUnsent: false,
    reviewPassed: false,
  };
  await root.getByRole("button", { name: "最新の状態を確認" }).click();
  await root.getByRole("button", { name: "追加検証の費用を確認" }).click();
  await root.getByRole("checkbox").check();
  f.state.dropReview = true;
  await root
    .getByRole("button", { name: "この費用上限で追加検証する" })
    .click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "自動では送信し直しません",
  );
  const id = c.reviewRequestId;
  await page.reload();
  await root.getByRole("button", { name: "未確認の受付を確認" }).click();
  await expect(root.getByText("内容を検証中", { exact: true })).toBeVisible();
  expect(f.state.calls.filter((c) => c.action === "review-again")).toHaveLength(
    1,
  );
  expect(
    f.state.calls.find((c) => c.action === "review-again")?.input
      .reviewRequestId,
  ).toBe(id);
});
test("保存した依頼の続きは明示して読み、日本語の空白や長すぎる目的は送らない", async ({
  page,
  context,
}) => {
  const f = await fixture(context),
    root = await prepare(page);
  const goal = root.getByLabel("学習目的", { exact: true });
  await goal.fill(" ");
  await root.getByRole("button", { name: "依頼を保存して費用を確認" }).click();
  expect(f.state.calls).toHaveLength(0);
  await goal.fill("あ".repeat(334));
  await root.getByRole("button", { name: "依頼を保存して費用を確認" }).click();
  expect(f.state.calls).toHaveLength(0);
  expect(
    await goal.evaluate((n: HTMLTextAreaElement) => n.validationMessage),
  ).toContain("長すぎます");
  const ids = Array.from({ length: 21 }, () => crypto.randomUUID()),
    calls: Record<string, unknown>[] = [];
  await context.route("**/api/topic-textbooks/creations/list", (route) => {
    const input = route.request().postDataJSON();
    calls.push(input);
    return route.fulfill({
      json: {
        account,
        next: input.after ? null : ids[19],
        creations: (input.after ? ids.slice(20) : ids.slice(0, 20)).map(
          (id, i) => ({
            id,
            title: `資料の仕組み${i}`,
            state: "draft",
            stage: "generation",
            reason: "",
            createdAt: 1800000000000,
            updatedAt: 1800000000000,
          }),
        ),
      },
    });
  });
  await root.getByText("保存した作成依頼", { exact: true }).click();
  await expect(
    root
      .getByRole("list", { name: "保存した教科書の作成依頼" })
      .getByRole("listitem"),
  ).toHaveCount(20);
  expect(calls).toEqual([{}]);
  await root.getByRole("button", { name: "以前の依頼を表示" }).click();
  await expect(
    root
      .getByRole("list", { name: "保存した教科書の作成依頼" })
      .getByRole("listitem"),
  ).toHaveCount(21);
  expect(calls).toEqual([{}, { after: ids[19] }]);
});

test("届かなかった承認は、同じモデルと費用で明示再送し、IDを変えない", async ({
  page,
  context,
}) => {
  const f = await fixture(context),
    root = await save(page);
  f.state.deferApprove = true;
  await approve(root);
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "自動では送信し直しません",
  );
  const input = f.state.calls.find((c) => c.action === "approve")!.input;
  await page.reload();
  await root.getByRole("button", { name: "未確認の受付を確認" }).click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "まだ未確認",
  );
  f.state.deferApprove = false;
  await root.getByRole("button", { name: "同じ受付内容の再送を確認" }).click();
  expect(f.state.calls.filter((c) => c.action === "approve")).toHaveLength(1);
  await root
    .getByRole("button", { name: "確認して同じ受付内容を再送" })
    .click();
  await expect(root.getByText("教科書を生成中", { exact: true })).toBeVisible();
  expect(
    f.state.calls.filter((c) => c.action === "approve").map((c) => c.input),
  ).toEqual([input, input]);
  await expect(
    root.getByRole("button", { name: "未確認の受付を確認" }),
  ).toBeHidden();
});
test("届かなかった追加検証も、保持した同じ検証IDのまま明示再送できる", async ({
  page,
  context,
}) => {
  const f = await fixture(context),
    root = await save(page);
  await approve(root);
  await expect(root.getByText("教科書を生成中", { exact: true })).toBeVisible();
  const c = f.state.creation!;
  c.state = "rejected";
  c.stage = "review";
  c.reason = "stage-rejected";
  c.operation = {
    id: c.reviewRequestId,
    state: "complete",
    reason: "",
    status: "complete",
    outcome: "complete",
    confirmedUnsent: false,
    reviewPassed: false,
  };
  await root.getByRole("button", { name: "最新の状態を確認" }).click();
  let block = true;
  const inputs: unknown[] = [];
  await context.route(
    "**/api/topic-textbooks/creations/review-again",
    (route) => {
      inputs.push(route.request().postDataJSON());
      return block ? route.abort("failed") : route.fallback();
    },
  );
  await root.getByRole("button", { name: "追加検証の費用を確認" }).click();
  await root.getByRole("checkbox").check();
  await root
    .getByRole("button", { name: "この費用上限で追加検証する" })
    .click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "自動では送信し直しません",
  );
  await page.reload();
  await root.getByRole("button", { name: "未確認の受付を確認" }).click();
  block = false;
  await root.getByRole("button", { name: "同じ受付内容の再送を確認" }).click();
  await root
    .getByRole("button", { name: "確認して同じ受付内容を再送" })
    .click();
  await expect(root.getByText("内容を検証中", { exact: true })).toBeVisible();
  expect(inputs).toHaveLength(2);
  expect(inputs[1]).toEqual(inputs[0]);
  expect(f.state.calls.filter((c) => c.action === "approve")).toHaveLength(1);
});
test("再開の応答が不明なら読取だけで確認済みにせず、同じ再開を明示できる", async ({
  page,
  context,
}) => {
  await fixture(context);
  const root = await save(page);
  await approve(root);
  await expect(root.getByText("教科書を生成中", { exact: true })).toBeVisible();
  let block = true;
  await context.route("**/api/topic-textbooks/creations/resume", (route) =>
    block ? route.abort("failed") : route.fallback(),
  );
  await root.getByRole("button", { name: "続きを再開", exact: true }).click();
  await root.getByRole("button", { name: "確認して再開", exact: true }).click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "自動では送信し直しません",
  );
  await root.getByRole("button", { name: "未確認の受付を確認" }).click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "まだ未確認",
  );
  await expect(
    root.getByRole("button", { name: "未確認の受付を確認" }),
  ).toBeVisible();
  block = false;
  await root.getByRole("button", { name: "同じ受付内容の再送を確認" }).click();
  await root
    .getByRole("button", { name: "確認して同じ受付内容を再送" })
    .click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "同じ受付内容を確認",
  );
});
test("古い保留結果の日時更新を再予約の証明にせず、同じ再予約を再送する", async ({
  page,
  context,
}) => {
  const f = await fixture(context),
    root = await save(page);
  await approve(root);
  await expect(root.getByText("教科書を生成中", { exact: true })).toBeVisible();
  const c = f.state.creation!;
  c.state = "held";
  c.reason = "operation-unconfirmed";
  c.operation = {
    id: c.id,
    state: "held",
    reason: "operation-unconfirmed",
    status: "materials-unavailable",
    outcome: null,
    confirmedUnsent: true,
    reviewPassed: null,
  };
  await root.getByRole("button", { name: "最新の状態を確認" }).click();
  let block = true;
  const inputs: unknown[] = [];
  await context.route("**/api/topic-textbooks/creations/retry", (route) => {
    inputs.push(route.request().postDataJSON());
    return block ? route.abort("failed") : route.fallback();
  });
  await root.getByRole("button", { name: "再予約の費用を確認" }).click();
  await root.getByRole("checkbox").check();
  await root
    .getByRole("button", { name: "未送信を確認して再予約する" })
    .click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "自動では送信し直しません",
  );
  c.updatedAt++;
  await root.getByRole("button", { name: "未確認の受付を確認" }).click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "まだ未確認",
  );
  block = false;
  await root.getByRole("button", { name: "同じ受付内容の再送を確認" }).click();
  await root
    .getByRole("button", { name: "確認して同じ受付内容を再送" })
    .click();
  await expect(root.getByText("教科書を生成中", { exact: true })).toBeVisible();
  expect(inputs).toHaveLength(2);
  expect(inputs[1]).toEqual(inputs[0]);
});

test("管理者でない読者には教科書作成と旧試作を出さず、教材の取り込みと閲覧を残す", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  await context.route("**/api/topic-textbooks/status", (route) =>
    route.fulfill({
      json: {
        account,
        mode: "unconnected",
        csrfToken: "synthetic-csrf-token-for-tests",
        quotes: [],
        creations: { available: true, enabled: false, canAuthor: false },
        budget: {
          limitMilliYen: 500000,
          spentMilliYen: 0,
          heldMilliYen: 0,
          fixedMilliYen: null,
          safetyMilliYen: null,
        },
      },
    }),
  );
  await page.goto("/?view=textbooks#author=RSS");
  await expect(
    page.getByRole("heading", { name: "保存した教材", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".topic-creation .topic-preparation")).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "教科書を作る", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("保存した作成依頼", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("以前の試作と処理記録", { exact: true }),
  ).toBeHidden();
  await expect(page.locator(".topic-creator")).toBeHidden();
  await expect(
    page.getByText("教材ファイルを取り込む", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("自分のLLMで教科書を作る", { exact: true }),
  ).toBeHidden();
  await page.goto("/?view=feeds");
  await page.getByRole("button", { name: "ことばの辞書を開く" }).click();
  const word = page.getByLabel("調べたい言葉");
  await word.fill("RSS");
  await word.press("Enter");
  await page.getByRole("button", { name: "保存した教科書を探す" }).click();
  await expect(page.getByText("この言葉に合う教科書は見つかりませんでした。")).toBeVisible();
  await expect(page.getByRole("link", { name: "この言葉で教科書を作る" })).toHaveCount(0);
  expect(f.state.calls).toHaveLength(0);
});
test("作成権限を失った後も、自分の完成版を確認して取り込める", async ({
  page,
  context,
}) => {
  const f = await fixture(context),
    root = await save(page);
  await approve(root);
  await expect(root.getByText("教科書を生成中", { exact: true })).toBeVisible();
  await f.ready();
  await context.route("**/api/topic-textbooks/status", (route) =>
    route.fulfill({
      json: {
        account,
        mode: "unconnected",
        csrfToken: "synthetic-csrf-token-for-tests",
        quotes: [],
        creations: { available: true, enabled: false, canAuthor: false },
        budget: {
          limitMilliYen: 500000,
          spentMilliYen: 0,
          heldMilliYen: 0,
          fixedMilliYen: null,
          safetyMilliYen: null,
        },
      },
    }),
  );
  await page.reload();
  await expect(root.locator(".topic-preparation")).toBeHidden();
  await root.getByText("保存した作成依頼", { exact: true }).click();
  await root.getByRole("button", { name: "依頼を確認", exact: true }).click();
  await expect(
    root.getByRole("button", { name: "モデルと費用を確認", exact: true }),
  ).toHaveCount(0);
  await root
    .getByRole("button", { name: "完成版をこのブラウザに取り込む" })
    .click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "取り込みました",
  );
  expect(f.state.calls.filter((c) => c.action === "approve")).toHaveLength(1);
});

test("追加検証の再送が見積り変更で拒否されても、同じ検証IDで費用を確認し直せる", async ({
  page,
  context,
}) => {
  const f = await fixture(context),
    root = await save(page);
  await approve(root);
  await expect(root.getByText("教科書を生成中", { exact: true })).toBeVisible();
  const c = f.state.creation!;
  c.state = "rejected";
  c.stage = "review";
  c.reason = "stage-rejected";
  c.operation = {
    id: c.reviewRequestId,
    state: "complete",
    reason: "",
    status: "complete",
    outcome: "complete",
    confirmedUnsent: false,
    reviewPassed: false,
  };
  await root.getByRole("button", { name: "最新の状態を確認" }).click();
  const inputs: { reviewRequestId: string; quote: typeof review }[] = [];
  let step = 0;
  await context.route(
    "**/api/topic-textbooks/creations/review-again",
    (route) => {
      inputs.push(route.request().postDataJSON());
      step++;
      return step === 1
        ? route.abort("failed")
        : step === 2
          ? route.fulfill({
              status: 409,
              json: { account, status: "quote-changed" },
            })
          : route.fallback();
    },
  );
  await root.getByRole("button", { name: "追加検証の費用を確認" }).click();
  await root.getByRole("checkbox").check();
  await root
    .getByRole("button", { name: "この費用上限で追加検証する" })
    .click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "自動では送信し直しません",
  );
  await root.getByRole("button", { name: "未確認の受付を確認" }).click();
  await root.getByRole("button", { name: "同じ受付内容の再送を確認" }).click();
  await root
    .getByRole("button", { name: "確認して同じ受付内容を再送" })
    .click();
  await expect(root.locator(".topic-creation-notice")).toContainText(
    "モデルや費用が変わりました",
  );
  f.state.reviewQuote = {
    ...review,
    maxMilliYen: 4000,
    quoteDigest: "e".repeat(64),
  };
  await root.getByRole("button", { name: "追加検証の費用を確認" }).click();
  await expect(root.getByText(/今回の上限 合計4円/)).toBeVisible();
  await root.getByRole("checkbox").check();
  await root
    .getByRole("button", { name: "この費用上限で追加検証する" })
    .click();
  await expect(root.getByText("内容を検証中", { exact: true })).toBeVisible();
  expect(new Set(inputs.map((i) => i.reviewRequestId)).size).toBe(1);
  expect(inputs.at(-1)!.quote.maxMilliYen).toBe(4000);
});
