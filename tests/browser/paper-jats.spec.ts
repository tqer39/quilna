import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import fixture from "../fixtures/crossref-work.json" with { type: "json" };
import { crossrefMetadata, paperSnapshot } from "../../src/paper-format";
const xml = new TextDecoder().decode(await readFile("tests/fixtures/europepmc-work.xml"));
/** Exercise the native browser XML parser without loading the product or allowing any external reference. */
async function environment(page: Page) {
  const network: string[] = [];
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:5197") {
      network.push(url.href);
      return route.abort();
    }
    if (url.pathname === "/__paper-parser-fixture")
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>XML parser fixture</title>",
      });
    return route.continue();
  });
  await page.goto("/__paper-parser-fixture");
  return network;
}
/** Return a selected source or its stable refusal message without involving a provider response. */
async function parse(page: Page, raw: string) {
  const paper = await paperSnapshot(
    crossrefMetadata(fixture, fixture.message.DOI),
    "2026-11-03T00:00:00.000Z",
  );
  return page.evaluate(
    async ({ raw, paper }) => {
      const path = "/src/paper-jats.ts",
        api: typeof import("../../src/paper-jats") = await import(path);
      try {
        return {
          source: await api.parsePaperJATS(
            raw,
            "PMC1234567",
            paper,
            "2026-11-03T00:00:01.000Z",
          ),
          error: null,
        };
      } catch (error) {
        return { source: null, error: (error as Error).message };
      }
    },
    { raw, paper },
  );
}
test("declared JATS version type survives extraction and is not inferred from bibliographic version", async ({ page }) => {
  await environment(page);
  const result = await parse(page, xml.replace("</article-meta>", '<article-version article-version-type="pmc-version">2</article-version></article-meta>'));
  expect(result.error).toBeNull();
  expect(result.source!.facts).toMatchObject({ version: "2", versionType: "pmc-version" });
  expect(result.source!.paper.metadata.version).toBe("2");
});
test("JATS extraction retains source identity, attribution, exact paragraph locations and explicit unsupported-block counts without fetching assets", async ({
  page,
}) => {
  const network = await environment(page),
    result = await parse(page, xml);
  expect(result.error).toBeNull();
  const source = result.source!;
  expect(source.facts.doi).toBe(fixture.message.DOI);
  expect(source.facts.pmcid).toBe("PMC1234567");
  expect(source.facts.authors).toEqual(["Fixture Author"]);
  expect(source.facts.license.copyright).toBe("Copyright Synthetic Author");
  expect(source.facts.license.statement).toBe("Synthetic CC BY 4.0 license.");
  expect(source.facts.version).toBeNull();
  expect(source.paper.metadata.version).toBe("2");
  expect(source.facts.blocks).toEqual([
    {
      path: "/article[1]/body[1]/sec[1]/p[1]",
      sections: ["合成の節"],
      text: "Evidence😀 & exact quote.",
    },
    {
      path: "/article[1]/body[1]/sec[1]/p[2]",
      sections: ["合成の節"],
      text: "CO_{2} x^{3}.",
    },
    {
      path: "/article[1]/body[1]/sec[1]/sec[1]/p[1]",
      sections: ["合成の節", "Nested section"],
      text: "Another paragraph.",
    },
  ]);
  expect(source.facts.omitted).toBe(3);
  expect(network).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as unknown as Record<string, unknown>).PAPER_XML_XSS,
    ),
  ).toBeUndefined();
  expect(
    await page.locator("article,script:not([type='module'])").count(),
  ).toBe(0);
});
test("ALI grant and CC0 are recognized explicitly while missing titles/authors remain unknown", async ({
  page,
}) => {
  await environment(page);
  const ali = xml
    .replace(' xlink:href="https://creativecommons.org/licenses/by/4.0/"', "")
    .replace(
      "<license-p>",
      "<ali:license_ref>https://creativecommons.org/publicdomain/zero/1.0/</ali:license_ref><license-p>",
    )
    .replace(/<title-group>[\s\S]*?<\/title-group>/, "")
    .replace(/<contrib-group>[\s\S]*?<\/contrib-group>/, "");
  const result = await parse(page, ali);
  expect(result.error).toBeNull();
  expect(result.source!.facts.license.url).toBe(
    "https://creativecommons.org/publicdomain/zero/1.0/",
  );
  expect(result.source!.facts.title).toBeNull();
  expect(result.source!.facts.authors).toEqual([]);
});
const invalid: [string, (value: string) => string][] = [
  [
    "amplified section headings",
    (s) =>
      s.replace(
        /<body>[\s\S]*?<\/body>/,
        "<body>" +
          ("<sec><title>" + "S".repeat(500) + "</title>").repeat(16) +
          "<p>Evidence</p>".repeat(2000) +
          "</sec>".repeat(16) +
          "</body>",
      ),
  ],
  [
    "a different DOI",
    (s) => s.replace("10.5555/quilna.synthetic", "10.5555/another"),
  ],
  ["a different PMCID", (s) => s.replace(">PMC1234567<", ">PMC7654321<")],
  [
    "a missing DOI",
    (s) => s.replace(/<article-id pub-id-type="doi">[^<]*<\/article-id>/, ""),
  ],
  [
    "a restricted license",
    (s) => s.replace("/licenses/by/4.0/", "/licenses/by-nc/4.0/"),
  ],
  [
    "an absent grant URI",
    (s) =>
      s.replace(
        ' xlink:href="https://creativecommons.org/licenses/by/4.0/"',
        "",
      ),
  ],
  [
    "conflicting article licenses",
    (s) =>
      s.replace(
        "</permissions>",
        '<license xlink:href="https://creativecommons.org/publicdomain/zero/1.0/"><license-p>Another grant</license-p></license></permissions>',
      ),
  ],
  [
    "internal entity declarations",
    (s) =>
      s.replace(
        /<!DOCTYPE[^>]*>/,
        '<!DOCTYPE article [<!ENTITY external SYSTEM "https://never-fetch.invalid/private">]>',
      ),
  ],
  [
    "multiple document declarations",
    (s) =>
      s.replace(
        "<article xmlns:",
        '<!DOCTYPE article SYSTEM "https://never-fetch.invalid/other"><article xmlns:',
      ),
  ],
  ["malformed XML", (s) => s.replace("</body>", "</wrong-body>")],
  [
    "a source without eligible paragraphs",
    (s) =>
      s.replace(/<body>[\s\S]*?<\/body>/, "<body><fig><graphic/></fig></body>"),
  ],
  [
    "a scoped/future grant",
    (s) =>
      s.replace(
        "<license-p>",
        '<ali:license_ref applies_to="am" start_date="2099-01-01">https://creativecommons.org/licenses/by/4.0/</ali:license_ref><license-p>',
      ),
  ],
  ["excessive input", (s) => s + " ".repeat(2000001)],
  [
    "excessive DOM nodes",
    (s) => s.replace("<body>", "<body>" + "<empty/>".repeat(20001)),
  ],
  [
    "excessive DOM depth",
    (s) =>
      s
        .replace("<body>", "<body>" + "<sec>".repeat(34))
        .replace("</body>", "</sec>".repeat(34) + "</body>"),
  ],
];
for (const [name, mutate] of invalid)
  test(`refuses ${name} without fetching external resources`, async ({
    page,
  }) => {
    const network = await environment(page),
      result = await parse(page, mutate(xml));
    expect(result.source).toBeNull();
    expect(result.error).toBe(
      "対応する公開本文・DOI・PMCID・利用条件をXMLで確認できません。保存済みの記録は保持しています。",
    );
    expect(network).toEqual([]);
  });

test("body transport validates real XML, omits credentials and shares the manual request boundary without test-only unlocking", async ({
  page,
}) => {
  const network = await environment(page),
    paper = await paperSnapshot(crossrefMetadata(fixture, fixture.message.DOI));
  const result = await page.evaluate(
    async ({ xml, paper }) => {
      const path = "/src/paper-text-client.ts",
        api: typeof import("../../src/paper-text-client") = await import(path);
      let clock = Date.parse("2026-11-03T00:00:00Z");
      const calls: {
        url: string;
        credentials: RequestCredentials | undefined;
        referrerPolicy: ReferrerPolicy | undefined;
        redirect: RequestRedirect | undefined;
        headers: HeadersInit | undefined;
      }[] = [];
      const send: typeof fetch = async (input, options) => {
        calls.push({
          url: String(input),
          credentials: options?.credentials,
          referrerPolicy: options?.referrerPolicy,
          redirect: options?.redirect,
          headers: options?.headers,
        });
        return new Response(xml, {
          headers: { "content-type": "application/xml;charset=UTF-8" },
        });
      };
      const client = new api.PaperTextClient(send, () => clock),
        signal = new AbortController().signal,
        first = await client.lookup("PMC1234567", paper, signal);
      let blocked = "";
      try {
        await new api.PaperTextClient(send, () => clock).lookup(
          "PMC1234567",
          paper,
          signal,
        );
      } catch (error) {
        blocked = (error as Error).message;
      }
      clock += 1000;
      const later = await client.lookup("PMC1234567", paper, signal);
      return { calls, blocked, first, later };
    },
    { xml, paper },
  );
  expect(result.calls).toHaveLength(2);
  expect(result.calls[0]).toEqual({
    url: "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1234567/fullTextXML",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    redirect: "error",
    headers: { Accept: "application/xml" },
  });
  expect(result.blocked).toContain("以降");
  expect(result.first.digest).toBe(result.later.digest);
  expect(result.first.capturedAt).not.toBe(result.later.capturedAt);
  expect(network).toEqual([]);
});
test("immutable excerpt storage preserves the original capture on recapture and retains changed XML as a separate source", async ({
  page,
}) => {
  await environment(page);
  const paper = await paperSnapshot(
    crossrefMetadata(fixture, fixture.message.DOI),
  );
  const result = await page.evaluate(
    async ({ xml, paper }) => {
      const paths = [
          "/src/paper-jats.ts",
          "/src/paper-text-format.ts",
          "/src/paper-excerpt-store.ts",
        ],
        jats: typeof import("../../src/paper-jats") = await import(paths[0]),
        format: typeof import("../../src/paper-text-format") = await import(
          paths[1]
        ),
        store: typeof import("../../src/paper-excerpt-store") = await import(
          paths[2]
        );
      const original = await jats.parsePaperJATS(
          xml,
          "PMC1234567",
          paper,
          "2026-11-03T00:00:00.000Z",
        ),
        quote = await format.paperExcerpt(
          original,
          original.facts.blocks[0].path,
          0,
          8,
          "2026-11-03T00:00:01.000Z",
        ),
        first = await store.savePaperExcerpt(quote);
      const later = await format.paperTextSnapshot(
          paper,
          original.facts,
          "2026-11-03T01:00:00.000Z",
        ),
        recaptured = await format.paperExcerpt(
          later,
          later.facts.blocks[0].path,
          0,
          8,
          "2026-11-03T01:00:01.000Z",
        ),
        reused = await store.savePaperExcerpt(recaptured);
      const changed = await jats.parsePaperJATS(
          xml.replace("Evidence😀", "Changed 😀"),
          "PMC1234567",
          paper,
          "2026-11-03T02:00:00.000Z",
        ),
        next = await format.paperExcerpt(
          changed,
          changed.facts.blocks[0].path,
          0,
          7,
        ),
        added = await store.savePaperExcerpt(next),
        records = await store.listPaperExcerpts();
      return { quote, first, reused, added, records };
    },
    { xml, paper },
  );
  expect(result.first.reused).toBe(false);
  expect(result.reused.reused).toBe(true);
  expect(result.reused.record).toEqual(result.quote);
  expect(result.added.record.source.digest).not.toBe(
    result.quote.source.digest,
  );
  expect(result.records.records).toHaveLength(2);
  expect(result.records.records).toContainEqual(result.quote);
});
test("concurrent quote saves enforce the record capacity atomically and all pages remain readable", async ({
  page,
}) => {
  await environment(page);
  const paper = await paperSnapshot(
    crossrefMetadata(fixture, fixture.message.DOI),
  );
  const result = await page.evaluate(
    async ({ xml, paper }) => {
      const paths = [
          "/src/paper-jats.ts",
          "/src/paper-text-format.ts",
          "/src/paper-excerpt-store.ts",
        ],
        jats: typeof import("../../src/paper-jats") = await import(paths[0]),
        format: typeof import("../../src/paper-text-format") = await import(
          paths[1]
        ),
        store: typeof import("../../src/paper-excerpt-store") = await import(
          paths[2]
        );
      const source = await jats.parsePaperJATS(xml, "PMC1234567", paper),
        block = source.facts.blocks[0],
        quotes = [];
      for (
        let start = 0;
        start < block.text.length && quotes.length < 101;
        start++
      )
        for (
          let end = start + 1;
          end <= block.text.length && quotes.length < 101;
          end++
        ) {
          try {
            quotes.push(
              await format.paperExcerpt(source, block.path, start, end),
            );
          } catch {
            /* Exclude split surrogate pairs and whitespace-only quotes. */
          }
        }
      const attempts = await Promise.allSettled(
          quotes.map((q) => store.savePaperExcerpt(q)),
        ),
        records = [];
      let after: string | undefined;
      do {
        const page = await store.listPaperExcerpts(after);
        records.push(...page.records);
        after = page.next;
      } while (after);
      return {
        success: attempts.filter((a) => a.status === "fulfilled").length,
        failure: attempts.filter((a) => a.status === "rejected").length,
        errors: attempts.filter((a) => a.status === "rejected").map((a) => a.reason.message as string),
        count: records.length,
        unique: new Set(records.map((r) => r.digest)).size,
      };
    },
    { xml, paper },
  );
  expect(result).toEqual({ success: 100, failure: 1, count: 100, unique: 100,
    errors: ["論文引用の保存上限100件に達しています。既存の記録は保持しています。新しい引用はファイルに保存できます。"],
  });
});
test("an aborted save can be retried and a future database schema refuses reads without changing retained bytes", async ({
  page,
}) => {
  await environment(page);
  const paper = await paperSnapshot(
    crossrefMetadata(fixture, fixture.message.DOI),
  );
  const result = await page.evaluate(
    async ({ xml, paper }) => {
      const paths = [
          "/src/paper-jats.ts",
          "/src/paper-text-format.ts",
          "/src/paper-excerpt-store.ts",
        ],
        jats: typeof import("../../src/paper-jats") = await import(paths[0]),
        format: typeof import("../../src/paper-text-format") = await import(
          paths[1]
        ),
        store: typeof import("../../src/paper-excerpt-store") = await import(
          paths[2]
        );
      const source = await jats.parsePaperJATS(xml, "PMC1234567", paper),
        block = source.facts.blocks[0],
        first = await format.paperExcerpt(source, block.path, 0, 8),
        second = await format.paperExcerpt(source, block.path, 0, 10);
      await store.savePaperExcerpt(first);
      const original = IDBDatabase.prototype.transaction;
      let once = true,
        failed = false;
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = original.apply(this, args);
        if (
          once &&
          this.name === store.paperExcerptDatabase &&
          args[1] === "readwrite"
        ) {
          once = false;
          queueMicrotask(() => tx.abort());
        }
        return tx;
      };
      try {
        await store.savePaperExcerpt(second);
      } catch {
        failed = true;
      } finally {
        IDBDatabase.prototype.transaction = original;
      }
      const afterAbort = await store.listPaperExcerpts();
      await store.savePaperExcerpt(second);
      const before = await store.listPaperExcerpts();
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(store.paperExcerptDatabase, 2);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("future");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
      });
      let refused = false;
      try {
        await store.listPaperExcerpts();
      } catch {
        refused = true;
      }
      const raw = await new Promise<unknown[]>((resolve, reject) => {
        const request = indexedDB.open(store.paperExcerptDatabase, 2);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("excerpts"),
            get = tx.objectStore("excerpts").getAll();
          tx.oncomplete = () => {
            db.close();
            resolve(get.result);
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      });
      return {
        failed,
        afterAbort,
        before,
        refused,
        raw: raw.map((r) => JSON.parse(String(r))),
      };
    },
    { xml, paper },
  );
  expect(result.failed).toBe(true);
  expect(result.afterAbort.records).toHaveLength(1);
  expect(result.before.records).toHaveLength(2);
  expect(result.refused).toBe(true);
  expect(result.raw).toEqual(result.before.records);
});
