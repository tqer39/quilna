import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import fixture from "../fixtures/crossref-work.json" with { type: "json" };
import { crossrefMetadata, paperSnapshot } from "../../src/paper-format";

const citation = JSON.parse(new TextDecoder().decode(await readFile("tests/fixtures/paper-excerpt-v1.json")));

test("saved bibliography and citation URLs restore exact local records without provider traffic", async ({ page, browser }) => {
  const requests: string[] = [];
  await page.route("https://**/*", (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await page.goto("/?view=papers");
  const paper = await paperSnapshot({ ...crossrefMetadata(fixture, fixture.message.DOI), titles: ["URLで復元する保存書誌"] });
  await page.evaluate(async ({ paper, citation }) => {
    const papers = "/src/paper-store.ts", excerpts = "/src/paper-excerpt-store.ts";
    await (await import(papers)).savePaper(paper);
    await (await import(excerpts)).savePaperExcerpt(citation);
  }, { paper, citation });
  await page.reload();
  await page.getByRole("button", { name: "書誌情報を開く", exact: true }).click();
  const paperURL = page.url();
  expect(new URL(paperURL).searchParams.get("paper")).toBeTruthy();
  await page.getByRole("button", { name: "論文引用を開く", exact: true }).click();
  const citationURL = page.url();
  expect(new URL(citationURL).searchParams.get("excerpt")).toBe(citation.digest);
  const quote = page.getByRole("region", { name: "論文引用のプレビュー", exact: true });
  await expect(quote.locator("blockquote")).toHaveText(citation.text);
  await page.getByRole("button", { name: "この書誌情報を保存", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存済み", exact: true })).toBeVisible();
  await expect(page).toHaveURL(citationURL);
  await page.goBack();
  await expect(page.getByRole("heading", { name: paper.metadata.titles[0], exact: true })).toBeVisible();
  await page.goForward();
  await expect(quote.locator("blockquote")).toHaveText(citation.text);
  await page.reload();
  await expect(quote.locator("blockquote")).toHaveText(citation.text);
  await page.getByRole("button", { name: "保存一覧へ戻る", exact: true }).click();
  expect(new URL(page.url()).searchParams.has("excerpt")).toBe(false);
  await expect(page.getByRole("region", { name: "書誌情報のプレビュー", exact: true })).toBeEmpty();
  await page.goto(paperURL);
  await expect(page.getByRole("button", { name: "この書誌情報を保存", exact: true })).toBeDisabled();
  expect(requests).toEqual([]);
  const context = await browser.newContext();
  try {
    const other = await context.newPage();
    await other.goto(citationURL);
    await expect(other.getByRole("status")).toContainText("現在のライブラリにありません");
  } finally { await context.close(); }
});

test("bibliography page cursors survive reload and Back and refuse corrupted URL records without deletion", async ({ page }) => {
  await page.goto("/?view=papers");
  const metadata = crossrefMetadata(fixture, fixture.message.DOI);
  const rows = await Promise.all(Array.from({ length: 25 }, (_, i) => paperSnapshot({ ...metadata, titles: [`URL page ${i}`] })));
  await page.evaluate(async (rows) => {
    const path = "/src/paper-store.ts", api = await import(path);
    for (const row of rows) await api.savePaper(row);
  }, rows);
  await page.reload();
  const library = page.getByRole("region", { name: "保存した書誌情報", exact: true });
  await expect(library.locator(".paper-row")).toHaveCount(20);
  await library.getByRole("button", { name: "次の20件", exact: true }).click();
  await expect(library.locator(".paper-row")).toHaveCount(5);
  const secondPage = page.url();
  expect(new URL(secondPage).searchParams.get("paperAfter")).toBeTruthy();
  const visible = await library.locator(".paper-row p").allTextContents();
  await page.reload();
  await expect(library.locator(".paper-row p")).toHaveText(visible);
  await page.goBack();
  await expect(library.locator(".paper-row")).toHaveCount(20);
  await page.goForward();
  await expect(library.locator(".paper-row p")).toHaveText(visible);
  await library.getByRole("button", { name: "書誌情報を開く", exact: true }).first().click();
  const target = page.url(), key = new URL(target).searchParams.get("paper")!;
  await page.evaluate(async (key) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("quilna.papers.v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("snapshots", "readwrite");
      tx.objectStore("snapshots").put("damaged but retained", key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, key);
  await page.reload();
  await expect(page.getByRole("region", { name: "書誌情報のプレビュー", exact: true })).toBeEmpty();
  await expect(page.getByRole("status")).not.toBeEmpty();
  const retained = await page.evaluate(async (key) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("quilna.papers.v1"); request.onsuccess = () => resolve(request.result);
    });
    const value = await new Promise((resolve) => {
      const request = db.transaction("snapshots").objectStore("snapshots").get(key);
      request.onsuccess = () => resolve(request.result);
    });
    db.close(); return value;
  }, key);
  expect(retained).toBe("damaged but retained");
});

for (const paginate of [false, true])
test(`a pending URL detail survives paging=${paginate} and cannot reopen after returning to the list`, async ({ page }) => {
  await page.goto("/?view=papers");
  const metadata = crossrefMetadata(fixture, fixture.message.DOI);
  const papers = await Promise.all(Array.from({ length: 25 }, (_, i) => paperSnapshot({ ...metadata, titles: [`Pending source ${i}`] })));
  await page.evaluate(async (papers) => {
    const path = "/src/paper-store.ts", api = await import(path);
    for (const paper of papers) await api.savePaper(paper);
  }, papers);
  await page.reload();
  await page.getByRole("button", { name: "書誌情報を開く", exact: true }).first().click();
  const key = new URL(page.url()).searchParams.get("paper")!;
  const selectedTitle = await page.getByRole("region", { name: "書誌情報のプレビュー", exact: true }).getByRole("heading").first().textContent();
  await page.getByRole("button", { name: "保存一覧へ戻る", exact: true }).click();
  await page.evaluate((key) => {
    const original = IDBObjectStore.prototype.get;
    const gate = { held: false, release: () => {} };
    Object.assign(window, { paperRouteGate: gate });
    IDBObjectStore.prototype.get = function (...args) {
      const request = original.apply(this, args);
      if (this.name === "snapshots" && args[0] === key) {
        IDBObjectStore.prototype.get = original;
        const tx = this.transaction;
        let complete: typeof tx.oncomplete = null;
        Object.defineProperty(tx, "oncomplete", {
          get: () => complete,
          set: (value) => { complete = value; },
        });
        tx.addEventListener("complete", (event) => {
          gate.held = true;
          gate.release = () => { complete?.call(tx, event); };
        });
      }
      return request;
    };
  }, key);
  await page.goBack();
  await expect.poll(() => page.evaluate(() => (window as unknown as { paperRouteGate: { held: boolean } }).paperRouteGate.held)).toBe(true);
  if (paginate) {
    await page.getByRole("button", { name: "次の20件", exact: true }).click();
    await expect(page.getByRole("region", { name: "書誌情報のプレビュー", exact: true }).getByRole("heading").first()).toHaveText(selectedTitle!);
    expect(new URL(page.url()).searchParams.get("paper")).toBe(key);
    expect(new URL(page.url()).searchParams.get("paperAfter")).toBeTruthy();
    await page.getByRole("button", { name: "保存一覧へ戻る", exact: true }).click();
  } else await page.goForward();
  await page.evaluate(async () => {
    (window as unknown as { paperRouteGate: { release: () => void } }).paperRouteGate.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  expect(new URL(page.url()).searchParams.has("paper")).toBe(false);
  await expect(page.getByRole("region", { name: "書誌情報のプレビュー", exact: true })).toBeEmpty();
  await expect(page.getByRole("button", { name: "書誌情報を開く", exact: true }).first()).toBeVisible();
});

test("returning from the back/forward cache restores the saved detail named by the URL", async ({ page }) => {
  await page.goto("/?view=papers");
  const paper = await paperSnapshot({ ...crossrefMetadata(fixture, fixture.message.DOI), titles: ["戻るキャッシュから復元する書誌"] });
  await page.evaluate(async (paper) => {
    const path = "/src/paper-store.ts";
    await (await import(path)).savePaper(paper);
  }, paper);
  await page.reload();
  await page.getByRole("button", { name: "書誌情報を開く", exact: true }).click();
  const heading = page.getByRole("heading", { name: paper.metadata.titles[0], exact: true });
  await expect(heading).toBeVisible();
  // Playwright disables the real cache, so replay the events a cached page receives.
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    document.documentElement.style.removeProperty("display");
  });
  await expect(page.getByRole("region", { name: "書誌情報のプレビュー", exact: true })).toBeEmpty();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(heading).toBeVisible();
});
