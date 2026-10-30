import { test, expect, type Page } from "@playwright/test";
import type { DocumentPolicy } from "../../src/document-policy-client";
const account = "a".repeat(64),
  other = "b".repeat(64),
  url = "https://publisher.example.org/article";
const id = "77777777-7777-4777-8777-777777777777";
function saved(): DocumentPolicy {
  return {
    id,
    url,
    enabled: true,
    expires: Date.now() + 86400000,
    evidence: "Synthetic permission for offline fixtures",
    policyRevision: 1,
    managementRevision: 1,
    updated: 1,
    members: [account],
    aliases: [],
  };
}
async function fixture(page: Page, initial: DocumentPolicy | null = null) {
  const state = {
    policy: initial,
    enabled: true,
    account,
    mode: "ok",
    hold: null as Promise<void> | null,
    saves: 0,
    statuses: 0,
    requests: [] as string[],
  };
  await page.route("**/api/session", (r) =>
    r.fulfill({ json: { csrfToken: "synthetic-csrf-token-for-policy" } }),
  );
  await page.route("**/api/documents/admin-*", async (r) => {
    const action = new URL(r.request().url()).pathname.split("admin-")[1];
    state.requests.push(action);
    if (action === "status") {
      state.statuses++;
      return r.fulfill({
        json: { account: state.account, enabled: state.enabled },
      });
    }
    expect(r.request().headers()["x-document-account"]).toBe(account);
    expect(r.request().headers()["x-csrf-token"]).toBe(
      "synthetic-csrf-token-for-policy",
    );
    const body = r.request().postDataJSON();
    if (action === "list")
      return r.fulfill({
        json: {
          account,
          policies: state.policy ? [state.policy] : [],
          after: null,
        },
      });
    if (action === "read")
      return r.fulfill({ json: { account, policy: state.policy } });
    state.saves++;
    if (state.mode === "conflict")
      return r.fulfill({
        status: 409,
        json: { account, status: "document-conflict" },
      });
    if (state.hold) await state.hold;
    const old = state.policy;
    state.policy = {
      ...body,
      id: old?.id ?? id,
      url: old?.url ?? body.url,
      policyRevision: old
        ? old.policyRevision + Number(old.evidence !== body.evidence)
        : 1,
      managementRevision: (old?.managementRevision ?? 0) + 1,
      updated: Date.now(),
    };
    if (state.mode === "lost") return r.abort("failed");
    const result = structuredClone(state.policy!);
    // JSON field order is not part of the protocol's meaning.
    result.aliases = result.aliases.map((a) => ({
      policyRevision: a.policyRevision,
      evidence: a.evidence,
      expires: a.expires,
      enabled: a.enabled,
      url: a.url,
    }));
    if (state.mode === "different") result.members = [];
    if (state.mode === "malformed") result.aliases = [null as never];
    if (state.mode === "logout") state.account = other;
    return r.fulfill({ json: { account, policy: result } });
  });
  await page.goto("/?view=feeds");
  await page.getByRole("button", { name: "設定", exact: true }).click();
  const root = page.locator(".rss-policy-settings");
  await root.locator("summary").click();
  return { state, root };
}
async function connect(root: ReturnType<Page["locator"]>) {
  await root
    .getByRole("button", { name: "管理者として接続を確認", exact: true })
    .click();
  await expect(root.getByRole("status")).toContainText(
    "管理者の接続を確認しました",
  );
}
async function edit(root: ReturnType<Page["locator"]>) {
  await connect(root);
  await root
    .getByRole("button", { name: "有効 · " + url, exact: true })
    .click();
  await expect(root.getByLabel("出典の記事URL", { exact: true })).toHaveValue(
    url,
  );
}
async function preview(root: ReturnType<Page["locator"]>) {
  await root
    .getByRole("button", { name: "変更内容を確認", exact: true })
    .click();
  await expect(root.locator(".rss-policy-review")).toBeVisible();
}
for (const design of ["studio", "editorial", "focus"]) {
  test(`${design} creates a reviewed permission and alias at narrow width without uploading personal records`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.addInitScript(
      (design) => localStorage.setItem("quilna.reader.design.v1", design),
      design,
    );
    const { state, root } = await fixture(page);
    expect(state.requests).toEqual([]);
    await connect(root);
    await root
      .getByRole("button", { name: "共有する出典を登録", exact: true })
      .click();
    const enabled = root.getByLabel("指定した利用者への本文共有を有効にする", {
      exact: true,
    });
    await expect(enabled).not.toBeChecked();
    await root.getByLabel("出典の記事URL", { exact: true }).fill(url);
    await root
      .getByLabel("本文を共有できる根拠", { exact: true })
      .fill("Synthetic permission from the publisher");
    await enabled.check();
    await root
      .getByRole("button", { name: "別名URLを追加", exact: true })
      .click();
    await root
      .getByLabel("別名URL", { exact: true })
      .fill(url + "?source=approved");
    await root
      .getByLabel("同じ記事と判断した根拠", { exact: true })
      .fill("Explicit synthetic alias evidence");
    await root.getByLabel("この別名を有効にする", { exact: true }).check();
    await root
      .getByRole("button", { name: "変更内容を確認", exact: true })
      .click();
    await expect(root.getByRole("status")).toContainText(
      "同じ記事を指すことを確認してください",
    );
    await root
      .getByLabel("現在の共有条件で、同じ記事を指すことを確認しました", {
        exact: true,
      })
      .check();
    await preview(root);
    expect(state.saves).toBe(0);
    await root
      .getByRole("button", { name: "この内容を保存", exact: true })
      .click();
    await expect(root.getByRole("status")).toContainText(
      "共有設定を保存しました",
    );
    expect(state.saves).toBe(1);
    expect(state.policy?.members).toEqual([account]);
    expect(state.policy?.aliases[0].policyRevision).toBe(1);
    await expect(
      root.getByLabel("出典の記事URL", { exact: true }),
    ).toHaveAttribute("readonly", "");
    expect(Object.keys(state.policy!).sort()).toEqual(
      [
        "aliases",
        "enabled",
        "evidence",
        "expires",
        "id",
        "managementRevision",
        "members",
        "policyRevision",
        "updated",
        "url",
      ].sort(),
    );
    await root
      .getByRole("button", { name: "変更内容を確認", exact: true })
      .focus();
    await page.keyboard.press("Tab");
    await expect(
      root.getByRole("button", { name: "最新の保存内容を確認", exact: true }),
    ).toBeFocused();
    expect(
      await page
        .getByRole("dialog")
        .evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
    ).toBe(true);
    await root
      .getByLabel("出典の記事URL", { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`policy-${design}.png`) });
  });
}
test("conflicting edits preserve the draft and require explicit replacement with current saved data", async ({
  page,
}) => {
  const { state, root } = await fixture(page, saved());
  await edit(root);
  await root
    .getByLabel("本文を共有できる根拠", { exact: true })
    .fill("My unsaved permission explanation");
  state.mode = "conflict";
  await preview(root);
  await root
    .getByRole("button", { name: "この内容を保存", exact: true })
    .click();
  await expect(root.getByRole("status")).toContainText("別の編集");
  await expect(
    root.getByLabel("本文を共有できる根拠", { exact: true }),
  ).toHaveValue("My unsaved permission explanation");
  await expect(
    root.getByRole("button", { name: "変更内容を確認", exact: true }),
  ).toBeDisabled();
  await expect(
    root.getByRole("button", { name: "この内容を保存", exact: true }),
  ).toHaveCount(0);
  state.policy!.evidence = "Another editor's saved permission";
  state.policy!.managementRevision++;
  await root
    .getByRole("button", { name: "最新の保存内容を確認", exact: true })
    .click();
  await expect(
    root.getByText("Another editor's saved permission", { exact: true }),
  ).toBeVisible();
  await expect(
    root.getByLabel("本文を共有できる根拠", { exact: true }),
  ).toHaveValue("My unsaved permission explanation");
  page.once("dialog", (d) => d.dismiss());
  await root
    .getByRole("button", { name: "この保存内容で編集し直す", exact: true })
    .click();
  await expect(
    root.getByLabel("本文を共有できる根拠", { exact: true }),
  ).toHaveValue("My unsaved permission explanation");
  page.once("dialog", (d) => d.accept());
  await root
    .getByRole("button", { name: "この保存内容で編集し直す", exact: true })
    .click();
  await expect(
    root.getByLabel("本文を共有できる根拠", { exact: true }),
  ).toHaveValue("Another editor's saved permission");
  expect(state.saves).toBe(1);
});
test("a committed save with a lost response cannot be retried blindly and remains recoverable", async ({
  page,
}) => {
  const { state, root } = await fixture(page, saved());
  await edit(root);
  await root
    .getByLabel("共有する利用者ID（1行に1人）", { exact: true })
    .fill(account + "\n" + other);
  state.mode = "lost";
  await preview(root);
  await root
    .getByRole("button", { name: "この内容を保存", exact: true })
    .click();
  await expect(root.getByRole("status")).toContainText(
    "自動で保存し直しません",
  );
  expect(state.policy?.managementRevision).toBe(2);
  await root
    .getByRole("button", { name: "最新の保存内容を確認", exact: true })
    .click();
  await expect(root.getByText(/対象2人/)).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await root
    .getByRole("button", { name: "この保存内容で編集し直す", exact: true })
    .click();
  await expect(
    root.getByLabel("共有する利用者ID（1行に1人）", { exact: true }),
  ).toHaveValue(account + "\n" + other);
  expect(state.saves).toBe(1);
});
test("a changed login prevents dispatch and conceals the draft until the original admin reconnects", async ({
  page,
}) => {
  const { state, root } = await fixture(page, saved());
  await edit(root);
  await root
    .getByLabel("本文を共有できる根拠", { exact: true })
    .fill("Keep this private draft for the first admin");
  await preview(root);
  state.account = other;
  await root
    .getByRole("button", { name: "この内容を保存", exact: true })
    .click();
  await expect(root.getByRole("status")).toContainText(
    "同じアカウントで接続し直して",
  );
  await expect(
    root.getByLabel("本文を共有できる根拠", { exact: true }),
  ).toBeHidden();
  expect(state.saves).toBe(0);
  state.account = account;
  await connect(root);
  await expect(
    root.getByLabel("本文を共有できる根拠", { exact: true }),
  ).toHaveValue("Keep this private draft for the first admin");
  await expect(
    root.getByRole("button", { name: "変更内容を確認", exact: true }),
  ).toBeDisabled();
});
for (const mode of ["different", "logout", "malformed"])
  test(`${mode} after a save never acknowledges unverified data`, async ({
    page,
  }) => {
    const { state, root } = await fixture(page, saved());
    await edit(root);
    state.mode = mode;
    await preview(root);
    await root
      .getByRole("button", { name: "この内容を保存", exact: true })
      .click();
    await expect(root.getByRole("status")).toContainText("確認できません");
    await expect(root.getByRole("status")).not.toContainText("保存しました");
    expect(state.saves).toBe(1);
  });
test("permission evidence changes invalidate alias approval and a disabled environment exposes no editor", async ({
  page,
}) => {
  const p = saved();
  p.aliases = [
    {
      url: url + "?alias=approved",
      expires: p.expires,
      enabled: true,
      evidence: "Synthetic same-source approval",
      policyRevision: 1,
    },
  ];
  const { state, root } = await fixture(page, p);
  state.enabled = false;
  await root
    .getByRole("button", { name: "管理者として接続を確認", exact: true })
    .click();
  await expect(root.getByRole("status")).toContainText("管理を利用できません");
  await expect(
    root.getByRole("button", { name: "共有する出典を登録", exact: true }),
  ).toBeHidden();
  state.enabled = true;
  await edit(root);
  await root
    .getByLabel("本文を共有できる根拠", { exact: true })
    .fill("Changed explicit sharing permission");
  await expect(
    root.getByLabel("現在の共有条件で、同じ記事を指すことを確認しました", {
      exact: true,
    }),
  ).not.toBeChecked();
  await root
    .getByRole("button", { name: "変更内容を確認", exact: true })
    .click();
  await expect(root.getByRole("status")).toContainText(
    "同じ記事を指すことを確認してください",
  );
  expect(state.saves).toBe(0);
  await root
    .getByLabel("現在の共有条件で、同じ記事を指すことを確認しました", {
      exact: true,
    })
    .check();
  await preview(root);
  await root
    .getByRole("button", { name: "この内容を保存", exact: true })
    .click();
  await expect(root.getByRole("status")).toContainText(
    "共有設定を保存しました",
  );
  expect(state.policy?.policyRevision).toBe(2);
  expect(state.policy?.aliases[0].policyRevision).toBe(2);
});

test("an uncertain create keeps its draft and can reopen the committed source without creating a duplicate", async ({
  page,
}) => {
  const { state, root } = await fixture(page);
  await connect(root);
  await root
    .getByRole("button", { name: "共有する出典を登録", exact: true })
    .click();
  await root.getByLabel("出典の記事URL", { exact: true }).fill(url);
  await root
    .getByLabel("本文を共有できる根拠", { exact: true })
    .fill("Synthetic permission for a new source");
  state.mode = "lost";
  await preview(root);
  await root
    .getByRole("button", { name: "この内容を保存", exact: true })
    .click();
  await expect(root.getByRole("status")).toContainText(
    "自動で保存し直しません",
  );
  await root
    .getByRole("button", { name: "最新の保存内容を確認", exact: true })
    .click();
  await expect(
    root.getByLabel("本文を共有できる根拠", { exact: true }),
  ).toHaveValue("Synthetic permission for a new source");
  page.once("dialog", (d) => d.accept());
  await root
    .getByRole("button", { name: "無効 · " + url, exact: true })
    .click();
  await expect(root.getByRole("status")).toContainText(
    "最新の共有設定を読み込みました",
  );
  await expect(
    root.getByLabel("出典の記事URL", { exact: true }),
  ).toHaveAttribute("readonly", "");
  expect(state.saves).toBe(1);
});

test("a second pending save replaces the previous success notice until its own commit is confirmed", async ({
  page,
}) => {
  const { state, root } = await fixture(page, saved());
  await edit(root);
  await root
    .getByLabel("本文を共有できる根拠", { exact: true })
    .fill("First confirmed permission update");
  await preview(root);
  await root
    .getByRole("button", { name: "この内容を保存", exact: true })
    .click();
  await expect(root.getByRole("status")).toContainText(
    "共有設定を保存しました",
  );
  expect(state.policy?.managementRevision).toBe(2);
  let release!: () => void;
  state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await root
      .getByLabel("共有する利用者ID（1行に1人）", { exact: true })
      .fill(account + "\n" + other);
    await preview(root);
    await root
      .getByRole("button", { name: "この内容を保存", exact: true })
      .click();
    await expect.poll(() => state.saves).toBe(2);
    expect(state.policy?.managementRevision).toBe(2);
    await expect(root.getByRole("status")).toHaveText(
      "共有設定を保存しています…",
    );
    await expect(
      root.getByRole("button", { name: "この内容を保存", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(root.getByRole("status")).toContainText(
    "共有設定を保存しました",
  );
  expect(state.policy?.managementRevision).toBe(3);
  expect(state.policy?.members).toEqual([account, other]);
});
