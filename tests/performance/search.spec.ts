import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
// Separate origin/profile: never seed or mutate the user's preview database.
for (const tagged of [false, true]) {
  test(`100k originals and translations${tagged ? " with dense tags" : ""}: input to painted results, correctness and contention`, async ({
    page,
    context,
    browser,
  }, info) => {
    const report: Record<string, unknown> = {
      browser: browser.version(),
      os: await page.evaluate(() => navigator.userAgent),
      corpus: 100000,
      tagged,
      ...(tagged
        ? {
            automaticTagsPerArticle: 8,
            manualTagsPerArticle: 12,
            manualArticleCount: 33333,
          }
        : {}),
      originalBytes: 2048,
      translationBytes: 2048,
      samples: [],
    };
    const samples: {
      group: string;
      query: string;
      filter?: string;
      action?: string;
      ms: number;
    }[] = [];
    report.samples = samples;
    try {
      await page.goto("/?view=feeds");
      await expect(
        page.getByRole("button", { name: "フィードを探す", exact: true }),
      ).toBeEnabled();
      const seedStart = Date.now();
      await page.evaluate(async (tagged) => {
        const labels = [
          "技術・開発",
          "AI・機械学習",
          "科学・研究",
          "ビジネス・経済",
          "暮らし・健康",
          "手順・解説",
          "レビュー",
          "ニュース",
        ];
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const r = indexedDB.open("tsumiki.rss.v1");
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        for (let start = 0; start < 100000; start += 500) {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("articles", "readwrite");
            const store = tx.objectStore("articles");
            for (let i = start; i < start + 500; i++) {
              const id = i.toString().padStart(6, "0");
              const header = `Article ${id} SQLite ${i % 100 === 0 ? "cohort" : "ordinary"} `;
              const body = header + "a".repeat(2048 - header.length);
              const lead = `日本語翻訳 ${id} ${i % 100 === 0 ? "対象集合" : "通常記事"} `;
              const bytes = new TextEncoder().encode(lead).length;
              const translated =
                lead +
                "文".repeat(Math.floor((2048 - bytes) / 3)) +
                "x".repeat((2048 - bytes) % 3);
              store.put({
                id,
                title: `Article ${id}`,
                body,
                url: "",
                feedUrl: "",
                published: null,
                fetchedAt: "2026-10-24T00:00:00Z",
                ...(tagged
                  ? {
                      tags: {
                        version: 1,
                        state: "classified",
                        suggestions: labels.map((tag) => ({
                          tag,
                          evidence: ["synthetic corpus"],
                        })),
                      },
                      ...(i % 3 === 1
                        ? {
                            manualTags: [
                              ...labels,
                              "手動限定",
                              `分類${i % 100}`,
                              `棚${i % 20}`,
                              i % 100 === 0 ? "対象タグ" : "通常タグ",
                            ],
                          }
                        : {}),
                    }
                  : {}),
                saved: i % 10 === 0,
                read: i % 2 === 0,
                translation: {
                  text: translated,
                  sourceText: body,
                  sourceLanguage: "en",
                  targetLanguage: "ja",
                },
              });
            }
            tx.oncomplete = () => resolve();
            tx.onerror = tx.onabort = () => reject(tx.error);
          });
        }
        db.close();
      }, tagged);
      report.seedMs = Date.now() - seedStart;
      const readyStart = Date.now();
      await page.reload();
      await page.getByLabel("保存領域の記事を検索").fill("不存在");
      await expect(page.locator("#rss-search-status")).toHaveText(
        "0件 · 0–0件を表示",
        { timeout: 120000 },
      );
      report.loadAndPrepareMs = Date.now() - readyStart;
      const writer = await context.newPage();
      // Same origin, no app: the writer owns one explicit transaction at a time.
      await writer.goto("/favicon.ico");
      const cases: {
        query: string;
        expected: string[];
        total: number;
        filter?: string;
        action?: "filter";
      }[] = [
        {
          query: "ＳＱＬｉｔｅ 099999",
          expected: ["Article 099999"],
          total: 1,
        },
        {
          query: "対象集合",
          expected: Array.from(
            { length: 50 },
            (_, i) => `Article ${(i * 100).toString().padStart(6, "0")}`,
          ),
          total: 1000,
        },
        { query: "does-not-exist", expected: [], total: 0 },
      ];
      if (tagged)
        cases.push(
          {
            query: "手動限定",
            expected: Array.from(
              { length: 50 },
              (_, i) => `Article ${(i * 3 + 1).toString().padStart(6, "0")}`,
            ),
            total: 33333,
          },
          {
            query: "対象集合",
            filter: "tag:手動限定",
            action: "filter",
            expected: Array.from(
              { length: 50 },
              (_, i) =>
                `Article ${(i * 300 + 100).toString().padStart(6, "0")}`,
            ),
            total: 333,
          },
          {
            query: "",
            filter: "tag:技術・開発",
            action: "filter",
            expected: Array.from(
              { length: 50 },
              (_, i) => `Article ${i.toString().padStart(6, "0")}`,
            ),
            total: 100000,
          },
          {
            query: "",
            filter: "state:手動設定",
            action: "filter",
            expected: Array.from(
              { length: 50 },
              (_, i) => `Article ${(i * 3 + 1).toString().padStart(6, "0")}`,
            ),
            total: 33333,
          },
        );
      for (const group of ["idle", "held-write", "continuous-write"]) {
        await writer.evaluate(async (group) => {
          const w = window as unknown as {
            stop: boolean;
            commits: number[];
            held: boolean;
          };
          w.stop = false;
          w.commits = [];
          w.held = false;
          if (group === "idle") return;
          const db = await new Promise<IDBDatabase>((resolve) => {
            const r = indexedDB.open("tsumiki.rss.v1");
            r.onsuccess = () => resolve(r.result);
          });
          if (group === "held-write") {
            const tx = db.transaction("articles", "readwrite");
            const store = tx.objectStore("articles");
            store.put({ id: "held-probe" });
            const keep = () => {
              if (w.stop) {
                tx.abort();
                db.close();
                return;
              }
              const r = store.get("000001");
              r.onsuccess = keep;
            };
            w.held = true;
            tx.onabort = () => {
              w.held = false;
            };
            keep();
          } else {
            const write = () => {
              if (w.stop) {
                db.close();
                return;
              }
              const tx = db.transaction("articles", "readwrite");
              const store = tx.objectStore("articles");
              const r = store.get("000001");
              r.onsuccess = () => {
                const body =
                  r.result.body.slice(0, 2000) +
                  " writer-generation-" +
                  w.commits.length;
                store.put({
                  ...r.result,
                  ...(r.result.manualTags
                    ? {
                        manualTags: [
                          ...r.result.manualTags.slice(0, 11),
                          "書込タグ" + w.commits.length,
                        ],
                      }
                    : {}),
                  body,
                  translation: {
                    ...r.result.translation,
                    sourceText: body,
                    text:
                      r.result.translation.text.slice(0, 600) +
                      " 書込世代" +
                      w.commits.length,
                  },
                });
              };
              tx.oncomplete = () => {
                w.commits.push(Date.now());
                const channel = new BroadcastChannel("tsumiki.rss.v1");
                channel.postMessage({ articleId: "000001" });
                channel.close();
                setTimeout(write, 20);
              };
            };
            write();
          }
        }, group);
        for (const c of cases) {
          if (tagged) {
            await page.getByLabel("タグで絞り込み").selectOption("");
            if (c.action === "filter")
              await page.getByLabel("保存領域の記事を検索").fill(c.query);
          }
          const start = Date.now();
          for (let i = 0; i < 30; i++) {
            const ms = await page.evaluate(
              async ({ query, expected, total, filter, action }) => {
                const input =
                  action === "filter"
                    ? document.querySelector<HTMLSelectElement>(
                        "#rss-tag-filter",
                      )!
                    : document.querySelector<HTMLInputElement>("#rss-search")!;
                const start = performance.now();
                input.value = action === "filter" ? filter! : query;
                input.dispatchEvent(
                  new Event(action === "filter" ? "change" : "input", {
                    bubbles: true,
                  }),
                );
                await new Promise<void>((resolve) =>
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => resolve()),
                  ),
                );
                const actual = Array.from(
                  document.querySelectorAll(".rss-article-title"),
                  (n) => n.textContent,
                );
                if (JSON.stringify(actual) !== JSON.stringify(expected))
                  throw Error("Incorrect result identities");
                if (
                  !document
                    .querySelector("#rss-search-status")
                    ?.textContent?.startsWith(`${total}件 ·`)
                )
                  throw Error("Incorrect total");
                return performance.now() - start;
              },
              c,
            );
            samples.push({
              group,
              query: c.query,
              ...(tagged
                ? { filter: c.filter ?? "", action: c.action ?? "query" }
                : {}),
              ms,
            });
          }
          const end = Date.now();
          if (group === "continuous-write") {
            const commits = await writer.evaluate(
              () => (window as unknown as { commits: number[] }).commits,
            );
            expect(commits.some((t) => t > start && t < end)).toBe(true);
          }
        }
        await writer.evaluate(() => {
          (window as unknown as { stop: boolean }).stop = true;
        });
        if (group === "held-write")
          await expect
            .poll(() =>
              writer.evaluate(
                () => (window as unknown as { held: boolean }).held,
              ),
            )
            .toBe(false);
        if (group === "continuous-write") {
          const commits = await writer.evaluate(
            () => (window as unknown as { commits: number[] }).commits,
          );
          report.writerCommits = commits;
          if (tagged) {
            await page.getByLabel("タグで絞り込み").selectOption("");
            await page.getByLabel("保存領域の記事を検索").fill("書込タグ");
            await expect(page.locator(".rss-article-title")).toHaveText(
              "Article 000001",
            );
          }
          // The changed original and translation must both become searchable in the reader.
          await page
            .getByLabel("保存領域の記事を検索")
            .fill("writer-generation-");
          await expect(page.locator(".rss-article-title")).toHaveText(
            "Article 000001",
          );
          await page.getByLabel("保存領域の記事を検索").fill("書込世代");
          await expect(page.locator(".rss-article-title")).toHaveText(
            "Article 000001",
          );
        }
      }
      // Full traversal of the 1,000 matches, independent of the page-size cap.
      await page.getByLabel("保存領域の記事を検索").fill("対象集合");
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        ids.push(
          ...(await page.locator(".rss-article-title").allTextContents()),
        );
        if (i < 19)
          await page
            .getByRole("button", { name: "次の50件", exact: true })
            .click();
      }
      expect(ids).toEqual(
        Array.from(
          { length: 1000 },
          (_, i) => `Article ${(i * 100).toString().padStart(6, "0")}`,
        ),
      );
      if (tagged) {
        await page.getByLabel("タグで絞り込み").selectOption("tag:手動限定");
        const taggedIds: string[] = [];
        for (let i = 0; i < 7; i++) {
          taggedIds.push(
            ...(await page.locator(".rss-article-title").allTextContents()),
          );
          if (i < 6)
            await page
              .getByRole("button", { name: "次の50件", exact: true })
              .click();
        }
        expect(taggedIds).toEqual(
          Array.from(
            { length: 333 },
            (_, i) => `Article ${(i * 300 + 100).toString().padStart(6, "0")}`,
          ),
        );
      }
      report.maxMs = Math.max(...samples.map((s) => s.ms));
      expect(
        samples.filter((s) => s.ms >= 200),
        "Every measured input-to-paint sample must be under 200 ms",
      ).toEqual([]);
      await writer.close();
    } finally {
      await writeFile(
        info.outputPath("measurements.json"),
        JSON.stringify(report, null, 2),
      );
    }
  });
}
