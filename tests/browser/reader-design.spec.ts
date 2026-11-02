import { test, expect } from "@playwright/test";

const key = "quilna.reader.design.v1";
const articleTitle = "知識がつながる、新しい読書のかたち";
const xml = `<rss version="2.0"><channel><title>Quilna Journal</title>${[
  articleTitle,
  "街の小さな変化から、デザインを考える",
  "AIとともに学ぶための、三つの問い",
  "遠くのニュースが身近になるとき",
]
  .map(
    (title, index) =>
      `<item><guid>${index}</guid><title>${title}</title><description>日々の発見を記録すると、別々に見えた情報がつながり始めます。気になる言葉を手掛かりに、少し先まで読み進めてみましょう。</description></item>`,
  )
  .join("")}</channel></rss>`;

for (const design of ["studio", "editorial", "focus"])
  test(`${design} keeps the settings close button clear of scrolled controls`, async ({
    page,
  }, info) => {
    await page.addInitScript(
      (value) => localStorage.setItem("quilna.reader.design.v1", value),
      design,
    );
    await page.goto("/?view=feeds");
    await page.getByRole("button", { name: "設定", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const close = dialog.getByRole("button", { name: "閉じる", exact: true });
    for (const viewport of [
      { width: 320, height: 740 },
      { width: 640, height: 360 },
      { width: 1440, height: 1000 },
    ]) {
      await page.setViewportSize(viewport);
      for (const label of [
        "ロケール（翻訳・読み上げ）",
        "新しく取り込む本文の取得先",
      ]) {
        const input = dialog.getByLabel(label, { exact: true });
        await input.evaluate((e) => e.scrollIntoView({ block: "start" }));
        const a = await close.boundingBox(),
          b = await input.boundingBox();
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();
        const overlaps =
          a!.x < b!.x + b!.width &&
          a!.x + a!.width > b!.x &&
          a!.y < b!.y + b!.height &&
          a!.y + a!.height > b!.y;
        await page.screenshot({
          path: info.outputPath(
            `${design}-${viewport.width}-${label.startsWith("ロケール") ? "locale" : "source"}.png`,
          ),
        });
        expect(
          overlaps,
          `Close must not cover ${label} at ${viewport.width}x${viewport.height}`,
        ).toBe(false);
        expect(a!.y).toBeGreaterThanOrEqual(0);
        expect(a!.y + a!.height).toBeLessThanOrEqual(viewport.height);
        await input.focus();
        await expect(input).toBeFocused();
      }
      expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
        true,
      );
    }
    await close.click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "設定", exact: true }),
    ).toBeFocused();
  });

for (const design of ["Studio", "Editorial", "Focus"]) {
  test(`${design} preserves reading and saved state across a design change and reload`, async ({
    page,
  }, info) => {
    await page.route("**/api/feeds/fetch", (route) =>
      route.fulfill({ json: { url: "https://example.org/rss", xml } }),
    );
    await page.goto("/?view=feeds");
    await page.getByLabel("サイト・RSSのURL").fill("https://example.org/rss");
    await page
      .getByRole("button", { name: "フィードを探す", exact: true })
      .click();
    await page
      .getByRole("button", { name: "登録して読む", exact: true })
      .click();
    await page.getByRole("button", { name: articleTitle, exact: true }).click();
    await page
      .getByRole("button", { name: "この記事を保存", exact: true })
      .click();
    await expect(page.locator("#rss-save-article")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const before = await page.locator(".rss-article-body").innerText();
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("radio", { name: design, exact: true }).check();
    await expect(page.locator("html")).toHaveAttribute(
      "data-reader-design",
      design.toLowerCase(),
    );
    await page.screenshot({
      path: info.outputPath(`${design}-settings.png`),
      animations: "disabled",
    });
    await page.getByRole("button", { name: "閉じる", exact: true }).click();
    await expect(page.locator(".rss-article-body")).toHaveText(before, {
      useInnerText: true,
    });
    await expect(page.locator("#rss-save-article")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page
      .getByRole("link", { name: "翻訳・読み上げ", exact: true })
      .click();
    await expect(page.locator("#rss-reading-tools")).toBeFocused();
    await page.getByRole("link", { name: "本文を読む", exact: true }).click();
    await expect(page.locator("#rss-article-body")).toBeFocused();
    await expect(page.locator("#rss-current-title")).toHaveText(articleTitle);
    expect(new URL(page.url()).hash).toBe("");
    await page.locator("#rss-current-title").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`${design}-reading.png`) });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute(
      "data-reader-design",
      design.toLowerCase(),
    );
    await page.getByRole("button", { name: /保存した記事 · 1/ }).click();
    await expect(
      page.getByRole("button", { name: articleTitle, exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: /すべての記事 · 4/ }).click();
    await page.locator(".rss-main").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`${design}-list.png`) });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 320, height: 740 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await expect(
      page.getByRole("radio", { name: design, exact: true }),
    ).toBeChecked();
    expect(
      await page
        .locator(".rss-settings")
        .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
    ).toBe(true);
  });
}

test("invalid preference falls back, keyboard selection works, and failed persistence is explicit", async ({
  page,
}) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, "unknown");
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException("Blocked", "QuotaExceededError");
      return original.call(this, name, value);
    };
  }, key);
  await page.goto("/?view=feeds");
  await expect(page.locator("html")).toHaveAttribute(
    "data-reader-design",
    "studio",
  );
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("radio", { name: "Studio", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("radio", { name: "Editorial", exact: true }),
  ).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute(
    "data-reader-design",
    "editorial",
  );
  await expect(
    page.getByText(
      "デザインを保存できませんでした。今回は適用しますが、次回は設定し直してください。",
    ),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "設定", exact: true }),
  ).toBeFocused();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-reader-design",
    "studio",
  );
});

test("unavailable storage uses a readable default and does not prevent opening settings", async ({
  page,
}) => {
  await page.addInitScript((key) => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function (name) {
      if (name === key) throw new DOMException("Blocked", "SecurityError");
      return original.call(this, name);
    };
  }, key);
  await page.goto("/?view=feeds");
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(
    page.getByText(
      "デザイン設定を読み込めませんでした。Studioで表示しています。",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Studio", exact: true }),
  ).toBeChecked();
});
