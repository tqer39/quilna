import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page, design = "studio", many = false) {
  await page.addInitScript((design) => {
    localStorage.setItem("quilna.feed.refresh.v1", "0");
    // Keep graph interaction fixtures stable independently of their age.
    // Selection retention during background updates is tracked separately.
    localStorage.setItem("quilna.article.updates.v1", "false");
    localStorage.setItem("quilna.reader.design.v1", design);
  }, design);
  await page.route("**/api/collection", (r) =>
    r.fulfill({ status: 404, json: {} }),
  );
  await page.route("**/__graph", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Graph fixture</title>",
    }),
  );
  await page.goto("/__graph");
  await page.evaluate(async (many) => {
    const storePath = "/src/feed-store.ts",
      linkPath = "/src/article-connections.ts",
      highlightPath = "/src/article-highlights.ts";
    const { openFeedLibrary } = await import(storePath);
    const { writeConnection, connectionKey } = await import(linkPath);
    const { writeHighlight, highlightVersion } = await import(highlightPath);
    const ids = many
      ? ["a", ...Array.from({ length: 12 }, (_, i) => `b${i}`)]
      : ["a", "b", "c", "hidden", "unread"];
    const db = await openFeedLibrary();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite");
      for (const id of ids)
        tx.objectStore("articles").put({
          id,
          title: `Graph article ${id}`,
          url: `https://example.org/${id}`,
          feedUrl: "",
          published: null,
          fetchedAt: "2026-10-30T00:00:00Z",
          body: `Article ${id}: source evidence is preserved.`,
          read: id !== "unread",
          saved: id === "a",
          manualTags: ["共通の話題"],
          content: {
            text: `Article ${id}: source evidence is preserved.`,
            title: `Graph article ${id}`,
            url: `https://example.org/${id}`,
            language: "en",
            fetchedAt: "2026-10-30T00:00:00Z",
          },
        });
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    db.close();
    const ref = (id: string) => ({
      id,
      title: `Graph article ${id}`,
      url: `https://example.org/${id}`,
    });
    for (const id of many ? ids.slice(1) : ["b", "hidden"])
      await writeConnection(
        {
          id: connectionKey("a", id),
          members: ["a", id].sort(),
          from: ref("a"),
          to: ref(id),
          state: id === "hidden" ? "hidden" : "linked",
          reason:
            id === "hidden"
              ? ""
              : `比較する理由 ${id} <img src=x onerror=alert(1)>`,
          revision: 1,
          createdAt: "2026-10-30T00:00:00Z",
        },
        null,
      );
    if (!many)
      await writeConnection(
        {
          id: connectionKey("b", "c"),
          members: ["b", "c"],
          from: ref("b"),
          to: ref("c"),
          state: "linked",
          reason: "次のつながり",
          revision: 1,
          createdAt: "2026-10-30T00:00:00Z",
        },
        null,
      );
    const text = "Article a: source evidence is preserved.";
    await writeHighlight(
      {
        id: "11111111-1111-4111-8111-111111111111",
        articleId: "a",
        title: ref("a").title,
        url: ref("a").url,
        view: "original",
        language: "en",
        version: await highlightVersion(text, text, "original", "en"),
        start: 11,
        end: 26,
        quote: "source evidence",
        note: "この主張の根拠を比較",
        createdAt: "2026-10-30T00:00:00Z",
        revision: 1,
      },
      null,
    );
  }, many);
  await page.goto("/?view=feeds");
  await page
    .getByRole("button", { name: "Graph article a", exact: true })
    .click();
}
async function openGraph(page: Page) {
  await page.locator("#rss-graph > details > summary").click();
  await expect(page.locator("#rss-graph .rss-graph-center")).toBeVisible();
}
const evidence = (page: Page) =>
  page.getByRole("region", { name: "選択した関係の理由と出典" });
const node = (page: Page, title: string) =>
  page.locator(".rss-graph-node").filter({ hasText: title });

test("graph explores confirmed links, quotes and topic roots without converting suggestions into links", async ({
  page,
}) => {
  await fixture(page);
  await expect(page.locator(".rss-graph-node")).toHaveCount(0);
  await openGraph(page);
  await expect(page.locator(".rss-graph-node")).toHaveCount(3);
  await expect(node(page, "Graph article hidden")).toHaveCount(0);
  const line = page.locator(".rss-graph-edge-linked").first();
  await line.scrollIntoViewIfNeeded();
  const point = await line.evaluate((element) => {
    const path = element as SVGPathElement;
    const point = path
      .getPointAtLength(path.getTotalLength() * 0.8)
      .matrixTransform(path.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(point.x, point.y);
  await expect(evidence(page)).toContainText(
    "比較する理由 b <img src=x onerror=alert(1)>",
  );
  await expect(evidence(page).locator("img")).toHaveCount(0);
  await expect(
    evidence(page).getByRole("link", { name: "保存した出典を開く" }),
  ).toHaveCount(2);
  await evidence(page)
    .getByRole("button", { name: "ここを起点に周辺を見る" })
    .click();
  await expect(page.locator(".rss-graph-center")).toContainText(
    "Graph article b",
  );
  await node(page, "Graph article c").click();
  await expect(evidence(page)).toContainText("次のつながり");
  await page.getByRole("button", { name: "前の起点へ", exact: true }).click();
  await expect(page.locator(".rss-graph-center")).toContainText(
    "Graph article a",
  );
  await node(page, "共通の話題").click();
  await expect(evidence(page)).toContainText(
    "内容の一致・支持・反証を確認した関係ではありません",
  );
  await evidence(page)
    .getByRole("button", { name: "ここを起点に周辺を見る" })
    .click();
  await expect(page.locator(".rss-graph-center")).toContainText("共通の話題");
  await expect(node(page, "Graph article unread")).toHaveCount(0);
  await expect(node(page, "Graph article c")).toHaveCount(1);
  const data = await page.evaluate(async () => {
    const linkPath = "/src/article-connections.ts",
      storePath = "/src/feed-store.ts";
    const links = await (await import(linkPath)).readConnections("a");
    const db = await (await import(storePath)).openFeedLibrary();
    const articles = await new Promise<{ id: string; read: boolean }[]>(
      (resolve) => {
        const req = db.transaction("articles").objectStore("articles").getAll();
        req.onsuccess = () => resolve(req.result);
      },
    );
    db.close();
    return { links, unread: articles.find((a) => a.id === "unread")!.read };
  });
  expect(data.links.map((c: { state: string }) => c.state).sort()).toEqual([
    "hidden",
    "linked",
  ]);
  expect(data.unread).toBe(false);
});

test("quote relation preserves evidence, moves to exact source and refuses a different version", async ({
  page,
}) => {
  await fixture(page);
  await openGraph(page);
  await node(page, "source evidence").click();
  await expect(evidence(page)).toContainText("この主張の根拠を比較");
  await evidence(page)
    .getByRole("button", { name: "表示中の本文の引用へ" })
    .click();
  await expect(evidence(page)).toContainText("根拠の本文を選択しました");
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(
    "source evidence",
  );
  await evidence(page)
    .getByRole("button", { name: "ここを起点に周辺を見る" })
    .click();
  await expect(page.locator(".rss-graph-center")).toContainText(
    "source evidence",
  );
  await expect(node(page, "Graph article a")).toHaveCount(1);
  await page.getByRole("button", { name: "前の起点へ", exact: true }).click();
  await page.evaluate(async () => {
    const path = "/src/feed-store.ts";
    const db = await (await import(path)).openFeedLibrary();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite"),
        store = tx.objectStore("articles"),
        get = store.get("a");
      get.onsuccess = () =>
        store.put({
          ...get.result,
          content: {
            ...get.result.content,
            text: "Updated article. " + get.result.content.text,
          },
        });
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Graph article a", exact: true })
    .click();
  await openGraph(page);
  await node(page, "source evidence").click();
  await evidence(page)
    .getByRole("button", { name: "表示中の本文の引用へ" })
    .click();
  await expect(evidence(page)).toContainText("別の本文の版・言語の引用");
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("");
});

for (const design of ["studio", "editorial", "focus"])
  test(`${design}: bounded graph, keyboard list, pagination and narrow reading layout`, async ({
    page,
  }, testInfo) => {
    await fixture(page, design, true);
    await openGraph(page);
    await expect(page.locator("html")).toHaveAttribute(
      "data-reader-design",
      design,
    );
    await expect(page.locator(".rss-graph-node")).toHaveCount(8);
    const connectionGap = await page
      .locator(".rss-graph-canvas")
      .evaluate((canvas) => {
        const center = canvas
          .querySelector(".rss-graph-center")!
          .getBoundingClientRect();
        const path = canvas
          .querySelector(".rss-graph-edge")!
          .getBoundingClientRect();
        return Math.abs(center.bottom - path.top);
      });
    expect(connectionGap).toBeLessThan(1);
    await expect(page.getByRole("button", { name: "前の8件" })).toBeDisabled();
    await page.getByRole("button", { name: "次の8件" }).click();
    await expect(page.locator(".rss-graph-node")).toHaveCount(6);
    await expect(page.getByRole("button", { name: "次の8件" })).toBeDisabled();
    await page.getByRole("button", { name: "前の8件" }).click();
    await page.locator("#rss-graph details details > summary").click();
    const first = page
      .getByRole("list", { name: "関係図と同じ情報の一覧" })
      .getByRole("button")
      .first();
    await first.focus();
    await page.keyboard.press("Enter");
    await expect(evidence(page)).toBeFocused();
    await expect(evidence(page)).toContainText("比較する理由");
    const contrast = await page
      .locator(".rss-graph-node")
      .first()
      .evaluate((el) => {
        const rgb = (c: string) =>
          c
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((v) => {
              const s = v / 255;
              return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            });
        const lum = (c: string) => {
          const [r, g, b] = rgb(c);
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const style = getComputedStyle(el),
          a = lum(style.color),
          b = lum(style.backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await page
      .locator("#rss-graph")
      .screenshot({ path: testInfo.outputPath(`graph-${design}.png`) });
    await page.setViewportSize({ width: 320, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator(".rss-source-text")).toContainText(
      "Article a: source evidence is preserved.",
    );
  });

for (const failure of [false, true])
  test(`late ${failure ? "failure" : "success"} cannot replace a newer A-B-A graph`, async ({
    page,
  }) => {
    await fixture(page);
    await page.evaluate((failure) => {
      const transaction = IDBDatabase.prototype.transaction,
        getAll = IDBIndex.prototype.getAll;
      let first = true,
        held: IDBTransaction | undefined;
      IDBDatabase.prototype.transaction = function (
        ...args: Parameters<IDBDatabase["transaction"]>
      ) {
        const tx = transaction.apply(this, args);
        if (
          this.name === "quilna.connections.v1" &&
          tx.mode === "readonly" &&
          first
        ) {
          first = false;
          held = tx;
          for (const name of ["complete", "abort"] as const)
            Object.defineProperty(tx, `on${name}`, {
              configurable: true,
              set(handler: (event: Event) => void) {
                tx.addEventListener(
                  name,
                  (event) => {
                    (
                      window as unknown as { releaseGraph: () => void }
                    ).releaseGraph = () => handler.call(tx, event);
                  },
                  { once: true },
                );
              },
            });
        }
        return tx;
      };
      IDBIndex.prototype.getAll = function (...args) {
        const request = getAll.apply(this, args);
        if (this.objectStore.transaction === held && failure)
          request.addEventListener("success", () => held!.abort());
        return request;
      };
    }, failure);
    await page.locator("#rss-graph > details > summary").click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            typeof (window as unknown as { releaseGraph?: () => void })
              .releaseGraph,
        ),
      )
      .toBe("function");
    for (const id of ["b", "a"]) {
      await page
        .getByRole("button", { name: "← 記事一覧へ", exact: true })
        .click();
      await page
        .getByRole("button", { name: `Graph article ${id}`, exact: true })
        .click();
      await openGraph(page);
    }
    await page.evaluate(async () => {
      const path = "/src/article-connections.ts",
        { readConnections, writeConnection } = await import(path);
      const old = (await readConnections("a")).find(
        (c: { state: string }) => c.state === "linked",
      );
      await writeConnection({ ...old, reason: "新しい根拠", revision: 2 }, 1);
    });
    await page.getByRole("button", { name: "関係図を再読み込み" }).click();
    await node(page, "Graph article b").click();
    await expect(evidence(page)).toContainText("新しい根拠");
    await page.evaluate(() =>
      (window as unknown as { releaseGraph: () => void }).releaseGraph(),
    );
    await expect(evidence(page)).toContainText("新しい根拠");
    await expect(
      page.locator("#rss-graph > details > [role=status]"),
    ).not.toContainText("取得できません");
  });

test("failed graph read is explicit, preserves data, retries and follows cross-tab edits and unlink", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const getAll = IDBIndex.prototype.getAll;
    let first = true;
    IDBIndex.prototype.getAll = function (...args) {
      const request = getAll.apply(this, args);
      if (this.name === "members" && first) {
        first = false;
        const tx = this.objectStore.transaction;
        request.addEventListener("success", () => tx.abort());
      }
      return request;
    };
  });
  await openGraph(page);
  await expect(
    page.locator("#rss-graph > details > [role=status]"),
  ).toContainText("記事間のつながりを取得できません");
  await expect(node(page, "source evidence")).toHaveCount(1);
  await page.getByRole("button", { name: "関係図を再読み込み" }).click();
  await expect(node(page, "Graph article b")).toHaveCount(1);
  await page.evaluate(async () => {
    const path = "/src/article-connections.ts",
      { readConnections, writeConnection } = await import(path);
    const old = (await readConnections("a")).find(
      (c: { state: string }) => c.state === "linked",
    );
    await writeConnection({ ...old, reason: "別画面から更新", revision: 2 }, 1);
    const ch = new BroadcastChannel("quilna.connections.v1");
    ch.postMessage(["a", "b"]);
    ch.close();
  });
  await node(page, "Graph article b").click();
  await expect(evidence(page)).toContainText("別画面から更新");
  await page.evaluate(async () => {
    const path = "/src/article-connections.ts",
      { readConnections, writeConnection } = await import(path);
    const old = (await readConnections("a")).find(
      (c: { state: string }) => c.state === "linked",
    );
    await writeConnection(old, 2, true);
    const ch = new BroadcastChannel("quilna.connections.v1");
    ch.postMessage(["a", "b"]);
    ch.close();
  });
  await expect(node(page, "Graph article b")).toHaveCount(0);
  await expect(evidence(page)).toBeEmpty();
  await expect(node(page, "source evidence")).toHaveCount(1);
});

test("missing articles retain safe source references and a deleted quote focus reports the loss", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(async () => {
    const path = "/src/feed-store.ts";
    const db = await (await import(path)).openFeedLibrary();
    await new Promise<void>((resolve) => {
      const tx = db.transaction("articles", "readwrite");
      tx.objectStore("articles").delete("b");
      tx.oncomplete = () => resolve();
    });
    db.close();
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Graph article a", exact: true })
    .click();
  await openGraph(page);
  await node(page, "Graph article b").click();
  await expect(
    evidence(page).getByRole("button", { name: "この記事を読む" }).last(),
  ).toBeDisabled();
  await expect(
    evidence(page).getByRole("link", { name: "保存した出典を開く" }).last(),
  ).toHaveAttribute("href", "https://example.org/b");
  await evidence(page)
    .getByRole("button", { name: "ここを起点に周辺を見る" })
    .click();
  await expect(
    page.locator("#rss-graph > details > [role=status]"),
  ).toContainText("現在のライブラリにありません");
  await expect(node(page, "Graph article c")).toHaveCount(1);
  await page.getByRole("button", { name: "前の起点へ", exact: true }).click();
  await node(page, "source evidence").click();
  await evidence(page)
    .getByRole("button", { name: "ここを起点に周辺を見る" })
    .click();
  await expect(page.locator(".rss-graph-center")).toContainText(
    "source evidence",
  );
  await page.evaluate(async () => {
    const path = "/src/article-highlights.ts",
      { readHighlights, writeHighlight } = await import(path);
    const h = (await readHighlights("a"))[0];
    await writeHighlight(h, 1, true);
    const ch = new BroadcastChannel("quilna.highlights.v1");
    ch.postMessage("a");
    ch.close();
  });
  await expect(
    page.locator("#rss-graph > details > [role=status]"),
  ).toContainText("引用は削除されています");
  await expect(page.locator(".rss-graph-node")).toHaveCount(0);
  await expect(page.locator(".rss-source-text")).toContainText(
    "Article a: source evidence is preserved.",
  );
});

test("topic pagination visits all matching articles and large topic scans are cancellable", async ({
  page,
}) => {
  await fixture(page, "studio", true);
  await openGraph(page);
  await page.getByRole("button", { name: "次の8件" }).click();
  await node(page, "共通の話題").click();
  await evidence(page)
    .getByRole("button", { name: "ここを起点に周辺を見る" })
    .click();
  await expect(page.locator(".rss-graph-node")).toHaveCount(8);
  const first = await page.locator(".rss-graph-node span").allTextContents();
  await page.getByRole("button", { name: "次の8件" }).click();
  await expect(page.locator(".rss-graph-node")).toHaveCount(5);
  const last = await page.locator(".rss-graph-node span").allTextContents();
  expect(new Set([...first, ...last]).size).toBe(13);
  await expect(page.getByRole("button", { name: "次の8件" })).toBeDisabled();
  // Test the cancellable scan at its actual yield boundary with a large synthetic library.
  const result = await page.evaluate(async () => {
    const path = "/src/article-graph.ts";
    const { graphNeighborhood } = await import(path);
    const controller = new AbortController();
    const promise = graphNeighborhood(
      { kind: "tag", tag: "absent" },
      0,
      new Array(100000).fill({ read: true, manualTags: ["different"] }),
      () => undefined,
      controller.signal,
    );
    controller.abort();
    try {
      await promise;
      return "completed";
    } catch (e) {
      return (e as Error).name;
    }
  });
  expect(result).toBe("AbortError");
  await page.locator("#rss-graph > details > summary").click();
  await expect(page.locator(".rss-graph-canvas")).toBeHidden();
});

test("a delayed quote verification cannot move the reading position after selecting another graph card", async ({
  page,
}) => {
  await fixture(page);
  await openGraph(page);
  await node(page, "source evidence").click();
  await page.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (
      ...args: Parameters<SubtleCrypto["digest"]>
    ) => {
      const result = await digest(...args);
      await new Promise<void>((resolve) => {
        (window as unknown as { releaseQuote: () => void }).releaseQuote =
          resolve;
      });
      return result;
    };
    getSelection()?.removeAllRanges();
  });
  await evidence(page)
    .getByRole("button", { name: "表示中の本文の引用へ" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          typeof (window as unknown as { releaseQuote?: () => void })
            .releaseQuote,
      ),
    )
    .toBe("function");
  await node(page, "共通の話題").click();
  await page.evaluate(async () => {
    (window as unknown as { releaseQuote: () => void }).releaseQuote();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("");
  await expect(evidence(page)).toBeFocused();
  await expect(evidence(page)).toContainText("同じ話題の手がかり");
});
