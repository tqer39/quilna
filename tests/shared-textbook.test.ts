import { describe, expect, it } from "vitest";
import fixture from "./fixtures/shared-textbook-v1.json";
import {
  parseSharedTextbook,
  parseSharedJSON,
  sharedTextbookDigest,
} from "../src/shared-textbook-format";

const bytes = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const encode = (value: unknown) =>
  btoa(
    Array.from(new TextEncoder().encode(JSON.stringify(value)), (n) =>
      String.fromCharCode(n),
    ).join(""),
  );
const decode = (value: string) =>
  JSON.parse(new TextDecoder().decode(bytes(value)));
const archive = JSON.stringify(fixture);
function changeRecord(mutate: (record: ReturnType<typeof decode>) => void) {
  const record = decode(fixture.record);
  mutate(record);
  return JSON.stringify({ ...fixture, record: encode(record) });
}
async function changePart(
  part: "request" | "draft" | "review",
  mutate: (value: ReturnType<typeof decode>) => void,
) {
  const record = decode(fixture.record),
    value = decode(record[part]);
  mutate(value);
  record[part] = encode(value);
  // Recompute sender-controlled hash links so semantic refusal cannot be
  // explained merely by stale hashes in these adversarial fixtures.
  if (part !== "review") {
    const review = decode(record.review);
    review[`${part}Digest`] = await sharedTextbookDigest(bytes(record[part]));
    record.review = encode(review);
  }
  return JSON.stringify({ ...fixture, record: encode(record) });
}
it("retains exact nested bytes, version, sources, questions and sender review without reading private stores", async () => {
  const book = await parseSharedTextbook(archive);
  expect(book.raw).toBe(archive);
  expect(book.record.version).toBe(7);
  expect(book.id).toBe("3dc875db-19bc-4995-a91b-749669f32136:7");
  expect(book.draft.lessons.map((s) => s.content.id)).toEqual([
    "models",
    "tools",
  ]);
  expect(book.request.sources[0].excerpt).toContain("保存処理");
  expect(book.review.sections).toHaveLength(2);
  expect(book.digest).toBe(await sharedTextbookDigest(bytes(fixture.record)));
});
describe("private or unsupported fields never enter a re-exportable archive", () => {
  it("refuses envelope and record extras", async () => {
    await expect(
      parseSharedTextbook(JSON.stringify({ ...fixture, answers: "PRIVATE" })),
    ).rejects.toThrow();
    for (const field of ["answers", "sessionToken", "personalNotes"])
      await expect(
        parseSharedTextbook(
          changeRecord((r) => {
            r[field] = "PRIVATE";
          }),
        ),
      ).rejects.toThrow();
  });
  it.each(["request", "draft", "review"] as const)(
    "refuses hidden fields in %s bytes",
    async (part) => {
      await expect(
        parseSharedTextbook(
          await changePart(part, (v) => {
            v.personalHistory = "PRIVATE";
          }),
        ),
      ).rejects.toThrow();
    },
  );
  it("refuses extras below a known source/lesson/check/invocation", async () => {
    const edits = [
      changePart("request", (r) => {
        r.sources[0].token = "PRIVATE";
      }),
      changePart("draft", (d) => {
        d.lessons[0].content.question.options[0].notes = "PRIVATE";
      }),
      changePart("review", (r) => {
        r.sections[0].checks[0].credentials = "PRIVATE";
      }),
    ];
    for (const raw of edits)
      await expect(parseSharedTextbook(await raw)).rejects.toThrow();
    await expect(
      parseSharedTextbook(
        changeRecord((r) => {
          r.generator.apiKey = "PRIVATE";
        }),
      ),
    ).rejects.toThrow();
  });
});
it("rejects ambiguous JSON, invalid encoding, excessive depth and unsupported/bounded formats", async () => {
  expect(() => parseSharedJSON('{"x":1,"\\u0078":2}')).toThrow();
  expect(() =>
    parseSharedJSON("[".repeat(33) + "0" + "]".repeat(33)),
  ).toThrow();
  await expect(
    parseSharedTextbook(
      archive.replace(
        '"schemaVersion":1',
        '"schemaVersion":1,"schemaVersion":1',
      ),
    ),
  ).rejects.toThrow();
  await expect(parseSharedTextbook(" ".repeat(540_001))).rejects.toThrow();
  await expect(
    parseSharedTextbook(JSON.stringify({ ...fixture, schemaVersion: 2 })),
  ).rejects.toThrow();
  await expect(
    parseSharedTextbook(
      JSON.stringify({ ...fixture, record: fixture.record + "\n" }),
    ),
  ).rejects.toThrow();
  await expect(
    parseSharedTextbook(
      JSON.stringify({
        ...fixture,
        record: btoa(String.fromCharCode(0xff)),
      }),
    ),
  ).rejects.toThrow();
  await expect(
    parseSharedTextbook(
      changeRecord((r) => {
        r.version = 0;
      }),
    ),
  ).rejects.toThrow();
  await expect(
    parseSharedTextbook(
      changeRecord((r) => {
        r.request = btoa('{"schemaVersion":1,"schemaVersion":1}');
      }),
    ),
  ).rejects.toThrow();
});
it("requires complete successful, content-bound sender checks and distinct invocation identities", async () => {
  for (const mutate of [
    (r: ReturnType<typeof decode>) => {
      r.sections[0].checks[0].passed = false;
    },
    (r: ReturnType<typeof decode>) => {
      r.sections[0].checks.pop();
    },
    (r: ReturnType<typeof decode>) => {
      r.sections[0].checks[0].criterion = r.sections[0].checks[1].criterion;
    },
    (r: ReturnType<typeof decode>) => {
      r.sections[0].sectionID = "missing";
    },
    (r: ReturnType<typeof decode>) => {
      r.requestDigest = "0".repeat(64);
    },
  ])
    await expect(
      parseSharedTextbook(await changePart("review", mutate)),
    ).rejects.toThrow();
  await expect(
    parseSharedTextbook(
      changeRecord((r) => {
        r.reviewer.id = r.generator.id.toLowerCase();
      }),
    ),
  ).rejects.toThrow();
});
it("refuses broken evidence, question choices and forward prerequisites even with matching hashes", async () => {
  const mutations = [
    (d: ReturnType<typeof decode>) => {
      d.lessons[0].explanationEvidence[0].quote = "Not in this source";
    },
    (d: ReturnType<typeof decode>) => {
      d.lessons[0].content.question.correctOptionID = "missing";
    },
    (d: ReturnType<typeof decode>) => {
      d.lessons[0].content.question.options[1].text =
        d.lessons[0].content.question.options[0].text;
    },
    (d: ReturnType<typeof decode>) => {
      d.lessons[0].prerequisiteSectionIDs = ["tools"];
    },
    (d: ReturnType<typeof decode>) => {
      delete d.lessons[0].optionEvidence.text;
    },
    (d: ReturnType<typeof decode>) => {
      d.lessons[1].content.question.id = d.lessons[0].content.question.id;
    },
  ];
  for (const mutate of mutations)
    await expect(
      parseSharedTextbook(await changePart("draft", mutate)),
    ).rejects.toThrow();
});
it("rejects source identity collisions, translation mismatches and active URL schemes", async () => {
  for (const mutate of [
    (r: ReturnType<typeof decode>) => {
      r.sources.push({
        ...r.sources[0],
        id: r.sources[0].id.toLowerCase(),
        articleID: "other",
      });
    },
    (r: ReturnType<typeof decode>) => {
      r.sources[0].translation.articleID = "other";
    },
    (r: ReturnType<typeof decode>) => {
      r.sources[0].url = "javascript:alert(1)";
    },
    (r: ReturnType<typeof decode>) => {
      r.sources[0].url = "https://user:secret@example.org/";
    },
  ])
    await expect(
      parseSharedTextbook(await changePart("request", mutate)),
    ).rejects.toThrow();
});
