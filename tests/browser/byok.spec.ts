import { test, expect } from "@playwright/test";
async function open(page: import("@playwright/test").Page) {
  await page.goto("/#read");
  await page
    .getByRole("button", { name: "自分のAPIキー設定", exact: true })
    .click();
  return page.getByRole("dialog", { name: "自分のAPIキー設定（模擬）" });
}
test("BYOK mock lifecycle isolates users/providers, hides keys, keeps storage unchanged and resets on reload", async ({
  page,
  baseURL,
}, info) => {
  const external: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).origin !== new URL(baseURL!).origin)
      external.push(r.url());
  });
  const dialog = await open(page);
  const before = await page.evaluate(() => JSON.stringify(localStorage));
  const card = dialog.getByRole("region", { name: "OpenAI設定" });
  const other = dialog.getByRole("region", { name: "Anthropic設定" });
  await expect(dialog.locator('input[type="password"]')).toHaveCount(2);
  for (const input of await dialog.locator('input[type="password"]').all()) {
    await expect(input).toBeDisabled();
    await expect(input).toHaveValue("");
  }
  await card
    .getByRole("button", { name: "ダミーで模擬登録", exact: true })
    .click();
  await expect(card.getByRole("status")).toHaveText(
    "模擬登録済み · 永続保存なし · 実API未接続",
  );
  await expect(other.getByRole("status")).toHaveText("未登録 · 実API未接続");
  await card.getByRole("button", { name: "模擬接続確認", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText(
    "模擬確認済み · 実API未接続",
  );
  await card
    .getByLabel("モデル候補（実利用可否未確認）")
    .selectOption("gpt-6-luna");
  await expect(card.getByRole("status")).toHaveText(
    "模擬モデル選択済み · 実API利用可否未確認",
  );
  await dialog
    .getByLabel("模擬利用者（認証ではありません）")
    .selectOption("demo-b");
  await expect(card.getByRole("status")).toHaveText("未登録 · 実API未接続");
  await card
    .getByRole("button", { name: "ダミーで模擬登録", exact: true })
    .click();
  await expect(card.getByRole("status")).toContainText("模擬登録済み");
  await dialog
    .getByLabel("模擬利用者（認証ではありません）")
    .selectOption("demo-a");
  await card
    .getByRole("button", { name: "ダミーで模擬差し替え", exact: true })
    .click();
  await expect(card.getByRole("status")).toContainText("模擬登録済み");
  await card
    .getByRole("button", { name: "模擬設定を削除", exact: true })
    .click();
  await expect(card.getByRole("status")).toHaveText("未登録 · 実API未接続");
  await card
    .getByRole("button", { name: "ダミーで模擬登録", exact: true })
    .click();
  await expect(card.getByRole("status")).toContainText("模擬登録済み");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).toBe(before);
  expect(external).toEqual([]);
  await page.screenshot({
    path: info.outputPath("byok-settings.png"),
    fullPage: true,
  });
  await page.reload();
  await page
    .getByRole("button", { name: "自分のAPIキー設定", exact: true })
    .click();
  await expect(card.getByRole("status")).toHaveText("未登録 · 実API未接続");
});
test("BYOK failure, cancellation, rapid clicks, owner switch, delete during pending and back are safe", async ({
  page,
}) => {
  const dialog = await open(page);
  const card = dialog.getByRole("region", { name: "Anthropic設定" });
  const register = card.getByRole("button", {
    name: "ダミーで模擬登録",
    exact: true,
  });
  await dialog.getByLabel("模擬応答").selectOption("fail");
  await register.click();
  await expect(card.getByRole("status")).toContainText("模擬処理に失敗");
  await dialog.getByLabel("模擬応答").selectOption("wait");
  await register.evaluate((b) => {
    (b as HTMLButtonElement).click();
    (b as HTMLButtonElement).click();
  });
  await expect(register).toBeDisabled();
  await card.getByRole("button", { name: "模擬処理を中断" }).click();
  await expect(card.getByRole("status")).toContainText("中断");
  await register.click();
  await card.getByRole("button", { name: "模擬設定を削除" }).click();
  await expect(card.getByRole("status")).toHaveText("未登録 · 実API未接続");
  await register.click();
  await dialog
    .getByLabel("模擬利用者（認証ではありません）")
    .selectOption("demo-b");
  await expect(card.getByRole("status")).toHaveText("未登録 · 実API未接続");
  await dialog
    .getByLabel("模擬利用者（認証ではありません）")
    .selectOption("demo-a");
  await expect(card.getByRole("status")).toContainText("中断");
  await dialog.getByLabel("模擬応答").selectOption("ok");
  await register.click();
  await expect(card.getByRole("status")).toContainText("模擬登録済み");
  await dialog.getByLabel("模擬応答").selectOption("fail");
  await card
    .getByRole("button", { name: "ダミーで模擬差し替え", exact: true })
    .click();
  await expect(card.getByRole("status")).toContainText("元の設定を維持");
  await expect(
    card.getByRole("button", { name: "模擬接続確認" }),
  ).toBeEnabled();
  await dialog.getByLabel("模擬応答").selectOption("wait");
  await card.getByRole("button", { name: "模擬接続確認" }).click();
  const hash = await page.evaluate(() => location.hash);
  await page.keyboard.press("n");
  expect(await page.evaluate(() => location.hash)).toBe(hash);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "自分のAPIキー設定", exact: true })
    .click();
  await expect(card.getByRole("status")).toContainText("中断");
  await dialog.getByRole("button", { name: "教材へ戻る" }).click();
  await page.getByRole("button", { name: "次へ →", exact: true }).click();
  await page
    .getByRole("button", { name: "自分のAPIキー設定", exact: true })
    .click();
  await card.getByRole("button", { name: "模擬接続確認" }).click();
  await page.goBack();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "自分のAPIキー設定", exact: true })
    .click();
  await expect(card.getByRole("status")).toContainText("中断");
});
test("BYOK dialog reflows at 320/390/1440 and keyboard returns to opener", async ({
  page,
}) => {
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const dialog = await open(page);
    expect(
      await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth + 1),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "自分のAPIキー設定", exact: true }),
    ).toBeFocused();
  }
});
