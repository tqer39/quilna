import { test, expect, type Page } from "@playwright/test";

const samples = [
  '// 日本語😀\nfunction sample() {\n\treturn "<img onerror=alert(1)>";\n}\n',
  'def greet():\n    return "hello"\n\n',
];
async function fixture(page: Page) {
  await page.goto("/?view=feeds");
  await expect(page.getByLabel("サイト・RSSのURL")).toBeVisible();
  return page.evaluate(async (samples) => {
    const path = "/src/article-code.ts";
    const { appendArticleText } = await import(path);
    const parent = document.createElement("div");
    parent.id = "copy-fixture";
    parent.className = "rss-article-body";
    const text = samples.join("between") + "inline";
    const start = samples[0].length + "between".length;
    appendArticleText(parent, text, [
      { start: 0, end: samples[0].length, block: true },
      { start, end: start + samples[1].length, block: true },
      { start: text.length - 6, end: text.length, block: false },
    ]);
    document.querySelector("#app")!.replaceChildren(parent);
    const paste = document.createElement("textarea");
    paste.setAttribute("aria-label", "貼り付け確認");
    document.body.append(paste);
    return text;
  }, samples);
}

for (const design of ["studio", "editorial", "focus"]) {
  test(`${design} copies each code block exactly and preserves source selection`, async ({
    page,
    context,
  }, info) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.addInitScript((design) => {
      localStorage.setItem("quilna.reader.design.v1", design);
    }, design);
    const text = await fixture(page);
    const buttons = page.getByRole("button", { name: "コードをコピー" });
    await expect(buttons).toHaveCount(2);
    for (let index = 0; index < samples.length; index++) {
      await buttons.nth(index).focus();
      await page.keyboard.press("Enter");
      await expect(
        page.locator(".rss-code-tools").getByRole("status").nth(index),
      ).toHaveText("コピーしました");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        samples[index],
      );
    }
    await page.getByRole("textbox", { name: "貼り付け確認" }).focus();
    await page.keyboard.press("ControlOrMeta+V");
    await expect(
      page.getByRole("textbox", { name: "貼り付け確認" }),
    ).toHaveValue(samples[1]);
    expect(await page.locator("#copy-fixture").textContent()).toBe(text);
    expect(
      await page.evaluate(() => {
        const root = document.querySelector("#copy-fixture")!;
        const range = document.createRange();
        range.selectNodeContents(root);
        const selection = getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        return range.toString();
      }),
    ).toBe(text);
    const box = await buttons.first().boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("code-copy.png"),
      fullPage: true,
    });
  });
}

test("copy waits for completion, isolates blocks, reports denial and permits retry", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const pending: { text: string; resolve: () => void; reject: () => void }[] =
      [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) =>
          new Promise<void>((resolve, reject) => {
            pending.push({
              text,
              resolve,
              reject: () => reject(new Error("denied")),
            });
          }),
      },
    });
    Object.assign(window, { pending });
  });
  const buttons = page.getByRole("button", { name: "コードをコピー" });
  await buttons.first().click();
  await expect(buttons.first()).toBeDisabled();
  await expect(
    page.locator(".rss-code-tools").getByRole("status").first(),
  ).toHaveText("コピー中…");
  await expect(
    page.locator(".rss-code-tools").getByRole("status").nth(1),
  ).toBeEmpty();
  await buttons.nth(1).click();
  await page.evaluate(() => {
    const pending = (
      window as unknown as {
        pending: { resolve: () => void; reject: () => void }[];
      }
    ).pending;
    pending[0].reject();
    pending[1].resolve();
  });
  await expect(
    page.locator(".rss-code-tools").getByRole("status").first(),
  ).toContainText("コードを選択してコピーしてください");
  await expect(
    page.locator(".rss-code-tools").getByRole("status").nth(1),
  ).toHaveText("コピーしました");
  await buttons.first().click();
  const written = await page.evaluate(() => {
    const pending = (
      window as unknown as { pending: { text: string; resolve: () => void }[] }
    ).pending;
    pending[2].resolve();
    return pending.map((p) => p.text);
  });
  expect(written).toEqual([samples[0], samples[1], samples[0]]);
  await expect(
    page.locator(".rss-code-tools").getByRole("status").first(),
  ).toHaveText("コピーしました");
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    }),
  );
  await buttons.first().click();
  await expect(
    page.locator(".rss-code-tools").getByRole("status").first(),
  ).toContainText("コピーできませんでした");
  await expect(buttons.first()).toBeEnabled();
});

test("pending copy feedback survives quote repaint and cannot affect changed source", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const pending: (() => void)[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => new Promise<void>((resolve) => pending.push(resolve)),
      },
    });
    Object.assign(window, { pending });
  });
  const button = page.getByRole("button", { name: "コードをコピー" }).first();
  await button.click();
  const repaint = async (text: string) =>
    page.evaluate(async (text) => {
      const path = "/src/article-code.ts";
      const { appendArticleText } = await import(path);
      const parent = document.querySelector("#copy-fixture")!;
      parent.replaceChildren();
      appendArticleText(parent, text, [
        { start: 0, end: text.length, block: true },
      ]);
    }, text);
  await repaint(samples[0]);
  await expect(button).toBeDisabled();
  await page.evaluate(() =>
    (window as unknown as { pending: (() => void)[] }).pending[0](),
  );
  await expect(page.locator(".rss-code-tools").getByRole("status")).toHaveText(
    "コピーしました",
  );
  await button.click();
  await repaint("changed code");
  await page.evaluate(() =>
    (window as unknown as { pending: (() => void)[] }).pending[1](),
  );
  await expect(page.locator(".rss-code-tools").getByRole("status")).toBeEmpty();
  await expect(button).toBeEnabled();
});
