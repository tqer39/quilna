import { test, expect } from "@playwright/test";

import { readFile } from "node:fs/promises";
import { articleImageData } from "../../src/favicon-data.mjs";

for (const [sourceFormat, format] of [
  ["png", "webp"],
  ["avif", "webp"],
  ["png", "jpeg"],
]) {
  test(`${sourceFormat} の図版を ${format} に縮小して保存し、再読み込み後も表示する`, async ({
    page,
  }) => {
    if (format === "jpeg") {
      await page.addInitScript(() => {
        const encode = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function (type, quality) {
          return encode.call(
            this,
            type === "image/webp" ? "image/png" : type,
            quality,
          );
        };
      });
    }
    const prefix = new RegExp(`^data:image/${format};base64,`);
    await page.goto("/?view=feeds");
    const image =
      sourceFormat === "avif"
        ? articleImageData(await readFile("tests/fixtures/article-figure.avif"))
        : await page.evaluate(() => {
            const canvas = document.createElement("canvas");
            canvas.width = 1800;
            canvas.height = 900;
            canvas.getContext("2d")!.fillRect(0, 0, 1800, 900);
            return canvas.toDataURL("image/png");
          });
    const text = "元の記事の説明文です。".repeat(30);
    const url = "https://example.org/illustrated";
    const figurePath = `/figure.${sourceFormat}`;
    const figure =
      sourceFormat === "avif"
        ? `<picture><source type="image/avif" srcset="${figurePath} 1800w"><img src="data:," alt="構成図"></picture>`
        : `<img src="${figurePath}" alt="構成図">`;
    let requests = 0;
    await page.route("**/api/feeds/fetch", (route) => {
      const body = route.request().postDataJSON();
      if (body.image && body.url === new URL(figurePath, url).href) {
        requests++;
        return route.fulfill({ json: { image } });
      }
      return route.fulfill({
        json: {
          url,
          html: `<article><h1>図版のある記事</h1><p>${text}</p><figure>${figure}</figure><p>図の説明。${text}</p></article>`,
        },
      });
    });
    await page.goto("/?view=feeds&screen=import");
    const dialog = page.getByRole("dialog", {
      name: "サイト・記事の取り込み",
      exact: true,
    });
    await dialog.getByLabel("サイト・RSSのURL").fill(url);
    await dialog
      .getByRole("button", { name: "記事として取り込む", exact: true })
      .click();
    const img = page.locator(".rss-source-text img[alt='構成図']");
    await expect(img).toHaveAttribute("src", prefix);
    await expect(img).toHaveAttribute("width", "1440");
    await expect(img.locator("xpath=following-sibling::p[1]")).toContainText(
      "図の説明",
    );
    await page.reload();
    await expect(img).toBeVisible();
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(
      1440,
    );
    await page.route("https://example.org/**", (route) => route.abort());
    await page.goto("/?view=feeds&filter=saved");
    const row = page
      .locator(".rss-article-list > li")
      .filter({ hasText: "図版のある記事" });
    const thumbnail = row.locator(".rss-story-thumbnail img");
    await expect(thumbnail).toHaveAttribute("src", prefix);
    await expect
      .poll(() =>
        thumbnail.evaluate((node: HTMLImageElement) => node.naturalWidth),
      )
      .toBe(1440);
    expect(requests).toBe(1);
  });
}
