import { test, expect, type Page } from "@playwright/test";
import type { LearningRecord } from "../../src/article-learning";

async function fixture(page: Page, design = "studio") {
  await page.addInitScript((design) => {
    localStorage.setItem("quilna.reader.design.v1", design);
    localStorage.setItem("quilna.feed.refresh.v1", "0");
  }, design);
  await page.route("**/api/collection", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  await page.route("**/__learning", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Learning records</title>",
    }),
  );
  await page.goto("/__learning");
  await page.evaluate(async () => {
    const libraryPath = "/src/feed-store.ts",
      highlightPath = "/src/article-highlights.ts";
    const { openFeedLibrary } = await import(libraryPath);
    const { writeHighlight, highlightVersion } = await import(highlightPath);
    const db = await openFeedLibrary();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite");
      for (const id of ["a", "b"])
        tx.objectStore("articles").put({
          id,
          title: `Quote article ${id}`,
          url: `https://example.org/${id}`,
          feedUrl: "",
          published: null,
          fetchedAt: "2026-10-30T00:00:00Z",
          body: `Evidence ${id}. Another point.`,
          read: true,
          saved: id === "a",
          content: {
            text: `Evidence ${id}. Another point.`,
            title: `Quote article ${id}`,
            url: `https://example.org/${id}`,
            language: "en",
            fetchedAt: "2026-10-30T00:00:00Z",
          },
        });
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    db.close();
    for (const [index, id] of ["a", "b", "a"].entries()) {
      const text = `Evidence ${id}. Another point.`;
      const start = index === 2 ? 12 : 0,
        quote = index === 2 ? "Another point." : `Evidence ${id}.`;
      await writeHighlight(
        {
          id: `00000000-0000-4000-8000-00000000000${index}`,
          articleId: id,
          title: `Quote article ${id}`,
          url: `https://example.org/${id}`,
          view: "original",
          language: "en",
          version: await highlightVersion(text, text, "original", "en"),
          start,
          end: start + quote.length,
          quote,
          note: `メモ ${index}`,
          createdAt: "2026-10-30T00:00:00Z",
          revision: 1,
        },
        null,
      );
    }
  });
  await page.goto("/?view=feeds");
  await page
    .getByRole("button", { name: "Quote article a", exact: true })
    .click();
}
const panel = (page: Page) => page.locator("#rss-learning-records");
test("newer schema is refused without losing data or the entered draft", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("quilna.learning.v1", 2);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("future").put("keep", "marker");
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
      }),
  );
  await page.locator("#rss-highlights summary").click();
  await page
    .getByRole("button", { name: "この引用から学びを記録", exact: true })
    .first()
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "保存領域を開けませんでした",
  );
  await page
    .getByLabel("学んだこと・自分の説明（必須）")
    .fill("保存できるまで控えておく説明");
  await panel(page)
    .getByRole("button", { name: "学びの記録を再読み込み" })
    .click();
  await expect(page.getByLabel("学んだこと・自分の説明（必須）")).toHaveValue(
    "保存できるまで控えておく説明",
  );
  await expect(
    panel(page).getByRole("button", { name: "学びを保存", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open("quilna.learning.v1", 2);
          request.onsuccess = () => {
            const db = request.result,
              get = db
                .transaction("future")
                .objectStore("future")
                .get("marker");
            get.onsuccess = () => {
              resolve(get.result);
              db.close();
            };
            get.onerror = () => reject(get.error);
          };
          request.onerror = () => reject(request.error);
        }),
    ),
  ).toBe("keep");
});

test("keyboard workflow saves only after explicit input and submit", async ({
  page,
}) => {
  await fixture(page);
  await page.locator("#rss-highlights summary").focus();
  await page.evaluate(() =>
    speechSynthesis.dispatchEvent(new Event("voiceschanged")),
  );
  await expect(page.locator("#rss-highlights summary")).toBeFocused();
  await page.keyboard.press("Enter");
  const start = page
    .getByRole("button", { name: "この引用から学びを記録", exact: true })
    .first();
  await start.focus();
  await page.evaluate(() =>
    speechSynthesis.dispatchEvent(new Event("voiceschanged")),
  );
  await expect(start).toBeFocused();
  await page.keyboard.press("Enter");
  const input = page.getByLabel("学んだこと・自分の説明（必須）");
  await input.focus();
  await page.keyboard.type("A reflection in my own words.");
  expect(await read(page)).toEqual([]);
  await panel(page)
    .getByRole("button", { name: "学びを保存", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(records(page)).toContainText("A reflection in my own words.");
});
const records = (page: Page) =>
  panel(page).getByRole("list", { name: "保存した学び" });
async function begin(page: Page) {
  await page.locator("#rss-highlights summary").click();
  await page
    .getByRole("button", { name: "この引用から学びを記録", exact: true })
    .first()
    .click();
  await expect(
    panel(page).getByRole("button", { name: "学びを保存", exact: true }),
  ).toBeEnabled();
}
async function save(
  page: Page,
  text = "自分の言葉で説明する <img src=x onerror=alert(1)>",
) {
  await page.getByLabel("学んだこと・自分の説明（必須）").fill(text);
  await panel(page)
    .getByRole("button", { name: "学びを保存", exact: true })
    .click();
  await expect(records(page)).toContainText(text);
}
async function read(page: Page): Promise<LearningRecord[]> {
  return page.evaluate(async () => {
    const path = "/src/article-learning.ts";
    return (await import(path)).readLearning("a");
  });
}
for (const design of ["studio", "editorial", "focus"])
  test(`${design} explicitly records, restores, edits and deletes learning independently`, async ({
    page,
  }, info) => {
    await fixture(page, design);
    await expect(panel(page).locator("details")).not.toHaveAttribute(
      "open",
      "",
    );
    expect(await read(page)).toEqual([]);
    await begin(page);
    await panel(page)
      .getByRole("button", { name: "学びを保存", exact: true })
      .click();
    await expect(panel(page).getByRole("status")).toContainText("1〜4000文字");
    expect(await read(page)).toEqual([]);
    await save(page);
    await expect(records(page).locator("img,script")).toHaveCount(0);
    const initial = (await read(page))[0];
    expect(initial.source.quote).toBe("Evidence a.");
    expect(initial.source.note).toBe("メモ 0");
    await page.reload();
    await page
      .getByRole("button", { name: "Quote article a", exact: true })
      .click();
    await panel(page).locator("summary").click();
    await expect(records(page)).toContainText(initial.reflection);
    await panel(page)
      .getByRole("button", { name: "学びを編集", exact: true })
      .click();
    await save(page, "あとから自分の説明を修正");
    const updated = (await read(page))[0];
    expect(updated.source).toEqual(initial.source);
    expect(updated.revision).toBe(2);
    await panel(page)
      .getByRole("button", { name: "学びの引用を本文で確認" })
      .click();
    await expect(panel(page).getByRole("status")).toContainText(
      "根拠の本文を選択しました",
    );
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(
      "Evidence a.",
    );
    await page.setViewportSize({ width: 320, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await panel(page).screenshot({ path: info.outputPath("learning.png") });
    page.once("dialog", (d) => d.accept());
    await panel(page)
      .getByRole("button", { name: "学びを削除", exact: true })
      .click();
    await expect(panel(page).getByRole("status")).toContainText("0件の学び");
    expect(
      await page.evaluate(async () => {
        const libraryPath = "/src/feed-store.ts",
          highlightPath = "/src/article-highlights.ts";
        const db = await (await import(libraryPath)).openFeedLibrary();
        const article = await new Promise<{ read: boolean; saved: boolean }>(
          (resolve) => {
            const get = db
              .transaction("articles")
              .objectStore("articles")
              .get("a");
            get.onsuccess = () => resolve(get.result);
          },
        );
        const highlights = await (
          await import(highlightPath)
        ).readHighlights("a");
        return {
          read: article.read,
          saved: article.saved,
          quotes: highlights.length,
        };
      }),
    ).toEqual({ read: true, saved: true, quotes: 2 });
  });

test("write failures and another quote selection retain the unsaved reflection", async ({
  page,
}) => {
  await fixture(page);
  await begin(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.transaction.db.name === "quilna.learning.v1")
        throw new DOMException("full", "QuotaExceededError");
      return put.apply(this, args);
    };
    Object.assign(window, {
      restoreLearning: () => {
        IDBObjectStore.prototype.put = put;
      },
    });
  });
  await page
    .getByLabel("学んだこと・自分の説明（必須）")
    .fill("失敗しても残す説明");
  await panel(page)
    .getByRole("button", { name: "学びを保存", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "保存できませんでした",
  );
  await page
    .getByRole("button", { name: "この引用から学びを記録", exact: true })
    .last()
    .click();
  await expect(page.getByLabel("学んだこと・自分の説明（必須）")).toHaveValue(
    "失敗しても残す説明",
  );
  await expect(panel(page).getByRole("status")).toContainText(
    "保存できませんでした",
  );
  await page.evaluate(() =>
    (window as unknown as { restoreLearning: () => void }).restoreLearning(),
  );
  await save(page, "失敗しても残す説明");
  expect((await read(page))[0].source.quote).toBe("Evidence a.");
});

test("snapshots survive deleted highlights and changed source text without moving their offsets", async ({
  page,
}) => {
  await fixture(page);
  await begin(page);
  await save(page);
  const before = (await read(page))[0];
  await page.evaluate(async () => {
    const h = "/src/article-highlights.ts",
      lib = "/src/feed-store.ts";
    const { readHighlights, writeHighlight } = await import(h);
    for (const quote of await readHighlights("a"))
      await writeHighlight(quote, quote.revision, true);
    const db = await (await import(lib)).openFeedLibrary();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite"),
        store = tx.objectStore("articles"),
        get = store.get("a");
      get.onsuccess = () =>
        store.put({
          ...get.result,
          content: {
            ...get.result.content,
            text: "Changed evidence. Another point.",
          },
        });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Quote article a", exact: true })
    .click();
  await panel(page).locator("summary").click();
  await expect(records(page)).toContainText("Evidence a.");
  await panel(page)
    .getByRole("button", { name: "学びの引用を本文で確認" })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "別の本文の版・言語",
  );
  expect((await read(page))[0]).toEqual(before);
});

test("competing edit notification preserves a draft and rejects stale overwrites", async ({
  page,
}) => {
  await fixture(page);
  await begin(page);
  await save(page, "保存した説明");
  await panel(page)
    .getByRole("button", { name: "学びを編集", exact: true })
    .click();
  await page.getByLabel("学んだこと・自分の説明（必須）").fill("こちらの編集");
  await page.evaluate(async () => {
    const path = "/src/article-learning.ts";
    const { readLearning, writeLearning } = await import(path),
      old = (await readLearning("a"))[0];
    await writeLearning(
      { ...old, reflection: "別の画面の編集", revision: old.revision + 1 },
      old.revision,
    );
    const channel = new BroadcastChannel("quilna.learning.v1");
    channel.postMessage("a");
    channel.close();
  });
  await expect(records(page)).toContainText("別の画面の編集");
  await expect(page.getByLabel("学んだこと・自分の説明（必須）")).toHaveValue(
    "こちらの編集",
  );
  await panel(page)
    .getByRole("button", { name: "学びを保存", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "別の画面で記録が変わりました",
  );
  expect((await read(page))[0].reflection).toBe("別の画面の編集");
  await panel(page).getByRole("button", { name: "学びの編集をやめる" }).click();
  await panel(page)
    .getByRole("button", { name: "学びを編集", exact: true })
    .click();
  await expect(page.getByLabel("学んだこと・自分の説明（必須）")).toHaveValue(
    "別の画面の編集",
  );
  await save(page, "両方を確認して修正");
});

test("storage refuses changed source, stale deletion and over-capacity simultaneous writes", async ({
  page,
}) => {
  await fixture(page);
  await begin(page);
  await save(page, "基準");
  const result = await page.evaluate(async () => {
    const path = "/src/article-learning.ts";
    const { readLearning, writeLearning, openLearning, learningLimit } =
      await import(path);
    const old = (await readLearning("a"))[0];
    const sourceChange = await Promise.allSettled([
      writeLearning(
        {
          ...old,
          source: { ...old.source, quote: "Evidence z." },
          revision: 2,
        },
        1,
      ),
    ]);
    await writeLearning({ ...old, reflection: "更新", revision: 2 }, 1);
    const staleDelete = await Promise.allSettled([writeLearning(old, 1, true)]);
    const db = await openLearning();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("records", "readwrite");
      for (let i = 1; i < learningLimit - 1; i++)
        tx.objectStore("records").put({ ...old, id: crypto.randomUUID() });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    const writes = await Promise.allSettled(
      [0, 1].map(() =>
        writeLearning({ ...old, id: crypto.randomUUID() }, null),
      ),
    );
    const stored = await readLearning("a");
    return {
      sourceChange: sourceChange[0].status,
      staleDelete: staleDelete[0].status,
      writes: writes.map((x) => x.status).sort(),
      count: stored.length,
      source: stored.find((r: LearningRecord) => r.id === old.id).source,
    };
  });
  expect(result.sourceChange).toBe("rejected");
  expect(result.staleDelete).toBe("rejected");
  expect(result.writes).toEqual(["fulfilled", "rejected"]);
  expect(result.count).toBe(200);
  expect(result.source.quote).toBe("Evidence a.");
});

test("failed deletion keeps the record and allows a retry", async ({
  page,
}) => {
  await fixture(page);
  await begin(page);
  await save(page, "削除失敗の記録");
  await page.evaluate(() => {
    const remove = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (
      ...args: Parameters<typeof remove>
    ) {
      if (this.transaction.db.name === "quilna.learning.v1")
        throw new DOMException("failed", "UnknownError");
      return remove.apply(this, args);
    };
    Object.assign(window, {
      restoreLearningDelete: () => {
        IDBObjectStore.prototype.delete = remove;
      },
    });
  });
  page.once("dialog", (d) => d.accept());
  await panel(page)
    .getByRole("button", { name: "学びを削除", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "保存できませんでした",
  );
  await expect(records(page)).toContainText("削除失敗の記録");
  await page.evaluate(() =>
    (
      window as unknown as { restoreLearningDelete: () => void }
    ).restoreLearningDelete(),
  );
  page.once("dialog", (d) => d.accept());
  await panel(page)
    .getByRole("button", { name: "学びを削除", exact: true })
    .click();
  await expect(panel(page).getByRole("status")).toContainText("0件の学び");
});

for (const outcome of ["success", "failure"] as const)
  test(`late ${outcome} from an old article cannot replace a newer reading context`, async ({
    page,
  }) => {
    await fixture(page);
    await begin(page);
    await page.evaluate((outcome) => {
      const transaction = IDBDatabase.prototype.transaction;
      const getAll = IDBIndex.prototype.getAll;
      let first = true,
        held: IDBTransaction | undefined;
      IDBDatabase.prototype.transaction = function (
        ...args: Parameters<IDBDatabase["transaction"]>
      ) {
        const tx = transaction.apply(this, args);
        if (
          this.name === "quilna.learning.v1" &&
          tx.mode === "readonly" &&
          first
        ) {
          first = false;
          held = tx;
          for (const eventName of ["complete", "abort"] as const)
            Object.defineProperty(tx, `on${eventName}`, {
              configurable: true,
              set(handler: (event: Event) => void) {
                tx.addEventListener(
                  eventName,
                  (event) =>
                    Object.assign(window, {
                      learningReadHeld: true,
                      releaseLearningRead: () => handler.call(tx, event),
                    }),
                  { once: true },
                );
              },
            });
        }
        return tx;
      };
      IDBIndex.prototype.getAll = function (...args) {
        const r = getAll.apply(this, args);
        if (this.objectStore.transaction === held && outcome === "failure")
          r.addEventListener("success", () => held!.abort());
        return r;
      };
    }, outcome);
    await page
      .getByRole("button", { name: "学びの記録を再読み込み", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { learningReadHeld?: boolean })
              .learningReadHeld,
        ),
      )
      .toBe(true);
    await page
      .getByRole("button", { name: "記事一覧へ", exact: false })
      .click();
    await page
      .getByRole("button", { name: "Quote article b", exact: true })
      .click();
    await panel(page).locator("summary").click();
    await expect(panel(page).getByRole("status")).toContainText("0件の学び");
    await page.evaluate(() =>
      (
        window as unknown as { releaseLearningRead: () => void }
      ).releaseLearningRead(),
    );
    await expect(panel(page).getByRole("status")).toContainText("0件の学び");
    await expect(
      panel(page).getByRole("button", { name: "学びの記録を再読み込み" }),
    ).toBeEnabled();
  });

test("a submitted write finishes for its original article after navigation", async ({
  page,
}) => {
  await fixture(page);
  await begin(page);
  await page.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction;
    let first = true;
    IDBDatabase.prototype.transaction = function (
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      const tx = transaction.apply(this, args);
      if (
        this.name === "quilna.learning.v1" &&
        tx.mode === "readwrite" &&
        first
      ) {
        first = false;
        Object.defineProperty(tx, "oncomplete", {
          configurable: true,
          set(handler: (event: Event) => void) {
            tx.addEventListener(
              "complete",
              (event) =>
                Object.assign(window, {
                  learningWriteHeld: true,
                  releaseLearningWrite: () => handler.call(tx, event),
                }),
              { once: true },
            );
          },
        });
      }
      return tx;
    };
  });
  await page.getByLabel("学んだこと・自分の説明（必須）").fill("記事Aの学び");
  await panel(page)
    .getByRole("button", { name: "学びを保存", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { learningWriteHeld?: boolean })
            .learningWriteHeld,
      ),
    )
    .toBe(true);
  await expect(
    page.getByLabel("学んだこと・自分の説明（必須）"),
  ).toBeDisabled();
  await page.getByRole("button", { name: "記事一覧へ", exact: false }).click();
  await page
    .getByRole("button", { name: "Quote article b", exact: true })
    .click();
  await panel(page).locator("summary").click();
  await expect(panel(page).getByRole("status")).toContainText("0件の学び");
  await page.evaluate(() =>
    (
      window as unknown as { releaseLearningWrite: () => void }
    ).releaseLearningWrite(),
  );
  await expect(panel(page).getByRole("status")).toContainText("0件の学び");
  expect((await read(page))[0].reflection).toBe("記事Aの学び");
  expect(
    await page.evaluate(async () => {
      const path = "/src/article-learning.ts";
      return (await import(path)).readLearning("b");
    }),
  ).toEqual([]);
  await page.locator("#rss-highlights summary").click();
  await page
    .getByRole("button", { name: "この引用から学びを記録", exact: true })
    .first()
    .click();
  await save(page, "記事Bの学び");
});

test("starting a reflection cancels a delayed source jump", async ({
  page,
}) => {
  await fixture(page);
  await begin(page);
  await save(page, "既存の学び");
  await page.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let first = true;
    crypto.subtle.digest = (...args: Parameters<typeof digest>) => {
      if (!first) return digest(...args);
      first = false;
      return new Promise<ArrayBuffer>((resolve, reject) => {
        Object.assign(window, {
          learningJumpHeld: true,
          releaseLearningJump: () => digest(...args).then(resolve, reject),
        });
      });
    };
    document.getSelection()?.removeAllRanges();
  });
  await panel(page)
    .getByRole("button", { name: "学びの引用を本文で確認" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { learningJumpHeld?: boolean })
            .learningJumpHeld,
      ),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "この引用から学びを記録", exact: true })
    .last()
    .click();
  await page
    .getByLabel("学んだこと・自分の説明（必須）")
    .fill("次の引用を考える");
  await page.evaluate(() =>
    (
      window as unknown as { releaseLearningJump: () => Promise<void> }
    ).releaseLearningJump(),
  );
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(
    "",
  );
  await expect(page.getByLabel("学んだこと・自分の説明（必須）")).toHaveValue(
    "次の引用を考える",
  );
  await expect(panel(page).getByRole("status")).not.toContainText(
    "根拠の本文を選択しました",
  );
});
