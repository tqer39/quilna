import { test, expect, type BrowserContext } from "@playwright/test";
const account = "a".repeat(64);
const ids = [
  "e9cae8c8-692f-49e8-9a4f-b2a92c8061c3",
  "f9cae8c8-692f-49e8-9a4f-b2a92c8061c3",
];
const job = (i = 0, state = "queued") => ({
  id: ids[i],
  state,
  createdAt: 1800000000000 + i * 1000,
  updatedAt: 1800000001000,
  reason: "",
  result: null,
});
async function fixture(context: BrowserContext) {
  const state = {
    jobs: [job()],
    calls: [] as { action: string; data: Record<string, unknown> }[],
    fail: false,
    deny: false,
    secondPage: false,
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
  await context.route("**/api/topic-textbooks/jobs/*", async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const data = route.request().postDataJSON();
    state.calls.push({ action, data });
    expect(route.request().headers()["x-library-account"]).toBe(account);
    expect(route.request().headers()["x-csrf-token"]).toBe(
      "synthetic-csrf-token-for-tests",
    );
    if (state.deny)
      return route.fulfill({
        status: 401,
        json: { status: "unauthenticated" },
      });
    if (state.fail)
      return route.fulfill({
        status: 503,
        json: { status: "topic-job-unavailable" },
      });
    if (action === "list")
      return route.fulfill({
        json: {
          account,
          jobs: (state.secondPage && data.after ? [job(1)] : state.jobs).map(
            ({ result: ignored, ...j }) => {
              void ignored;
              return j;
            },
          ),
          after: state.secondPage && !data.after ? ids[0] : null,
        },
      });
    const found = state.jobs.find((j) => j.id === data.id);
    if (action === "cancel" && found) found.state = "cancelled";
    if (action === "remove") {
      state.jobs = state.jobs.filter((j) => j.id !== data.id);
      return route.fulfill({ json: { account, removed: true } });
    }
    return route.fulfill({ json: { account, job: found ?? null } });
  });
  return state;
}
test("開いた時だけ保存先を確認し、再読み込み・取消・削除でも生成を送らない", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/?view=textbooks");
  expect(state.calls).toHaveLength(0);
  const panel = page.locator(".topic-job-status");
  await panel.locator("summary").first().click();
  await expect(panel.getByText("順番待ち", { exact: true })).toBeVisible();
  await panel
    .getByRole("button", { name: "予約を取り消す", exact: true })
    .click();
  expect(state.calls.filter((c) => c.action === "cancel")).toHaveLength(0);
  await panel.getByRole("button", { name: "確認して予約を取り消す" }).click();
  await expect(
    panel.getByText("予約を取り消しました。", { exact: true }),
  ).toBeVisible();
  expect(state.calls.find((c) => c.action === "cancel")?.data).toEqual({
    id: ids[0],
    confirm: true,
  });
  await page.reload();
  await panel.locator("summary").first().click();
  await expect(panel.getByText("予約取消済み", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "控えを整理する" }).click();
  await panel.getByRole("button", { name: "確認して控えを削除する" }).click();
  await expect(
    panel.getByText("控えを削除しました。", { exact: true }),
  ).toBeVisible();
  expect(state.calls.map((c) => c.action)).toEqual([
    "list",
    "cancel",
    "list",
    "remove",
  ]);
  await expect(panel.locator(".topic-job-row")).toHaveCount(0);
});
test("結果不明は再照会だけにし、失敗時も一覧を保持する", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.jobs = [job(0, "held")];
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-job-status");
  await panel.locator("summary").first().click();
  await panel.getByRole("button", { name: "結果を確認" }).click();
  await expect(panel.getByText(/「結果を確認」は保存先を照会し/)).toBeVisible();
  expect(state.calls.map((c) => c.action)).toEqual(["list", "refresh"]);
  state.fail = true;
  await panel.getByRole("button", { name: "一覧を確認" }).click();
  await expect(panel.getByRole("status")).toContainText(
    "表示中の記録を残しています",
  );
  await expect(panel.locator(".topic-job-row")).toHaveCount(1);
  expect(state.calls.filter((c) => c.action === "refresh")).toHaveLength(1);
});
test("ページ送りを扱い、狭い幅でもキーボードで確認できる", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.secondPage = true;
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-job-status");
  await panel.locator("summary").first().focus();
  await page.keyboard.press("Enter");
  await panel.getByRole("button", { name: "続きを表示" }).click();
  await expect(panel.locator(".topic-job-row")).toHaveCount(2);
  await expect(panel.getByRole("button", { name: "一覧を確認" })).toBeFocused();
  expect(state.calls[1].data).toEqual({ after: ids[0] });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `.local-state/experience-review/topic-jobs-${test.info().project.name}.png`,
    fullPage: true,
  });
});
test("本人性の失効で既存ライブラリを再読み込みし、以前の一覧を残さない", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-job-status");
  await panel.locator("summary").first().click();
  await expect(panel.locator(".topic-job-row")).toHaveCount(1);
  state.deny = true;
  const reloaded = page.waitForEvent(
    "framenavigated",
    (frame) => frame === page.mainFrame(),
  );
  await panel.getByRole("button", { name: "結果を確認" }).click();
  await reloaded;
  await expect(panel.locator(".topic-job-row")).toHaveCount(0);
  await expect(panel).not.toHaveAttribute("open", "");
  expect(state.calls.filter((call) => call.action === "list")).toHaveLength(1);
});
for (const kind of ["topic-textbook-draft", "topic-textbook-review"])
  test(`${kind}の結果を教材完成と表示しない`, async ({ page, context }) => {
    await fixture(context);
    await context.route("**/api/topic-textbooks/jobs/read", (route) =>
      route.fulfill({
        json: {
          account,
          job: {
            ...job(),
            state: "complete",
            result: {
              status: "complete",
              account,
              draft: {
                kind,
                requestDigest: "d".repeat(64),
                draftDigest: "e".repeat(64),
                json: "{}",
                invocation: {
                  id: ids[1],
                  provider: "openai",
                  model: "fixture",
                },
                ...(kind === "topic-textbook-review"
                  ? { allChecksPassed: false }
                  : {}),
              },
            },
          },
        },
      }),
    );
    await page.goto("/?view=textbooks");
    const panel = page.locator(".topic-job-status");
    await panel.locator("summary").first().click();
    await panel.getByRole("button", { name: "結果を確認" }).click();
    await expect(
      panel.getByRole("region", { name: "作成結果の状態" }),
    ).toContainText(
      kind === "topic-textbook-draft"
        ? "内容の検証と教材としての保存は、まだ完了していません。"
        : "検証で修正が必要になりました。",
    );
    await expect(panel.getByRole("button", { name: /教材を保存/ })).toHaveCount(
      0,
    );
    await expect(panel.getByText("{}", { exact: true })).toHaveCount(0);
  });
test("壊れた個別記録を残し、二重クリックで照会を増やさない", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await context.route("**/api/topic-textbooks/jobs/list", async (route) => {
    state.calls.push({ action: "list", data: route.request().postDataJSON() });
    entered();
    await gate;
    await route.fulfill({
      json: {
        account,
        jobs: [{ id: ids[0], state: "unavailable" }],
        after: null,
      },
    });
  });
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-job-status");
  await panel.locator("summary").first().click();
  await waiting;
  await panel.getByRole("button", { name: "一覧を確認" }).dblclick();
  release();
  await expect(
    panel.getByText("記録を確認できません", { exact: true }),
  ).toBeVisible();
  expect(state.calls.filter((call) => call.action === "list")).toHaveLength(1);
  await expect(
    panel.getByRole("button", { name: "控えを整理する" }),
  ).toHaveCount(0);
});
test("削除したページ末尾を続きの指定に使わず、最新一覧から確認し直す", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.jobs = [job(0, "cancelled")];
  let lists = 0;
  await context.route("**/api/topic-textbooks/jobs/list", (route) => {
    const data = route.request().postDataJSON();
    state.calls.push({ action: "list", data });
    lists++;
    const { result: ignored, ...summary } = job(
      lists === 1 ? 0 : 1,
      "cancelled",
    );
    void ignored;
    return route.fulfill({
      json: { account, jobs: [summary], after: lists === 1 ? ids[0] : null },
    });
  });
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-job-status");
  await panel.locator("summary").first().click();
  await panel.getByRole("button", { name: "控えを整理する" }).click();
  await expect(panel.getByText(/この画面から復元できず/)).toBeVisible();
  await panel.getByRole("button", { name: "確認して控えを削除する" }).click();
  await expect(panel.getByRole("status")).toContainText("控えを削除しました");
  await expect(panel.getByRole("button", { name: "続きを表示" })).toBeHidden();
  await panel.getByRole("button", { name: "一覧を確認" }).click();
  await expect(panel.locator(".topic-job-row")).toHaveCount(1);
  expect(
    state.calls.filter((c) => c.action === "list").map((c) => c.data),
  ).toEqual([{}, {}]);
  await panel.locator(".topic-job-row summary").click();
  await expect(panel.getByText(ids[1], { exact: true })).toBeVisible();
});
test("再照会で行と操作を更新し、取得した結果へフォーカスを移す", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-job-status");
  await panel.locator("summary").first().click();
  await expect(panel.getByText("順番待ち", { exact: true })).toBeVisible();
  state.jobs[0].state = "running";
  await panel.getByRole("button", { name: "結果を確認" }).click();
  await expect(
    panel.getByRole("region", { name: "作成結果の状態" }),
  ).toBeFocused();
  await expect(
    panel.getByRole("button", { name: "予約を取り消す", exact: true }),
  ).toHaveCount(0);
  await panel.getByRole("button", { name: "結果を確認" }).click();
  await expect
    .poll(() => state.calls.map((c) => c.action))
    .toEqual(["list", "read", "refresh"]);
});
test("取消の応答を待つ間に閉じても、再表示で保存先を確認して操作を繰り返さない", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await context.route("**/api/topic-textbooks/jobs/cancel", async (route) => {
    state.calls.push({
      action: "cancel",
      data: route.request().postDataJSON(),
    });
    state.jobs[0].state = "cancelled";
    entered();
    await gate;
    await route
      .fulfill({ json: { account, job: state.jobs[0] } })
      .catch(() => {});
  });
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-job-status");
  await panel.locator("summary").first().click();
  await panel
    .getByRole("button", { name: "予約を取り消す", exact: true })
    .click();
  await panel.getByRole("button", { name: "確認して予約を取り消す" }).click();
  await waiting;
  await panel.locator("summary").first().click();
  await expect(panel).not.toHaveAttribute("aria-busy", "true");
  release();
  await panel.locator("summary").first().click();
  await expect(panel.getByText("予約取消済み", { exact: true })).toBeVisible();
  expect(state.calls.filter((c) => c.action === "cancel")).toHaveLength(1);
});
for (const code of ["topic-job-active", "rate-limit", "topic-job-unavailable"])
  test(`${code}で取消を繰り返さず、確認方法を表示する`, async ({
    page,
    context,
  }) => {
    const state = await fixture(context);
    await context.route("**/api/topic-textbooks/jobs/cancel", (route) => {
      state.calls.push({
        action: "cancel",
        data: route.request().postDataJSON(),
      });
      return route.fulfill({
        status: code === "rate-limit" ? 429 : 409,
        json: { status: code },
      });
    });
    await page.goto("/?view=textbooks");
    const panel = page.locator(".topic-job-status");
    await panel.locator("summary").first().click();
    await panel
      .getByRole("button", { name: "予約を取り消す", exact: true })
      .click();
    await panel.getByRole("button", { name: "確認して予約を取り消す" }).click();
    await expect(panel.getByRole("status")).toContainText(
      code === "topic-job-active"
        ? "最新の状態を確認"
        : code === "rate-limit"
          ? "少し時間を置いて"
          : "既に反映された可能性",
    );
    expect(state.calls.filter((c) => c.action === "cancel")).toHaveLength(1);
    await expect(panel.locator(".topic-job-row")).toHaveCount(1);
  });
test("確定した接続不備を結果不明と表示せず、繰り返し回復照会しない", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.jobs = [job(0, "held")];
  for (const action of ["read", "refresh"])
    await context.route(`**/api/topic-textbooks/jobs/${action}`, (route) => {
      state.calls.push({ action, data: route.request().postDataJSON() });
      return route.fulfill({
        json: {
          account,
          job: {
            ...job(0, "held"),
            reason: "operation-unconfirmed",
            result: { account, status: "unconnected" },
          },
        },
      });
    });
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-job-status");
  await panel.locator("summary").first().click();
  await panel.getByRole("button", { name: "結果を確認" }).click();
  await expect(
    panel.getByRole("region", { name: "作成結果の状態" }),
  ).toContainText("生成先に接続されていません");
  await expect(panel.getByText(/処理結果をまだ確定できません/)).toHaveCount(0);
  await panel.getByRole("button", { name: "結果を確認" }).click();
  await expect
    .poll(() => state.calls.map((c) => c.action))
    .toEqual(["list", "refresh", "read"]);
});
test("別の画面で続きの記録が削除されても一覧を再確認できる", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.secondPage = true;
  await context.route("**/api/topic-textbooks/jobs/list", (route) => {
    const data = route.request().postDataJSON();
    if (data.after)
      return route.fulfill({
        status: 400,
        json: { status: "topic-job-cursor" },
      });
    const { result: ignored, ...summary } = job();
    void ignored;
    return route.fulfill({ json: { account, jobs: [summary], after: ids[0] } });
  });
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-job-status");
  await panel.locator("summary").first().click();
  await panel.getByRole("button", { name: "続きを表示" }).click();
  await expect(panel.getByRole("status")).toContainText("一覧が変更されました");
  await expect(panel.getByRole("button", { name: "一覧を確認" })).toBeFocused();
  await expect(panel.getByRole("button", { name: "続きを表示" })).toBeHidden();
  await panel.getByRole("button", { name: "一覧を確認" }).click();
  await expect(panel.getByRole("button", { name: "続きを表示" })).toBeVisible();
});
test("閉鎖直後の再表示は中止の後処理が終わってから一覧を読み直す", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.jobs = [job(0, "held")];
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      if (String(input).endsWith("/jobs/refresh") && response.body) {
        const getReader = response.body.getReader.bind(response.body);
        response.body.getReader = (() => {
          const reader = getReader();
          const read = reader.read.bind(reader),
            cancel = reader.cancel.bind(reader);
          let reads = 0;
          reader.read = (async () => {
            if (reads++ > 0) {
              await new Promise<void>((resolve) => {
                (window as unknown as { releaseRead: () => void }).releaseRead =
                  resolve;
              });
            }
            return read();
          }) as typeof reader.read;
          reader.cancel = (async () => {
            await new Promise<void>((resolve) => {
              (
                window as unknown as { releaseCancel: () => void }
              ).releaseCancel = resolve;
            });
            await cancel();
          }) as typeof reader.cancel;
          return reader;
        }) as typeof response.body.getReader;
      }
      return response;
    };
  });
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-job-status");
  await panel.locator("summary").first().click();
  await panel.getByRole("button", { name: "結果を確認" }).click();
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { releaseRead?: () => void }).releaseRead ===
      "function",
  );
  await panel.locator("summary").first().click();
  await page.evaluate(() =>
    (window as unknown as { releaseRead: () => void }).releaseRead(),
  );
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { releaseCancel?: () => void })
        .releaseCancel === "function",
  );
  await panel.locator("summary").first().click();
  await expect(panel).toHaveAttribute("aria-busy", "true");
  await page.evaluate(() =>
    (window as unknown as { releaseCancel: () => void }).releaseCancel(),
  );
  await expect
    .poll(() => state.calls.filter((c) => c.action === "list").length)
    .toBe(2);
  await expect(panel).not.toHaveAttribute("aria-busy", "true");
});
test("続き位置以外の控えを削除しても現在のページ送りを保つ", async ({
  page,
  context,
}) => {
  const state = await fixture(context);
  state.jobs = [job(0, "cancelled"), job(1, "cancelled")];
  const third = "a9cae8c8-692f-49e8-9a4f-b2a92c8061c3";
  await context.route("**/api/topic-textbooks/jobs/list", (route) => {
    const data = route.request().postDataJSON();
    state.calls.push({ action: "list", data });
    const values = data.after
      ? [{ ...job(1, "cancelled"), id: third }]
      : state.jobs;
    return route.fulfill({
      json: {
        account,
        jobs: values.map(({ result: ignored, ...value }) => {
          void ignored;
          return value;
        }),
        after: data.after ? null : ids[1],
      },
    });
  });
  await page.goto("/?view=textbooks");
  const panel = page.locator(".topic-job-status");
  await panel.locator("summary").first().click();
  const first = panel.locator(".topic-job-row").first();
  await first.getByRole("button", { name: "控えを整理する" }).click();
  await first.getByRole("button", { name: "確認して控えを削除する" }).click();
  await expect(panel.getByRole("status")).toHaveText("控えを削除しました。");
  await panel.getByRole("button", { name: "続きを表示" }).click();
  await expect(panel.locator(".topic-job-row")).toHaveCount(2);
  expect(state.calls.filter((c) => c.action === "list").at(-1)?.data).toEqual({
    after: ids[1],
  });
});
