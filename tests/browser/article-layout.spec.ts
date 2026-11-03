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
