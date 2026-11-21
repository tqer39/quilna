import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { parseSharedTextbook } from "../../src/shared-textbook-format";

test("手元のLLMの応答から出典照合と検証を経て読める教材を作る", async ({
  page,
  context,
}) => {
  const fixture = await parseSharedTextbook(
    new TextDecoder().decode(
      await readFile("tests/fixtures/shared-textbook-v2.json"),
    ),
  );
  await page.goto("/?view=textbooks");
  await page.getByText("自分のLLMで教科書を作る", { exact: true }).click();
  await context.setOffline(true);
  const source = fixture.request.sources[0];
  await page.getByLabel("テーマ", { exact: true }).fill("モデルの役割");
  await page
    .getByLabel("学習目標", { exact: true })
    .fill(fixture.request.learningGoal);
  await page.getByLabel("出典名", { exact: true }).fill(source.title);
  await page.getByLabel("資料の抜粋").fill(source.excerpt);
  await page.getByRole("button", { name: "生成の依頼文を用意する" }).click();
  const request = JSON.parse(
    (await page.getByLabel("生成の依頼文", { exact: true }).inputValue()).split(
      "\n",
    )[2],
  );
  await page.getByLabel("生成に使ったモデル名").fill("ローカル生成");
  const draft = JSON.stringify(fixture.draft).replaceAll(
    new RegExp(source.id, "ig"),
    request.sources[0].id,
  );
  await page
    .getByLabel("生成されたJSON")
    .fill(draft.replace(request.sources[0].id, source.id));
  await page.getByRole("button", { name: "検証の依頼文を用意する" }).click();
  await expect(page.getByText(/引用は抜粋との完全一致/)).toBeVisible();
  const circular = JSON.parse(draft);
  circular.lessons[0].prerequisiteSectionIDs = [circular.lessons[0].content.id];
  await page.getByLabel("生成されたJSON").fill(JSON.stringify(circular));
  await page.getByRole("button", { name: "検証の依頼文を用意する" }).click();
  await expect(page.locator(".local-textbook [role=status]")).toContainText(
    "1節目の prerequisiteSectionIDs を修正してください。最初の節は空配列 []",
  );
  await expect(page.getByLabel("検証の依頼文", { exact: true })).toBeHidden();
  await page.getByLabel("生成されたJSON").fill(draft);
  await page.getByRole("button", { name: "検証の依頼文を用意する" }).click();
  const hashes = JSON.parse(
    (await page.getByLabel("検証の依頼文", { exact: true }).inputValue()).split(
      "\n",
    )[1],
  );
  expect(
    (await page.getByLabel("検証の依頼文", { exact: true }).inputValue()).split(
      "\n",
    )[3],
  ).toBe(
    JSON.stringify(fixture.draft.lessons.map((lesson) => lesson.content.id)),
  );
  const review = { ...fixture.review, ...hashes };
  await page.getByLabel("検証に使ったモデル名").fill("ローカル検証");
  const failed = structuredClone(review);
  failed.sections[0].checks[0].passed = false;
  await page.getByLabel("検証結果のJSON").fill(JSON.stringify(failed));
  await page.getByRole("button", { name: "教材ファイルを用意する" }).click();
  await expect(page.getByText(/検証で不合格/)).toBeVisible();
  await expect(page.locator(".local-textbook li")).toHaveText(
    fixture.draft.lessons[0].content.title +
      " — " +
      failed.sections[0].checks[0].reason,
  );
  await page.getByLabel("検証結果のJSON").fill(JSON.stringify(review));
  await page.getByRole("button", { name: "教材ファイルを用意する" }).click();
  await page.getByText("具体例を出典と見比べる", { exact: true }).click();
  const example = page.locator(".local-textbook details section").first();
  const lesson = fixture.draft.lessons[0];
  await expect(example).toContainText(lesson.workedExample);
  await expect(example.locator("blockquote").first()).toHaveText(
    lesson.exampleEvidence[0].quote,
  );
  await expect(example.locator("figcaption").first()).toHaveText(source.title);
  await expect(example).toContainText(
    fixture.review.sections
      .find((section) => section.sectionID === lesson.content.id)!
      .checks.find((check) => check.criterion === "workedExample")!.reason,
  );
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "教材JSONをダウンロード" }).click();
  const path = test.info().outputPath("教材.json");
  await (await pending).saveAs(path);
  expect(
    (await parseSharedTextbook(new TextDecoder().decode(await readFile(path))))
      .draft.title,
  ).toBe(fixture.draft.title);
  const read = page.getByRole("button", { name: "内容を確認して読む" });
  await read.click();
  await page.getByRole("button", { name: "取り込みを取り消す" }).click();
  await expect(read).toBeFocused();
  await read.click();
  await page
    .getByRole("button", { name: "確認してこのブラウザに取り込む" })
    .click();
  await expect(
    page.getByRole("navigation", { name: "教材の目次" }),
  ).toBeVisible();
});
