import { test, expect, type Page } from "@playwright/test";
import fixture from "../fixtures/crossref-work.json" with { type: "json" };
const list = (items: unknown[] = [fixture.message], total = items.length) => ({
  status: "ok",
  "message-type": "work-list",
  message: { items, "total-results": total },
});
/** Only synthetic responses are allowed; inspect exact query/credential boundaries. */
async function provider(page: Page) {
  const requests: string[] = [];
  await page.route("https://api.crossref.org/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    requests.push(url.href);
    expect(request.headers().cookie).toBeUndefined();
    expect(request.headers().authorization).toBeUndefined();
    expect(request.headers().referer).toBeUndefined();
    await route.fulfill({ json: url.pathname === "/works" ? list() : fixture });
  });
  return requests;
}
/** Inspect retained observations independently of search/preview status text. */
async function records(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/paper-store.ts",
      api: typeof import("../../src/paper-store") = await import(path);
    return api.listPapers();
  });
}
test("explicit keyword search selects a separate DOI observation before save, with keyboard and narrow-screen text safety", async ({
  page,
}) => {
  const requests = await provider(page);
  await page.goto("/?view=papers");
  await page.setViewportSize({ width: 320, height: 800 });
  expect(requests).toEqual([]);
  const query = "学習 & mailto=secret@example.org";
  await page.getByLabel("書誌キーワード", { exact: true }).fill(query);
  await page.getByLabel("書誌キーワード", { exact: true }).press("Enter");
  const results = page.getByRole("region", {
    name: "書誌キーワードの検索結果",
    exact: true,
  });
  await expect(
    results.getByRole("heading", { name: `「${query}」の検索結果` }),
  ).toBeFocused();
  expect(requests).toHaveLength(1);
  const url = new URL(requests[0]);
  expect(url.searchParams.get("query.bibliographic")).toBe(query);
  const keys: string[] = [];
  url.searchParams.forEach((_value, key) => keys.push(key));
  expect(keys).toEqual(["query.bibliographic", "rows", "select"]);
  await expect(results).toContainText("2026-10");
  await expect(results.locator("script")).toHaveCount(0);
  await expect(results).not.toContainText("PRIVATE_ABSTRACT");
  expect((await records(page)).snapshots).toEqual([]);
  await expect(
    page.getByRole("region", { name: "書誌情報のプレビュー", exact: true }),
  ).toBeEmpty();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  // Advance the shared provider boundary explicitly; no implicit retry or queued request.
  await page.evaluate(() =>
    localStorage.setItem("quilna.crossref-rate.v1", "0"),
  );
  const choose = results.getByRole("button", {
    name: "このDOIをCrossrefへ送って詳細を確認",
  });
  await choose.focus();
  await choose.press("Enter");
  const preview = page.getByRole("region", {
    name: "書誌情報のプレビュー",
    exact: true,
  });
  await expect(
    preview.getByRole("heading", {
      name: fixture.message.title[0],
      exact: true,
    }),
  ).toBeFocused();
  expect(requests).toHaveLength(2);
  expect(new URL(requests[1]).pathname).toBe(
    "/works/10.5555%2Fquilna.synthetic",
  );
  await page
    .getByRole("button", { name: "この書誌情報を保存", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "保存済み", exact: true }),
  ).toBeVisible();
  const before = (await records(page)).snapshots;
  expect(before).toHaveLength(1);
  expect(JSON.stringify(before)).not.toContain(query);
  await page.reload();
  expect((await records(page)).snapshots).toEqual(before);
  await expect(
    page.getByRole("region", { name: "書誌キーワードの検索結果", exact: true }),
  ).toBeEmpty();
  expect(requests).toHaveLength(2);
});
test("empty, incomplete, duplicate and invalid results retain the previous query and never write a snapshot", async ({
  page,
}) => {
  let value: unknown = list(
    [{ DOI: "10.5555/missing" }, { DOI: "10.5555/MISSING" }],
    30,
  );
  await page.route("https://api.crossref.org/**", (route) =>
    route.fulfill({ json: value }),
  );
  await page.goto("/?view=papers");
  const search = async (query: string) => {
    await page.evaluate(() =>
      localStorage.setItem("quilna.crossref-rate.v1", "0"),
    );
    await page.getByLabel("書誌キーワード", { exact: true }).fill(query);
    await page
      .getByRole("button", { name: "キーワードをCrossrefへ送って検索" })
      .click();
  };
  const results = page.getByRole("region", {
    name: "書誌キーワードの検索結果",
    exact: true,
  });
  await search("missing");
  await expect(results).toContainText("題名不明");
  await expect(results).toContainText("重複1件");
  await expect(results.getByRole("button")).toHaveCount(1);
  value = list([{ DOI: "invalid" }]);
  await search("broken");
  await expect(
    page.getByRole("region", { name: "書誌キーワード検索", exact: true }),
  ).toContainText("検索結果を確認できません");
  await expect(
    results.getByRole("heading", {
      name: "「missing」の検索結果",
      exact: true,
    }),
  ).toBeVisible();
  value = list([]);
  await search("empty");
  await expect(results).toContainText("該当する書誌情報がありません");
  expect((await records(page)).snapshots).toEqual([]);
});
for (const outcome of ["resolve", "reject"] as const)
  test(`late ${outcome} after input change, cancellation, new query and old-result selection cannot replace the active view`, async ({
    page,
  }) => {
    await page.goto("/?view=papers");
    // Replace only the component's transport with controllable promises which deliberately ignore abort.
    await page.evaluate(async () => {
      const path = "/src/paper-search-view.ts",
        api: typeof import("../../src/paper-search-view") = await import(path);
      const root = document.createElement("div");
      document.body.replaceChildren(root);
      type Pending = {
        resolve: (v: unknown) => void;
        reject: (e: Error) => void;
      };
      const state = window as unknown as {
        pending: Pending[];
        selected: string[];
      };
      state.pending = [];
      state.selected = [];
      const view = api.paperSearchView(
        {
          search: () =>
            new Promise((resolve, reject) =>
              state.pending.push({
                resolve: resolve as (v: unknown) => void,
                reject,
              }),
            ),
        },
        (doi) => state.selected.push(doi),
        () => {},
      );
      root.append(view.root);
    });
    const search = async (query: string) => {
      await page.getByLabel("書誌キーワード", { exact: true }).fill(query);
      await page
        .getByRole("button", { name: "キーワードをCrossrefへ送って検索" })
        .click();
    };
    const finish = async (index: number, title: string, reject = false) =>
      page.evaluate(
        ({ index, title, reject }) => {
          const state = window as unknown as {
            pending: {
              resolve: (v: unknown) => void;
              reject: (e: Error) => void;
            }[];
          };
          if (reject)
            state.pending[index].reject(Error(`LATE_FAILURE_${title}`));
          else
            state.pending[index].resolve({
              total: 1,
              duplicates: 0,
              items: [
                {
                  doi: "10.5555/synthetic",
                  titles: [title],
                  authors: [],
                  container: [],
                  published: {},
                },
              ],
            });
        },
        { index, title, reject },
      );
    await search("first");
    await finish(0, "FIRST_RESULT");
    await expect(page.getByText("FIRST_RESULT", { exact: true })).toBeVisible();
    await search("second");
    await page.getByLabel("書誌キーワード", { exact: true }).fill("third");
    await page
      .getByRole("button", { name: "キーワードをCrossrefへ送って検索" })
      .click();
    await finish(2, "THIRD_RESULT");
    await expect(page.getByText("THIRD_RESULT", { exact: true })).toBeVisible();
    await finish(1, "SECOND_RESULT", outcome === "reject");
    await expect(page.getByText("THIRD_RESULT", { exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(
      "LATE_FAILURE_SECOND_RESULT",
    );
    await search("fourth");
    await page.getByRole("button", { name: "検索を中止", exact: true }).click();
    await finish(3, "FOURTH_RESULT", outcome === "reject");
    await expect(page.getByText("THIRD_RESULT", { exact: true })).toBeVisible();
    await search("fifth");
    await page
      .getByRole("button", { name: "このDOIをCrossrefへ送って詳細を確認" })
      .click();
    await finish(4, "FIFTH_RESULT", outcome === "reject");
    await expect(page.getByText("THIRD_RESULT", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as { selected: string[] }).selected,
      ),
    ).toEqual(["10.5555/synthetic"]);
    await expect(page.locator("body")).not.toContainText("LATE_FAILURE_");
  });
