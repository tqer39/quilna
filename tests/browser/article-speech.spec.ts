import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, delayed = false) {
  await page.addInitScript(
    ({ delayed }) => {
      const w = window as unknown as {
        spoken: string[];
        loadVoices: () => void;
      };
      w.spoken = [];
      const voices = [
        {
          name: "Novelty",
          voiceURI: "novelty",
          lang: "en-US",
          localService: true,
          default: false,
        },
        {
          name: "Natural",
          voiceURI: "natural",
          lang: "en-GB",
          localService: true,
          default: true,
        },
        {
          name: "Kyoko",
          voiceURI: "ja",
          lang: "ja-JP",
          localService: true,
          default: true,
        },
        {
          name: "Remote",
          voiceURI: "remote",
          lang: "en-US",
          localService: false,
          default: true,
        },
      ];
      let ready = !delayed;
      const engine = Object.assign(new EventTarget(), {
        getVoices: () => (ready ? voices : []),
        speak: (u: SpeechSynthesisUtterance) =>
          w.spoken.push(u.voice!.voiceURI),
        cancel: () => {},
        pause: () => {},
        resume: () => {},
        paused: false,
      });
      w.loadVoices = () => {
        ready = true;
        engine.dispatchEvent(new Event("voiceschanged"));
      };
      Object.defineProperty(window, "speechSynthesis", { value: engine });
      Object.defineProperty(window, "SpeechSynthesisUtterance", {
        value: class {
          constructor(public text: string) {}
        },
      });
      Object.defineProperty(window, "Translator", {
        value: {
          create: async () => ({
            translate: async () => "原文から翻訳された日本語の文章です。",
            destroy: () => {},
          }),
        },
      });
    },
    { delayed },
  );
  const url = "https://publisher.example.org/speech";
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill({
      json: {
        url,
        html: `<html lang="en"><head><title>Speech article</title></head><body><article><h1>Speech article</h1><p>${"This article discusses reading original sources and preserving evidence. ".repeat(10)}</p></article></body></html>`,
      },
    }),
  );
  await page.goto("/?view=feeds");
  await page.getByLabel("サイト・RSSのURL").fill(url);
  await page
    .getByRole("button", { name: "記事として取り込む", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Speech article", exact: true }),
  ).toBeVisible();
}

test("local voice choices persist by language and switching cancels speech", async ({
  page,
}) => {
  await setup(page);
  const voice = page.getByLabel("読み上げ音声", { exact: true });
  await expect(voice).toHaveValue("natural");
  await expect(voice.locator("option")).toHaveCount(3);
  await page
    .getByRole("button", { name: "表示中の本文を読み上げ", exact: true })
    .click();
  await expect(page.getByText("読み上げ中", { exact: true })).toBeVisible();
  await voice.selectOption("novelty");
  await expect(
    page.getByRole("button", { name: "読み上げを停止", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "日本語に翻訳", exact: true }).click();
  await expect(
    page.getByText("日本語訳（機械翻訳）", { exact: true }),
  ).toBeVisible();
  await expect(voice).toHaveValue("ja");
  await page.getByRole("button", { name: "原文を読む", exact: true }).click();
  await expect(voice).toHaveValue("novelty");
  await page.reload();
  await page
    .getByRole("button", { name: "Speech article", exact: true })
    .click();
  await expect(voice).toHaveValue("novelty");
  await page
    .getByRole("button", { name: "表示中の本文を読み上げ", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => (window as unknown as { spoken: string[] }).spoken,
    ),
  ).toEqual(["novelty"]);
});

test("voices arriving after page load update the selector without a reload", async ({
  page,
}) => {
  await setup(page, true);
  const voice = page.getByLabel("読み上げ音声", { exact: true });
  await expect(voice).toBeDisabled();
  await page.evaluate(() =>
    (window as unknown as { loadVoices: () => void }).loadVoices(),
  );
  await expect(voice).toBeEnabled();
  await expect(voice).toHaveValue("natural");
  await page
    .getByRole("button", { name: "表示中の本文を読み上げ", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => (window as unknown as { spoken: string[] }).spoken,
    ),
  ).toEqual(["natural"]);
});
