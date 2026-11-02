import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { sharedTextbookDigest } from "../../src/shared-textbook-format";

const fixturePath = "tests/fixtures/shared-textbook-v1.json";
const fixture = new TextDecoder().decode(await readFile(fixturePath));
const title = "合成教材：モデルと実行";
function modifiedRecord(
  mutate: (record: ReturnType<typeof JSON.parse>) => void,
) {
  const envelope = JSON.parse(fixture),
    record = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(envelope.record), (c) => c.charCodeAt(0)),
      ),
    );
  mutate(record);
  envelope.record = btoa(
    Array.from(new TextEncoder().encode(JSON.stringify(record)), (n) =>
      String.fromCharCode(n),
    ).join(""),
  );
  return JSON.stringify(envelope);
}
async function selectFile(page: Page, raw: string) {
  const path = test.info().outputPath(`shared-${crypto.randomUUID()}.json`);
  await writeFile(path, raw);
  await page
    .getByLabel("教材JSONファイル（540,000バイト以下）")
    .setInputFiles(path);
}
async function upload(page: Page, raw = fixture) {
  await selectFile(page, raw);
  await expect(
    page.getByRole("button", {
      name: "確認してこのブラウザに取り込む",
      exact: true,
    }),
  ).toBeVisible();
}
async function importBook(page: Page, raw = fixture) {
  await upload(page, raw);
  await page
    .getByRole("button", {
      name: "確認してこのブラウザに取り込む",
      exact: true,
    })
    .click();
  await expect(page.getByRole("status")).toContainText("教材を取り込みました");
}
async function openBook(page: Page, version = 7) {
  await page
    .getByRole("button", {
      name: `${title} · 版 ${version}を読む`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("navigation", { name: "教材の目次", exact: true }),
  ).toBeVisible();
}
async function exported(page: Page) {
  await page.getByText("教材ファイルを書き出す", { exact: true }).click();
  await page
    .getByLabel("出典と引用を確認し、この教材ファイルを書き出す", {
      exact: true,
    })
    .check();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "教材ファイルをダウンロード", exact: true })
    .click();
  const path = await (await download).path();
  if (!path) throw Error("Missing download");
  return new TextDecoder().decode(await readFile(path));
}
test("settings leads to the separate file library, preview/cancel keeps the existing demo and private state", async ({
  page,
}) => {
  await page.goto("/?view=feeds");
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page
    .getByRole("link", { name: "教材ファイルの取り込み・読書へ" })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "受け取った教材" }),
  ).toBeVisible();
  await expect(page).toHaveTitle("受け取った教材 | Quilna");
  await page.evaluate(() =>
    localStorage.setItem("fieldnotes.history.v1", "PRIVATE_HISTORY_SENTINEL"),
  );
  await upload(page);
  await expect(
    page.getByRole("region", { name: "教材ファイルのプレビュー" }),
  ).toContainText("版 7");
  await page
    .getByRole("button", { name: "取り込みを取り消す", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "取り込みを取り消しました",
  );
  await expect(
    page.getByRole("region", { name: "保存した教材" }),
  ).toContainText("まだ教材を取り込んでいません");
  expect(
    await page.evaluate(() => localStorage.getItem("fieldnotes.history.v1")),
  ).toBe("PRIVATE_HISTORY_SENTINEL");
  await importBook(page);
  await page.reload();
  await openBook(page);
  await expect(page).toHaveTitle(`${title} · 版 7 | Quilna`);
  await expect(
    page.getByLabel("教材JSONファイル（540,000バイト以下）"),
  ).toBeHidden();
  await page
    .getByRole("button", { name: "教材一覧へ戻る", exact: true })
    .click();
  await expect(page).toHaveTitle("受け取った教材 | Quilna");
  await expect(
    page.getByLabel("教材JSONファイル（540,000バイト以下）"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `${title} · 版 7を読む`, exact: true }),
  ).toBeFocused();
  await importBook(
    page,
    modifiedRecord((r) => {
      r.version = 8;
    }),
  );
  await openBook(page, 8);
  await page
    .getByRole("button", { name: "教材一覧へ戻る", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: `${title} · 版 8を読む`, exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(() => localStorage.getItem("fieldnotes.history.v1")),
  ).toBe("PRIVATE_HISTORY_SENTINEL");
});
test("two disposable recipient profiles preserve the exact file and have separate answers after reload and re-export", async ({
  page,
  browser,
}) => {
  await page.goto("/?view=textbooks");
  await importBook(page);
  await openBook(page);
  const group = page
    .getByRole("group", {
      name: "モデルの文章だけで確認できるのは？",
      exact: true,
    })
    .first();
  await group.getByLabel("文章が出力された", { exact: true }).check();
  await group
    .getByRole("button", { name: "回答して保存", exact: true })
    .click();
  await expect(
    page.getByText("正答です。回答を保存しました。", { exact: true }),
  ).toBeVisible();
  const raw = await exported(page);
  expect(raw).toBe(fixture);
  const receiver = await browser.newContext({
    viewport: page.viewportSize() ?? undefined,
  });
  try {
    const other = await receiver.newPage();
    await other.goto("http://127.0.0.1:5197/?view=textbooks");
    await importBook(other, raw);
    await openBook(other);
    await expect(
      other.getByText("まだ回答を保存していません。", { exact: true }),
    ).toHaveCount(2);
    const secondGroup = other
      .getByRole("group", {
        name: "モデルの文章だけで確認できるのは？",
        exact: true,
      })
      .first();
    await secondGroup
      .getByLabel("ファイルの保存が成功した", { exact: true })
      .check();
    await secondGroup
      .getByRole("button", { name: "回答して保存", exact: true })
      .click();
    await expect(
      other.getByText("回答を保存しました。解説を確認してください。", {
        exact: true,
      }),
    ).toBeVisible();
    expect(await exported(other)).toBe(raw);
    await other.reload();
    await openBook(other);
    await expect(
      other.getByText(/ファイルの保存が成功した · 別の選択肢/),
    ).toHaveCount(1);
    await page.reload();
    await openBook(page);
    await expect(page.getByText(/文章が出力された · 正答/)).toHaveCount(1);
    await expect(
      page.getByText(/ファイルの保存が成功した · 別の選択肢/),
    ).toHaveCount(0);
  } finally {
    await receiver.close();
  }
});
test("an identical reimport is idempotent; conflicting origin/version, invalid bytes and private extras preserve stored books and answers", async ({
  page,
}) => {
  await page.goto("/?view=textbooks");
  await importBook(page);
  await importBook(page, JSON.stringify(JSON.parse(fixture), null, 2));
  await expect(
    page.getByRole("button", { name: `${title} · 版 7を読む`, exact: true }),
  ).toHaveCount(1);
  await upload(
    page,
    modifiedRecord((r) => {
      r.createdAt++;
    }),
  );
  await page
    .getByRole("button", {
      name: "確認してこのブラウザに取り込む",
      exact: true,
    })
    .click();
  await expect(page.getByRole("status")).toContainText("上書きしませんでした");
  for (const raw of [
    "{",
    JSON.stringify({ ...JSON.parse(fixture), answers: "PRIVATE" }),
    modifiedRecord((r) => {
      r.sessionToken = "PRIVATE";
    }),
    " ".repeat(540_001),
  ]) {
    await selectFile(page, raw);
    await expect(
      page.getByRole("button", {
        name: "確認してこのブラウザに取り込む",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(page.getByRole("status")).not.toBeEmpty();
  }
  await page.reload();
  await openBook(page);
  expect(await exported(page)).toBe(fixture);
});
test("import and answer write failures keep the preview/selection and allow explicit retry without replacing private state", async ({
  page,
}) => {
  await page.goto("/?view=textbooks");
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.add;
    const state = window as unknown as { failSharedStore: string };
    state.failSharedStore = "books";
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === state.failSharedStore)
        throw new DOMException("Synthetic full disk", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  await upload(page);
  await page
    .getByRole("button", {
      name: "確認してこのブラウザに取り込む",
      exact: true,
    })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "保存領域を利用できません",
  );
  await expect(
    page.getByRole("button", {
      name: "確認してこのブラウザに取り込む",
      exact: true,
    }),
  ).toBeEnabled();
  await page.evaluate(() => {
    (window as unknown as { failSharedStore: string }).failSharedStore = "";
  });
  await page
    .getByRole("button", {
      name: "確認してこのブラウザに取り込む",
      exact: true,
    })
    .click();
  await expect(page.getByRole("status")).toContainText("教材を取り込みました");
  await openBook(page);
  await page.evaluate(() => {
    (window as unknown as { failSharedStore: string }).failSharedStore =
      "answers";
  });
  const group = page
    .getByRole("group", {
      name: "モデルの文章だけで確認できるのは？",
      exact: true,
    })
    .first();
  await group.getByLabel("文章が出力された", { exact: true }).check();
  await group
    .getByRole("button", { name: "回答して保存", exact: true })
    .click();
  await expect(
    page.getByText("選択は保持しています。「回答して保存」で再試行できます。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    group.getByLabel("文章が出力された", { exact: true }),
  ).toBeChecked();
  await page.evaluate(() => {
    (window as unknown as { failSharedStore: string }).failSharedStore = "";
  });
  await group
    .getByRole("button", { name: "回答して保存", exact: true })
    .click();
  await expect(
    page.getByText("正答です。回答を保存しました。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/文章が出力された · 正答/)).toHaveCount(1);
});
test("failed answer reads leave the textbook readable and refuse new answers until the existing history can be checked", async ({
  page,
}) => {
  await page.goto("/?view=textbooks");
  await importBook(page);
  await page.evaluate(() => {
    const original = IDBIndex.prototype.getAll;
    const state = window as unknown as { failSharedReads: boolean };
    state.failSharedReads = true;
    IDBIndex.prototype.getAll = function (...args) {
      if (this.objectStore.name === "answers" && state.failSharedReads)
        throw Error("Synthetic read failure");
      return original.apply(this, args);
    };
  });
  await openBook(page);
  await expect(
    page.getByText(
      "回答履歴を確認できません。保存済みデータの上書きを止めています。",
      { exact: true },
    ),
  ).toHaveCount(2);
  await expect(
    page
      .getByRole("group", {
        name: "モデルの文章だけで確認できるのは？",
        exact: true,
      })
      .first()
      .getByRole("button", { name: "回答して保存", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "1. モデルの出力", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { failSharedReads: boolean }).failSharedReads = false;
  });
  await page
    .getByRole("button", { name: "回答の読み込みを再試行", exact: true })
    .click();
  await expect(
    page.getByText("まだ回答を保存していません。", { exact: true }),
  ).toHaveCount(2);
});
test("simultaneous conflicting imports are atomic and a corrupt retained file is never reset or replaced", async ({
  page,
  context,
}) => {
  await page.goto("/?view=textbooks");
  const other = await context.newPage();
  await other.goto("/?view=textbooks");
  const alternate = modifiedRecord((r) => {
    r.createdAt++;
  });
  const run = (p: Page, raw: string) =>
    p.evaluate(async (raw) => {
      const path = "/src/shared-textbook-store.ts";
      const api = await import(path);
      try {
        await api.importSharedTextbook(raw);
        return true;
      } catch {
        return false;
      }
    }, raw);
  const results = await Promise.all([
    run(page, fixture),
    run(other, alternate),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const saved = await page.evaluate(async () => {
    const path = "/src/shared-textbook-store.ts";
    const api = await import(path);
    return (await api.listSharedTextbooks()).map((b: { raw: string }) => b.raw);
  });
  expect(saved).toEqual([results[0] ? fixture : alternate]);
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("quilna.shared-textbooks.v1", 1);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("books", "readwrite"),
          books = tx.objectStore("books"),
          all = books.getAll();
        all.onsuccess = () =>
          books.put({ id: all.result[0].id, raw: "CORRUPT_PRESERVE" });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "教材一覧を再試行", exact: true }),
  ).toBeVisible();
  await upload(page, saved[0]);
  await page
    .getByRole("button", {
      name: "確認してこのブラウザに取り込む",
      exact: true,
    })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "保存領域を利用できません",
  );
  const raw = await page.evaluate(
    async () =>
      new Promise<string>((resolve) => {
        const request = indexedDB.open("quilna.shared-textbooks.v1", 1);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("books"),
            all = tx.objectStore("books").getAll();
          all.onsuccess = () => resolve(all.result[0].raw);
          tx.oncomplete = () => db.close();
        };
      }),
  );
  expect(raw).toBe("CORRUPT_PRESERVE");
  await other.close();
});

test("a late failed file read cannot clear a newer preview, and invalid UTF-8 has a usable error", async ({
  page,
}) => {
  await page.goto("/?view=textbooks");
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    let first = true;
    const state = window as unknown as { releaseOldRead: () => void };
    File.prototype.arrayBuffer = function () {
      const bytes = original.call(this);
      if (!first) return bytes;
      first = false;
      return new Promise<ArrayBuffer>((resolve) => {
        state.releaseOldRead = () => {
          void bytes.then(resolve);
        };
      });
    };
  });
  await selectFile(page, "{");
  await expect(page.getByRole("status")).toHaveText(
    "教材ファイルを確認しています。",
  );
  await upload(
    page,
    modifiedRecord((r) => {
      r.version = 8;
    }),
  );
  await page.evaluate(() => {
    (window as unknown as { releaseOldRead: () => void }).releaseOldRead();
  });
  await expect(page.getByRole("status")).toHaveText(
    "まだ保存していません。教材と出典を確認してください。",
  );
  await expect(
    page.getByRole("region", { name: "教材ファイルのプレビュー" }),
  ).toContainText("版 8");
  const path = test.info().outputPath("invalid-utf8.json");
  await writeFile(path, new Uint8Array([0xff, 0xfe]));
  await page
    .getByLabel("教材JSONファイル（540,000バイト以下）")
    .setInputFiles(path);
  await expect(page.getByRole("status")).toContainText(
    "UTF-8のJSONファイルを選んで再試行",
  );
  await expect(
    page.getByRole("button", {
      name: "確認してこのブラウザに取り込む",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("imported markup stays text, evidence is inspectable, and the 320px reader fetches no source or model automatically", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const markup =
    '<img src="https://untrusted.example/leak" onerror="alert(1)"><script>window.SHARED_EXECUTED=1</script>';
  const envelope = JSON.parse(fixture),
    record = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(envelope.record), (c) => c.charCodeAt(0)),
      ),
    );
  const draft = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(record.draft), (c) => c.charCodeAt(0)),
    ),
  );
  draft.lessons[0].content.paragraphs = [markup];
  const draftBytes = new TextEncoder().encode(JSON.stringify(draft));
  record.draft = btoa(
    Array.from(draftBytes, (n) => String.fromCharCode(n)).join(""),
  );
  const review = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(record.review), (c) => c.charCodeAt(0)),
    ),
  );
  review.draftDigest = await sharedTextbookDigest(draftBytes);
  record.review = btoa(
    Array.from(new TextEncoder().encode(JSON.stringify(review)), (n) =>
      String.fromCharCode(n),
    ).join(""),
  );
  envelope.record = btoa(
    Array.from(new TextEncoder().encode(JSON.stringify(record)), (n) =>
      String.fromCharCode(n),
    ).join(""),
  );
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto("/?view=textbooks");
  await importBook(page, JSON.stringify(envelope));
  await openBook(page);
  await expect(page.getByText(markup, { exact: true })).toBeVisible();
  await expect(page.locator("main img, main script, main iframe")).toHaveCount(
    0,
  );
  await page.getByText("説明の根拠", { exact: true }).first().click();
  await expect(
    page.getByRole("link", { name: "元の出典を開く", exact: true }).first(),
  ).toHaveAttribute("href", "https://generation-fixture.invalid/model");
  expect(
    requests.every((url) => new URL(url).origin === "http://127.0.0.1:5197"),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("the 100-edition limit is atomic across competing imports and never evicts a retained file", async ({
  page,
}) => {
  await page.goto("/?view=textbooks");
  await expect(
    page.getByRole("region", { name: "保存した教材" }),
  ).toContainText("まだ教材を取り込んでいません");
  await page.evaluate(async (raw) => {
    const envelope = JSON.parse(raw),
      original = JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(atob(envelope.record), (c) => c.charCodeAt(0)),
        ),
      );
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("quilna.shared-textbooks.v1", 1);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("books", "readwrite"),
          store = tx.objectStore("books");
        for (let i = 0; i < 99; i++) {
          const bookID = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`,
            record = { ...original, bookID };
          const encoded = btoa(
            Array.from(new TextEncoder().encode(JSON.stringify(record)), (n) =>
              String.fromCharCode(n),
            ).join(""),
          );
          store.add({
            id: `${bookID}:7`,
            raw: JSON.stringify({ ...envelope, record: encoded }),
          });
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, fixture);
  const alternate = modifiedRecord((r) => {
    r.version = 8;
  });
  const results = await page.evaluate(
    async ([a, b]) => {
      const path = "/src/shared-textbook-store.ts",
        api = await import(path);
      const outcomes = await Promise.all(
        [a, b].map(async (raw) => {
          try {
            await api.importSharedTextbook(raw);
            return true;
          } catch {
            return false;
          }
        }),
      );
      await api.importSharedTextbook(outcomes[0] ? a : b);
      return {
        outcomes,
        books: (await api.listSharedTextbooks()).map(
          (book: { id: string }) => book.id,
        ),
      };
    },
    [fixture, alternate],
  );
  expect(results.outcomes.filter(Boolean)).toHaveLength(1);
  expect(results.books).toHaveLength(100);
  for (let i = 0; i < 99; i++)
    expect(results.books).toContain(
      `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}:7`,
    );
});

test("a future database version is reported without resetting its books or unknown stores", async ({
  page,
}) => {
  await page.goto("/?view=textbooks");
  await importBook(page);
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("quilna.shared-textbooks.v1", 2);
      request.onupgradeneeded = () =>
        request.result
          .createObjectStore("future")
          .put("PRESERVE_FUTURE", "marker");
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "教材一覧を再試行", exact: true }),
  ).toBeVisible();
  const retained = await page.evaluate(
    async () =>
      new Promise<{ version: number; marker: string; raw: string }>(
        (resolve, reject) => {
          const request = indexedDB.open("quilna.shared-textbooks.v1");
          request.onsuccess = () => {
            const db = request.result,
              tx = db.transaction(["books", "future"]),
              marker = tx.objectStore("future").get("marker"),
              books = tx.objectStore("books").getAll();
            tx.oncomplete = () => {
              resolve({
                version: db.version,
                marker: marker.result,
                raw: books.result[0].raw,
              });
              db.close();
            };
            tx.onerror = () => reject(tx.error);
          };
        },
      ),
  );
  expect(retained).toEqual({
    version: 2,
    marker: "PRESERVE_FUTURE",
    raw: fixture,
  });
});

test("10,000 retained answers are paged without loss and capacity failure preserves the selection and all previous attempts", async ({
  page,
}) => {
  await page.goto("/?view=textbooks");
  await importBook(page);
  await page.evaluate(async () => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path),
      [book] = await api.listSharedTextbooks(),
      content = book.draft.lessons[0].content;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("quilna.shared-textbooks.v1", 1);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("answers", "readwrite"),
          store = tx.objectStore("answers");
        for (let i = 0; i < 10_000; i++)
          store.add({
            id: `10000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`,
            textbook: book.digest,
            section: content.id,
            question: content.question.id,
            option: content.question.correctOptionID,
            correct: true,
            time: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
          });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await openBook(page);
  await expect(
    page.getByText("回答 10000件 · 1 / 500ページ（新しい回答から20件ずつ）", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/文章が出力された · 正答/)).toHaveCount(20);
  await page.getByRole("button", { name: "古い20件", exact: true }).click();
  await expect(
    page.getByText("回答 10000件 · 2 / 500ページ（新しい回答から20件ずつ）", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新しい20件", exact: true }).click();
  const group = page
    .getByRole("group", {
      name: "モデルの文章だけで確認できるのは？",
      exact: true,
    })
    .first();
  await group.getByLabel("文章が出力された", { exact: true }).check();
  await group
    .getByRole("button", { name: "回答して保存", exact: true })
    .click();
  await expect(
    page.getByText(
      "この教材の回答保存上限（10,000件）に達しました。以前の回答は保持しています。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    group.getByLabel("文章が出力された", { exact: true }),
  ).toBeChecked();
  const count = await page.evaluate(async () => {
    const path = "/src/shared-textbook-store.ts",
      api = await import(path),
      [book] = await api.listSharedTextbooks();
    return (await api.readSharedAnswers(book)).length;
  });
  expect(count).toBe(10_000);
});

test("returning to the library during an answer read prevents its late completion from reopening the reader", async ({
  page,
}) => {
  await page.goto("/?view=textbooks");
  await importBook(page);
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    const state = window as unknown as {
      heldSharedRead: boolean;
      releaseSharedRead: () => void;
    };
    let first = true;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = original.apply(this, args);
      if (
        first &&
        args[1] === "readonly" &&
        Array.from(tx.objectStoreNames).includes("answers")
      ) {
        first = false;
        let completed:
          ((this: IDBTransaction, event: Event) => unknown) | null = null;
        Object.defineProperty(tx, "oncomplete", {
          set(value) {
            completed = value;
          },
          get() {
            return completed;
          },
        });
        tx.addEventListener("complete", (event) => {
          state.heldSharedRead = true;
          state.releaseSharedRead = () => {
            completed?.call(tx, event);
          };
        });
      }
      return tx;
    };
  });
  await page
    .getByRole("button", { name: `${title} · 版 7を読む`, exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { heldSharedRead: boolean }).heldSharedRead,
      ),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "教材一覧へ戻る", exact: true })
    .click();
  await page.evaluate(async () => {
    (
      window as unknown as { releaseSharedRead: () => void }
    ).releaseSharedRead();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  await expect(
    page.getByLabel("教材JSONファイル（540,000バイト以下）"),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "教材の目次", exact: true }),
  ).toHaveCount(0);
  await expect(page).toHaveTitle("受け取った教材 | Quilna");
  await expect(
    page.getByRole("button", { name: `${title} · 版 7を読む`, exact: true }),
  ).toBeFocused();
});
