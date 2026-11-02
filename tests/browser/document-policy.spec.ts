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
/**
 * Mount policy settings with mutable, intercepted session/policy/history responses.
 * Return the UI and synthetic server state so tests can gate requests or inject
 * failures and account changes without granting real access or calling a service.
 */
async function fixture(page: Page, initial: DocumentPolicy | null = null) {
  const state = {
    policy: initial,
    history: initial ? [structuredClone(initial)] : ([] as DocumentPolicy[]),
    enabled: true,
    account,
    mode: "ok",
    hold: null as Promise<void> | null,
    saves: 0,
    statuses: 0,
    updates: [] as Record<string, unknown>[],
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
    if (action === "read") {
      if (state.mode === "read-failure") return r.abort("failed");
      if (state.mode === "read-logout") state.account = other;
      return r.fulfill({ json: { account, policy: state.policy } });
    }
    if (action === "history") {
      const entries = state.history
        .map((p) => ({
          revision: p.managementRevision,
          actor: account,
          recorded: 1,
          kind: "update",
        }))
        .reverse();
      return r.fulfill({ json: { account, id, entries, before: null } });
    }
    if (action === "revision") {
      const p = structuredClone(
        state.history.find((p) => p.managementRevision === body.revision)!,
      );
      if (state.mode === "history-invalid")
        p.id = "88888888-8888-4888-8888-888888888888";
      if (state.mode === "history-logout") state.account = other;
      return r.fulfill({
        json: {
          account,
          policy: p,
          entry: {
            revision: body.revision,
            actor: account,
            recorded: 1,
            kind: "update",
          },
        },
      });
    }
    state.saves++;
    state.updates.push(body);
    if (
      state.mode === "conflict" ||
      (state.policy &&
        body.expectedRevision !== state.policy.managementRevision)
    )
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
    state.history.push(structuredClone(state.policy!));
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

/** Open the fixture's first historical revision without replacing the draft. */
async function openOldRevision(root: ReturnType<Page["locator"]>) {
  await root
    .getByRole("button", { name: "変更履歴を確認", exact: true })
    .click();
  await root
    .getByRole("button", { name: "変更 #1 を読む", exact: true })
    .click();
}

for (const design of ["studio", "editorial", "focus"])
  test(`${design} recovers a historical draft against the latest revision with explicit reapproval`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.addInitScript(
      (d) => localStorage.setItem("quilna.reader.design.v1", d),
      design,
    );
    const old = saved();
    old.members.push(other);
    old.aliases.push({
      url: url + "?old-alias",
      enabled: true,
      expires: old.expires,
      evidence: "Old explicit source alias",
      policyRevision: 1,
    });
    const { state, root } = await fixture(page, old);
    await edit(root);
    const reason = root.getByLabel("本文を共有できる根拠", { exact: true });
    await reason.fill("Keep my unsaved draft");
    await openOldRevision(root);
    // Another administrator changed the source after this editor was opened.
    state.policy = {
      ...old,
      enabled: false,
      members: [account],
      aliases: [],
      evidence: "Current updated permission",
      policyRevision: 4,
      managementRevision: 5,
    };
    const current = structuredClone(state.policy);
    const recover = root.getByRole("button", {
      name: "この記録から下書きを作る",
      exact: true,
    });
    await Promise.all([
      new Promise<void>((resolve) =>
        page.once("dialog", async (d) => {
          await d.dismiss();
          resolve();
        }),
      ),
      recover.click(),
    ]);
    await expect(recover).toBeEnabled();
    await expect(reason).toHaveValue("Keep my unsaved draft");
    expect(state.policy).toEqual(current);
    page.once("dialog", (d) => d.accept());
    await root
      .getByRole("button", { name: "この記録から下書きを作る", exact: true })
      .click();
    await expect(reason).toHaveValue(old.evidence);
    await expect(
      root.getByLabel("共有する利用者ID（1行に1人）", { exact: true }),
    ).toHaveValue(account + "\n" + other);
    const enabled = root.getByLabel("指定した利用者への本文共有を有効にする", {
      exact: true,
    });
    const alias = root.getByLabel("この別名を有効にする", { exact: true });
    const approval = root.getByLabel(
      "現在の共有条件で、同じ記事を指すことを確認しました",
      { exact: true },
    );
    await expect(enabled).not.toBeChecked();
    await expect(alias).not.toBeChecked();
    await expect(approval).not.toBeChecked();
    expect(state.saves).toBe(0);
    expect(state.policy).toEqual(current);
    await enabled.check();
    await alias.check();
    await root
      .getByRole("button", { name: "変更内容を確認", exact: true })
      .click();
    await expect(root.getByRole("status")).toContainText(
      "同じ記事を指すことを確認してください",
    );
    await approval.check();
    await preview(root);
    await expect(root.locator(".rss-policy-review")).toContainText(other);
    expect(state.saves).toBe(0);
    await root.locator(".rss-policy-review").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`recovery-${design}.png`) });
    await root
      .getByRole("button", { name: "この内容を保存", exact: true })
      .click();
    await expect(root.getByRole("status")).toContainText(
      "共有設定を保存しました",
    );
    expect(state.updates[0].expectedRevision).toBe(5);
    expect(state.policy?.managementRevision).toBe(6);
    expect(state.policy?.policyRevision).toBe(5);
    expect(state.policy?.aliases[0].policyRevision).toBe(5);
    expect(state.policy?.expires).toBe(old.expires);
    expect(state.history[0]).toEqual(old);
    expect(state.history.at(-1)?.members).toEqual([account, other]);
  });

for (const mode of ["read-failure", "read-logout"])
  test(`${mode} during historical recovery preserves the draft and saved permissions`, async ({
    page,
  }) => {
    const original = saved(),
      { state, root } = await fixture(page, original);
    await edit(root);
    const reason = root.getByLabel("本文を共有できる根拠", { exact: true });
    await reason.fill("Unchanged draft after failed recovery");
    await openOldRevision(root);
    state.mode = mode;
    await root
      .getByRole("button", { name: "この記録から下書きを作る", exact: true })
      .click();
    await expect(root.getByRole("status")).toContainText("確認できません");
    if (mode === "read-logout") {
      await expect(reason).toBeHidden();
      state.account = account;
      await connect(root);
    }
    await expect(reason).toHaveValue("Unchanged draft after failed recovery");
    expect(state.policy).toEqual(original);
    expect(state.saves).toBe(0);
  });

test("historical recovery does not renew an expired grant and a concurrent save cannot overwrite new permissions", async ({
  page,
}) => {
  const old = saved();
  old.expires = Date.now() - 86400000;
  const { state, root } = await fixture(page, old);
  await edit(root);
  await openOldRevision(root);
  await root
    .getByRole("button", { name: "この記録から下書きを作る", exact: true })
    .click();
  await expect(root.getByRole("status")).toContainText(
    "履歴から下書きを作りました",
  );
  const enabled = root.getByLabel("指定した利用者への本文共有を有効にする", {
    exact: true,
  });
  await enabled.check();
  await root
    .getByRole("button", { name: "変更内容を確認", exact: true })
    .click();
  await expect(root.getByRole("status")).toContainText("未来の期限が必要");
  expect(state.saves).toBe(0);
  await enabled.uncheck();
  await preview(root);
  state.policy = {
    ...old,
    managementRevision: 2,
    members: [],
    evidence: "Another administrator revoked permission",
  };
  const current = structuredClone(state.policy);
  await root
    .getByRole("button", { name: "この内容を保存", exact: true })
    .click();
  await expect(root.getByRole("status")).toContainText("別の編集");
  expect(state.policy).toEqual(current);
  await expect(
    root.getByLabel("本文を共有できる根拠", { exact: true }),
  ).toHaveValue(old.evidence);
  await expect(
    root.getByRole("button", { name: "変更内容を確認", exact: true }),
  ).toBeDisabled();
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

for (const design of ["studio", "editorial", "focus"]) {
  test(`${design} reads historical permission without changing the dirty draft at 320px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.addInitScript(
      (design) => localStorage.setItem("quilna.reader.design.v1", design),
      design,
    );
    const p = saved(),
      { state, root } = await fixture(page, p);
    await edit(root);
    const reason = root.getByLabel("本文を共有できる根拠", { exact: true });
    await reason.fill("Unsaved current permission draft");
    await root
      .getByRole("button", { name: "変更履歴を確認", exact: true })
      .click();
    await root
      .getByRole("button", { name: "変更 #1 を読む", exact: true })
      .click();
    const history = root.getByRole("region", { name: "共有設定の変更履歴" });
    await expect(history).toContainText(p.evidence);
    await expect(history).toContainText(account);
    await expect(reason).toHaveValue("Unsaved current permission draft");
    expect(state.saves).toBe(0);
    const box = await history.evaluate((e) => ({
      right: e.getBoundingClientRect().right,
      width: innerWidth,
    }));
    expect(box.right).toBeLessThanOrEqual(box.width);
    expect(await history.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
      true,
    );
    await history.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `.local-state/policy-history-qa/${design}-${info.project.name}.png`,
    });
    state.mode = "history-invalid";
    await root
      .getByRole("button", { name: "変更 #1 を読む", exact: true })
      .click();
    await expect(root.getByRole("status")).toContainText(
      "応答を確認できません",
    );
    await expect(reason).toHaveValue("Unsaved current permission draft");
    state.mode = "history-logout";
    await root
      .getByRole("button", { name: "変更 #1 を読む", exact: true })
      .click();
    await expect(history).toBeHidden();
    expect(state.saves).toBe(0);
  });
}
