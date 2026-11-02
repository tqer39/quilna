import { test, expect } from "@playwright/test";
const csrf = "dummy-browser-csrf-no-live-grant";
const panel = (page: import("@playwright/test").Page) =>
  page.locator(".account-settings");
test("unconfigured real login UI stays off and reading/mock settings still work", async ({
  page,
}, info) => {
  await page.goto("/#read");
  await expect(page).toHaveTitle("CAA を読み解く | Quilna");
  await expect(page.locator("header .brand")).toHaveText("Quilna");
  await panel(page).locator("summary").click();
  await expect(
    panel(page).getByRole("button", { name: "Googleでログイン", exact: true }),
  ).toBeDisabled();
  await expect(panel(page).getByRole("status")).toContainText("未接続");
  await page
    .getByRole("button", { name: "自分のAPIキー設定", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").locator("input[type=password]"),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "教材へ戻る", exact: true }).click();
  await page.getByRole("button", { name: "次へ →", exact: true }).click();
  await expect(page.locator("main h2").first()).toBeVisible();
  await page.screenshot({
    path: info.outputPath("account-off.png"),
    fullPage: true,
  });
});
test("authenticated metadata panel keeps keys empty/disabled, clears on logout, and never saves auth to localStorage", async ({
  page,
}) => {
  let logged = true;
  const posts: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/logout") {
      posts.push(path);
      expect(route.request().headers()["x-csrf-token"]).toBe(csrf);
      logged = false;
      return route.fulfill({
        json: { status: "signed-out", realKeyInputEnabled: false },
      });
    }
    if (path === "/api/auth/status")
      return route.fulfill({
        json: {
          available: true,
          authenticated: logged,
          csrfToken: csrf,
          realKeyInputEnabled: false,
        },
      });
    if (path === "/api/session")
      return route.fulfill({
        json: {
          csrfToken: csrf,
          connection: "unconnected",
          realKeyInputEnabled: false,
        },
      });
    return route.fulfill({
      json: {
        revision: 1,
        model: "gpt-6-luna",
        state: "registered",
        checked: false,
        connection: "unconnected",
      },
    });
  });
  await page.goto("/#read");
  const before = await page.evaluate(() => JSON.stringify(localStorage));
  await panel(page).locator("summary").click();
  await expect(
    panel(page).getByRole("region", { name: "保存済みOpenAI設定" }),
  ).toContainText("保存版 #1");
  for (const input of await panel(page).locator("input[type=password]").all()) {
    await expect(input).toBeDisabled();
    await expect(input).toHaveValue("");
  }
  await panel(page)
    .getByRole("button", { name: "ログアウト", exact: true })
    .click();
  await expect(panel(page).getByRole("region")).toHaveCount(0);
  await expect(
    panel(page).getByRole("button", { name: "Googleでログイン", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).toBe(before);
  expect(posts).toEqual(["/api/auth/logout"]);
  await page.reload();
  await panel(page).locator("summary").click();
  await expect(panel(page).getByRole("region")).toHaveCount(0);
});
test("cancel during login startup rejects the late redirect and duplicate clicks do not create another request", async ({
  page,
  baseURL,
}) => {
  let release: () => void = () => {};
  const pending = new Promise<void>((r) => {
    release = r;
  });
  let starts = 0;
  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status"))
      return route.fulfill({
        json: {
          available: true,
          authenticated: false,
          csrfToken: csrf,
          realKeyInputEnabled: false,
        },
      });
    if (path.endsWith("/start")) {
      starts++;
      await pending;
      return route.fulfill({
        json: {
          authorizationUrl:
            "https://accounts.google.com/o/oauth2/v2/auth?state=dummy",
        },
      });
    }
    return route.fulfill({ json: { status: "signed-out" } });
  });
  await page.goto("/#read");
  await panel(page).locator("summary").click();
  const login = panel(page).getByRole("button", {
    name: "Googleでログイン",
    exact: true,
  });
  await expect(login).toBeEnabled();
  await login.click();
  await expect(login).toBeDisabled();
  await panel(page)
    .getByRole("button", { name: "ログインを中断", exact: true })
    .click();
  release();
  await expect(login).toBeEnabled();
  expect(starts).toBe(1);
  expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
});
test("callback outcome query is removed and authentication failure leaves reading available", async ({
  page,
}) => {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ status: 503, json: { status: "auth-unconfigured" } }),
  );
  await page.goto("/?auth=failed#read");
  await expect(panel(page)).toHaveAttribute("open", "");
  expect(new URL(page.url()).searchParams.has("auth")).toBe(false);
  await expect(
    panel(page).getByRole("button", { name: "Googleでログイン", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("main h1")).toBeVisible();
});

test("session expiry removes saved metadata on the next state refresh and does not enable input", async ({
  page,
}) => {
  let live = true;
  await page.route("**/api/**", (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/auth/status")
      return route.fulfill({
        json: {
          available: true,
          authenticated: live,
          csrfToken: csrf,
          realKeyInputEnabled: false,
        },
      });
    if (p === "/api/session")
      return route.fulfill({
        json: {
          csrfToken: csrf,
          connection: "unconnected",
          realKeyInputEnabled: false,
        },
      });
    return route.fulfill({
      json: {
        revision: 2,
        model: null,
        state: "deleted",
        checked: false,
        connection: "unconnected",
      },
    });
  });
  await page.goto("/#read");
  await panel(page).locator("summary").click();
  await expect(panel(page).getByRole("region")).toHaveCount(2);
  live = false;
  await page.evaluate(() =>
    window.dispatchEvent(new PopStateEvent("popstate")),
  );
  await expect(panel(page).getByRole("region")).toHaveCount(0);
  await expect(
    panel(page).getByRole("button", { name: "ログアウト", exact: true }),
  ).toBeDisabled();
});

test("private Dev logout replaces cached reader with the login entry", async ({
  page,
  baseURL,
}) => {
  let logged = true;
  await page.route(new URL("/", baseURL).href, async (route) => {
    if (!logged)
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body><main><h1>Googleログインの設定準備中</h1></main></body></html>',
      });
    const r = await route.fetch();
    return route.fulfill({
      response: r,
      body: (await r.text()).replace(
        "</head>",
        '<meta name="private-dev" content="true"></head>',
      ),
    });
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/logout") {
      logged = false;
      return route.fulfill({
        json: { status: "signed-out", realKeyInputEnabled: false },
      });
    }
    if (path === "/api/auth/status")
      return route.fulfill({
        json: {
          available: true,
          authenticated: logged,
          csrfToken: csrf,
          realKeyInputEnabled: false,
        },
      });
    if (path === "/api/session")
      return route.fulfill({
        json: {
          csrfToken: csrf,
          connection: "unconnected",
          realKeyInputEnabled: false,
        },
      });
    return route.fulfill({
      json: {
        revision: 0,
        model: null,
        state: "deleted",
        checked: false,
        connection: "unconnected",
      },
    });
  });
  await page.goto("/#read");
  await panel(page).locator("summary").click();
  await expect(
    panel(page).getByRole("button", { name: "ログアウト", exact: true }),
  ).toBeEnabled();
  await panel(page)
    .getByRole("button", { name: "ログアウト", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Googleログインの設定準備中" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "CAA は、どこまで効く？", exact: true }),
  ).toHaveCount(0);
});
