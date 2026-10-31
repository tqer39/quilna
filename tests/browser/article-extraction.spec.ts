import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const fixtures: {
  name: string;
  html: string;
  codes: string[];
  url?: string;
}[] = JSON.parse(
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
  fixtures.push({
    name: "publisher metadata",
    codes: [],
    html: `<html><head><title>Publisher labels</title><meta property="article:tag" content="AI"><meta name="keywords" content="Research, AI"></head><body><nav><a rel="tag">Ignored navigation</a></nav><article><h1>Publisher labels</h1><a rel="tag">Science</a><p>${"Research evidence is preserved for careful reading. ".repeat(30)}</p></article></body></html>`,
  });
  const zennHTML = `<html><head><title>Zenn topics</title></head><body><article><h1>Zenn topics</h1><p>${"Original article evidence remains readable with site-specific topics. ".repeat(20)}</p></article><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"topics":[{"name":"WebAssembly"},{"name":"Linux"},{"name":42},null]}}}</script></body></html>`;
  fixtures.push({
    name: "Zenn topics",
    codes: [],
    url: "https://zenn.dev/example/articles/topics",
    html: zennHTML,
  });
  fixtures.push({ name: "other site page data", codes: [], html: zennHTML });
  fixtures.push({
    name: "malformed Zenn data",
    codes: [],
    url: "https://zenn.dev/example/articles/topics",
    html: zennHTML.replace('{"props":', "{invalid"),
  });
  let externalRequests = 0;
  await page.route("https://**", async (route) => {
    externalRequests++;
    await route.abort();
  });
  for (const fixture of fixtures) {
    const url = fixture.url ?? "https://publisher.example.org/article";
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
    if (fixture.name === "publisher metadata")
      expect(browser.sourceTags).toEqual(["AI", "Research", "Science"]);
    if (fixture.name === "Zenn topics")
      expect(browser.sourceTags).toEqual(["WebAssembly", "Linux"]);
    if (["other site page data", "malformed Zenn data"].includes(fixture.name))
      expect(browser.sourceTags).toBeUndefined();
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
