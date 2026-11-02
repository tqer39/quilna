import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
test("reading settings contain local-save scope and shortcuts without permanent reading chrome", async ({
  page,
}, testInfo) => {
  await page.goto("/#read");
  await expect(page.locator(".save-status")).not.toBeVisible();
  const toggle = page.getByLabel("N：次へ / P：前へ（キー移動を有効にする）");
  await expect(toggle).not.toBeVisible();
  await page.getByRole("button", { name: "次へ →", exact: true }).click();
  await saveSettled(page);
  await expect(page.locator(".save-status")).not.toBeVisible();
  const trigger = page.getByRole("button", { name: "読書設定", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "読書設定", exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(/別の端末やブラウザとは同期しません/),
  ).toBeVisible();
  await expect(toggle).toBeVisible();
  await page.keyboard.press("n");
  await expect(page).toHaveURL(/#explore$/);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("reading-settings.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.goBack();
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("reading-without-save-panel.png"),
    fullPage: true,
  });
});

test("read, interact, answer retry, reload, resume, back, time and mobile layout", async ({
  page,
}, testInfo) => {
  await page.goto("/#read");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  if (testInfo.project.name === "mobile") {
    await page.getByText("このセクションの目次", { exact: true }).click();
    await saveSettled(page);
    await expect(
      page.getByRole("link", {
        name: "01 / 発行判断に使う CAA レコードはどれ？",
      }),
    ).toBeVisible();
    await page.getByText("このセクションの目次", { exact: true }).click();
    await saveSettled(page);
  }
  await page.getByRole("button", { name: "次へ →" }).click();
  await saveSettled(page);
  await page
    .getByRole("button", { name: "予想をスキップして自由探索" })
    .click();
  await saveSettled(page);
  await page.getByLabel("子の CAA を切り替える").selectOption("absent");
  await saveSettled(page);
  await expect(
    page.getByRole("heading", { name: "× CAA ポリシー上の禁止" }),
  ).toBeVisible();
  await page.getByLabel("子の CAA を切り替える").selectOption("report");
  await saveSettled(page);
  await expect(
    page.getByRole("heading", { name: "○ CAA ポリシー上の許可" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath(`diagram.png`),
    fullPage: true,
  });
  await page.getByRole("button", { name: "次へ →" }).click();
  await saveSettled(page);
  await page.getByRole("button", { name: "CAA 上、禁止される" }).click();
  await saveSettled(page);
  await expect(
    page.getByText("もう一度、探索の停止条件を確認しましょう"),
  ).toBeVisible();
  await page.getByRole("button", { name: "別の回答で再試行" }).click();
  await saveSettled(page);
  await page.getByRole("button", { name: "CAA 上、許可される" }).click();
  await saveSettled(page);
  await expect(page.getByRole("heading", { name: "正解です" })).toBeVisible();
  const count = () =>
    page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("fieldnotes.history.v1")!).attempts
          .length,
    );
  expect(await count()).toBe(2);
  await page
    .getByRole("button", { name: "CAA 上、許可される" })
    .evaluate((b) => (b as HTMLButtonElement).click());
  await saveSettled(page);
  expect(await count()).toBe(2);
  await saveSettled(page);
  await page.reload();
  expect(await count()).toBe(2);
  await expect(
    page.getByRole("heading", { name: "03 / 結果を予測する" }),
  ).toBeVisible();
  await page.goto("/#read");
  await page.getByRole("button", { name: /前回のブロックへ/ }).click();
  await saveSettled(page);
  await expect(
    page.getByRole("heading", { name: "03 / 結果を予測する" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "次へ →" }).click();
  await saveSettled(page);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "03 / 結果を予測する" }),
  ).toBeVisible();
  for (const t of ["5", "10", "15", "30"]) {
    await page.getByLabel("今日の時間（目安）").selectOption(t);
    await saveSettled(page);
    await expect(page.getByText(/今回 .*終点：/)).toBeVisible();
  }
  await expect(page.getByLabel("読み方")).toHaveCount(0);
  await page.goto("/#takeaway");
  await expect(
    page.getByRole("heading", { name: "13 / 明日、説明できるように" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "セクションを読み終えた" }).click();
  await saveSettled(page);
  await expect(page.getByText(/読了。/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath(`summary.png`),
    fullPage: true,
  });
});
test("save failure keeps attempts and retry persists them", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const native = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (!(window as unknown as { allowSave: boolean }).allowSave)
        throw Error("quota");
      return native.call(this, k, v);
    };
  });
  await page.goto("/#predict");
  await page.getByRole("button", { name: "CAA 上、許可される" }).click();
  await saveSettled(page);
  await expect(
    page.getByText(
      "保存できません。このタブ内の回答・予想・ふりかえりは保持しています。",
    ),
  ).toBeVisible();
  await page.evaluate(
    () => ((window as unknown as { allowSave: boolean }).allowSave = true),
  );
  await page.getByRole("button", { name: "保存を再試行" }).click();
  await saveSettled(page);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("fieldnotes.history.v1")!).attempts
          .length,
    ),
  ).toBe(1);
});
test("corrupt history is not overwritten", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("fieldnotes.history.v1", "corrupt"),
  );
  await page.goto("/#read");
  await expect(
    page.getByText(/既存データの上書きを止めています/),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("fieldnotes.history.v1")),
  ).toBe("corrupt");
});
test("keyboard and reduced motion", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#explore");
  await page
    .getByRole("button", { name: "予想をスキップして自由探索" })
    .click();
  await saveSettled(page);
  await page.getByRole("button", { name: "次の設定を試す →" }).focus();
  await page.keyboard.press("Enter");
  await saveSettled(page);
  await expect(
    page.getByRole("heading", { name: "× CAA ポリシー上の禁止" }),
  ).toBeVisible();
  await expect(
    testInfo.project.name === "mobile"
      ? page.locator(".mobile-dns-tree")
      : page.getByRole("img", { name: "DNS 親子と CAA の探索" }),
  ).toBeVisible();
});

test("unavailable localStorage still permits reading and answering", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("disabled", "SecurityError");
      },
    }),
  );
  await page.goto("/#predict");
  await expect(
    page.getByText(/既存データの上書きを止めています/),
  ).toBeVisible();
  await page.getByRole("button", { name: "CAA 上、許可される" }).click();
  await saveSettled(page);
  await expect(page.getByRole("heading", { name: "正解です" })).toBeVisible();
});

test("child-only diagram, all five names, CA changes and independent records", async ({
  page,
}, testInfo) => {
  await page.goto("/#boundary");
  const row = (id: string) => page.locator(`[data-target="${id}"]`);
  for (const id of ["parent", "sibling", "independent"])
    await expect(
      row(id).getByText("○ CAA ポリシー上の許可", { exact: true }),
    ).toBeVisible();
  for (const id of ["child", "descendant"])
    await expect(
      row(id).getByText("× CAA ポリシー上の禁止", { exact: true }),
    ).toBeVisible();
  await row("sibling").getByText("この名前の探索を追う").click();
  await saveSettled(page);
  await expect(
    row("sibling").getByText("www.example.com: CAA RRset なし → 親へ", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("special.api の独自 RRset").selectOption("none");
  await saveSettled(page);
  await expect(
    row("independent").getByText("× CAA ポリシー上の禁止", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "独自 RRset の次の設定を試す →" })
    .focus();
  await page.keyboard.press("Enter");
  await saveSettled(page);
  await expect(
    row("independent").getByText("○ CAA ポリシー上の許可", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("special.api の独自 RRset").selectOption("allow");
  await saveSettled(page);
  await page.screenshot({
    path: testInfo.outputPath(`scope.png`),
    fullPage: true,
  });
  await page.getByLabel("比較する CA").selectOption("other-ca.example");
  await saveSettled(page);
  await expect(
    row("independent").getByText("× CAA ポリシー上の禁止", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("子 api の方針").selectOption("allow");
  await saveSettled(page);
  await expect(
    row("child").getByText("× CAA ポリシー上の禁止", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("比較する CA").selectOption("letsencrypt.org");
  await saveSettled(page);
  await expect(
    row("child").getByText("○ CAA ポリシー上の許可", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("new predictions, applications and old answers survive the version update", async ({
  page,
}, testInfo) => {
  const old = {
    bookId: "caa-first-rrset",
    version: "1.4.0",
    blockId: "predict",
    userId: "existing-user",
    attemptId: "old-attempt",
    time: "2026-10-10T01:00:00.000Z",
    answer: "deny",
    correct: false,
  };
  await page.addInitScript((value) => {
    if (!localStorage.getItem("fieldnotes.history.v1"))
      localStorage.setItem(
        "fieldnotes.history.v1",
        JSON.stringify({
          schemaVersion: 1,
          userId: value.userId,
          attempts: [value],
          resume: {
            bookId: value.bookId,
            version: value.version,
            blockId: "takeaway",
            userId: value.userId,
            time: value.time,
            minutes: 5,
            difficulty: "operations",
          },
        }),
      );
  }, old);
  await page.goto("/#read");
  await expect(page.getByText(/旧版の回答は保存したまま/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /前回のブロックへ/ }),
  ).toHaveCount(0);
  for (const [id, answer] of [
    ["scope-predict", "禁止"],
    ["sibling-predict", "許可"],
    ["override-predict", "許可"],
    ["renewal-predict", "禁止"],
  ]) {
    await page.goto(`/#${id}`);
    await page.getByRole("button", { name: `CAA 上、${answer}される` }).click();
    await saveSettled(page);
    await expect(page.getByRole("heading", { name: "正解です" })).toBeVisible();
  }
  const history = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fieldnotes.history.v1")!),
  );
  expect(history.attempts[0]).toEqual(old);
  expect(history.attempts).toHaveLength(5);
  expect(
    history.attempts
      .slice(1)
      .every((a: { version: string }) => a.version === "1.8.0"),
  ).toBe(true);
  expect(history.resume.version).toBe("1.8.0");
  expect(history.resume).not.toHaveProperty("difficulty");
  await page.goto("/#applications");
  for (const summary of await page
    .getByText("予測して結果を見る", { exact: true })
    .all())
    await summary.click();
  await saveSettled(page);
  await expect(
    page.locator('.application [data-policy="deny"][data-tone="neutral"]'),
  ).toHaveCount(3);
  await page.screenshot({
    path: testInfo.outputPath(`applications.png`),
    fullPage: true,
  });
  await page.goto("/#limits");
  await expect(page.getByText(/要求するすべての名前について/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("sequence roles and readable lookup flow with keyboard navigation", async ({
  page,
}, testInfo) => {
  await page.goto("/#read");
  await expect(
    page.getByRole("heading", {
      name: "01 / 発行判断に使う CAA レコードはどれ？",
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "RRset は、同じ名前・種類・クラスに属する DNS レコードの集合です。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("1. 申請者 → 認証局", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("3. 権威 DNS → 認証局", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/再帰リゾルバー・キャッシュ/)).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath(`sequence.png`),
    fullPage: true,
  });
  await page.goto("/#explain");
  await page.getByText("探索フロー全体を見る", { exact: true }).click();
  await saveSettled(page);
  await expect(page.getByText("ない → 親名へ", { exact: true })).toBeVisible();
  await expect(
    page.getByText("ある → 探索を止める", { exact: true }),
  ).toBeVisible();
  const steps = page.getByRole("button", { name: "次のステップを見る" });
  await expect(page.getByText("ステップ 1 / 4", { exact: true })).toBeVisible();
  await steps.focus();
  await page.keyboard.press("Enter");
  await saveSettled(page);
  await expect(page.getByText("ステップ 2 / 4", { exact: true })).toBeVisible();
  await steps.click();
  await saveSettled(page);
  await steps.click();
  await saveSettled(page);
  await expect(
    page.locator('.flow-stages [data-kind="decision"]'),
  ).toContainText("○ CAA ポリシー上の許可");
  await expect(steps).toBeDisabled();
  await page.getByRole("button", { name: "一つ前のステップ" }).click();
  await saveSettled(page);
  await expect(page.getByText("ステップ 3 / 4", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "最初から追う" }).click();
  await saveSettled(page);
  await expect(page.getByText("ステップ 1 / 4", { exact: true })).toBeVisible();
  await page.getByLabel("フローを追う子の設定").selectOption("absent");
  await saveSettled(page);
  for (let i = 0; i < 5; i++) await steps.click();
  await saveSettled(page);
  await expect(page.getByText("ステップ 6 / 6", { exact: true })).toBeVisible();
  await expect(
    page.locator('.flow-stages [data-kind="decision"]'),
  ).toContainText("× CAA ポリシー上の禁止");
  await page.screenshot({
    path: testInfo.outputPath(`flow.png`),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("basic explanations and operational guidance are always included", async ({
  page,
}) => {
  await page.goto("/#read");
  await expect(page.getByLabel("読み方")).toHaveCount(0);
  await expect(page.getByLabel("今日の時間（目安）")).toBeVisible();
  await page.goto("/#explain");
  await expect(
    page.getByText(/下位チームが iodef を追加しただけでも/),
  ).toBeVisible();
  await page.goto("/#scope");
  await expect(page.getByText(/変更レビューで確認してください/)).toBeVisible();
  await page.getByLabel("今日の時間（目安）").selectOption("5");
  await saveSettled(page);
  await saveSettled(page);
  await page.reload();
  await expect(page.getByLabel("今日の時間（目安）")).toHaveValue("5");
  await expect(page.getByText(/変更レビューで確認してください/)).toBeVisible();
});

test("compact reading, visible budget endpoint and explicit resume scope", async ({
  page,
}) => {
  await page.goto("/#read");
  for (const [minutes, endpoint] of [
    ["5", "02"],
    ["10", "04"],
    ["15", "06"],
    ["30", "13"],
    ["5", "02"],
  ]) {
    await page.getByLabel("今日の時間（目安）").selectOption(minutes);
    await saveSettled(page);
    await expect(page.locator(".plan")).toContainText(`01–${endpoint}`);
    await expect(page.locator("nav [data-in-plan]")).toHaveCount(
      Number(endpoint),
    );
  }
  await page.getByRole("button", { name: "次へ →" }).click();
  await saveSettled(page);
  await expect(
    page.getByText("今回の目安の終点です", { exact: true }),
  ).toBeVisible();
  await saveSettled(page);
  await page.reload();
  await expect(
    page.getByRole("button", { name: /前回のブロックへ：02/ }),
  ).toBeVisible();
  await page
    .getByText("はじめに：教材・保存範囲・用語", { exact: true })
    .click();
  await saveSettled(page);
  await expect(
    page.getByText(/スクロール位置、図の設定、探索ステップ/),
  ).toBeVisible();
  await page.getByRole("button", { name: "次回は次のブロックから" }).click();
  await saveSettled(page);
  await expect(page.locator(".plan")).toContainText("03–04");
  await saveSettled(page);
  await page.reload();
  await expect(page.locator(".plan")).toContainText("03–04");
});

test("320px and 390px DNS labels stay readable and every block reflows", async ({
  page,
}, testInfo) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const id of [
      "read",
      "explore",
      "predict",
      "explain",
      "scope",
      "boundary",
      "scope-predict",
      "sibling-predict",
      "override-predict",
      "applications",
      "renewal-predict",
      "limits",
      "takeaway",
    ]) {
      await page.goto(`/#${id}`);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        await page
          .locator("main h2")
          .evaluate((e) => e.getBoundingClientRect().top),
      ).toBeLessThan(600);
      if (id === "explore" || id === "boundary") {
        if (id === "explore") {
          await saveSettled(page);
          await page.reload();
          await page
            .getByRole("button", { name: "予想をスキップして自由探索" })
            .click();
          await saveSettled(page);
        }
        await expect(page.locator(".mobile-dns-tree")).toBeVisible();
        expect(
          await page
            .locator(".dns-node strong")
            .first()
            .evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
        ).toBeGreaterThanOrEqual(16);
        await page.screenshot({
          path: testInfo.outputPath(`${width}-${id}-readable.png`),
          fullPage: true,
        });
      }
    }
  }
});

test("term help preserves reading position, context and focus without scoring", async ({
  page,
}, testInfo) => {
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/#read");
    const term = page
      .getByRole("button", { name: "RRsetの説明を開く" })
      .first();
    await term.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => scrollY);
    const attemptsBefore = await page.evaluate(
      () =>
        JSON.parse(
          localStorage.getItem("fieldnotes.history.v1") ?? '{"attempts":[]}',
        ).attempts,
    );
    for (let i = 0; i < 2; i++) {
      await term.click();
      await saveSettled(page);
      const dialog = page.getByRole("dialog", { name: "RRsetの説明" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("今の文脈", { exact: true })).toBeVisible();
      if (width === 390 && i === 0)
        await page.screenshot({
          path: testInfo.outputPath("term-help.png"),
          fullPage: true,
        });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (i === 0)
        await page
          .getByRole("button", { name: "閉じて読書へ戻る" })
          .evaluate((b) => {
            (b as HTMLButtonElement).click();
            (b as HTMLButtonElement).click();
          });
      else await page.keyboard.press("Escape");
      await saveSettled(page);
      await expect(dialog).not.toBeVisible();
      await expect(term).toBeFocused();
      expect(
        Math.abs((await page.evaluate(() => scrollY)) - before),
      ).toBeLessThan(3);
    }
    expect(
      await page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem("fieldnotes.history.v1") ?? '{"attempts":[]}',
          ).attempts,
      ),
    ).toEqual(attemptsBefore);
    await term.press("Enter");
    await saveSettled(page);
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goForward();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "閉じて読書へ戻る" }).click();
    await saveSettled(page);
    await expect(term).toBeFocused();
    await page.goto("/#boundary");
    await page.getByRole("button", { name: "iodefの説明を開く" }).click();
    await saveSettled(page);
    await expect(
      page.getByRole("dialog").getByText(/子孫の独自 RRset/),
    ).toBeVisible();
    await page.getByRole("button", { name: "閉じて読書へ戻る" }).click();
    await saveSettled(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
});

test("wrong answer, targeted guidance, diagram, Back/Forward and new attempt", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#predict");
  await page.getByRole("button", { name: "CAA 上、禁止される" }).click();
  await saveSettled(page);
  await expect(page.locator(".question-feedback")).toHaveAttribute(
    "data-misconception-id",
    "merge-parent",
  );
  await expect(page.getByText(/親の禁止を子の集合に足す/)).toBeVisible();
  const review = page.getByRole("button", { name: "該当する図と理由を確認" });
  await review.click();
  await saveSettled(page);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText("ここで RRset を採用・探索終了"),
  ).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(review).toBeFocused();
  await page.goForward();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "閉じて読書へ戻る" }).click();
  await saveSettled(page);
  await expect(review).toBeFocused();
  await page.getByRole("button", { name: "次へ →" }).click();
  await saveSettled(page);
  await page.goBack();
  await expect(page.locator(".question-feedback")).toHaveAttribute(
    "data-misconception-id",
    "merge-parent",
  );
  await page.getByRole("button", { name: "別の回答で再試行" }).click();
  await saveSettled(page);
  await page.getByRole("button", { name: "CAA 上、許可される" }).click();
  await saveSettled(page);
  await expect(page.getByRole("heading", { name: "正解です" })).toBeVisible();
  const attempts = await page.evaluate(
    () => JSON.parse(localStorage.getItem("fieldnotes.history.v1")!).attempts,
  );
  expect(attempts).toHaveLength(2);
  expect(attempts[0].correct).toBe(false);
  expect(attempts[1].correct).toBe(true);
  expect(attempts[0].attemptId).not.toBe(attempts[1].attemptId);
  await review.click();
  await saveSettled(page);
  await page.screenshot({
    path: testInfo.outputPath(`question-help.png`),
    fullPage: true,
  });
});

test("support remains usable when storage writes fail", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw Error("storage disabled");
    };
  });
  await page.goto("/#sibling-predict");
  await page.getByRole("button", { name: "CAA 上、禁止される" }).click();
  await saveSettled(page);
  await expect(page.locator(".question-feedback")).toHaveAttribute(
    "data-misconception-id",
    "sideways",
  );
  await page.getByRole("button", { name: "該当する図と理由を確認" }).click();
  await saveSettled(page);
  await page.keyboard.press("Escape");
  await saveSettled(page);
  await expect(page.locator(".question-feedback")).toHaveAttribute(
    "data-misconception-id",
    "sideways",
  );
  await expect(page.getByText(/保存できません/)).toBeVisible();
});

test("additional terms keep sources, optional details and reader history", async ({
  page,
}, testInfo) => {
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [id, label, block, source] of [
      [
        "lets-encrypt",
        "Let’s Encrypt",
        "read",
        "https://letsencrypt.org/about/",
      ],
      [
        "resolver",
        "リゾルバー",
        "read",
        "https://www.rfc-editor.org/rfc/rfc9499.html#section-6",
      ],
      [
        "authoritative-dns",
        "権威 DNS",
        "read",
        "https://www.rfc-editor.org/rfc/rfc9499.html#section-6",
      ],
      [
        "dnssec",
        "DNSSEC",
        "limits",
        "https://www.rfc-editor.org/rfc/rfc4033.html#section-3",
      ],
    ]) {
      await page.goto(`/#${block}`);
      const trigger = page.locator(`article [data-term-id="${id}"]`).first();
      await trigger.scrollIntoViewIfNeeded();
      const before = await page.evaluate(() => scrollY);
      const history = await page.evaluate(() =>
        localStorage.getItem("fieldnotes.history.v1"),
      );
      await trigger.press("Enter");
      await saveSettled(page);
      const dialog = page.getByRole("dialog", { name: `${label}の説明` });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("link", { name: /出典/ })).toHaveAttribute(
        "href",
        source,
      );
      await expect(dialog.locator("[data-term-id]")).toHaveCount(0);
      await dialog.getByText("もう少し詳しく", { exact: true }).click();
      await saveSettled(page);
      await expect(dialog.locator("details").first()).toHaveAttribute(
        "open",
        "",
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (width === 390 && id === "dnssec")
        await page.screenshot({
          path: testInfo.outputPath("dnssec-details.png"),
          fullPage: true,
        });
      await page.keyboard.press("Escape");
      await saveSettled(page);
      await expect(trigger).toBeFocused();
      expect(
        Math.abs((await page.evaluate(() => scrollY)) - before),
      ).toBeLessThan(3);
      expect(
        await page.evaluate(() =>
          localStorage.getItem("fieldnotes.history.v1"),
        ),
      ).toBe(history);
      await trigger.click();
      await saveSettled(page);
      await page.goBack();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.goForward();
      await expect(dialog).toBeVisible();
      await page.getByRole("button", { name: "閉じて読書へ戻る" }).click();
      await saveSettled(page);
      await expect(trigger).toBeFocused();
    }
  }
});

function contrast(a: string, b: string) {
  const luminance = (color: string) => {
    const rgb = color
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number)
      .map((v) => {
        const n = v / 255;
        return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
      });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const [l, r] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l + 0.05) / (r + 0.05);
}

test("semantic feedback separates correctness, policy, warnings and save state with contrast", async ({
  page,
}, testInfo) => {
  const ratios: object[] = [];
  for (const scheme of ["light", "dark"] as const)
    for (const width of [320, 390, 1440]) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/#predict");
      await saveSettled(page);
      await page.reload();
      await page.getByRole("button", { name: "CAA 上、禁止される" }).click();
      await saveSettled(page);
      await expect(
        page.locator('.question-feedback [data-tone="error"]'),
      ).toBeVisible();
      await expect(page.locator(".save-status")).toBeEmpty();
      if (width === 390)
        await page.screenshot({
          path: testInfo.outputPath(`quiz-error-${scheme}.png`),
          fullPage: true,
        });
      await page.getByRole("button", { name: "別の回答で再試行" }).click();
      await saveSettled(page);
      await expect(
        page.locator(".question-feedback .semantic-feedback"),
      ).toHaveCount(0);
      // A correct policy prohibition is still a quiz success.
      await page.goto("/#scope-predict");
      await page.getByRole("button", { name: "CAA 上、禁止される" }).click();
      await saveSettled(page);
      await expect(
        page.locator('.question-feedback [data-tone="success"]'),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "該当する図と理由を確認" })
        .click();
      await saveSettled(page);
      await expect(
        page.locator('dialog [data-policy="deny"][data-tone="neutral"]'),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await saveSettled(page);
      await page.getByRole("button", { name: "別の回答で再試行" }).focus();
      const focus = await page
        .getByRole("button", { name: "別の回答で再試行" })
        .evaluate((e) => getComputedStyle(e).outlineWidth);
      expect(parseFloat(focus)).toBeGreaterThanOrEqual(3);
      const focusColors = await page
        .getByRole("button", { name: "別の回答で再試行" })
        .evaluate((e) => ({
          ring: getComputedStyle(e).outlineColor,
          page: getComputedStyle(document.documentElement).backgroundColor,
        }));
      expect(
        contrast(focusColors.ring, focusColors.page),
      ).toBeGreaterThanOrEqual(3);
      if (width === 390)
        await page.screenshot({
          path: testInfo.outputPath(`success-${scheme}.png`),
          fullPage: true,
        });
      // Render all token variants through an actual old-version resume warning and storage failure.
      await page.evaluate(() => {
        const key = "fieldnotes.history.v1";
        const saved = JSON.parse(localStorage.getItem(key)!);
        saved.resume.version = "1.5.0";
        localStorage.setItem(key, JSON.stringify(saved));
      });
      await saveSettled(page);
      await page.reload();
      await expect(page.locator('[data-tone="warning"]')).toBeVisible();
      if (width === 390)
        await page.screenshot({
          path: testInfo.outputPath(`warning-${scheme}.png`),
          fullPage: true,
        });
      await page.evaluate(() => {
        Storage.prototype.setItem = () => {
          throw Error("test storage failure");
        };
      });
      await page.getByRole("button", { name: "次へ →" }).click();
      await saveSettled(page);
      await expect(
        page.locator('.save-status [data-tone="error"]'),
      ).toBeVisible();
      if (width === 390)
        await page.screenshot({
          path: testInfo.outputPath(`warning-error-${scheme}.png`),
          fullPage: true,
        });
      const colors = await page
        .locator(".semantic-feedback")
        .evaluateAll((nodes) =>
          nodes.map((e) => {
            const s = getComputedStyle(e);
            return {
              tone: (e as HTMLElement).dataset.tone,
              fg: s.color,
              bg: s.backgroundColor,
              border: s.borderTopColor,
            };
          }),
        );
      // Token values also cover success and neutral, independent of the displayed state.
      const tokens = await page.evaluate(() => {
        const s = getComputedStyle(document.documentElement);
        return ["success", "error", "warning", "neutral"].map((tone) => ({
          tone,
          fg: s.getPropertyValue(`--${tone}-fg`).trim(),
          bg: s.getPropertyValue(`--${tone}-bg`).trim(),
          border: s.getPropertyValue(`--${tone}-border`).trim(),
        }));
      });
      const toRgb = (v: string) =>
        v.startsWith("#")
          ? `rgb(${[1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)).join(",")})`
          : v;
      for (const c of [...colors, ...tokens]) {
        const text = contrast(toRgb(c.fg), toRgb(c.bg));
        const boundary = contrast(toRgb(c.border), toRgb(c.bg));
        expect(text).toBeGreaterThanOrEqual(4.5);
        expect(boundary).toBeGreaterThanOrEqual(3);
        ratios.push({ scheme, width, tone: c.tone, text, boundary });
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  const ratioPath = testInfo.outputPath("semantic-contrast.json");
  await writeFile(ratioPath, JSON.stringify(ratios, null, 2));
  await testInfo.attach("semantic-contrast", {
    path: ratioPath,
    contentType: "application/json",
  });
});

test("four learning outcomes appear at the entry only, practical cases remain", async ({
  page,
}) => {
  await page.goto("/#read");
  await expect(
    page.getByRole("heading", { name: "この教科書で理解できること" }),
  ).toBeVisible();
  await expect(page.locator(".learning-outcomes li")).toHaveCount(4);
  await page.getByRole("button", { name: "次へ →" }).click();
  await saveSettled(page);
  await expect(page.locator(".learning-outcomes")).toHaveCount(0);
  await page.goto("/#applications");
  await expect(
    page.getByRole("heading", { name: "10 / CAA があると何が嬉しい？" }),
  ).toBeVisible();
  await expect(page.locator(".application")).toHaveCount(3);
});

test("predict then reveal, explore, reflect, reload, Back/Forward and retry preserve separate records", async ({
  page,
}, testInfo) => {
  await page.goto("/#explore");
  await expect(page.locator("[data-policy]")).toHaveCount(0);
  await expect(page.locator(".trace")).toHaveCount(0);
  await page.getByRole("button", { name: "予想して図を見る" }).click();
  await saveSettled(page);
  await page.getByLabel("予想する子の設定").selectOption("report");
  await saveSettled(page);
  await expect(
    page.getByRole("button", { name: "予想を保存", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "禁止されると予想" }).press("Enter");
  await saveSettled(page);
  await page
    .getByLabel("予想の理由（任意・1000文字まで）")
    .fill("親の禁止も足すと思った");
  await page.getByRole("button", { name: "予想を保存", exact: true }).click();
  await saveSettled(page);
  await expect(page.locator("[data-policy]")).toHaveCount(0);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fieldnotes.history.v1")!),
  );
  expect(saved.diagramPredictions).toHaveLength(1);
  expect(saved.diagramReveals).toHaveLength(0);
  expect(saved.attempts).toHaveLength(0);
  const prediction = saved.diagramPredictions[0];
  expect(prediction.snapshot.tree["api.example.com"][0].tag).toBe("iodef");
  await saveSettled(page);
  await page.reload();
  await expect(
    page.getByText("あなたの予想：禁止", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-policy]")).toHaveCount(0);
  await page.getByRole("button", { name: "結果と図を見る" }).press("Enter");
  await saveSettled(page);
  await expect(
    page.locator('.prediction-comparison [data-tone="error"]'),
  ).toBeVisible();
  await expect(
    page.locator('.prediction-comparison [data-policy="allow"]'),
  ).toBeVisible();
  await page.getByLabel("子の CAA を切り替える").selectOption("deny");
  await saveSettled(page);
  await expect(
    page.getByText("保存した予想と異なる設定を探索中", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.prediction-comparison [data-policy="allow"]'),
  ).toBeVisible();
  await page
    .getByLabel("予想と何が違った？（任意）")
    .fill("iodef だけでも子で探索が止まる");
  await page
    .getByText("理解の変化・助かった説明も記録する（任意）", { exact: true })
    .click();
  await saveSettled(page);
  await page
    .getByLabel("理解がどう変わった？（任意）")
    .fill("親と合算しないと分かった");
  await page
    .getByLabel("どの説明が助かった？（任意）")
    .fill("採用する集合の表示");
  await page
    .getByLabel("理解の自己申告（任意・正誤とは別）")
    .selectOption("clearer");
  await saveSettled(page);
  await page
    .getByRole("button", { name: "ふりかえりを追加保存" })
    .evaluate((b) => {
      (b as HTMLButtonElement).click();
      (b as HTMLButtonElement).click();
    });
  await saveSettled(page);
  let history = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fieldnotes.history.v1")!),
  );
  expect(history.diagramPredictions[0]).toEqual(prediction);
  expect(history.diagramReveals).toHaveLength(1);
  expect(history.diagramReveals[0].correct).toBe(false);
  expect(history.diagramReflections).toHaveLength(1);
  expect(history.diagramReflections[0].understanding).toBe("clearer");
  await page.getByRole("button", { name: "次へ →", exact: true }).click();
  await saveSettled(page);
  await page.goBack();
  await expect(
    page.locator('.prediction-comparison [data-tone="error"]'),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "03 / 結果を予測する" }),
  ).toBeVisible();
  await page.goBack();
  await saveSettled(page);
  await page.reload();
  await page.getByText("保存したふりかえり（1件）", { exact: true }).click();
  await saveSettled(page);
  await expect(page.getByText(/親と合算しないと分かった/)).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("prediction-reflection.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "新しい予想で再挑戦" }).click();
  await saveSettled(page);
  await page.getByLabel("予想する子の設定").selectOption("deny");
  await saveSettled(page);
  await page.getByRole("button", { name: "禁止されると予想" }).click();
  await saveSettled(page);
  await page.getByRole("button", { name: "予想を保存", exact: true }).click();
  await saveSettled(page);
  await page.getByRole("button", { name: "結果と図を見る" }).click();
  await saveSettled(page);
  await expect(
    page.locator('.prediction-comparison [data-tone="success"]'),
  ).toBeVisible();
  await expect(
    page.locator(
      '.prediction-comparison [data-policy="deny"][data-tone="neutral"]',
    ),
  ).toBeVisible();
  await page.getByLabel("過去の予想を確認").selectOption(prediction.attemptId);
  await saveSettled(page);
  await expect(
    page.getByText("あなたの予想：禁止", { exact: true }),
  ).toBeVisible();
  history = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fieldnotes.history.v1")!),
  );
  expect(history.diagramPredictions).toHaveLength(2);
  expect(history.diagramPredictions[0]).toEqual(prediction);
  expect(
    history.diagramReveals.map((r: { correct: boolean }) => r.correct),
  ).toEqual([false, true]);
  expect(history.diagramReflections).toHaveLength(1);
  expect(history.attempts).toHaveLength(0);
  expect(new URL(page.url()).hash).toBe("#explore");
});

test("prediction skip and optional reflection reflow on 320, 390 and desktop without grading skips", async ({
  page,
}, testInfo) => {
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#explore");
    await page.evaluate(() => localStorage.clear());
    await saveSettled(page);
    await page.reload();
    await page.getByRole("button", { name: "予想して図を見る" }).click();
    await saveSettled(page);
    await page
      .getByRole("button", { name: "予想せず結果へ（未回答として保存）" })
      .click();
    await saveSettled(page);
    await page.getByRole("button", { name: "結果と図を見る" }).click();
    await saveSettled(page);
    await expect(
      page
        .locator('.prediction-comparison [data-tone="neutral"]')
        .getByText("未回答：正誤の評価なし", { exact: true }),
    ).toBeVisible();
    const history = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("fieldnotes.history.v1")!),
    );
    expect(history.diagramPredictions[0].prediction).toBe(null);
    expect(history.diagramReveals[0].correct).toBe(null);
    expect(history.diagramReflections).toHaveLength(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`prediction-skip-${width}.png`),
      fullPage: true,
    });
  }
});

test("prediction and reflection survive a failed write and explicit save retry", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if ((window as unknown as { failWrites: boolean }).failWrites)
        throw Error("test failure");
      original.call(this, k, v);
    };
    (window as unknown as { failWrites: boolean }).failWrites = true;
  });
  await page.goto("/#explore");
  await page.getByRole("button", { name: "予想して図を見る" }).click();
  await saveSettled(page);
  await page.getByRole("button", { name: "許可されると予想" }).click();
  await saveSettled(page);
  await page.getByRole("button", { name: "予想を保存", exact: true }).click();
  await saveSettled(page);
  await expect(page.locator('.save-status [data-tone="error"]')).toBeVisible();
  await page.getByRole("button", { name: "結果と図を見る" }).click();
  await saveSettled(page);
  await page
    .getByLabel("予想と何が違った？（任意）")
    .fill("探索終了の位置を確認した");
  await page.getByRole("button", { name: "ふりかえりを追加保存" }).click();
  await saveSettled(page);
  await page.evaluate(() => {
    (window as unknown as { failWrites: boolean }).failWrites = false;
  });
  await page.getByRole("button", { name: "保存を再試行" }).click();
  await saveSettled(page);
  await expect(page.locator(".save-status")).toBeEmpty();
  const history = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fieldnotes.history.v1")!),
  );
  expect(history.diagramPredictions).toHaveLength(1);
  expect(history.diagramReveals).toHaveLength(1);
  expect(history.diagramReflections).toHaveLength(1);
  await saveSettled(page);
  await page.reload();
  await expect(
    page.locator('.prediction-comparison [data-tone="success"]'),
  ).toBeVisible();
});

async function saveQuestionAndProposal(
  page: import("@playwright/test").Page,
  title: string,
  checked = new Date().toISOString().slice(0, 10),
  kind = "reading",
) {
  await page.goto("/#read");
  const work = page.locator(".question-workbench");
  await work
    .getByText("この節・用語への質問と教材の改善", { exact: true })
    .click();
  await saveSettled(page);
  await work
    .getByLabel("質問（1000文字まで）", { exact: true })
    .fill("DNSSEC と CAA は何が違う？");
  await work
    .getByRole("button", { name: "質問をローカル保存", exact: true })
    .click();
  await saveSettled(page);
  await work.locator(".saved-question > summary").click();
  await saveSettled(page);
  await work
    .getByText("根拠を確認して手動の追加案を作る", { exact: true })
    .click();
  await saveSettled(page);
  await work
    .getByLabel("不足している説明・図・確認点", { exact: true })
    .fill("DNS の署名検証と CA の許可の区別");
  await work
    .getByLabel("確認した公式出典URL", { exact: true })
    .fill("https://www.rfc-editor.org/rfc/rfc4033.html#section-3");
  await work
    .getByLabel("出典を確認した日（YYYY-MM-DD）", { exact: true })
    .fill(checked);
  await work
    .getByLabel("出典のどの箇所が何を裏付けるか", { exact: true })
    .fill("RFC4033 §3–4 は出所と改ざんの検証を説明し、暗号化を提供しない。");
  await work.getByLabel("追加案の種類", { exact: true }).selectOption(kind);
  await saveSettled(page);
  await work.getByLabel("追加する見出し", { exact: true }).fill(title);
  await work
    .getByLabel("追加する説明・問題文（1000文字まで）", { exact: true })
    .fill(
      "DNSSEC は DNS の答えを検証します。CAA は発行してよい CA を指定します。",
    );
  await work
    .getByRole("button", { name: "手動追加案を保存して差分確認" })
    .click();
  await saveSettled(page);
  return work;
}

test("optional resume recall hides the answer, preserves reading resume and separates self report", async ({
  page,
}, testInfo) => {
  await page.goto("/#predict");
  await expect(
    page.getByRole("button", { name: "復習してから再開（任意）" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "CAA 上、許可される" }).click();
  await saveSettled(page);
  await saveSettled(page);
  await page.reload();
  await page.getByRole("button", { name: "復習してから再開（任意）" }).click();
  await saveSettled(page);
  const review = page.locator(".resume-review");
  await expect(review.getByRole("heading", { name: "前回の要点" })).toHaveCount(
    0,
  );
  await review
    .getByRole("button", { name: "想起：CAA 上、禁止" })
    .press("Enter");
  await saveSettled(page);
  await expect(review.locator('[data-tone="error"]')).toBeVisible();
  await review
    .getByLabel("理解の自己申告（任意・想起の正誤とは別）")
    .selectOption("clearer");
  await saveSettled(page);
  await review.getByRole("button", { name: "自己申告を保存" }).click();
  await saveSettled(page);
  await page.screenshot({
    path: testInfo.outputPath("resume-recall.png"),
    fullPage: true,
  });
  await review.getByRole("button", { name: "続きへ進む" }).click();
  await saveSettled(page);
  await expect(
    page.getByRole("heading", { name: "03 / 結果を予測する" }),
  ).toBeVisible();
  const h = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fieldnotes.history.v1")!),
  );
  expect(h.attempts).toHaveLength(1);
  expect(h.recalls).toHaveLength(1);
  expect(h.recalls[0].correct).toBe(false);
  expect(h.recallReports[0].understanding).toBe("clearer");
  expect(new URL(page.url()).hash).toBe("#predict");
});

test("resume skip is ungraded and new version uses a safe introduction", async ({
  page,
}) => {
  await page.goto("/#predict");
  await page.getByRole("button", { name: "CAA 上、許可される" }).click();
  await saveSettled(page);
  await page.evaluate(() => {
    const h = JSON.parse(localStorage.getItem("fieldnotes.history.v1")!);
    h.resume.version = "1.7.0";
    localStorage.setItem("fieldnotes.history.v1", JSON.stringify(h));
  });
  await saveSettled(page);
  await page.reload();
  await page
    .getByRole("button", { name: "新版の導入を1問確認（任意）" })
    .click();
  await saveSettled(page);
  await expect(
    page.locator(".resume-review").getByText(/旧版の正誤や再開位置/),
  ).toBeVisible();
  await page.getByRole("button", { name: "復習をスキップして続きへ" }).click();
  await saveSettled(page);
  const h = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fieldnotes.history.v1")!),
  );
  expect(h.recalls[0].correct).toBe(null);
  expect(h.recalls[0].answer).toBe(null);
  expect(h.attempts).toHaveLength(1);
});

test("manual proposal preview, personal apply, new local version and old answers survive reload", async ({
  page,
}, testInfo) => {
  await page.goto("/#predict");
  await page.getByRole("button", { name: "CAA 上、許可される" }).click();
  await saveSettled(page);
  const work = await saveQuestionAndProposal(
    page,
    "追補 / DNSSEC と CAA の役割",
  );
  await expect(work.getByText("生成未接続", { exact: true })).toBeVisible();
  await expect(
    work.getByRole("heading", { name: "反映前", exact: true }),
  ).toBeVisible();
  await expect(
    work.getByRole("button", { name: "この差分を本人選択で反映" }),
  ).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("manual-diff.png"),
    fullPage: true,
  });
  await work
    .getByLabel("差分と公式根拠を読み、この追加だけを反映する", { exact: true })
    .check();
  await work.getByRole("button", { name: "この差分を本人選択で反映" }).click();
  await saveSettled(page);
  await page.getByRole("button", { name: "次へ →", exact: true }).click();
  await saveSettled(page);
  await expect(
    page.getByRole("heading", {
      name: "追補 / DNSSEC と CAA の役割",
      exact: true,
    }),
  ).toBeVisible();
  await saveSettled(page);
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "追補 / DNSSEC と CAA の役割",
      exact: true,
    }),
  ).toBeVisible();
  const h = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fieldnotes.history.v1")!),
  );
  expect(h.bookRevisions).toHaveLength(1);
  expect(h.bookRevisions[0].baseVersion).toBe("1.8.0");
  expect(h.bookRevisions[0].version).toContain("+local.");
  expect(h.attempts[0].version).toBe("1.8.0");
  expect(h.questionEvents[0].action).toBe("resolved");
  await page.goBack();
  expect(h.proposals).toHaveLength(1);
});

test("stale source holds proposals and cancellation never publishes", async ({
  page,
}) => {
  const work = await saveQuestionAndProposal(
    page,
    "古い根拠の追補",
    "2025-01-01",
  );
  await expect(
    work.locator(".proposal-preview").getByText(/30日超/),
  ).toBeVisible();
  await work
    .getByLabel("差分と公式根拠を読み、この追加だけを反映する", { exact: true })
    .check();
  await expect(
    work.getByRole("button", { name: "この差分を本人選択で反映" }),
  ).toBeDisabled();
  await work.getByRole("button", { name: "提案を取り消す" }).click();
  await saveSettled(page);
  await work.locator(".proposal-preview > summary").click();
  await saveSettled(page);
  await expect(work.getByText(/取消済み/)).toBeVisible();
  await saveSettled(page);
  await page.reload();
  const h = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fieldnotes.history.v1")!),
  );
  expect(h.bookRevisions).toHaveLength(0);
  expect(h.proposalEvents[0].action).toBe("cancel");
});

test("term questions, local drafts and proposal controls reflow and do not send generation requests", async ({
  page,
  baseURL,
}, testInfo) => {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).origin !== new URL(baseURL!).origin)
      requests.push(r.url());
  });
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#read");
    await page.getByRole("button", { name: "DNSSECの説明を開く" }).count();
    await page.locator('article [data-term-id="resolver"]').first().click();
    await saveSettled(page);
    const dialog = page.getByRole("dialog");
    await dialog
      .getByText("この用語への質問を残す（生成未接続）", { exact: true })
      .click();
    await saveSettled(page);
    await dialog
      .getByLabel("この用語への質問（1000文字まで）", { exact: true })
      .fill(`リゾルバーの役割を説明したい ${width}`);
    await dialog
      .getByRole("button", { name: "用語の質問をローカル保存" })
      .click();
    await saveSettled(page);
    await page.keyboard.press("Escape");
    await saveSettled(page);
    const work = page.locator(".question-workbench");
    await work
      .getByText("この節・用語への質問と教材の改善", { exact: true })
      .click();
    await saveSettled(page);
    await work
      .getByRole("button", {
        name: "質問・提案一覧を読み直す（未保存の入力は破棄）",
      })
      .click();
    await saveSettled(page);
    await expect(
      work.getByText(`リゾルバーの役割を説明したい ${width}`, { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`question-${width}.png`),
      fullPage: true,
    });
    await saveSettled(page);
    await page.reload();
  }
  expect(requests).toEqual([]);
});

test("proposal publish fails safely on quota errors and a conflicting local revision", async ({
  page,
}) => {
  const work = await saveQuestionAndProposal(page, "安全な追補");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as unknown as { restore: () => void }).restore = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = () => {
      throw Error("quota");
    };
  });
  await work
    .getByLabel("差分と公式根拠を読み、この追加だけを反映する", { exact: true })
    .check();
  await work.getByRole("button", { name: "この差分を本人選択で反映" }).click();
  await saveSettled(page);
  await expect(work.getByText(/新しい版を保存できませんでした/)).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { restore: () => void }).restore();
    const h = JSON.parse(localStorage.getItem("fieldnotes.history.v1")!);
    const proposal = h.proposals[0];
    const fakeBook = {
      bookId: "caa-first-rrset",
      version: "1.8.0+local.other",
      contentSchemaVersion: 4,
      title: "他タブの版",
      blocks: [
        {
          id: "read",
          kind: "reading",
          title: "他タブ",
          markdown: "他タブの教材",
        },
      ],
    };
    h.bookRevisions.push({
      bookId: fakeBook.bookId,
      version: fakeBook.version,
      blockId: "read",
      userId: h.userId,
      time: new Date().toISOString(),
      revisionId: "other",
      proposalId: proposal.proposalId,
      baseVersion: "1.8.0",
      book: fakeBook,
    });
    localStorage.setItem("fieldnotes.history.v1", JSON.stringify(h));
  });
  await work.getByRole("button", { name: "この差分を本人選択で反映" }).click();
  await saveSettled(page);
  await expect(work.getByText(/別タブで教材版が変わりました/)).toBeVisible();
  const h = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fieldnotes.history.v1")!),
  );
  expect(h.bookRevisions).toHaveLength(1);
  expect(h.bookRevisions[0].revisionId).toBe("other");
});

test("two shared tabs applying the same proposal create one revision under an exclusive lock", async ({
  page,
  context,
}) => {
  const work = await saveQuestionAndProposal(page, "同時反映の追補");
  const other = await context.newPage();
  await other.goto("/#read");
  const second = other.locator(".question-workbench");
  await second
    .getByText("この節・用語への質問と教材の改善", { exact: true })
    .click();
  await saveSettled(page);
  await second.locator(".proposal-preview > summary").click();
  await saveSettled(page);
  await work
    .getByLabel("差分と公式根拠を読み、この追加だけを反映する", { exact: true })
    .check();
  await second
    .getByLabel("差分と公式根拠を読み、この追加だけを反映する", { exact: true })
    .check();
  await Promise.all([
    work.getByRole("button", { name: "この差分を本人選択で反映" }).click(),
    second.getByRole("button", { name: "この差分を本人選択で反映" }).click(),
  ]);
  await saveSettled(page);
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("fieldnotes.history.v1")!)
              .bookRevisions.length,
        ),
    )
    .toBe(1);
  const h = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fieldnotes.history.v1")!),
  );
  expect(
    h.proposalEvents.filter((e: { action: string }) => e.action === "apply"),
  ).toHaveLength(1);
  const labels = await Promise.all([
    page.locator(".prototype-note").textContent(),
    other.locator(".prototype-note").textContent(),
  ]);
  expect(labels.filter((t) => t?.includes("本人のローカル追加"))).toHaveLength(
    1,
  );
  await other.close();
});

test("N/P moves blocks, focuses the heading, preserves answers and supports Back/Forward", async ({
  page,
}, testInfo) => {
  await page.goto("/#predict");
  await page.getByRole("button", { name: "CAA 上、許可される" }).click();
  await saveSettled(page);
  await page.locator("article h2").focus();
  await page.keyboard.press("Shift+N");
  await saveSettled(page);
  await expect(page).toHaveURL(/#explain$/);
  await expect(page.locator("article h2")).toBeFocused();
  await page.keyboard.press("p");
  await saveSettled(page);
  await expect(page).toHaveURL(/#predict$/);
  await expect(page.getByText("正解です", { exact: true })).toBeVisible();
  await page.goBack();
  await saveSettled(page);
  await expect(page).toHaveURL(/#explain$/);
  await page.goForward();
  await saveSettled(page);
  await expect(page).toHaveURL(/#predict$/);
  const h = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fieldnotes.history.v1")!),
  );
  expect(h.attempts).toHaveLength(1);
  expect(h.resume.blockId).toBe("predict");
  await page.goto("/#read");
  const length = await page.evaluate(() => history.length);
  await page.keyboard.press("p");
  await page.evaluate(() =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "n", repeat: true, bubbles: true }),
    ),
  );
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.goto("/#takeaway");
  const last = await page.evaluate(() => history.length);
  await page.keyboard.press("n");
  expect(await page.evaluate(() => history.length)).toBe(last);
  await expect(page.getByText(/読了。/)).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("navigation-shortcuts.png"),
    fullPage: true,
  });
});

test("N/P ignores forms, editable text, modifiers, composition, modal and disabled setting", async ({
  page,
}) => {
  await page.goto("/#read");
  await page.getByLabel("今日の時間（目安）").focus();
  await page.keyboard.press("n");
  const work = page.locator(".question-workbench");
  await work.locator("summary").first().click();
  await work.getByLabel("質問（1000文字まで）", { exact: true }).fill("np");
  await page.keyboard.press("n");
  await expect(page).toHaveURL(/#read$/);
  await page.evaluate(() => {
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    editable.id = "keyboard-editor";
    document.body.append(editable);
    editable.focus();
  });
  await page.keyboard.press("N");
  await expect(page).toHaveURL(/#read$/);
  await page.evaluate(() =>
    document.querySelector("#keyboard-editor")?.remove(),
  );
  await page.locator("article h2").focus();
  await page.evaluate(() => {
    for (const options of [
      { isComposing: true },
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
    ])
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "n",
          bubbles: true,
          cancelable: true,
          ...options,
        }),
      );
  });
  await expect(page).toHaveURL(/#read$/);
  await page.getByRole("button", { name: "RRsetの説明を開く" }).first().click();
  await page.keyboard.press("n");
  await expect(page.getByRole("dialog", { name: "RRsetの説明" })).toBeVisible();
  await expect(page).toHaveURL(/#read$/);
  await page.getByRole("button", { name: "閉じて読書へ戻る" }).click();
  await expect(
    page.getByRole("dialog", { name: "RRsetの説明" }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "読書設定", exact: true }).click();
  await page.getByLabel("N：次へ / P：前へ（キー移動を有効にする）").uncheck();
  await page.getByRole("button", { name: "閉じて読書へ戻る" }).click();
  await expect(
    page.getByRole("dialog", { name: "読書設定", exact: true }),
  ).not.toBeVisible();
  await page.locator("article h2").focus();
  await page.keyboard.press("n");
  await expect(page).toHaveURL(/#read$/);
  await saveSettled(page);
  await page.reload();
  await page.getByRole("button", { name: "読書設定", exact: true }).click();
  await expect(
    page.getByLabel("N：次へ / P：前へ（キー移動を有効にする）"),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "閉じて読書へ戻る" }).click();
  await expect(
    page.getByRole("dialog", { name: "読書設定", exact: true }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "次へ →", exact: true }).click();
  await saveSettled(page);
  await expect(page).toHaveURL(/#explore$/);
});

test("N/P navigation and answers remain usable during storage failure", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw Error("quota");
    };
  });
  await page.goto("/#predict");
  await page.getByRole("button", { name: "CAA 上、許可される" }).click();
  await saveSettled(page);
  await page.locator("article h2").focus();
  await page.keyboard.press("n");
  await saveSettled(page);
  await page.keyboard.press("p");
  await saveSettled(page);
  await expect(page).toHaveURL(/#predict$/);
  await expect(
    page.getByText(
      "保存できません。このタブ内の回答・予想・ふりかえりは保持しています。",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "読書設定", exact: true }).click();
  await page.getByLabel("N：次へ / P：前へ（キー移動を有効にする）").uncheck();
  await expect(
    page.getByText("設定はこのタブのみ。保存できませんでした。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "閉じて読書へ戻る" }).click();
  await expect(
    page.getByRole("dialog", { name: "読書設定", exact: true }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "読書設定", exact: true }).click();
  await expect(
    page.getByLabel("N：次へ / P：前へ（キー移動を有効にする）"),
  ).not.toBeChecked();
  await expect(
    page.getByText("設定はこのタブのみ。保存できませんでした。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "閉じて読書へ戻る" }).click();
  await expect(
    page.getByRole("dialog", { name: "読書設定", exact: true }),
  ).not.toBeVisible();
  await page.locator("article h2").focus();
  await page.keyboard.press("n");
  await expect(page).toHaveURL(/#predict$/);
});

test("N/P waits while an explicit proposal apply is pending", async ({
  page,
}) => {
  const work = await saveQuestionAndProposal(page, "キー移動待機の追補");
  await work
    .getByLabel("差分と公式根拠を読み、この追加だけを反映する", { exact: true })
    .check();
  await page.evaluate(
    () =>
      new Promise<void>((ready) => {
        void navigator.locks.request("fieldnotes.history.v1", async () => {
          ready();
          await new Promise<void>((resolve) => {
            (
              window as unknown as { releaseProposalLock: () => void }
            ).releaseProposalLock = resolve;
          });
        });
      }),
  );
  await work.getByRole("button", { name: "この差分を本人選択で反映" }).click();
  await page.locator("article h2").focus();
  await page.keyboard.press("n");
  await expect(page).toHaveURL(/#read$/);
  await page.evaluate(() =>
    (
      window as unknown as { releaseProposalLock: () => void }
    ).releaseProposalLock(),
  );
  await expect(page.locator(".prototype-note")).toContainText(
    "本人のローカル追加",
  );
  await saveSettled(page);
  await page.locator("article h2").focus();
  await page.keyboard.press("n");
  await saveSettled(page);
  await expect(
    page.getByRole("heading", { name: "キー移動待機の追補", exact: true }),
  ).toBeVisible();
});

test("another tab cancellation prevents applying a stale visible proposal", async ({
  page,
  context,
}) => {
  const work = await saveQuestionAndProposal(page, "別タブ取消の追補");
  const other = await context.newPage();
  await other.goto("/#read");
  const second = other.locator(".question-workbench");
  await second
    .getByText("この節・用語への質問と教材の改善", { exact: true })
    .click();
  await second.locator(".proposal-preview > summary").click();
  await second.getByRole("button", { name: "提案を取り消す" }).click();
  await saveSettled(other);
  await work
    .getByLabel("差分と公式根拠を読み、この追加だけを反映する", { exact: true })
    .check();
  await work.getByRole("button", { name: "この差分を本人選択で反映" }).click();
  await expect(
    work.getByText("取消済み、または反映済みの提案です。", { exact: true }),
  ).toBeVisible();
  const h = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("fieldnotes.history.v1")!),
  );
  expect(h.bookRevisions).toHaveLength(0);
  expect(h.proposalEvents.map((e: { action: string }) => e.action)).toEqual([
    "cancel",
  ]);
  await other.close();
});

test("allowed fixed diagram and question additions render without executing generated code", async ({
  page,
}) => {
  for (const [kind, title] of [
    ["lookup-flow", "追補 / 固定探索図"],
    ["question", "追補 / 固定 CAA 問題"],
  ]) {
    await page.goto("/#read");
    await page.evaluate(() => localStorage.clear());
    await saveSettled(page);
    await page.reload();
    const work = await saveQuestionAndProposal(page, title, undefined, kind);
    await work
      .getByLabel("差分と公式根拠を読み、この追加だけを反映する", {
        exact: true,
      })
      .check();
    await work
      .getByRole("button", { name: "この差分を本人選択で反映" })
      .click();
    await saveSettled(page);
    await expect(page.locator(".prototype-note")).toContainText(
      "本人のローカル追加",
    );
    await page.getByRole("button", { name: "次へ →", exact: true }).click();
    await saveSettled(page);
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    if (kind === "lookup-flow")
      await expect(page.locator(".flow-run")).toBeVisible();
    else {
      await page.getByRole("button", { name: "CAA 上、禁止される" }).click();
      await saveSettled(page);
      await expect(
        page.getByRole("heading", { name: "正解です", exact: true }),
      ).toBeVisible();
    }
  }
});

async function saveSettled(page: import("@playwright/test").Page) {
  await expect(page.locator(".save-status")).not.toHaveAttribute(
    "data-saving",
    "true",
  );
}
