import { test, expect, type Page } from "@playwright/test";
import type { FeedArticle } from "../../src/feed-parser";
const url = "https://publisher.example.org/story";
const paragraph =
  "This is the complete article about learning from original sources. It explains the research, its limitations, and why preserving evidence matters to a reader. ";
const html = `<!doctype html><html lang="en"><head><title>Collected article</title></head><body><nav>Navigation junk</nav><article><h1>Collected article</h1><p>${paragraph.repeat(5)}</p><h2>Second section</h2><p>Final paragraph. ${paragraph.repeat(4)}</p></article><img src="https://tracker.example.org/pixel"><script>window.articleExecuted = true</script><iframe src="https://tracker.example.org/frame"></iframe></body></html>`;
const codeExample =
  'function deleteAlarm() {\n  const tag = "<img onerror=alert(1)>";\n\n\treturn tag;\n}';
const codeHTML = `<!doctype html><html lang="en"><head><title>Collected article</title></head><body><article><h1>Collected article</h1><p>${paragraph.repeat(5)}</p><p>Call <code>deleteAlarm()</code> to cancel the scheduled work.</p><pre><code>${codeExample.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</code></pre><p>Final paragraph. ${paragraph.repeat(4)}</p></article></body></html>`;
async function source(page: Page, fail = false) {
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill(
      fail
        ? { status: 502, json: { error: "fetch" } }
        : { json: { url, html } },
    ),
  );
}
async function add(page: Page) {
  await page.goto("/?view=feeds");
  await page.getByLabel("サイト・RSSのURL").fill(url);
  await page
    .getByRole("button", { name: "記事として取り込む", exact: true })
    .click();
}
async function reopen(page: Page) {
  await page.reload();
  await page.getByRole("button", { name: /保存した記事 · 1/ }).click();
  await page
    .getByRole("button", { name: "Collected article", exact: true })
    .click();
}
test("direct article imports safe text and saved original survives reload and a network outage", async ({
  page,
}, info) => {
  const trackers: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("tracker.example.org")) trackers.push(r.url());
  });
  await source(page);
  await add(page);
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  await expect(page.locator(".rss-article-body")).not.toContainText(
    "Navigation junk",
  );
  await expect(page.locator("#rss-save-article")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(trackers).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { articleExecuted?: boolean }).articleExecuted,
    ),
  ).toBeUndefined();
  await source(page, true);
  await reopen(page);
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("article-imported.png"),
    fullPage: true,
  });
});
test("failed extraction preserves a saved link and retry recovers without duplicates", async ({
  page,
}) => {
  await source(page, true);
  await add(page);
  await expect(page.locator(".rss-content-note")).toContainText(
    "取り込みに失敗",
  );
  await expect(page.locator(".rss-article-body")).toContainText(
    "本文なし・リンク情報のみ",
  );
  await page.reload();
  await page.getByRole("button", { name: url, exact: true }).click();
  await expect(
    page.getByRole("button", { name: "本文の取得を再試行" }),
  ).toBeVisible();
  await source(page);
  await page.getByRole("button", { name: "本文の取得を再試行" }).click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  await expect(
    page.getByRole("button", { name: /保存した記事 · 1/ }),
  ).toBeVisible();
});
test("login shell is not misrepresented as imported content", async ({
  page,
}) => {
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill({
      json: {
        url,
        html: "<html><body><form>Sign in</form><p>Log in to read.</p></body></html>",
      },
    }),
  );
  await add(page);
  await expect(page.locator(".rss-content-note")).toContainText(
    "本文を見つけられませんでした",
  );
  await expect(page.getByRole("button", { name: "日本語に翻訳" })).toHaveCount(
    0,
  );
});
async function translator(page: Page, delayed = false) {
  await page.addInitScript(
    ({ delayed }) => {
      const w = window as unknown as {
        Translator: unknown;
        translationCalls: string[];
        releaseTranslation?: () => void;
      };
      w.translationCalls = [];
      w.Translator = {
        create: async () => ({
          translate: async (text: string) => {
            w.translationCalls.push(text);
            if (delayed)
              await new Promise<void>((resolve) => {
                w.releaseTranslation = resolve;
              });
            return "原文から翻訳した日本語の本文です。";
          },
          destroy: () => {},
        }),
      };
    },
    { delayed },
  );
}
test("code survives import, translation and offline reopen without reaching the translator", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await translator(page);
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill({ json: { url, html: codeHTML } }),
  );
  await add(page);
  const code = page.locator(".rss-article-body pre code");
  await expect(code.locator(".hljs-keyword").first()).toBeVisible();
  await expect(code).toHaveText(codeExample, { useInnerText: false });
  expect(await code.textContent()).toBe(codeExample);
  await page.getByRole("button", { name: "コードをコピー" }).click();
  await expect(page.locator(".rss-code-tools").getByRole("status")).toHaveText(
    "コピーしました",
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    codeExample,
  );
  await expect(page.locator(".rss-article-body p code")).toHaveText(
    "deleteAlarm()",
  );
  await expect(page.locator(".rss-article-body img")).toHaveCount(0);
  await page.getByRole("button", { name: "日本語に翻訳", exact: true }).click();
  await expect(
    page.getByText(
      "日本語訳を保存しました。機械翻訳のため原文も確認してください。",
      { exact: true },
    ),
  ).toBeVisible();
  expect(await code.textContent()).toBe(codeExample);
  await page.getByRole("button", { name: "コードをコピー" }).click();
  await expect(page.locator(".rss-code-tools").getByRole("status")).toHaveText(
    "コピーしました",
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    codeExample,
  );
  await expect(page.locator(".rss-article-body p code")).toHaveText(
    "deleteAlarm()",
  );
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { translationCalls: string[] }
      ).translationCalls.join("\n"),
    ),
  ).not.toMatch(/deleteAlarm|onerror|return tag/);
  await source(page, true);
  await reopen(page);
  expect(await code.textContent()).toBe(codeExample);
  await page.getByRole("button", { name: "コードをコピー" }).click();
  await expect(page.locator(".rss-code-tools").getByRole("status")).toHaveText(
    "コピーしました",
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    codeExample,
  );
  await page
    .getByRole("button", { name: "日本語訳を読む", exact: true })
    .click();
  expect(await code.textContent()).toBe(codeExample);
  await page.getByRole("button", { name: "コードをコピー" }).click();
  await expect(page.locator(".rss-code-tools").getByRole("status")).toHaveText(
    "コピーしました",
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    codeExample,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(code.locator(".hljs-keyword").first()).toBeVisible();
});
test("code HTML line breaks remain literal newlines including consecutive br elements", async ({
  page,
}) => {
  const withBreaks = codeHTML.replaceAll("\n", "<br>");
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill({ json: { url, html: withBreaks } }),
  );
  await add(page);
  await expect(page.locator(".rss-article-body pre code")).toHaveText(
    codeExample,
    { useInnerText: false },
  );
  expect(await page.locator(".rss-article-body pre code").textContent()).toBe(
    codeExample,
  );
});
test("translation is explicit, persists separately and original is retained", async ({
  page,
}) => {
  await translator(page);
  await source(page);
  await add(page);
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { translationCalls: string[] }).translationCalls
          .length,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: "日本語に翻訳", exact: true }).click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "原文から翻訳した日本語",
  );
  await page.getByRole("button", { name: "原文を読む", exact: true }).click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  await reopen(page);
  await page
    .getByRole("button", { name: "日本語訳を読む", exact: true })
    .click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "原文から翻訳した日本語",
  );
});

for (const changed of [false, true]) {
  test(`legacy code formatting upgrade ${changed ? "refuses changed source without losing saved values" : "preserves flags and survives reload"}`, async ({
    page,
  }) => {
    await page.route("**/api/feeds/fetch", (route) =>
      route.fulfill({ json: { url, html: codeHTML } }),
    );
    await add(page);
    await expect(page.locator(".rss-article-body pre code")).toHaveText(
      codeExample,
    );
    const before = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open("tsumiki.rss.v1");
        r.onsuccess = () => resolve(r.result);
      });
      return await new Promise<string>((resolve, reject) => {
        const tx = db.transaction("articles", "readwrite");
        const store = tx.objectStore("articles");
        const all = store.getAll();
        let saved = "";
        all.onsuccess = () => {
          const article = all.result[0];
          delete article.content.codeRanges;
          article.content.text = article.content.text
            .replace(/[^\S\n]+/g, " ")
            .replace(/\n\s*\n/g, "\n\n")
            .trim();
          article.translation = {
            text: "以前の保存訳",
            sourceText: article.content.text,
            sourceLanguage: "en",
            targetLanguage: "ja",
          };
          store.put(article);
          saved = JSON.stringify(article);
        };
        tx.oncomplete = () => {
          db.close();
          resolve(saved);
        };
        tx.onerror = () => reject(tx.error);
      });
    });
    await reopen(page);
    await expect(
      page.getByRole("button", { name: "コードの書式を取り直す", exact: true }),
    ).toBeVisible();
    if (changed)
      await page.route("**/api/feeds/fetch", (route) =>
        route.fulfill({
          json: {
            url,
            html: codeHTML.replace(
              "Final paragraph.",
              "Changed source paragraph.",
            ),
          },
        }),
      );
    await page
      .getByRole("button", { name: "コードの書式を取り直す", exact: true })
      .click();
    if (changed) {
      await expect(page.locator(".rss-error")).toContainText(
        "以前の内容は保持しています",
      );
      const after = await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const r = indexedDB.open("tsumiki.rss.v1");
          r.onsuccess = () => resolve(r.result);
        });
        return await new Promise<string>((resolve) => {
          const tx = db.transaction("articles", "readonly");
          const r = tx.objectStore("articles").getAll();
          tx.oncomplete = () => {
            db.close();
            resolve(JSON.stringify(r.result[0]));
          };
        });
      });
      expect(after).toBe(before);
      await page
        .getByRole("button", { name: "日本語訳を読む", exact: true })
        .click();
      await expect(page.locator(".rss-article-body")).toContainText(
        "以前の保存訳",
      );
    } else {
      await expect(page.locator(".rss-article-body pre code")).toHaveText(
        codeExample,
      );
      expect(
        await page.locator(".rss-article-body pre code").textContent(),
      ).toBe(codeExample);
      await expect(
        page.getByRole("button", { name: "日本語訳を読む", exact: true }),
      ).toHaveCount(0);
      await source(page, true);
      await reopen(page);
      expect(
        await page.locator(".rss-article-body pre code").textContent(),
      ).toBe(codeExample);
      await expect(page.locator("#rss-save-article")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    }
  });
}

test("invalid saved code ranges report an error and retain the stored record", async ({
  page,
}) => {
  await source(page);
  await add(page);
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("tsumiki.rss.v1");
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("articles", "readwrite");
      const store = tx.objectStore("articles");
      const r = store.getAll();
      r.onsuccess = () =>
        store.put({
          ...r.result[0],
          content: {
            ...r.result[0].content,
            codeRanges: [{ start: -1, end: 2, block: true }],
          },
        });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
    });
  });
  await page.reload();
  await expect(page.locator(".rss-error")).toContainText(
    "保存データの形式を確認できませんでした。データは削除していません",
  );
  expect(
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open("tsumiki.rss.v1");
        r.onsuccess = () => resolve(r.result);
      });
      return await new Promise<number>((resolve) => {
        const tx = db.transaction("articles", "readonly");
        const r = tx.objectStore("articles").count();
        tx.oncomplete = () => {
          db.close();
          resolve(r.result);
        };
      });
    }),
  ).toBe(1);
});
test("unsupported translation is disclosed without sending text externally", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "Translator", {
      value: undefined,
      configurable: true,
    }),
  );
  await source(page);
  await add(page);
  await expect(page.locator(".rss-reader-tools")).toContainText(
    "端末内翻訳に対応していません",
  );
  await expect(
    page.getByRole("button", { name: "日本語に翻訳", exact: true }),
  ).toBeDisabled();
});
test("cancelled translation cannot change another view even if the translator ignores abort", async ({
  page,
}) => {
  await translator(page, true);
  await source(page);
  await add(page);
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  await page.getByRole("button", { name: "日本語に翻訳", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!(window as unknown as { releaseTranslation?: unknown })
            .releaseTranslation,
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "← 記事一覧へ", exact: true }).click();
  await page.evaluate(() =>
    (
      window as unknown as { releaseTranslation: () => void }
    ).releaseTranslation(),
  );
  await page
    .getByRole("button", { name: "Collected article", exact: true })
    .click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  await expect(
    page.getByRole("button", { name: "日本語訳を読む", exact: true }),
  ).toHaveCount(0);
});
test("speech uses displayed text, supports pause/resume/rate and stops when leaving article", async ({
  page,
}) => {
  await translator(page);
  await page.addInitScript(() => {
    const w = window as unknown as {
      speechCalls: { text: string; rate: number; lang: string }[];
      speechEvents: string[];
    };
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      value: class {
        constructor(public text: string) {}
      },
    });
    w.speechCalls = [];
    w.speechEvents = [];
    Object.defineProperty(window, "speechSynthesis", {
      value: {
        getVoices: () => [
          { localService: true, lang: "en-US" },
          { localService: true, lang: "ja-JP" },
        ],
        speak: (u: SpeechSynthesisUtterance) =>
          w.speechCalls.push({ text: u.text, rate: u.rate, lang: u.lang }),
        cancel: () => w.speechEvents.push("cancel"),
        pause: () => w.speechEvents.push("pause"),
        resume: () => w.speechEvents.push("resume"),
      },
    });
  });
  await source(page);
  await add(page);
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  await page.getByLabel("読み上げ速度").selectOption("1.5");
  await page
    .getByRole("button", { name: "表示中の本文を読み上げ", exact: true })
    .click();
  await page
    .getByRole("button", { name: "読み上げを一時停止", exact: true })
    .click();
  await page
    .getByRole("button", { name: "読み上げを再開", exact: true })
    .click();
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          speechCalls: { text: string; rate: number; lang: string }[];
        }
      ).speechCalls,
  );
  expect(calls[0]).toMatchObject({ rate: 1.5, lang: "en-US" });
  expect(calls[0].text).toContain("complete article");
  await page
    .getByRole("button", { name: "読み上げを停止", exact: true })
    .click();
  await page.getByRole("button", { name: "日本語に翻訳", exact: true }).click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "原文から翻訳した日本語",
  );
  await page
    .getByRole("button", { name: "表示中の本文を読み上げ", exact: true })
    .click();
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { speechCalls: { lang: string }[] }
        ).speechCalls.at(-1)?.lang,
    ),
  ).toBe("ja-JP");
  await page.getByRole("button", { name: "← 記事一覧へ", exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as unknown as { speechEvents: string[] }).speechEvents.at(-1),
    ),
  ).toBe("cancel");
});
for (const transition of ["stop", "leave", "speed", "chunk"] as const) {
  test(`paused speech starts again after ${transition} without replaying cancelled text`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const w = window as unknown as {
        spoken: string[];
        finishChunk: () => void;
      };
      w.spoken = [];
      let paused = false;
      let queued: SpeechSynthesisUtterance | undefined;
      let active: SpeechSynthesisUtterance | undefined;
      const play = () => {
        if (!paused && queued) {
          w.spoken.push(queued.text);
          active = queued;
          queued = undefined;
        }
      };
      Object.defineProperty(window, "SpeechSynthesisUtterance", {
        value: class {
          constructor(public text: string) {}
        },
      });
      Object.defineProperty(window, "speechSynthesis", {
        value: {
          get paused() {
            return paused;
          },
          getVoices: () => [{ localService: true, lang: "en-US" }],
          speak: (u: SpeechSynthesisUtterance) => {
            queued = u;
            w.finishChunk = () => {
              if (active === u) active = undefined;
              u.onend?.({} as SpeechSynthesisEvent);
            };
            play();
          },
          // Per Web Speech API, cancel clears the queue, not the paused flag.
          cancel: () => {
            queued = undefined;
            active = undefined;
          },
          pause: () => {
            paused = true;
          },
          resume: () => {
            // A resume before cancel would audibly continue the old utterance.
            if (paused && active) w.spoken.push(active.text);
            paused = false;
            play();
          },
        },
      });
    });
    await source(page);
    await add(page);
    await expect(page.locator(".rss-article-body")).toContainText(
      "Final paragraph.",
    );
    const start = () =>
      page
        .getByRole("button", { name: "表示中の本文を読み上げ", exact: true })
        .click();
    const spoken = () =>
      page.evaluate(() => (window as unknown as { spoken: string[] }).spoken);
    await start();
    await page
      .getByRole("button", { name: "読み上げを一時停止", exact: true })
      .click();
    if (transition === "stop") {
      await page
        .getByRole("button", { name: "読み上げを停止", exact: true })
        .click();
    } else if (transition === "leave") {
      await page
        .getByRole("button", { name: "← 記事一覧へ", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Collected article", exact: true })
        .click();
    } else if (transition === "speed") {
      await page.getByLabel("読み上げ速度").selectOption("1.5");
    } else {
      // Deliver the just-finished chunk's event after the user pauses.
      await page.evaluate(() =>
        (window as unknown as { finishChunk: () => void }).finishChunk(),
      );
      await expect(
        page.getByRole("button", { name: "読み上げを再開", exact: true }),
      ).toBeVisible();
      await expect(page.getByText("一時停止中", { exact: true })).toBeVisible();
    }
    expect(await spoken()).toHaveLength(1);
    if (transition === "chunk") {
      await page
        .getByRole("button", { name: "読み上げを再開", exact: true })
        .click();
    } else {
      await start();
    }
    await expect.poll(spoken).toHaveLength(2);
    expect(await page.evaluate(() => speechSynthesis.paused)).toBe(false);
    await page
      .getByRole("button", { name: "読み上げを停止", exact: true })
      .click();
  });
}
test("failed content persistence is visible and retry saves the full text", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  await page.route("**/api/feeds/fetch", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ json: { url, html } });
  });
  await add(page);
  await expect.poll(() => !!release).toBe(true);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === "articles" && args[0].content) throw Error("quota");
      return put.apply(this, args);
    };
    (window as unknown as { restore: () => void }).restore = () => {
      IDBObjectStore.prototype.put = put;
    };
  });
  release!();
  await expect(page.locator(".rss-error")).toContainText(
    "本文・翻訳を保存できませんでした",
  );
  await expect(page.locator(".rss-content-note")).not.toContainText(
    "元サイトから取り込んだ本文です",
  );
  await page.evaluate(() =>
    (window as unknown as { restore: () => void }).restore(),
  );
  await source(page);
  await page
    .locator(".rss-error")
    .getByRole("button", { name: "再試行", exact: true })
    .click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
});

test("missing local voice and translation rejection leave readable originals and actionable messages", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "Translator", {
      value: {
        create: async () => {
          throw Error("language unavailable");
        },
      },
    });
    Object.defineProperty(window, "speechSynthesis", {
      value: { getVoices: () => [], cancel: () => {} },
    });
  });
  await source(page);
  await add(page);
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  await page.getByRole("button", { name: "日本語に翻訳", exact: true }).click();
  await expect(page.locator(".rss-reader-tools")).toContainText(
    "翻訳できませんでした",
  );
  await page
    .getByRole("button", { name: "表示中の本文を読み上げ", exact: true })
    .click();
  await expect(page.locator(".rss-reader-tools")).toContainText(
    "端末内音声が見つかりません",
  );
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
});

test("corrupt optional content is reported without deleting the library", async ({
  page,
}) => {
  await source(page);
  await add(page);
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("tsumiki.rss.v1");
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("articles", "readwrite");
        const store = tx.objectStore("articles");
        const all = store.getAll();
        all.onsuccess = () => store.put({ ...all.result[0], content: null });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.reload();
  await expect(page.locator(".rss-error")).toContainText(
    "保存データの形式を確認できませんでした。データは削除していません",
  );
});

test("late import preserves current article and concurrent saved flags", async ({
  page,
  context,
}) => {
  await source(page);
  await add(page);
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  const firstId = JSON.stringify(["article", url]);
  await page.evaluate(
    async ({ firstId }) => {
      await new Promise<void>((resolve) => {
        const r = indexedDB.open("tsumiki.rss.v1");
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction("articles", "readwrite");
          const store = tx.objectStore("articles");
          const get = store.get(firstId);
          get.onsuccess = () => {
            const a = get.result;
            store.put({ ...a, content: undefined });
            store.put({
              ...a,
              id: "other",
              title: "Other article",
              url: "https://publisher.example.org/other",
              content: { ...a.content, title: "Other article" },
            });
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      });
    },
    { firstId },
  );
  let release: (() => void) | undefined;
  await page.route("**/api/feeds/fetch", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ json: { url, html } });
  });
  await page.reload();
  await page.getByRole("button", { name: url, exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  await page.getByRole("button", { name: "← 記事一覧へ", exact: true }).click();
  await page
    .getByRole("button", { name: "Other article", exact: true })
    .click();
  const other = await context.newPage();
  await other.goto("/?view=feeds");
  await other.evaluate(async (firstId) => {
    await new Promise<void>((resolve) => {
      const r = indexedDB.open("tsumiki.rss.v1");
      r.onsuccess = () => {
        const db = r.result;
        const tx = db.transaction("articles", "readwrite");
        const store = tx.objectStore("articles");
        const get = store.get(firstId);
        get.onsuccess = () => store.put({ ...get.result, saved: false });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
  }, firstId);
  release!();
  await expect(
    page.getByRole("button", { name: /保存した記事 · 1/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Other article", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "← 記事一覧へ", exact: true }).click();
  await page
    .getByRole("button", { name: "Collected article", exact: true })
    .click();
  await expect(page.locator("#rss-save-article")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  await other.close();
});

test("automatic translation saves the target preference and reuses a matching saved translation", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as { Translator: unknown; pairs: string[] };
    w.pairs = [];
    w.Translator = {
      availability: async () => "available",
      create: async (options: {
        sourceLanguage: string;
        targetLanguage: string;
      }) => {
        w.pairs.push(`${options.sourceLanguage}:${options.targetLanguage}`);
        return {
          translate: async () => `Translation in ${options.targetLanguage}`,
          destroy() {},
        };
      },
    };
  });
  await source(page);
  await add(page);
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByLabel("ロケール（翻訳・読み上げ）", { exact: true }).selectOption("fr");
  await page.getByLabel("記事を開いたら自動翻訳").check();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "Translation in fr",
  );
  await expect(page.locator(".rss-article-body")).toHaveAttribute("lang", "fr");
  expect(
    await page.evaluate(() => (window as unknown as { pairs: string[] }).pairs),
  ).toEqual(["en:fr"]);
  await reopen(page);
  await expect(page.locator(".rss-article-body")).toContainText(
    "Translation in fr",
  );
  expect(
    await page.evaluate(() => (window as unknown as { pairs: string[] }).pairs),
  ).toEqual([]);
  await page.getByRole("button", { name: "原文を読む", exact: true }).click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(page.getByLabel("ロケール（翻訳・読み上げ）", { exact: true })).toHaveValue(
    "fr",
  );
  await page.getByLabel("ロケール（翻訳・読み上げ）", { exact: true }).selectOption("en");
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  await expect(
    page.getByRole("button", { name: "英語に翻訳", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "英語訳を読む", exact: true }),
  ).toHaveCount(0);
});

test("background automatic translation requires a click when the language pack is not ready", async ({
  page,
}) => {
  await translator(page);
  await page.addInitScript(() => {
    localStorage.setItem(
      "quilna.reader.preferences.v1",
      JSON.stringify({ targetLanguage: "ja", automatic: true }),
    );
    Object.defineProperty(navigator, "userActivation", {
      value: { isActive: false },
    });
    (
      window as unknown as {
        Translator: { availability: () => Promise<string> };
      }
    ).Translator.availability = async () => "downloadable";
  });
  await source(page);
  await add(page);
  await expect(page.locator(".rss-reader-tools")).toContainText(
    "翻訳ボタンを押してください",
  );
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { translationCalls: string[] }).translationCalls,
    ),
  ).toEqual([]);
  await page.getByRole("button", { name: "日本語に翻訳", exact: true }).click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "原文から翻訳した日本語",
  );
});

test("automatic translation does not guess missing source language or send text to another service", async ({
  page,
}) => {
  await translator(page);
  await page.addInitScript(() =>
    Object.defineProperty(window, "LanguageDetector", {
      value: undefined,
      configurable: true,
    }),
  );
  await page.addInitScript(() =>
    localStorage.setItem(
      "quilna.reader.preferences.v1",
      JSON.stringify({ targetLanguage: "ja", automatic: true }),
    ),
  );
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill({ json: { url, html: html.replace('lang="en"', "") } }),
  );
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST")
      requests.push(new URL(request.url()).pathname);
  });
  await add(page);
  await expect(page.locator(".rss-reader-tools")).toContainText(
    "原文の言語を判定できません",
  );
  await expect(page.getByLabel("原文の言語", { exact: true })).toHaveValue("");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { translationCalls: string[] }).translationCalls,
    ),
  ).toEqual([]);
  expect(requests).toEqual(["/api/feeds/fetch"]);
  await page.getByLabel("原文の言語", { exact: true }).selectOption("en");
  await page.getByRole("button", { name: "日本語に翻訳", exact: true }).click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "原文から翻訳した日本語",
  );
});

test("turning automatic translation off cancels a pending result without losing the original", async ({
  page,
}) => {
  await translator(page, true);
  await source(page);
  await add(page);
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByLabel("記事を開いたら自動翻訳").check();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!(window as unknown as { releaseTranslation?: unknown })
            .releaseTranslation,
      ),
    )
    .toBe(true);
  await page.getByLabel("記事を開いたら自動翻訳").uncheck();
  await page.evaluate(() =>
    (
      window as unknown as { releaseTranslation: () => void }
    ).releaseTranslation(),
  );
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  await expect(
    page.getByRole("button", { name: "日本語訳を読む", exact: true }),
  ).toHaveCount(0);
  await reopen(page);
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
});

test("cancellation while translation persistence waits for a writer leaves the saved original untouched", async ({
  page,
}) => {
  await source(page);
  await add(page);
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  const result = await page.evaluate(
    async (id) => {
      const modulePath = "/src/feed-store.ts";
      const { openFeedLibrary, readArticle, updateArticleContent } =
        await import(modulePath);
      const db = await openFeedLibrary();
      const article = await readArticle(db, id);
      const blocker = db.transaction("articles", "readwrite");
      let keepAlive = true;
      const pump = () => {
        blocker.objectStore("articles").get(id).onsuccess = () => {
          if (keepAlive) pump();
        };
      };
      pump();
      const controller = new AbortController();
      const pending = updateArticleContent(
        db,
        article,
        {
          translation: {
            text: "Cancelled translation",
            sourceText: article.content.text,
            sourceLanguage: "en",
            targetLanguage: "ja",
          },
        },
        false,
        controller.signal,
      ).then(
        () => "committed",
        () => "cancelled",
      );
      controller.abort();
      keepAlive = false;
      const status = await pending;
      const saved = await readArticle(db, id);
      db.close();
      return {
        status,
        text: saved.content.text,
        translation: saved.translation ?? null,
      };
    },
    JSON.stringify(["article", url]),
  );
  expect(result.status).toBe("cancelled");
  expect(result.text).toContain("Final paragraph.");
  expect(result.translation).toBeNull();
});

test("browser target follows the local language and reacts to a language change without relabeling old translations", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      value: ["fr-FR"],
    });
    (window as unknown as { Translator: unknown }).Translator = {
      availability: async () => "available",
      create: async ({ targetLanguage }: { targetLanguage: string }) => ({
        translate: async () => `Translated into ${targetLanguage}`,
        destroy() {},
      }),
    };
  });
  await source(page);
  await add(page);
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page
    .getByLabel("ロケール（翻訳・読み上げ）", { exact: true })
    .selectOption("browser");
  await page.getByLabel("記事を開いたら自動翻訳").check();
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(page.locator(".rss-article-body")).toContainText(
    "Translated into fr",
  );
  await reopen(page);
  await expect(page.locator(".rss-article-body")).toHaveAttribute("lang", "fr");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      value: ["en-GB"],
    });
    window.dispatchEvent(new Event("languagechange"));
  });
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  await expect(
    page.getByRole("button", { name: "英語に翻訳", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      value: ["xx-ZZ"],
    });
    window.dispatchEvent(new Event("languagechange"));
  });
  await expect(page.locator(".rss-reader-tools")).toContainText(
    "ブラウザの言語は翻訳先の対象外",
  );
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
});

async function detector(
  page: Page,
  mode: "confident" | "uncertain" | "mixed" | "delayed",
) {
  await page.addInitScript(
    ({ mode }) => {
      const w = window as unknown as {
        LanguageDetector: unknown;
        releaseDetection?: () => void;
      };
      let calls = 0;
      w.LanguageDetector = {
        availability: async () => "available",
        create: async () => ({
          detect: async () => {
            calls++;
            if (mode === "delayed")
              await new Promise<void>((resolve) => {
                w.releaseDetection = resolve;
              });
            return [
              {
                detectedLanguage: mode === "mixed" && calls > 1 ? "ja" : "en",
                confidence: mode === "uncertain" ? 0.4 : 0.99,
              },
            ];
          },
          destroy() {},
        }),
      };
    },
    { mode },
  );
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill({
      json: {
        url,
        html: html
          .replace('lang="en"', "")
          .replace(paragraph.repeat(5), paragraph.repeat(30)),
      },
    }),
  );
}
test("automatic local language detection translates unlabelled articles and retains a source correction control", async ({
  page,
}) => {
  await translator(page);
  await detector(page, "confident");
  await page.addInitScript(() =>
    localStorage.setItem(
      "quilna.reader.preferences.v1",
      JSON.stringify({ targetLanguage: "ja", automatic: true }),
    ),
  );
  await add(page);
  await expect(page.locator(".rss-article-body")).toContainText(
    "原文から翻訳した日本語",
  );
  await expect(page.getByLabel("原文の言語", { exact: true })).toHaveValue(
    "en",
  );
  await reopen(page);
  await expect(page.locator(".rss-article-body")).toContainText(
    "原文から翻訳した日本語",
  );
  await expect(page.getByLabel("原文の言語", { exact: true })).toHaveValue(
    "en",
  );
});
for (const mode of ["uncertain", "mixed"] as const) {
  test(`language detection leaves ${mode} articles untranslated with a manual choice`, async ({
    page,
  }) => {
    await translator(page);
    await detector(page, mode);
    await page.addInitScript(() =>
      localStorage.setItem(
        "quilna.reader.preferences.v1",
        JSON.stringify({ targetLanguage: "ja", automatic: true }),
      ),
    );
    await add(page);
    await expect(page.locator(".rss-reader-tools")).toContainText(
      "原文の言語を確実に判定できません",
    );
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { translationCalls: string[] })
            .translationCalls,
      ),
    ).toEqual([]);
    await expect(page.locator(".rss-article-body")).toContainText(
      "Final paragraph.",
    );
    await page.getByLabel("原文の言語", { exact: true }).selectOption("en");
    await page
      .getByRole("button", { name: "日本語に翻訳", exact: true })
      .click();
    await expect(page.locator(".rss-article-body")).toContainText(
      "原文から翻訳した日本語",
    );
  });
}
test("late language detection cannot update an article after cancellation", async ({
  page,
}) => {
  await translator(page);
  await detector(page, "delayed");
  await add(page);
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  await page
    .getByRole("button", { name: "原文の言語を判定", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!(window as unknown as { releaseDetection?: unknown })
            .releaseDetection,
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "翻訳を中止", exact: true }).click();
  await page.evaluate(() =>
    (window as unknown as { releaseDetection: () => void }).releaseDetection(),
  );
  await expect(page.getByLabel("原文の言語", { exact: true })).toHaveValue("");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { translationCalls: string[] }).translationCalls,
    ),
  ).toEqual([]);
});

test("a losing cross-tab import cannot replace the language of the saved original", async ({
  page,
  context,
}) => {
  await source(page, true);
  await add(page);
  await expect(page.locator(".rss-content-note")).toContainText(
    "取り込みに失敗",
  );
  let release: (() => void) | undefined;
  await page.route("**/api/feeds/fetch", async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      json: {
        url,
        html: html
          .replace('lang="en"', 'lang="ja"')
          .replace("Final paragraph.", "Discarded late copy."),
      },
    });
  });
  await page
    .getByRole("button", { name: "本文の取得を再試行", exact: true })
    .click();
  await expect.poll(() => !!release).toBe(true);
  const other = await context.newPage();
  await source(other);
  await other.goto("/?view=feeds");
  await other.getByRole("button", { name: url, exact: true }).click();
  await other
    .getByRole("button", { name: "本文の取得を再試行", exact: true })
    .click();
  await expect(other.locator(".rss-content-note")).toContainText(
    "元サイトから取り込んだ本文です",
  );
  release!();
  await expect(page.locator(".rss-content-note")).toContainText(
    "元サイトから取り込んだ本文です",
  );
  await expect(page.locator(".rss-article-body")).toContainText(
    "Final paragraph.",
  );
  await expect(page.locator(".rss-article-body")).not.toContainText(
    "Discarded late copy.",
  );
  await expect(page.getByLabel("原文の言語", { exact: true })).toHaveValue(
    "en",
  );
  await other.close();
});

for (const design of ["Studio", "Editorial", "Focus"]) {
  test(`${design} code syntax keeps contrast, exact selection and saved quote offsets`, async ({
    page,
  }, info) => {
    await page.addInitScript((design) => {
      localStorage.setItem("quilna.reader.design.v1", design.toLowerCase());
      localStorage.setItem("quilna.feed.refresh.v1", "0");
    }, design);
    const sample =
      "// Preserve 😀, whitespace and literal markup\n" +
      codeExample +
      "\nconst count = 42;\n";
    const escaped = sample
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    await page.route("**/api/feeds/fetch", (route) =>
      route.fulfill({
        json: {
          url,
          html: codeHTML.replace(
            /<pre>[\s\S]*?<\/pre>/,
            `<pre><code>${escaped}</code></pre>`,
          ),
        },
      }),
    );
    await add(page);
    const code = page.locator(".rss-article-body pre code");
    await expect(code.locator(".hljs-keyword").first()).toBeVisible();
    expect(await code.textContent()).toBe(sample);
    const colors = await code.evaluate((node) => {
      const luminance = (color: string) => {
        const channels = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((v) => {
            const s = v / 255;
            return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
        return (
          channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
        );
      };
      return Array.from(node.querySelectorAll("span")).map((span) => {
        const color = getComputedStyle(span).color;
        const fg = luminance(color);
        let parent: Element | null = span;
        let background = "rgba(0, 0, 0, 0)";
        while (parent && background === "rgba(0, 0, 0, 0)") {
          background = getComputedStyle(parent).backgroundColor;
          parent = parent.parentElement;
        }
        const bg = luminance(background);
        return {
          color,
          contrast: (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05),
        };
      });
    });
    expect(new Set(colors.map((c) => c.color)).size).toBeGreaterThanOrEqual(4);
    for (const c of colors) expect(c.contrast).toBeGreaterThanOrEqual(4.5);
    if (info.project.name === "mobile")
      await page.setViewportSize({ width: 320, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await code.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`syntax-${design}.png`) });
    await expect(
      page.getByRole("button", {
        name: "引用の候補を探す",
        exact: true,
        includeHidden: true,
      }),
    ).toBeEnabled();
    await reopen(page);
    await expect(
      page.getByRole("button", {
        name: "引用の候補を探す",
        exact: true,
        includeHidden: true,
      }),
    ).toBeEnabled();
    const selected = await code.evaluate((node) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode())
        nodes.push(n as Text);
      const range = document.createRange();
      range.setStart(nodes[0], 0);
      range.setEnd(nodes.at(-1)!, nodes.at(-1)!.length);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return range.toString();
    });
    expect(selected).toBe(sample);
    await page
      .getByRole("button", { name: "選択範囲をハイライト", exact: true })
      .click();
    await page
      .getByRole("button", { name: "ハイライトを保存", exact: true })
      .click();
    await expect(page.locator("#rss-highlights summary")).toHaveText(
      "ハイライト・メモ（1）",
    );
    expect(await code.textContent()).toBe(sample);
    expect(await code.locator("mark").allTextContents()).not.toHaveLength(0);
    const saved = await page.evaluate(async () => {
      const path = "/src/feed-store.ts";
      const db = await (await import(path)).openFeedLibrary();
      const articles = await new Promise<FeedArticle[]>((resolve, reject) => {
        const req = db.transaction("articles").objectStore("articles").getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      const highlightsPath = "/src/article-highlights.ts";
      const records = await (
        await import(highlightsPath)
      ).readHighlights(articles[0].id);
      return { text: articles[0].content!.text, record: records[0] };
    });
    expect(saved.record.quote).toBe(sample);
    expect(saved.text.slice(saved.record.start, saved.record.end)).toBe(sample);
    await reopen(page);
    expect(await code.textContent()).toBe(sample);
    await expect(code.locator(".hljs-keyword").first()).toBeVisible();
    expect((await code.locator("mark").allTextContents()).join("")).toBe(
      sample,
    );
  });
}

test("syntax rendering preserves literal text and safely falls back for large and unknown blocks", async ({
  page,
}) => {
  await page.goto("/?view=feeds");
  const results = await page.evaluate(async () => {
    const path = "/src/article-code.ts";
    const { appendArticleText } = await import(path);
    const samples = [
      'def greet(name):\n    # 日本語😀\n    return "Hello " + name\n',
      '{"enabled":true,"count":42,"label":"<script>alert(1)</script>"}',
      '<div class="card">hello &amp; world</div>',
      'echo "Hello"\nexport NAME="reader"\n',
      "ただの文章です。色を付けなくても読めます。",
      "const value = 123;\n".repeat(1000),
      "<img src=x onerror=alert(1)>\u0000\r\n",
    ];
    return samples.map((text) => {
      const parent = document.createElement("div");
      const offsets: { text: string; start: number }[] = [];
      appendArticleText(
        parent,
        text,
        [{ start: 0, end: text.length, block: true }],
        (value: string, start: number) => {
          offsets.push({ text: value, start });
          return document.createTextNode(value);
        },
      );
      return {
        exact: parent.textContent === text,
        offsetsValid: offsets.every(
          (x) => text.slice(x.start, x.start + x.text.length) === x.text,
        ),
        colored: !!parent.querySelector("span"),
        unsafe: !!parent.querySelector("img,script,iframe,svg"),
        markup: parent.querySelectorAll("[onerror],[onclick]").length,
      };
    });
  });
  for (const result of results)
    expect(result).toMatchObject({
      exact: true,
      offsetsValid: true,
      unsafe: false,
      markup: 0,
    });
  for (const result of results.slice(0, 4)) expect(result.colored).toBe(true);
  expect(results[4].colored).toBe(false);
  expect(results[5].colored).toBe(false);
});
