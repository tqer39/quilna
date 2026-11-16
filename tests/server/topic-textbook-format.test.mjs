import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  topicGenerationInput,
  topicReviewInput,
  normalizeTopicDraft,
  normalizeTopicReview,
  topicDraftOutputSchema,
  topicReviewOutputSchema,
} from "../../server/topic-textbook-format.mjs";
import {
  parseSharedTextbook,
  sharedTextbookDigest,
} from "../../src/shared-textbook-format.ts";
const fixture = JSON.parse(
  await readFile(
    new URL("../fixtures/shared-textbook-v2.json", import.meta.url),
    "utf8",
  ),
);
const decode = (s) => Buffer.from(s, "base64").toString("utf8");
const record = JSON.parse(decode(fixture.record));
const requestRaw = decode(record.request),
  draftRaw = decode(record.draft),
  reviewRaw = decode(record.review);
const wireDraft = () => {
  const draft = JSON.parse(draftRaw);
  for (const lesson of draft.lessons)
    lesson.optionEvidence = Object.entries(lesson.optionEvidence).map(
      ([optionID, evidence]) => ({ optionID, evidence }),
    );
  return draft;
};

test("テーマと選んだ出典だけを受け付け、送信前に私的な項目を拒否する", async () => {
  const input = await topicGenerationInput(requestRaw);
  assert.equal(input.request.schemaVersion, 2);
  assert.deepEqual(Object.keys(input.payload), ["request"]);
  assert.equal(
    input.requestDigest,
    await sharedTextbookDigest(new TextEncoder().encode(requestRaw)),
  );
  for (const extra of [
    { answers: ["私的な回答"] },
    { referringArticle: "私的な記事" },
    { key: "synthetic-not-a-key" },
  ])
    await assert.rejects(
      topicGenerationInput(
        JSON.stringify({ ...JSON.parse(requestRaw), ...extra }),
      ),
    );
  const legacy = JSON.parse(
    await readFile(
      new URL("../fixtures/shared-textbook-v1.json", import.meta.url),
      "utf8",
    ),
  );
  await assert.rejects(
    topicGenerationInput(decode(JSON.parse(decode(legacy.record)).request)),
  );
});
test("生成前に出典の改変・重複・私的な記事識別子・重複JSONキー・上限超過を拒否する", async () => {
  for (const mutate of [
    (r) => {
      r.sources[0].excerpt += "改変";
    },
    (r) => {
      r.sources.push(r.sources[0]);
    },
    (r) => {
      r.sources[0].articleID = "私的な記事";
    },
  ]) {
    const r = JSON.parse(requestRaw);
    mutate(r);
    await assert.rejects(topicGenerationInput(JSON.stringify(r)));
  }
  await assert.rejects(
    topicGenerationInput(
      requestRaw.replace(
        '"schemaVersion":2',
        '"schemaVersion":2,"schemaVersion":2',
      ),
    ),
  );
  await assert.rejects(topicGenerationInput(" ".repeat(48_001) + requestRaw));
});
test("strict出力では動的辞書を使わず、全objectで余分な項目を拒否する", () => {
  const inspect = (schema) => {
    if (!schema || typeof schema !== "object") return;
    if (schema.type === "object") {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(
        [...schema.required].sort(),
        Object.keys(schema.properties).sort(),
      );
    }
    for (const value of Object.values(schema)) {
      if (Array.isArray(value)) value.forEach(inspect);
      else inspect(value);
    }
  };
  inspect(topicDraftOutputSchema);
  inspect(topicReviewOutputSchema);
});
test("候補の選択肢根拠を一度正規化し、再読込できる正確なcandidateをレビューへ渡す", async () => {
  const raw = await normalizeTopicDraft(
    requestRaw,
    JSON.stringify(wireDraft()),
  );
  assert.deepEqual(JSON.parse(raw), JSON.parse(draftRaw));
  const input = await topicReviewInput(requestRaw, raw);
  assert.deepEqual(input.payload.draft, JSON.parse(draftRaw));
  assert.equal(
    input.payload.draftDigest,
    await sharedTextbookDigest(new TextEncoder().encode(raw)),
  );
  assert.equal(
    input.payload.requestDigest,
    await sharedTextbookDigest(new TextEncoder().encode(requestRaw)),
  );
});
test("重複根拠や欠けた選択肢・存在しない引用・未来の前提を合格candidateにしない", async () => {
  for (const mutate of [
    (d) => {
      d.lessons[0].optionEvidence.push(d.lessons[0].optionEvidence[0]);
    },
    (d) => {
      d.lessons[0].optionEvidence.pop();
    },
    (d) => {
      d.lessons[0].explanationEvidence[0].quote = "出典にない引用";
    },
    (d) => {
      d.lessons[0].prerequisiteSectionIDs = ["future"];
    },
    (d) => {
      d.answers = ["私的な回答"];
    },
  ]) {
    const d = wireDraft();
    mutate(d);
    await assert.rejects(normalizeTopicDraft(requestRaw, JSON.stringify(d)));
  }
});
test("否定レビューの正確なbytesと結果を保持し、共有教材としては受け入れない", async () => {
  const review = JSON.parse(reviewRaw);
  review.sections[0].checks[0].passed = false;
  const raw = JSON.stringify(review);
  assert.deepEqual(await normalizeTopicReview(requestRaw, draftRaw, raw), {
    raw,
    allChecksPassed: false,
  });
  const changed = { ...record, review: Buffer.from(raw).toString("base64") };
  await assert.rejects(
    parseSharedTextbook(
      JSON.stringify({
        ...fixture,
        record: Buffer.from(JSON.stringify(changed)).toString("base64"),
      }),
    ),
  );
  assert.deepEqual(
    await normalizeTopicReview(requestRaw, draftRaw, reviewRaw),
    { raw: reviewRaw, allChecksPassed: true },
  );
});
test("別候補へのreview差し替えと重複した検証項目を拒否する", async () => {
  for (const mutate of [
    (r) => {
      r.draftDigest = "0".repeat(64);
    },
    (r) => {
      r.requestDigest = "0".repeat(64);
    },
    (r) => {
      r.sections[0].checks[1].criterion = r.sections[0].checks[0].criterion;
    },
    (r) => {
      r.sections.push(r.sections[0]);
    },
  ]) {
    const r = JSON.parse(reviewRaw);
    mutate(r);
    await assert.rejects(
      normalizeTopicReview(requestRaw, draftRaw, JSON.stringify(r)),
    );
  }
});
