import { test, expect } from "@playwright/test";
import { openReaderTools } from "./reader-tools";

test("reader stays quiet while reading, preserves source and exposes optional tools on demand", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    localStorage.setItem("quilna.article.updates.v1", "false");
    localStorage.setItem("quilna.feed.refresh.v1", "0");
  });
  await page.route("**/api/collection", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  await page.route("**/api/feeds/fetch", (r) => {
    const data = r.request().postDataJSON();
    return r.fulfill({
      json: data.icon
        ? {}
        : {
            url: data.url,
            html: "<title>Source title &lt;img src=x&gt;</title><script>window.injected=true</script>",
          },
    });
  });
  await page.goto("/?view=feeds");
  const original = await page.evaluate(async () => {
    const text =
      "First section\n\n" +
      "Reading the original source. ".repeat(80) +
      "\n\nhttps://example.org/reference\n\nhttps://example.org/another\n\nSecond section\n\n" +
      "Keep the exact evidence. ".repeat(60) +
      "\n\nC:\\Users\\<username>\\.dotnet\n\nLast section\n\nDone.";
    const headings = ["First section", "Second section", "Last section"].map(
      (label) => ({
        start: text.indexOf(label),
        end: text.indexOf(label) + label.length,
        level: 2,
      }),
    );
    const url = "https://example.org/reference",
      codeStart = text.indexOf("C:\\Users");
    const path = "/src/feed-store.ts",
      { openFeedLibrary } = await import(path),
      db = await openFeedLibrary();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite");
      tx.objectStore("articles").put({
        id: "feedback",
        title: "Feedback sample",
        url: "https://example.org/story",
        feedUrl: "",
        body: text,
        read: true,
        saved: true,
        published: null,
        fetchedAt: new Date().toISOString(),
        content: {
          text,
          title: "Feedback sample",
          url: "https://example.org/story",
          fetchedAt: new Date().toISOString(),
          language: "en",
          codeRanges: [
            {
              start: codeStart,
              end: codeStart + "C:\\Users\\<username>\\.dotnet".length,
              block: true,
            },
          ],
          structure: {
            version: 1,
            headings,
            links: [url, "https://example.org/another"].map((href) => ({
              start: text.indexOf(href),
              end: text.indexOf(href) + href.length,
              href,
            })),
          },
        },
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return text;
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Feedback sample", exact: true })
    .click();
  await expect(page.locator(".rss-destinations summary")).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "主な移動先" }),
  ).toBeVisible();
  expect(
    await page
      .locator(".rss-location-bar")
      .evaluate((e) => getComputedStyle(e).position),
  ).toBe("static");
  await expect(page.locator("#rss-reading-extras")).not.toHaveAttribute(
    "open",
    "",
  );
  await expect(page.locator("#rss-highlights summary")).toBeHidden();
  await page.locator(".rss-body-link").first().scrollIntoViewIfNeeded();
  await expect(page.locator(".rss-link-title")).toHaveText([
    "Source title <img src=x>",
    "Source title <img src=x>",
  ]);
  expect(await page.locator(".rss-source-text").textContent()).toBe(
    original.replace(/\n\s*\n/g, ""),
  );
  await expect(page.locator(".rss-body-link img[src=x]")).toHaveCount(0);
  expect(await page.evaluate(() => "injected" in window)).toBe(false);
  const pre = page.locator(".rss-code-block pre");
  await expect(pre).toHaveText("C:\\Users\\<username>\\.dotnet");
  await expect(pre.locator("[class*=hljs]")).toHaveCount(0);
  expect(
    await page
      .locator(".rss-code-tools")
      .evaluate((e) => getComputedStyle(e).position),
  ).toBe("absolute");
  await openReaderTools(page);
  await page.locator("#rss-highlights summary").click();
  await expect(
    page.getByLabel("本文から探す引用（完全一致）", { exact: true }),
  ).toBeVisible();
  await page.locator("#rss-reading-extras > summary").click();
  await page.getByRole("button", { name: "目次・見出しマップ" }).click();
  await page
    .getByRole("navigation", { name: "この記事の目次" })
    .getByRole("link", { name: "Last section", exact: true })
    .click();
  await expect(
    page
      .getByRole("navigation", { name: "この記事の目次" })
      .getByRole("link", { name: "Last section", exact: true }),
  ).toHaveAttribute("aria-current", "location");
  await page.screenshot({ path: info.outputPath("reader-feedback.png") });
});

test("C# and PowerShell color tokens preserve literal source while path listings stay plain", async ({
  page,
}) => {
  await page.goto("/?view=feeds");
  const result = await page.evaluate(async () => {
    const path = "/src/code-syntax.ts";
    const { codeTokens } = await import(path);
    return [
      "#nullable enable\npublic record Person(string Name);",
      "[CmdletBinding()]\nparam([string]$Name)\nWrite-Host $Name",
      "C:\\Users\\<username>\\.dotnet\n\n%UserProfile%\\<username>\\.templateengine\n%TEMP2%\\<username>\\some path",
      "// first comment\n// second comment",
      '/usr/bin/env echo "hello"\n/usr/bin/env echo "world"',
    ].map((text) => {
      const tokens = codeTokens(text);
      return {
        text,
        tokens,
        restored: tokens.map((token: { text: string }) => token.text).join(""),
        colored: tokens.some(
          (token: { classes: string[] }) => token.classes.length > 0,
        ),
      };
    });
  });
  expect(result.map((row) => row.restored)).toEqual(
    result.map((row) => row.text),
  );
  expect(result.map((row) => row.colored)).toEqual([
    true,
    true,
    false,
    true,
    true,
  ]);
  expect(result[0].tokens).toContainEqual({
    text: "record",
    classes: ["hljs-function", "hljs-keyword"],
  });
  expect(result[1].tokens).toContainEqual({
    text: "CmdletBinding",
    classes: ["hljs-function", "hljs-type"],
  });
});

test("bare host links retain distinct accessible URLs and query links are not prefetched", async ({
  page,
}) => {
  const requested: string[] = [];
  await page.route("**/api/feeds/fetch", (route) => {
    const data = route.request().postDataJSON();
    if (!data.icon) requested.push(data.url);
    return route.fulfill({
      json: data.icon
        ? {}
        : { url: data.url, html: "<title>Shared title</title>" },
    });
  });
  await page.goto("/?view=feeds");
  await page.evaluate(async () => {
    const path = "/src/link-preview.ts";
    const { decorateArticleLink } = await import(path);
    const root = document.createElement("div");
    root.id = "link-fixture";
    for (const url of [
      "https://example.org",
      "https://example.org/other",
      "https://example.org/?token=private",
    ]) {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.textContent = url;
      root.append(anchor);
      decorateArticleLink(anchor, anchor.href);
    }
    document.body.replaceChildren(root);
  });
  await expect(page.locator(".rss-link-title")).toHaveCount(2);
  await expect(
    page.getByRole("link", {
      name: "Shared title — https://example.org/",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: "Shared title — https://example.org/other",
      exact: true,
    }),
  ).toBeVisible();
  expect(requested.sort()).toEqual([
    "https://example.org/",
    "https://example.org/other",
  ]);
});
