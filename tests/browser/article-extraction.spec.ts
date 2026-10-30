import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const fixtures: { name: string; html: string; codes: string[] }[] = JSON.parse(
  new TextDecoder().decode(
    await readFile("tests/fixtures/article-extraction.json"),
  ),
);
const bundle = await build({
  entryPoints: ["workers/article-loader.mjs"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  logLevel: "silent",
});
const { createArticleLoader } = await import(
  "data:text/javascript," + encodeURIComponent(bundle.outputFiles[0].text)
);

test("server and browser extraction preserve identical text, code ranges and document representations", async ({
  page,
}) => {
  await page.goto("/?view=feeds");
  let externalRequests = 0;
  await page.route("https://**", async (route) => {
    externalRequests++;
    await route.abort();
  });
  for (const fixture of fixtures) {
    const url = "https://publisher.example.org/article";
    const server = await createArticleLoader({
      send: async () =>
        new Response(fixture.html, {
          headers: { "Content-Type": "text/html" },
        }),
    })(url);
    const browser = await page.evaluate(
      async ({ html, url }) => {
        const path = "/src/article-content.ts";
        const value = (await import(path)).extractArticle(html, url);
        return value;
      },
      { html: fixture.html, url },
    );
    expect(
      { ...server.content, fetchedAt: browser.fetchedAt },
      fixture.name,
    ).toEqual(browser);
    expect(
      browser.codeRanges.map((r: { start: number; end: number }) =>
        browser.text.slice(r.start, r.end),
      ),
    ).toEqual(fixture.codes);
  }
  expect(externalRequests).toBe(0);
  expect(
    await page.evaluate(() => Reflect.get(globalThis, "__articleScriptRan")),
  ).toBeUndefined();
});
