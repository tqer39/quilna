import { test, expect } from "@playwright/test";
import { assets, freePort } from "../fixtures/browser-runtime.mjs";
import {
  creationRuntime,
  policy,
  url as sourceURL,
} from "../fixtures/topic-creation-runtime.mjs";

for (const revoke of [false, true])
  test(
    revoke
      ? "計数後に管理者権限が失効した依頼を確認し、復帰後に別の依頼として準備する"
      : "管理者が公開資料から非同期で教科書を作成し、再起動後に取り込んで読む",
    async ({ page, context }) => {
      const port = await freePort(),
        origin = "http://127.0.0.1:" + port;
      const serve = await assets();
      let cleanup;
      try {
        const fixture = await creationRuntime(
          (fn) => {
            cleanup = fn;
          },
          {
            origin,
            server: {
              port,
              host: "127.0.0.1",
              serviceBindings: {
                ASSETS: async (request) => {
                  const response = await serve(request);
                  if (new URL(request.url).pathname !== "/") return response;
                  return new Response(
                    (await response.text()).replace(
                      "</head>",
                      '<meta name="account-libraries" content="required"></head>',
                    ),
                    { headers: response.headers },
                  );
                },
              },
            },
            bindings: {
              FIXTURE_REVOKE_AUTHOR_AFTER_COUNT: String(revoke),
              LIBRARY_ISOLATION_ENABLED: "true",
              LIBRARY_LEGACY_OWNER_HASH: "0".repeat(64),
            },
          },
        );
        await context.setExtraHTTPHeaders({ "X-Test-Principal": "owner" });
        await page.goto(origin + "/?view=textbooks");
        const root = page.locator(".topic-creation"),
          prep = root.locator(".topic-preparation");
        await prep.locator("summary").first().click();
        await prep.getByLabel("学びたいテーマ").fill("モデル");
        await prep
          .getByRole("button", { name: "資料を探す", exact: true })
          .click();
        await prep
          .getByRole("button", { name: "この資料で教科書を準備する" })
          .click();
        await root
          .getByLabel("学習目的", { exact: true })
          .fill("モデルの出力と保存処理を区別する");
        await root
          .getByRole("button", { name: "依頼を保存して費用を確認" })
          .click();
        await root
          .getByRole("button", { name: "モデルと費用を確認", exact: true })
          .click();
        const stats = () =>
          fixture.call("/__creation-stats", { owner: fixture.owner });
        expect(await stats()).toEqual({ responses: 0, counts: 0 });
        await root.getByRole("checkbox").check();
        const accepted = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
            "/api/topic-textbooks/creations/approve",
        );
        await root
          .getByRole("button", { name: "この費用上限で作成を始める" })
          .click();
        expect((await accepted).status()).toBe(200);
        await page.goto("about:blank");
        await expect
          .poll(
            async () =>
              (await fixture.call("/api/topic-textbooks/creations/list", {}))
                .creations[0]?.state,
            { timeout: 20000 },
          )
          .toBe(revoke ? "rejected" : "ready");
        if (revoke) {
          await page.goto(origin + "/?view=textbooks");
          await root.getByText("保存した作成依頼", { exact: true }).click();
          await root.getByRole("button", { name: "一覧を確認" }).click();
          await root.getByRole("button", { name: "依頼を確認" }).click();
          await expect(
            root.getByText(/生成に必要な権限や接続を確認できませんでした/),
          ).toBeVisible();
          await expect(
            root.getByRole("button", { name: "新しい依頼の資料を探す" }),
          ).toHaveCount(0);
          const db = await fixture.runtime.getD1Database("AUTH_DB");
          await db
            .prepare('UPDATE "user" SET "emailVerified"=1 WHERE id=?')
            .bind("creation-fixture-user")
            .run();
        }
        await fixture.restart({ TEST_INSTANCE_ID: "after-restart" });
        await page.goto(origin + "/?view=textbooks");
        await root.getByText("保存した作成依頼", { exact: true }).click();
        await root.getByRole("button", { name: "一覧を確認" }).click();
        await root.getByRole("button", { name: "依頼を確認" }).click();
        if (revoke) {
          await expect(
            root.getByText(/生成に必要な権限や接続を確認できませんでした/),
          ).toBeVisible();
          await expect(
            root.getByRole("button", { name: "再予約の費用を確認" }),
          ).toHaveCount(0);
          await root
            .getByRole("button", { name: "新しい依頼の資料を探す" })
            .click();
          await expect(prep.getByLabel("学びたいテーマ")).toBeFocused();
          await prep.getByLabel("学びたいテーマ").fill("モデル");
          await prep
            .getByRole("button", { name: "資料を探す", exact: true })
            .click();
          await prep
            .getByRole("button", { name: "この資料で教科書を準備する" })
            .click();
          await root
            .getByLabel("学習目的", { exact: true })
            .fill("公開資料を読み直す");
          await root
            .getByRole("button", { name: "依頼を保存して費用を確認" })
            .click();
          await root
            .getByRole("button", { name: "モデルと費用を確認", exact: true })
            .click();
          const { creations } = await fixture.call(
            "/api/topic-textbooks/creations/list",
            {},
          );
          expect(creations.map((c) => c.state).sort()).toEqual([
            "draft",
            "rejected",
          ]);
          expect(new Set(creations.map((c) => c.id)).size).toBe(2);
          expect(await stats()).toEqual({ responses: 0, counts: 1 });
          return;
        }
        await root
          .getByRole("button", { name: "完成版をこのブラウザに取り込む" })
          .click();
        await expect(root.locator(".topic-creation-notice")).toContainText(
          "取り込みました",
        );
        await page.reload();
        const saved = page
          .getByRole("region", { name: "保存した教材" })
          .getByRole("button", { name: /テーマ別の合成教材/ });
        await saved.click();
        await expect(
          page.getByRole("heading", { name: /テーマ別の合成教材/ }).first(),
        ).toBeVisible();
        expect(await stats()).toEqual({ responses: 2, counts: 2 });
      } finally {
        await cleanup?.();
      }
    },
  );

test("別の読者が未ログインの入口から保存済みの公開記事を読める", async ({
  page,
}) => {
  const port = await freePort();
  const origin = "http://127.0.0.1:" + port;
  let cleanup;
  try {
    const fixture = await creationRuntime(
      (fn) => {
        cleanup = fn;
      },
      {
        origin,
        server: { port, host: "127.0.0.1" },
        bindings: { PRIVATE_DEV: "true" },
      },
    );
    const initialFetches = fixture.originCalls;
    await page.goto(origin);
    const entry = page.getByRole("link", {
      name: "ログインせずに共有記事を読む",
    });
    await entry.click();
    await page.getByLabel("記事の元のURL").fill(sourceURL);
    await page.getByRole("button", { name: "保存済みの記事を開く" }).click();
    await expect(page.locator("article")).toContainText("原文の版1");
    await page.reload();
    await expect(page.locator("article")).toContainText("原文の版1");
    const articlePage = page.url();
    await page.goto(origin);
    const endpoint = new URL("/api/public/documents", origin);
    endpoint.searchParams.set("url", sourceURL);
    // fetchの304はブラウザ内で保存済みの200に統合されるため、通信上の応答も確認する。
    const session = await page.context().newCDPSession(page);
    const documentRequests = new Set();
    const networkResponses = new Map();
    session.on("Network.requestWillBeSent", ({ requestId, request }) => {
      if (request.url === endpoint.href) documentRequests.add(requestId);
    });
    session.on(
      "Network.responseReceivedExtraInfo",
      ({ requestId, statusCode }) => {
        networkResponses.set(requestId, statusCode);
      },
    );
    await session.send("Network.enable");
    const readCopy = () =>
      page.evaluate(async (url) => {
        const response = await fetch(url);
        return {
          status: response.status,
          cache: response.headers.get("cache-control"),
          etag: response.headers.get("etag"),
          data: await response.json(),
        };
      }, endpoint.href);
    const first = await readCopy();
    expect(first.status).toBe(200);
    expect(first.data.content.text).toContain("原文の版1");
    expect(first.etag).toBeTruthy();
    expect(await readCopy()).toEqual(first);
    await fixture.database
      .prepare("UPDATE document_publications SET enabled=0 WHERE policy_id=?")
      .bind(policy)
      .run();
    const withdrawn = await readCopy();
    expect(withdrawn).toEqual({
      status: 404,
      cache: "no-store",
      etag: null,
      data: { status: "document-unavailable" },
    });
    await expect
      .poll(() =>
        Array.from(documentRequests, (id) => networkResponses.get(id)),
      )
      .toEqual([200, 304, 404]);
    await session.detach();
    const html = await page.goto(articlePage);
    expect(html.status()).toBe(404);
    await expect(page.locator("article")).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText(
      "公開されている保存済みの記事が見つかりません",
    );
    expect(fixture.originCalls).toBe(initialFetches);
    await fixture.restart({ PUBLIC_DOCUMENTS_ENABLED: "false" });
    await page.goto(origin);
    await expect(entry).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Googleでログイン" }),
    ).toBeVisible();
  } finally {
    await cleanup?.();
  }
});
