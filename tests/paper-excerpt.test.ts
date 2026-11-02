import { expect, it } from "vitest";
import fixture from "./fixtures/crossref-work.json";
import { crossrefMetadata, paperSnapshot } from "../src/paper-format";
import {
  paperExcerpt,
  parsePaperExcerpt,
  paperPMCID,
  paperLicense,
  paperTextEndpoint,
  paperTextHash,
  paperTextSnapshot,
  type PaperTextFacts,
} from "../src/paper-text-format";
/** Synthetic licensed text contains no real publication or user data. */
async function source() {
  const paper = await paperSnapshot(
    crossrefMetadata(fixture, fixture.message.DOI),
    "2026-11-03T00:00:00.000Z",
  );
  const facts: PaperTextFacts = {
    pmcid: "PMC1234567",
    doi: paper.metadata.doi,
    title: "Synthetic source",
    authors: ["Fixture Author"],
    articleType: "research-article",
    version: null,
    license: {
      url: "https://creativecommons.org/licenses/by/4.0/",
      statement: "Synthetic CC BY 4.0 statement",
      copyright: "Synthetic author",
    },
    xmlTextDigest: await paperTextHash("<article>synthetic</article>"),
    blocks: [
      {
        path: "/article[1]/body[1]/sec[1]/p[1]",
        sections: ["Synthetic section"],
        text: "Evidence😀 exact quote.",
      },
    ],
    omitted: 1,
  };
  return paperTextSnapshot(paper, facts, "2026-11-03T00:00:01.000Z");
}
it("fixes the PMCID endpoint and recognizes only declared supported license URLs", () => {
  expect(paperPMCID(" pmc1234567 ")).toBe("PMC1234567");
  expect(paperTextEndpoint("PMC1234567")).toBe(
    "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1234567/fullTextXML",
  );
  for (const value of [
    "https://europepmc.org/articles/PMC1234567",
    "PMC0",
    "PMC01",
    "PMC1?query=private",
    "PMC１２",
    "PMC" + "1".repeat(13),
  ])
    expect(() => paperPMCID(value)).toThrow();
  expect(paperLicense("http://creativecommons.org/licenses/by/4.0")).toBe(
    "https://creativecommons.org/licenses/by/4.0/",
  );
  expect(
    paperLicense("https://creativecommons.org/publicdomain/zero/1.0/"),
  ).toContain("zero/1.0/");
  for (const value of [
    "https://creativecommons.org/licenses/by-nc/4.0/",
    "https://creativecommons.org/licenses/by-nd/4.0/",
    "https://creativecommons.org/licenses/by/3.0/",
    "https://creativecommons.org/licenses/by/4.0/?extra=1",
    "https://creativecommons.org.evil.invalid/licenses/by/4.0/",
    "https://user@creativecommons.org/licenses/by/4.0/",
    "javascript:alert(1)",
  ])
    expect(() => paperLicense(value)).toThrow();
});
it("round trips exact quote offsets, source facts, unknown version, attribution and both capture times", async () => {
  const text = await source(),
    selected = text.facts.blocks[0];
  const quote = await paperExcerpt(
    text,
    selected.path,
    0,
    selected.text.length,
    "2026-11-03T00:00:02.000Z",
  );
  expect(await parsePaperExcerpt(JSON.stringify(quote))).toEqual(quote);
  expect(quote.source.facts.version).toBeNull();
  expect(quote.source.paper.metadata.version).toBe("2");
  expect(quote.text).toBe(selected.text);
  expect(quote.source.facts.license.statement).toContain("Synthetic");
});
it("keeps fact identity stable across recaptures while binding changed XML and bibliographic versions separately", async () => {
  const first = await source(),
    later = await paperTextSnapshot(
      first.paper,
      first.facts,
      "2026-11-03T00:01:01.000Z",
    );
  expect(later.digest).toBe(first.digest);
  const changed = await paperTextSnapshot(first.paper, {
    ...first.facts,
    xmlTextDigest: await paperTextHash("changed XML"),
  });
  expect(changed.digest).not.toBe(first.digest);
  const otherPaper = await paperSnapshot({
    ...first.paper.metadata,
    version: "3",
  });
  expect((await paperTextSnapshot(otherPaper, first.facts)).digest).not.toBe(
    first.digest,
  );
});
it("refuses empty, oversized, reversed, fractional, missing and surrogate-splitting quote ranges", async () => {
  const value = await source(),
    block = value.facts.blocks[0];
  for (const [start, end] of [
    [0, 0],
    [-1, 3],
    [4, 3],
    [0, 100],
    [0.5, 2],
    [9, 10],
    [0, 9],
  ])
    await expect(paperExcerpt(value, block.path, start, end)).rejects.toThrow();
  await expect(paperExcerpt(value, "missing", 0, 1)).rejects.toThrow();
  const large = await paperTextSnapshot(value.paper, {
    ...value.facts,
    blocks: [{ ...block, text: "a".repeat(6001) }],
  });
  await expect(paperExcerpt(large, block.path, 0, 6001)).rejects.toThrow();
});
it("rejects tampered text, source/endpoint/DOI bindings, unknown fields, future schemas and invalid instants", async () => {
  const value = await source(),
    quote = await paperExcerpt(value, value.facts.blocks[0].path, 0, 8);
  for (const mutate of [
    (v: Record<string, unknown>) => {
      v.text = "changed";
    },
    (v: Record<string, unknown>) => {
      v.schemaVersion = 2;
    },
    (v: Record<string, unknown>) => {
      v.answers = ["PRIVATE"];
    },
    (v: Record<string, unknown>) => {
      v.createdAt = "2026-02-30T00:00:00.000Z";
    },
    (v: Record<string, unknown>) => {
      (v.source as Record<string, unknown>).endpoint =
        "https://publisher.invalid/";
    },
    (v: Record<string, unknown>) => {
      (v.source as Record<string, unknown>).session = "PRIVATE";
    },
    (v: Record<string, unknown>) => {
      (
        (v.source as Record<string, unknown>).facts as Record<string, unknown>
      ).doi = "10.5555/different";
    },
    (v: Record<string, unknown>) => {
      (
        (v.source as Record<string, unknown>).facts as Record<string, unknown>
      ).abstract = "UNSELECTED";
    },
  ]) {
    const changed = structuredClone(quote) as unknown as Record<
      string,
      unknown
    >;
    mutate(changed);
    await expect(parsePaperExcerpt(JSON.stringify(changed))).rejects.toThrow();
  }
});
it("refuses duplicate/escaped JSON keys, broken JSON and oversized archives with stable notices", async () => {
  const value = await source(),
    quote = await paperExcerpt(value, value.facts.blocks[0].path, 0, 8),
    raw = JSON.stringify(quote);
  for (const changed of [
    raw.replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schema\\u0056ersion":1',
    ),
    '{"unexpected":',
    " ".repeat(3000001),
  ])
    await expect(parsePaperExcerpt(changed)).rejects.toThrow(
      "論文本文・引用・版の対応を確認できません",
    );
});
it("refuses conflicting paragraph locations, mismatched DOI, unsupported rights and excessive retained text", async () => {
  const value = await source();
  for (const change of [
    { doi: "10.5555/other" },
    { blocks: [value.facts.blocks[0], value.facts.blocks[0]] },
    {
      license: {
        ...value.facts.license,
        url: "https://creativecommons.org/licenses/by-nc/4.0/",
      },
    },
    {
      blocks: Array.from({ length: 6 }, (_, i) => ({
        ...value.facts.blocks[0],
        path: `/article[1]/body[1]/p[${i + 1}]`,
        text: "a".repeat(100000),
      })),
    },
  ])
    await expect(
      paperTextSnapshot(value.paper, { ...value.facts, ...change }),
    ).rejects.toThrow();
});
it("refuses section-heading amplification before an otherwise valid source becomes impossible to save or export", async () => {
  const value = await source(),
    sections = Array.from({ length: 16 }, () => "S".repeat(500));
  const blocks = Array.from({ length: 2000 }, (_, i) => ({
    path: `/article[1]/body[1]/p[${i + 1}]`,
    sections,
    text: "Evidence",
  }));
  let refused = false;
  try {
    await paperTextSnapshot(value.paper, { ...value.facts, blocks });
  } catch {
    refused = true;
  }
  expect(refused).toBe(true);
});
it("keeps accepted Unicode and escaped attribution within the portable archive limit", async () => {
  const value = await source(),
    blocks = Array.from({ length: 3 }, (_, i) => ({
      path: `/article[1]/body[1]/p[${i + 1}]`,
      sections: [],
      text: "界".repeat(100000),
    })),
    authors = Array.from({ length: 500 }, () => '"'.repeat(500));
  const retained = await paperTextSnapshot(value.paper, {
      ...value.facts,
      blocks,
      authors,
    }),
    quote = await paperExcerpt(retained, blocks[0].path, 0, 6000),
    raw = JSON.stringify(quote);
  expect(new TextEncoder().encode(raw).byteLength).toBeLessThan(3000000);
  expect((await parsePaperExcerpt(raw)).digest).toBe(quote.digest);
});
