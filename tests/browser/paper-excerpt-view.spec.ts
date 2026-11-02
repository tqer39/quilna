import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import fixture from "../fixtures/crossref-work.json" with { type: "json" };
import { crossrefMetadata, paperSnapshot } from "../../src/paper-format";
const xml = new TextDecoder().decode(
  await readFile("tests/fixtures/europepmc-work.xml"),
);
/** Only synthetic provider responses may leave the loopback application origin. */
async function providers(page: Page, body = xml) {
  const requests: string[] = [];
  await page.route("https://**/*", async (route) => {
    const request = route.request();
    requests.push(request.url());
    for (const name of ["cookie", "authorization", "referer"])
      expect(request.headers()[name]).toBeUndefined();
    if (request.url().startsWith("https://api.crossref.org/works/"))
      return route.fulfill({ json: fixture });
    if (
      request.url() ===
      "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1234567/fullTextXML"
    )
      return route.fulfill({ contentType: "application/xml", body });
    throw Error(`Unexpected external request: ${request.url()}`);
  });
  return requests;
}
/** The bibliography and body each require their own explicit disclosed submission. */
async function selected(page: Page) {
  await page.goto("/?view=papers");
  await page
    .getByLabel("DOIまたは https://doi.org/ のURL")
    .fill(fixture.message.DOI);
  await page.getByRole("button", { name: "DOIをCrossrefへ送って確認" }).click();
  await expect(page.getByLabel("Europe PMCのPMCID")).toBeVisible();
  await page.getByLabel("Europe PMCのPMCID").fill("PMC1234567");
  await page
    .getByRole("button", { name: "PMCIDをEurope PMCへ送って本文を確認" })
    .click();
}
/** Read validated records, independently of the visible save notice. */
async function records(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/paper-excerpt-store.ts";
    const api: typeof import("../../src/paper-excerpt-store") = await import(
      path
    );
    return (await api.listPaperExcerpts()).records;
  });
}
for (const outcome of ["success", "failure", "disposed"] as const)
  test(`late body ${outcome} cannot replace a retained quote after selection changes`, async ({
    page,
  }) => {
    await providers(page);
    await page.goto("/?view=papers");
    const paper = await paperSnapshot(
      crossrefMetadata(fixture, fixture.message.DOI),
      "2026-11-03T00:00:00.000Z",
    );
    await page.evaluate(
      async ({ paper, xml }) => {
        const parserPath = "/src/paper-jats.ts",
          viewPath = "/src/paper-excerpt-view.ts",
          formatPath = "/src/paper-text-format.ts";
        const parser: typeof import("../../src/paper-jats") = await import(
          parserPath
        );
        const view: typeof import("../../src/paper-excerpt-view") =
          await import(viewPath);
        const format: typeof import("../../src/paper-text-format") =
          await import(formatPath);
        const source = await parser.parsePaperJATS(
          xml,
          "PMC1234567",
          paper,
          "2026-11-03T00:00:01.000Z",
        );
        const record = await format.paperExcerpt(
          source,
          source.facts.blocks[0].path,
          0,
          8,
        );
        const state = window as unknown as {
          bodyCompletion: (error: boolean) => void;
          disposeBody: () => void;
          bodyStarted: boolean;
          bodySettled: boolean;
        };
        const component = view.paperExcerptView(
          paper,
          async () => {},
          { record },
          {
            lookup: () =>
              new Promise((resolve, reject) => {
                state.bodyStarted = true;
                state.bodyCompletion = (error) => {
                  if (error) reject(Error("STALE_BODY_FAILURE"));
                  else resolve(source);
                };
              }).finally(() => {
                state.bodySettled = true;
              }) as Promise<typeof source>,
          },
        );
        state.disposeBody = component.dispose;
        document.querySelector("#app")!.replaceChildren(component.root);
      },
      { paper, xml },
    );
    await page
      .getByRole("button", { name: "PMCIDをEurope PMCへ送って本文を確認" })
      .click();
    expect(
      await page.evaluate(
        () => (window as unknown as { bodyStarted: boolean }).bodyStarted,
      ),
    ).toBe(true);
    await page.getByLabel("Europe PMCのPMCID").fill("PMC7654321");
    await page.getByLabel("Europe PMCのPMCID").fill("PMC1234567");
    await page.evaluate((outcome) => {
      const state = window as unknown as {
        disposeBody: () => void;
        bodyCompletion: (error: boolean) => void;
      };
      if (outcome === "disposed") state.disposeBody();
      state.bodyCompletion(outcome === "failure");
    }, outcome);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { bodySettled: boolean }).bodySettled,
        ),
      )
      .toBe(true);
    await expect(
      page
        .getByRole("region", { name: "論文引用のプレビュー", exact: true })
        .locator("blockquote"),
    ).toHaveText("Evidence");
    await expect(page.locator("body")).not.toContainText("STALE_BODY_FAILURE");
    await expect(
      page.getByRole("region", { name: "取得した論文本文" }),
    ).toContainText("ファイルまたは保存領域内の記録");
  });
test("explicit body selection, save, reload and independent-profile file round trip preserve exact provenance", async ({
  page,
  browser,
}, info) => {
  if (info.project.name === "mobile")
    await page.setViewportSize({ width: 320, height: 844 });
  const requests = await providers(page);
  await selected(page);
  const body = page.getByRole("region", { name: "取得した論文本文" });
  await expect(body).toContainText("Copyright Synthetic Author");
  await expect(body).toContainText("不明（書誌の版番号からは推測しません）");
  await expect(body.locator("script,img,iframe")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => (window as unknown as Record<string, unknown>).PAPER_XML_XSS,
    ),
  ).toBeUndefined();
  expect(await records(page)).toEqual([]);
  await page
    .getByLabel("引用する段落の本文", { exact: true })
    .press("ControlOrMeta+a");
  await page
    .getByRole("button", { name: "選択した範囲を引用として確認" })
    .click();
  const quote = page.getByRole("region", {
    name: "論文引用のプレビュー",
    exact: true,
  });
  await expect(quote.locator("blockquote")).toHaveText(
    "Evidence😀 & exact quote.",
  );
  // Editing a pending target must not make an explicitly retained quote unsavable.
  await page.getByLabel("Europe PMCのPMCID").fill("PMC7654321");
  await page
    .getByRole("button", { name: "この論文引用を保存", exact: true })
    .click();
  await expect(quote).toContainText("論文引用を保存しました");
  const [original] = await records(page);
  expect(original.text).toBe("Evidence😀 & exact quote.");
  expect(original.start).toBe(0);
  expect(original.end).toBe(original.text.length);
  expect(original.source.paper.metadata.version).toBe("2");
  await page.reload();
  await page
    .getByRole("button", { name: "論文引用を開く", exact: true })
    .click();
  await expect(quote).toContainText("この引用は保存済みです");
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "この論文引用をファイルに保存" })
    .click();
  const download = await downloading,
    file = info.outputPath("excerpt.json");
  await download.saveAs(file);
  expect(JSON.parse(new TextDecoder().decode(await readFile(file)))).toEqual(
    original,
  );
  const recaptured = structuredClone(original);
  recaptured.createdAt =
    recaptured.source.capturedAt =
    recaptured.source.paper.capturedAt =
      "2027-01-01T00:00:00.000Z";
  const recaptureFile = info.outputPath("recapture.json");
  await writeFile(recaptureFile, JSON.stringify(recaptured));
  await page
    .getByLabel("保存した論文引用ファイルを確認", { exact: true })
    .setInputFiles(recaptureFile);
  await page
    .getByRole("button", { name: "この論文引用を保存", exact: true })
    .click();
  await expect(quote).toContainText(
    "最初の本文・書誌・引用の取得記録を保持しました",
  );
  expect(await records(page)).toEqual([original]);
  await quote.getByText("出典と引用位置の詳細", { exact: true }).click();
  const originalDate = await page.evaluate(
    (date) => new Date(date).toLocaleString("ja-JP"),
    original.createdAt,
  );
  await expect(
    quote.locator("dt").filter({ hasText: "引用を選んだ日時" }).locator("+ dd"),
  ).toHaveText(originalDate);
  expect(requests).toEqual([
    "https://api.crossref.org/works/10.5555%2Fquilna.synthetic",
    "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1234567/fullTextXML",
  ]);
  const other = await browser.newContext();
  try {
    const reader = await other.newPage(),
      external = await providers(reader);
    await reader.goto("http://127.0.0.1:5197/?view=papers");
    await reader
      .getByLabel("保存した論文引用ファイルを確認", { exact: true })
      .setInputFiles(file);
    await expect(
      reader.getByRole("region", { name: "論文引用のプレビュー", exact: true }),
    ).toContainText(original.text);
    expect(await records(reader)).toEqual([]);
    await reader
      .getByRole("button", { name: "この論文引用を保存", exact: true })
      .click();
    await expect(
      reader.getByRole("button", { name: "引用を保存済み", exact: true }),
    ).toBeVisible();
    expect(await records(reader)).toEqual([original]);
    expect(external).toEqual([]);
  } finally {
    await other.close();
  }
});
for (const [name, rejected] of [
  [
    "incompatible DOI",
    xml.replace("10.5555/quilna.synthetic", "10.5555/another"),
  ],
  [
    "noncommercial license",
    xml.replaceAll("/licenses/by/4.0/", "/licenses/by-nc/4.0/"),
  ],
])
  test(`body with ${name} cannot become a citation`, async ({ page }) => {
    await providers(page, rejected);
    await selected(page);
    await expect(
      page.getByRole("button", { name: "PMCIDをEurope PMCへ送って本文を確認" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("region", { name: "取得した論文本文" }),
    ).toBeEmpty();
    await expect(
      page.getByRole("button", { name: "この論文引用を保存", exact: true }),
    ).toHaveCount(0);
    expect(await records(page)).toEqual([]);
  });
test("invalid import preserves the stored citation and allows reopening", async ({
  page,
}, info) => {
  await providers(page);
  await selected(page);
  await page
    .getByRole("button", { name: "この段落全体を引用として確認" })
    .click();
  await page
    .getByRole("button", { name: "この論文引用を保存", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "引用を保存済み", exact: true }),
  ).toBeVisible();
  const before = await records(page);
  for (const buffer of [
    new Uint8Array([0xff]),
    new TextEncoder().encode('{"schema":1,"schema":1}'),
  ]) {
    const invalidFile = info.outputPath("invalid.json");
    await writeFile(invalidFile, buffer);
    await page
      .getByLabel("保存した論文引用ファイルを確認", { exact: true })
      .setInputFiles(invalidFile);
    await expect(page.getByRole("status")).toContainText("確認できません");
    expect(await records(page)).toEqual(before);
    await page
      .getByRole("button", { name: "論文引用を開く", exact: true })
      .click();
    await expect(
      page
        .getByRole("region", { name: "論文引用のプレビュー", exact: true })
        .locator("blockquote"),
    ).toHaveText(before[0].text);
  }
});
