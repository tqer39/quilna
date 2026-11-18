import { test, expect, type BrowserContext } from "@playwright/test";
const account = "a".repeat(64);
const id = (n: number) =>
  `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
const hash = async (s: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
async function fixture(context: BrowserContext) {
  const excerpt =
    'RSSは更新を配信します。<img src="https://private.example.org/probe"> 原文の確認用です。';
  const source = {
    id: id(1),
    title: "RSSの公開資料",
    url: "https://publisher.example.org/rss",
    excerpt,
    capturedAt: 816000000,
    publishedAt: null,
    updatedAt: null,
    sourceFingerprint: await hash(excerpt),
  };
  const candidate = {
    source,
    documentId: id(2),
    versionId: id(1),
    score: 10,
    matchedTerms: ["rss"],
  };
  const state = {
    calls: [] as { topic: string; after?: string }[],
    fail: false,
    error: null as string | null,
    pages: 1,
    empty: false,
    delay: null as Promise<void> | null,
  };
  await context.route("**/api/**", (route) =>
    route.fulfill({ status: 404, json: {} }),
  );
  await context.route("**/api/library/status", (route) =>
    route.fulfill({ json: { schema: 1, account, legacy: false } }),
  );
  await context.route(
    (u) => u.pathname === "/",
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: (await response.text()).replace(
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
        mode: "unconnected",
        csrfToken: "synthetic-csrf-token-for-tests",
        quotes: [],
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
  await context.route("**/api/topic-textbooks/preparations", async (route) => {
    const input = route.request().postDataJSON();
    state.calls.push(input);
    expect(route.request().headers()["x-library-account"]).toBe(account);
    expect(route.request().headers()["x-csrf-token"]).toBe(
      "synthetic-csrf-token-for-tests",
    );
    if (state.delay) await state.delay;
    if (state.error)
      return route.fulfill({
        status: state.error === "rate-limit" ? 429 : 503,
        json: { status: state.error },
      });
    if (state.fail)
      return route.fulfill({
        status: 503,
        json: { status: "topic-preparation-unavailable" },
      });
    const page = input.after
      ? Number.parseInt(input.after.slice(0, 8), 16) - 100
      : 0;
    await route
      .fulfill({
        json: {
          account,
          topic: input.topic,
          after: page + 1 < state.pages ? id(101 + page) : null,
          inspected: 5,
          unavailable: 0,
          sources: state.empty ? [] : [candidate],
        },
      })
      .catch(() => {});
  });
  return { state, candidate };
}
test("テーマだけで資料を準備し、引用入力・生成送信なしで原文を安全に確認する", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-preparation");
  await panel.locator("summary").first().click();
  expect(f.state.calls).toHaveLength(0);
  await panel.getByLabel("学びたいテーマ").fill("RSSの仕組み");
  await panel.getByRole("button", { name: "資料を探す", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText(
    "資料候補を1件用意しました",
  );
  await expect(panel.locator("textarea")).toHaveCount(0);
  await panel.getByText("選ばれた原文を確認", { exact: true }).click();
  await expect(panel.locator("blockquote")).toHaveText(
    f.candidate.source.excerpt,
  );
  await expect(panel.locator("img")).toHaveCount(0);
  expect(f.state.calls).toEqual([{ topic: "RSSの仕組み" }]);
  await expect(
    panel.getByRole("link", { name: "RSSの公開資料" }),
  ).toHaveAttribute("referrerpolicy", "no-referrer");
  await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `.local-state/experience-review/topic-preparation-${test.info().project.name}.png`,
    fullPage: true,
  });
});
test("続きの資料を自動で探索し、同じ文書を重複採用しない", async ({
  page,
  context,
}) => {
  const { state } = await fixture(context);
  state.pages = 3;
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-preparation");
  await panel.locator("summary").first().click();
  await panel.getByLabel("学びたいテーマ").fill("RSS");
  await panel.getByRole("button", { name: "資料を探す", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText(
    "15件を確認し、資料候補を1件",
  );
  await expect(panel.getByRole("link", { name: "RSSの公開資料" })).toHaveCount(
    1,
  );
  expect(state.calls).toEqual([
    { topic: "RSS" },
    { topic: "RSS", after: id(101) },
    { topic: "RSS", after: id(102) },
  ]);
});
test("探索の上限で残りを明示し、続きは明示操作で探索する", async ({
  page,
  context,
}) => {
  const { state } = await fixture(context);
  state.pages = 11;
  state.empty = true;
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-preparation");
  await panel.locator("summary").first().click();
  await panel.getByLabel("学びたいテーマ").fill("DNS");
  await panel.getByRole("button", { name: "資料を探す", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText(
    "50件を確認し、資料候補を0件",
  );
  await expect(panel.getByRole("status")).toContainText("残りの資料があります");
  expect(state.calls).toHaveLength(10);
  await panel.getByRole("button", { name: /続きの資料を探す/ }).click();
  await expect(panel.getByRole("status")).toContainText("55件を確認");
  await expect(panel.getByLabel("学びたいテーマ")).toBeFocused();
  expect(state.calls).toHaveLength(11);
});
test("新しい探索が失敗しても前のテーマの候補と入力を保持する", async ({
  page,
  context,
}) => {
  const { state } = await fixture(context);
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-preparation");
  await panel.locator("summary").first().click();
  const input = panel.getByLabel("学びたいテーマ");
  await input.fill("RSS");
  await panel.getByRole("button", { name: "資料を探す", exact: true }).click();
  await expect(
    panel.getByRole("heading", { name: "準備したテーマ：RSS" }),
  ).toBeVisible();
  state.fail = true;
  await input.fill("DNS");
  await panel.getByRole("button", { name: "資料を探す", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText(
    "受け取った候補は残しています",
  );
  await expect(
    panel.getByRole("heading", { name: "準備したテーマ：RSS" }),
  ).toBeVisible();
  await expect(input).toHaveValue("DNS");
  expect(state.calls).toHaveLength(2);
});
test("探索の待機を止めたら入力に戻り、自動でやり直さない", async ({
  page,
  context,
}) => {
  const { state } = await fixture(context);
  let release!: () => void;
  state.delay = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-preparation");
  await panel.locator("summary").first().click();
  await panel.getByLabel("学びたいテーマ").fill("RSS");
  await panel.getByRole("button", { name: "資料を探す", exact: true }).click();
  await expect.poll(() => state.calls.length).toBe(1);
  await panel.getByRole("button", { name: "探索の待機を止める" }).click();
  await expect(panel.getByRole("status")).toContainText(
    "探索の待機を止めました",
  );
  await expect(panel.getByLabel("学びたいテーマ")).toBeFocused();
  release();
  expect(state.calls).toHaveLength(1);
});
for (const [code, message] of [
  ["rate-limit", "1分ほど時間を置いて"],
  ["topic-preparation-unconfigured", "公開資料がまだ利用できません"],
  ["topic-preparation-topic", "学びたい内容を表す語句"],
])
  test(`${code}では原因に合う案内を出し、探索を繰り返さない`, async ({
    page,
    context,
  }) => {
    const { state } = await fixture(context);
    state.error = code;
    await page.goto("/?view=textbooks");
    const panel = page.locator(".topic-preparation");
    await panel.locator("summary").first().click();
    await panel.getByLabel("学びたいテーマ").fill("RSS");
    await panel
      .getByRole("button", { name: "資料を探す", exact: true })
      .click();
    await expect(panel.getByRole("status")).toContainText(message);
    expect(state.calls).toHaveLength(1);
  });
test("日本語のテーマが長すぎる時は送信前に知らせ、上限内の入力を変更せず送る", async ({
  page,
  context,
}) => {
  const { state } = await fixture(context);
  state.empty = true;
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-preparation");
  await panel.locator("summary").first().click();
  const input = panel.getByLabel("学びたいテーマ");
  await input.fill("あ".repeat(167));
  await panel.getByRole("button", { name: "資料を探す", exact: true }).click();
  expect(
    await input.evaluate((el) => (el as HTMLInputElement).validity.customError),
  ).toBe(true);
  expect(state.calls).toHaveLength(0);
  await input.fill("あ".repeat(166));
  await panel.getByRole("button", { name: "資料を探す", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("5件を確認");
  expect(state.calls[0].topic).toBe("あ".repeat(166));
});
test("新しいテーマの探索に失敗しても、続きボタンが以前のテーマを明示する", async ({
  page,
  context,
}) => {
  const { state } = await fixture(context);
  state.pages = 11;
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-preparation");
  await panel.locator("summary").first().click();
  const input = panel.getByLabel("学びたいテーマ");
  await input.fill("RSS");
  await panel.getByRole("button", { name: "資料を探す", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("50件を確認");
  state.fail = true;
  await input.fill("DNS");
  await panel.getByRole("button", { name: "資料を探す", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("確認できませんでした");
  const more = panel.getByRole("button", {
    name: "「RSS」の続きの資料を探す",
    exact: true,
  });
  await expect(more).toBeVisible();
  state.fail = false;
  await more.click();
  await expect(panel.getByRole("status")).toContainText("55件を確認");
  expect(state.calls.at(-1)?.topic).toBe("RSS");
  await expect(input).toHaveValue("DNS");
});
test("公開目録が空なら語句の変更を促さず、資料がまだないことを示す", async ({
  page,
  context,
}) => {
  await fixture(context);
  await context.route("**/api/topic-textbooks/preparations", (route) =>
    route.fulfill({
      json: {
        account,
        topic: "RSS",
        inspected: 0,
        unavailable: 0,
        sources: [],
        after: null,
      },
    }),
  );
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-preparation");
  await panel.locator("summary").first().click();
  await panel.getByLabel("学びたいテーマ").fill("RSS");
  await panel.getByRole("button", { name: "資料を探す", exact: true }).click();
  await expect(
    panel.getByText(/現在、探索できる公開資料がありません/),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /続きの資料を探す/ }),
  ).toBeHidden();
});
test("調べた原文がすべて読めなかった時は語句不一致と表示しない", async ({
  page,
  context,
}) => {
  await fixture(context);
  await context.route("**/api/topic-textbooks/preparations", (route) =>
    route.fulfill({
      json: {
        account,
        topic: "RSS",
        inspected: 5,
        unavailable: 5,
        sources: [],
        after: null,
      },
    }),
  );
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-preparation");
  await panel.locator("summary").first().click();
  await panel.getByLabel("学びたいテーマ").fill("RSS");
  await panel.getByRole("button", { name: "資料を探す", exact: true }).click();
  await expect(
    panel.getByText(/調べた資料の原文を確認できませんでした/),
  ).toBeVisible();
  await expect(
    panel.getByText(/この範囲には、テーマの語句を含む資料がありません/),
  ).toHaveCount(0);
});
test("長い題名・語句・原文でも320pxで横にはみ出さない", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  f.candidate.source.title = "資料" + "x".repeat(1994);
  f.candidate.source.excerpt = "RSS " + "x".repeat(5996);
  f.candidate.source.sourceFingerprint = await hash(f.candidate.source.excerpt);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-preparation");
  await panel.locator("summary").first().click();
  await panel.getByLabel("学びたいテーマ").fill("RSS");
  await panel.getByRole("button", { name: "資料を探す", exact: true }).click();
  await panel.getByText("選ばれた原文を確認", { exact: true }).click();
  await expect(panel.locator("blockquote")).toHaveText(
    f.candidate.source.excerpt,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
