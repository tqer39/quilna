import test from "node:test";
import assert from "node:assert/strict";
import { requestSchema, draftSchema } from "../../server/contracts.mjs";

const cases = [
  {
    name: "request source IDs",
    schema: requestSchema,
    field: "sourceIds",
    value: {
      requestId: "9d8cf5de-82a8-4e43-aab1-633da0880da8",
      bookId: "caa",
      version: "1.0.0",
      blockId: "read",
      question: "Why does the search stop?",
      excerpt: "CAA lookup",
      purpose: "book-addition",
      sourceIds: Array(1000).fill("unknown-source"),
      approvedPublicText: true,
    },
  },
  {
    name: "generated draft references",
    schema: draftSchema,
    field: "references",
    value: {
      gap: "Explain the lookup limit.",
      block: {
        id: "lookup-limit",
        title: "Lookup limit",
        kind: "reading",
        markdown: "Use the first CAA RRset.",
      },
      references: Array(1000).fill({ sourceId: "unknown-source", quote: "" }),
    },
  },
];

for (const { name, schema, field, value } of cases) {
  test(`oversized ${name} reject before accumulating per-item errors`, () => {
    const result = schema.safeParse(value);
    assert.equal(result.success, false);
    assert.equal(result.error.issues.length, 1);
    assert.equal(result.error.issues[0].code, "too_big");
    assert.deepEqual(result.error.issues[0].path, [field]);
  });
}
