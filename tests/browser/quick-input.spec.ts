import { test, expect, type Page } from "@playwright/test";

const titles = [
  "非同期で情報を集める",
  "キャッシュで速く読む",
  "宇宙の新しい発見",
];
const xml = `<rss version="2.0"><channel><title>毎日の発見</title>${titles.map((title, index) => `<item><guid>${index}</guid><title>${title}</title><category>${index < 2 ? "技術" : "科学"}</category><description>非同期の処理は、完了を待つ間も別の作業を進められます。気になる言葉を調べながら読み進めます。</description></item>`).join("")}</channel></rss>`;

async function seed(page: Page, voices: "local" | "remote" = "local") {
  await page.addInitScript((mode) => {
    localStorage.setItem("quilna.article.updates.v1", "false");
    const state = window as unknown as {
      spoken: string[];
      pending: SpeechSynthesisUtterance | null;
      cancellations: number;
      completeSpeech: () => void;
    };
    state.spoken = [];
    state.pending = null;
    state.cancellations = 0;
    const engine = Object.assign(new EventTarget(), {
      paused: false,
      getVoices: () => [
        {
          voiceURI: "japanese",
          name: "Japanese",
          lang: "ja-JP",
          localService: mode === "local",
          default: true,
        },
      ],
      speak: (utterance: SpeechSynthesisUtterance) => {
        state.pending = utterance;
        state.spoken.push(utterance.text);
      },
      cancel: () => {
        state.pending = null;
        state.cancellations++;
      },
      pause: () => {
        engine.paused = true;
      },
      resume: () => {
        engine.paused = false;
      },
    });
    state.completeSpeech = () => {
      for (let i = 0; state.pending && i < 100; i++) {
        const utterance = state.pending;
        state.pending = null;
        utterance.onend?.(new Event("end") as SpeechSynthesisEvent);
      }
    };
    Object.defineProperty(window, "speechSynthesis", { value: engine });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      value: class {
        constructor(public text: string) {}
      },
    });
  }, voices);
  await page.route("**/api/feeds/fetch", (route) =>
    route.fulfill({ json: { url: "https://example.org/feed", xml } }),
  );
  await page.goto("/?view=feeds");
  await page.getByLabel("サイト・RSSのURL").fill("https://example.org/feed");
  await page
    .getByRole("button", { name: "フィードを探す", exact: true })
    .click();
  await page.getByRole("button", { name: "登録して読む", exact: true }).click();
  await expect(page.locator(".rss-article-list li")).toHaveCount(3);
}

test("中断したポインター操作の選択を、後のキーボード辞書操作へ持ち越さない", async ({
  page,
}) => {
  await seed(page);
  await page.getByRole("button", { name: titles[0], exact: true }).click();
  const open = page.getByRole("button", { name: "ことばの辞書を開く" });
  await open.focus();
  const select = async (start: number) =>
    page.evaluate((start) => {
      const node = document.querySelector(".rss-source-text p")!.firstChild!;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, 3);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, start);
  await select(0);
  await open.dispatchEvent("pointerdown", {
    pointerId: 1,
    pointerType: "mouse",
  });
  await select(1);
  await open.press("Enter");
  const dialog = page.getByRole("dialog", { name: "ことばの辞書" });
  await expect(dialog.getByLabel("調べたい言葉")).toHaveValue("同期");
});

test("辞書をEscapeで閉じた同じ操作内で、本文の選択を復元する", async ({
  page,
}) => {
  await seed(page);
  await page.getByRole("button", { name: titles[0], exact: true }).click();
  await page.evaluate(() => {
    const node = document.querySelector(".rss-source-text p")!.firstChild!,
      range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 3);
    const s = getSelection()!;
    s.removeAllRanges();
    s.addRange(range);
  });
  await page.getByRole("button", { name: "ことばの辞書を開く" }).click();
  const dialog = page.getByRole("dialog", { name: "ことばの辞書" });
  await expect(dialog.getByLabel("調べたい言葉")).toHaveValue("非同期");
  const result = await dialog.evaluate((el) => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    return {
      open: (el as HTMLDialogElement).open,
      selected: getSelection()?.toString(),
    };
  });
  expect(result).toEqual({ open: false, selected: "非同期" });
});

test("一覧から未読のまま保存でき、再読込後にも残り、保存一覧で解除すると次の行へ戻る", async ({
  page,
}) => {
  await seed(page);
  const tags = page.locator(".rss-tag-summary").first();
  await expect(tags).not.toHaveAttribute("open", "");
  await tags.locator("summary").click();
  await expect(tags.locator("p")).toContainText("配信元：技術");
  await expect(tags.locator("p")).toContainText("自分のタグ：未設定");
  const save = page.getByRole("button", {
    name: `あとで読むに保存：${titles[0]}`,
    exact: true,
  });
  await save.focus();
  await save.press("Enter");
  const saved = page.getByRole("button", {
    name: `あとで読むから外す：${titles[0]}`,
    exact: true,
  });
  await expect(saved).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator(".rss-article-list li").filter({ has: saved }),
  ).toContainText("未読");
  await expect(saved).toBeFocused();
  await page.reload();
  await expect(saved).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /保存した記事 · 1/ }).click();
  await expect(page.locator(".rss-article-list li")).toHaveCount(1);
  await saved.focus();
  await saved.press("Enter");
  await expect(page.locator(".rss-article-list li")).toHaveCount(0);
  await expect(page.locator("#rss-search-status")).toBeFocused();
  await page.getByRole("button", { name: /未読 · 3/ }).click();
  await expect(page.locator(".rss-article-list li")).toHaveCount(3);
});

for (const design of ["studio", "editorial", "focus"])
  test(`${design}: 辞書の定義・対比語・未収録語と外部リンクを調べ、同じ本文と選択位置に戻る`, async ({
    page,
  }, info) => {
    await page.addInitScript(
      (design) => localStorage.setItem("quilna.reader.design.v1", design),
      design,
    );
    await seed(page);
    await page.getByRole("button", { name: titles[0], exact: true }).click();
    await expect(page.locator(".rss-source-text")).toContainText(
      "非同期の処理",
    );
    await page.evaluate(() => {
      const source = document.querySelector(".rss-source-text")!;
      const node = source.querySelector("p")!.firstChild!;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 3);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const open = page.getByRole("button", { name: "ことばの辞書を開く" });
    await open.click();
    const dialog = page.getByRole("dialog", { name: "ことばの辞書" });
    await expect(dialog.getByLabel("調べたい言葉")).toHaveValue("非同期");
    await expect(dialog.locator(".rss-definition")).toContainText(
      "完了を待つ間",
    );
    await dialog.getByRole("button", { name: "同期", exact: true }).click();
    await expect(dialog.locator(".rss-definition")).toContainText(
      "終わってから次の処理",
    );
    const input = dialog.getByLabel("調べたい言葉");
    await input.fill('未知の語 <img src=x onerror="alert(1)">');
    await input.press("Enter");
    await expect(dialog.getByRole("status")).toContainText("未収録");
    await expect(dialog.locator("img")).toHaveCount(0);
    const link = dialog.getByRole("link", {
      name: "Wiktionaryで意味・類語・対義語を調べる",
    });
    const href = await link.getAttribute("href");
    expect(new URL(href!).searchParams.get("search")).toBe(
      '未知の語 <img src=x onerror="alert(1)">',
    );
    await expect(link).toHaveAttribute("target", "_blank");
    await dialog.getByText("話題の言葉を探す", { exact: true }).click();
    await expect(
      dialog.getByRole("link", { name: /Google Trends/ }),
    ).toHaveAttribute("href", "https://trends.google.com/trending?geo=JP");
    await page.setViewportSize({ width: 320, height: 740 });
    await input.fill("非同期");
    await input.press("Enter");
    await expect(dialog.locator(".rss-definition")).toBeVisible();
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`${design}-dictionary-mobile.png`),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(open).toBeFocused();
    await expect(page.locator("#rss-current-title")).toHaveText(titles[0]);
    expect(await page.evaluate(() => getSelection()?.toString())).toBe(
      "非同期",
    );
  });

test("興味のあるタグの見出しだけを読み、停止・再開・条件変更・本文への移動を扱う", async ({
  page,
}) => {
  await seed(page);
  await page
    .getByLabel("タグで絞り込み", { exact: true })
    .selectOption("tag:技術");
  await page.getByText("見出しを聞く", { exact: true }).click();
  const player = page.locator(".rss-headline-player");
  await player.getByRole("button", { name: "この一覧の見出しを聞く" }).click();
  await expect(player.getByRole("status")).toHaveText("読み上げ中");
  await player.getByRole("button", { name: "一時停止", exact: true }).click();
  await expect(player.getByRole("status")).toHaveText("一時停止中");
  await player.getByRole("button", { name: "再開", exact: true }).click();
  await page.evaluate(() =>
    (window as unknown as { completeSpeech: () => void }).completeSpeech(),
  );
  await expect(player.getByRole("status")).toHaveText(
    "読み上げが終わりました。",
  );
  const spoken = await page.evaluate(() =>
    (window as unknown as { spoken: string[] }).spoken.join(""),
  );
  expect(spoken).toContain(titles[0]);
  expect(spoken).toContain(titles[1]);
  expect(spoken).not.toContain(titles[2]);
  await expect(page.getByRole("button", { name: /未読 · 3/ })).toBeVisible();
  await player.getByRole("button", { name: "この一覧の見出しを聞く" }).click();
  await page.getByLabel("保存領域の記事を検索").fill("キャッシュ");
  await expect(player.getByRole("status")).toContainText(
    "記事が変わったため停止",
  );
  await player.getByRole("button", { name: "この一覧の見出しを聞く" }).click();
  await expect(player.getByRole("status")).toHaveText("読み上げ中");
  await page.getByRole("button", { name: titles[1], exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { pending: unknown }).pending,
    ),
  ).toBeNull();
  await expect(page.locator("#rss-current-title")).toHaveText(titles[1]);
});

test("端末内音声がない場合は送信せず、一覧と保存を使える", async ({ page }) => {
  await seed(page, "remote");
  await page.getByText("見出しを聞く", { exact: true }).click();
  const player = page.locator(".rss-headline-player");
  await expect(
    player.getByRole("button", { name: "この一覧の見出しを聞く" }),
  ).toBeDisabled();
  await expect(player.getByRole("status")).toContainText(
    "端末内音声が見つかりません",
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { spoken: string[] }).spoken,
    ),
  ).toEqual([]);
  await page
    .getByRole("button", {
      name: `あとで読むに保存：${titles[0]}`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: /保存した記事 · 1/ }),
  ).toBeVisible();
});

test("保存が失敗したときは未保存・未読のまま残し、明示的な再試行で保存する", async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      ...args: Parameters<typeof original>
    ) {
      const result = original.apply(this, args);
      if (this.name === "articles" && args[0].saved) this.transaction.abort();
      return result;
    };
    (window as unknown as { restoreWrites: () => void }).restoreWrites = () => {
      IDBObjectStore.prototype.put = original;
    };
  });
  const save = page.getByRole("button", {
    name: `あとで読むに保存：${titles[0]}`,
    exact: true,
  });
  await save.click();
  await expect(page.locator(".rss-error")).toContainText(
    "変更を保存できませんでした",
  );
  await expect(save).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: /未読 · 3/ })).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { restoreWrites: () => void }).restoreWrites(),
  );
  await page
    .locator(".rss-error")
    .getByRole("button", { name: "再試行", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: `あとで読むから外す：${titles[0]}`,
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /未読 · 3/ })).toBeVisible();
});

test("辞書を開いたままブラウザで戻っても、以前の本文選択を別の画面へ移さない", async ({
  page,
}) => {
  await seed(page);
  await page.getByRole("button", { name: titles[0], exact: true }).click();
  await page.getByRole("button", { name: "ことばの辞書を開く" }).click();
  await expect(
    page.getByRole("dialog", { name: "ことばの辞書" }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("dialog", { name: "ことばの辞書" }),
  ).not.toBeVisible();
  await expect(page.locator(".rss-article-list li")).toHaveCount(3);
  await page.getByRole("button", { name: titles[2], exact: true }).click();
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("");
  await expect(page.locator("#rss-current-title")).toHaveText(titles[2]);
});

test("ハイライトの非同期再確認を待っても、本文で選択した語句を辞書へ渡せる", async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("tsumiki.rss.v1");
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("articles", "readwrite");
        const cursor = transaction.objectStore("articles").openCursor();
        cursor.onsuccess = () => {
          if (!cursor.result) return;
          cursor.result.update({
            ...cursor.result.value,
            read: true,
            tags: { version: 2, state: "unclassified", suggestions: [] },
          });
          cursor.result.continue();
        };
        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    });
  });
  await page.reload();
  await page.getByRole("button", { name: titles[0], exact: true }).click();
  await expect(page.locator(".rss-source-text")).toContainText("非同期");
  await page.evaluate(async () => {
    const source = document.querySelector(".rss-source-text")!;
    const text = source.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 3);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    await new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        observer.disconnect();
        resolve();
      });
      observer.observe(source, { childList: true });
      window.dispatchEvent(new Event("focus"));
    });
  });
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("非同期");
  await page.getByRole("button", { name: "ことばの辞書を開く" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "ことばの辞書" })
      .getByLabel("調べたい言葉"),
  ).toHaveValue("非同期");
});
