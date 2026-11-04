import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
const fixtures = JSON.parse(new TextDecoder().decode(await readFile("tests/fixtures/article-extraction.json")));
const fixture = fixtures.find((f: {name: string}) => f.name === "nested lists and data table");

test("lists, nested numbering and table cells retain semantics, links and source offsets", async ({ page }, info) => {
  await page.goto('/?view=feeds');
  const result = await page.evaluate(async (fixture) => {
    const extraction = '/src/article-content.ts', rendering = '/src/article-code.ts', validation = '/src/article-structure.ts';
    const content = (await import(extraction)).extractArticle(fixture.html, fixture.url);
    const root = document.createElement('div');
    root.className = 'rss-source-text rss-article-body';
    root.id = 'layout-fixture';
    root.style.maxWidth = '600px';
    (await import(rendering)).appendArticleText(root, content.text, content.codeRanges, (text: string, start: number) => {
      const span = document.createElement('span');
      span.dataset.sourceStart = String(start);
      span.textContent = text;
      return span;
    }, content.structure);
    document.querySelector('#app')!.replaceChildren(root);
    return { valid: (await import(validation)).validArticleStructure(content.text, content.structure), text: content.text };
  }, fixture);
  expect(result.valid).toBe(true);
  await expect(page.locator('#layout-fixture > ol')).toHaveAttribute('start', '3');
  await expect(page.locator('ol > li').nth(1)).toHaveAttribute('value', '7');
  await expect(page.locator('ol > li > ul > li')).toHaveCount(2);
  await expect(page.getByRole('table')).toHaveCount(1);
  await expect(page.locator('table tr')).toHaveCount(4);
  for (const name of ['No admin access', 'Key authentication only', 'Retained'])
    await expect(page.getByRole('cell', {name})).toBeVisible();
  await expect(page.locator('tbody tr').first().locator('th')).toHaveAttribute('rowspan', '2');
  await expect(page.locator('tbody tr').nth(1).locator('td')).toHaveAttribute('colspan', '2');
  await expect(page.locator('tbody tr').last().locator('td').first()).toBeEmpty();
  await expect(page.locator('table a')).toHaveAttribute('href', 'https://publisher.example.org/policy');
  await expect(page.locator('ol code')).toHaveText(['svc-power', 'echo ready']);
  expect(await page.locator('[data-source-start]').evaluateAll((nodes, text) => nodes.every(node => {
    const start = Number((node as HTMLElement).dataset.sourceStart);
    return text.slice(start, start + (node.textContent?.length || 0)) === node.textContent;
  }), result.text)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('region', {name: '記事の表（横にスクロールできます）'}).focus();
  await expect(page.getByRole('region')).toBeFocused();
  await page.screenshot({path: info.outputPath('article-layout.png'), fullPage: true});
});

test('invalid and deeply nested structural metadata is rejected without executing markup', async ({page}) => {
  await page.goto('/?view=feeds');
  const values = await page.evaluate(async () => {
    const path = '/src/article-structure.ts'; const {validArticleStructure} = await import(path);
    const check = (blocks: unknown) => validArticleStructure('example', {version: 1, links: [], headings: [], blocks});
    const bad = check([{tag: 'script',start:0,end:7,children:[]}]);
    const crossing = check([{tag:'ul',start:0,end:3,children:[{tag:'li',start:0,end:7,children:[]}]}]);
    const a: {tag:string,start:number,end:number,children:unknown[]} = {tag:'ul',start:0,end:7,children:[]};
    const b = {tag:'li',start:0,end:7,children:[a]}; a.children.push(b);
    return [bad,crossing,check([a])];
  });
  expect(values).toEqual([false,false,false]);
});

const filler = "Readable body text keeps this extraction above the article threshold. ".repeat(20);
for (const [name, markup, expected] of [
  ["a list directly inside a list", "<ul><li>Outer</li><ul><li>Inner</li></ul></ul>", ["Outer", "Inner"]],
  ["list items without a list", "<div><li>Stray item</li></div>", ["Stray item"]],
  ["a menu element", "<menu><li>Menu item</li></menu>", ["Menu item"]],
  ["a list inside a caption", "<table><caption><ul><li>Caption item</li></ul></caption><tr><td>Cell</td></tr></table>", ["Caption item", "Cell"]],
] as const)
  test(`imports keep readable text for ${name}`, async ({ page }) => {
    await page.goto("/?view=feeds");
    const content = await page.evaluate(async (html) => {
      const path = "/src/article-content.ts";
      const { extractArticle } = await import(path);
      return extractArticle(html, "https://publisher.example.org/guide");
    }, `<article><h1>Guide</h1><p>${filler}</p>${markup}</article>`);
    for (const text of expected) expect(content.text).toContain(text);
    if (name === "a list directly inside a list")
      expect(content.structure.blocks[0].children.map((b: { tag: string }) => b.tag)).toEqual(["li", "li"]);
  });

test("a table above the structure limit still imports as readable text", async ({ page }) => {
  await page.goto("/?view=feeds");
  const rows = Array.from({ length: 700 }, (_, i) => `<tr>${"<td>c</td>".repeat(8)}<td>row ${i}</td></tr>`).join("");
  const content = await page.evaluate(async (html) => {
    const path = "/src/article-content.ts";
    const { extractArticle } = await import(path);
    return extractArticle(html, "https://publisher.example.org/guide");
  }, `<article><h1>Guide</h1><p>${filler}</p><table>${rows}</table></article>`);
  expect(content.text).toContain("row 699");
  expect(content.structure.blocks).toEqual([]);
});

test("list and cell attributes follow HTML parsing, including reversed and full-group spans", async ({ page }) => {
  await page.goto("/?view=feeds");
  const html = `<article><h1>Guide</h1><p>${filler}</p>
    <ol reversed start="+9" id="signed"><li value=" 4">Padded</li><li>Next</li></ol>
    <table><caption><ul><li>In caption</li></ul></caption><tbody><tr><th rowspan="0">Group</th><td>A</td></tr><tr><td colspan="0">B</td></tr></tbody></table></article>`;
  const blocks = await page.evaluate(async (html) => {
    const extraction = "/src/article-content.ts", rendering = "/src/article-code.ts";
    const content = (await import(extraction)).extractArticle(html, "https://publisher.example.org/guide");
    const root = document.createElement("div");
    root.id = "attribute-fixture";
    (await import(rendering)).appendArticleText(root, content.text, content.codeRanges, (text: string) => document.createTextNode(text), content.structure);
    document.querySelector("#app")!.replaceChildren(root);
    return content.structure.blocks;
  }, html);
  expect(blocks[0]).toMatchObject({ tag: "ol", ordinal: 9, reversed: true });
  await expect(page.locator("#attribute-fixture > ol")).toHaveAttribute("reversed", "");
  await expect(page.locator("#attribute-fixture > ol")).toHaveAttribute("start", "9");
  await expect(page.locator("#attribute-fixture > ol > li").first()).toHaveAttribute("value", "4");
  await expect(page.locator("#attribute-fixture caption > ul > li")).toHaveText("In caption");
  await expect(page.locator("#attribute-fixture th")).toHaveAttribute("rowspan", "0");
  await expect(page.locator("#attribute-fixture td").last()).not.toHaveAttribute("colspan");
});

test("the renderer ignores invalid structural metadata and keeps the text", async ({ page }) => {
  await page.goto("/?view=feeds");
  const rendered = await page.evaluate(async () => {
    const path = "/src/article-code.ts";
    const root = document.createElement("div");
    (await import(path)).appendArticleText(root, "example text", [], (text: string) => document.createTextNode(text), {
      version: 1, links: [], headings: [],
      blocks: [{ tag: "script", start: 0, end: 7, children: [] }, { tag: "ol", start: 8, end: 12, children: [], reversed: "yes" }],
    });
    return { html: root.innerHTML, text: root.textContent };
  });
  expect(rendered.text).toBe("example text");
  expect(rendered.html).not.toContain("<script");
  expect(rendered.html).not.toContain("<ol");
});

test("code ranges across many blocks render once and in place", async ({ page }) => {
  await page.goto("/?view=feeds");
  const result = await page.evaluate(async () => {
    const path = "/src/article-code.ts";
    const root = document.createElement("div");
    const items = Array.from({ length: 40 }, (_, i) => `item ${i} code${i} end`);
    const ranges: { start: number; end: number; block: boolean }[] = [];
    const children: { tag: string; start: number; end: number; children: never[] }[] = [];
    let text = "";
    for (const item of items) {
      const start = text.length;
      text += item;
      const code = start + item.indexOf("code");
      ranges.push({ start: code, end: code + item.split(" ")[2].length, block: false });
      children.push({ tag: "li", start, end: text.length, children: [] });
      text += "\n\n";
    }
    (await import(path)).appendArticleText(root, text, ranges, (value: string) => document.createTextNode(value), {
      version: 1, links: [], headings: [],
      blocks: [{ tag: "ul", start: 0, end: text.length - 2, children }],
    });
    return Array.from(root.querySelectorAll("li code"), (node) => node.textContent);
  });
  expect(result).toEqual(Array.from({ length: 40 }, (_, i) => `code${i}`));
});
