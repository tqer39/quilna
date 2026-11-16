import { expect, it } from "vitest";
import fixture from "./fixtures/shared-textbook-v2.json";
import legacy from "./fixtures/shared-textbook-v1.json";
import {
  parseSharedTextbook,
  sharedTextbookDigest,
} from "../src/shared-textbook-format";

const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const decode = (s: string) => JSON.parse(new TextDecoder().decode(bytes(s)));
const encode = (v: unknown) =>
  btoa(
    Array.from(new TextEncoder().encode(JSON.stringify(v)), (n) =>
      String.fromCharCode(n),
    ).join(""),
  );

/** 参照hashを合わせ、不正な内容そのものを理由に拒否するかを確認する。 */
async function changed(
  part: "request" | "draft" | "review",
  mutate: (value: ReturnType<typeof decode>) => void,
) {
  const record = decode(fixture.record),
    value = decode(record[part]);
  mutate(value);
  record[part] = encode(value);
  if (part !== "review") {
    const review = decode(record.review);
    review[`${part}Digest`] = await sharedTextbookDigest(bytes(record[part]));
    record.review = encode(review);
  }
  return JSON.stringify({ ...fixture, record: encode(record) });
}

it("記事や購読先を捏造せずテーマと独立した根拠を読み、旧形式も保持する", async () => {
  const raw = JSON.stringify(fixture),
    book = await parseSharedTextbook(raw),
    old = await parseSharedTextbook(JSON.stringify(legacy));
  expect(book.raw).toBe(raw);
  expect(book.request.schemaVersion).toBe(2);
  expect(book.request).toHaveProperty("topic", {
    id: "d3468597-7d13-4e87-9d5b-fad7af5bb11d",
    name: "モデルと実行の役割分担",
  });
  for (const source of book.request.sources) {
    expect(source).not.toHaveProperty("articleID");
    expect(source).not.toHaveProperty("feedID");
    expect(source).not.toHaveProperty("translation");
  }
  expect(book.id).not.toBe(old.id);
  expect(old.raw).toBe(JSON.stringify(legacy));
  expect(old.request.sources[0]).toHaveProperty("articleID");
});

it("同名のテーマでもファイル内の識別子を正確に保持する", async () => {
  const original = await parseSharedTextbook(JSON.stringify(fixture));
  const other = await parseSharedTextbook(
    await changed("request", (r) => {
      r.topic.id = "44444444-4444-4444-8444-444444444444";
    }),
  );
  expect(other.request).toHaveProperty("topic.name", "モデルと実行の役割分担");
  expect(other.request).toHaveProperty(
    "topic.id",
    "44444444-4444-4444-8444-444444444444",
  );
  expect(original.request).toHaveProperty(
    "topic.id",
    "d3468597-7d13-4e87-9d5b-fad7af5bb11d",
  );
  expect(other.digest).not.toBe(original.digest);
});

it("外側・不変記録・依頼の形式が混ざったファイルを拒否する", async () => {
  await expect(
    parseSharedTextbook(JSON.stringify({ ...fixture, schemaVersion: 1 })),
  ).rejects.toThrow();
  const record = decode(fixture.record);
  record.schemaVersion = 1;
  await expect(
    parseSharedTextbook(JSON.stringify({ ...fixture, record: encode(record) })),
  ).rejects.toThrow();
  // 各内部形式が単独では正当でも、外側の形式を偽る組み合わせは拒否する。
  await expect(
    parseSharedTextbook(
      JSON.stringify({
        ...fixture,
        schemaVersion: 1,
        record: encode(record),
      }),
    ),
  ).rejects.toThrow();
  const oldRecord = decode(legacy.record);
  oldRecord.schemaVersion = 2;
  await expect(
    parseSharedTextbook(
      JSON.stringify({
        ...fixture,
        record: encode(oldRecord),
      }),
    ),
  ).rejects.toThrow();
  await expect(
    parseSharedTextbook(
      await changed("request", (r) => {
        r.schemaVersion = 1;
      }),
    ),
  ).rejects.toThrow();
  await expect(
    parseSharedTextbook(JSON.stringify({ ...fixture, schemaVersion: 3 })),
  ).rejects.toThrow();
});

it("テーマの欠落・曖昧なID・個人のリンクや回答の混入を拒否する", async () => {
  for (const mutate of [
    (r: ReturnType<typeof decode>) => delete r.topic,
    (r: ReturnType<typeof decode>) => (r.topic.id = "topic-name"),
    (r: ReturnType<typeof decode>) => (r.topic.name = " "),
    (r: ReturnType<typeof decode>) => (r.topic.confirmedLinks = ["PRIVATE"]),
    (r: ReturnType<typeof decode>) => (r.referringArticle = "PRIVATE"),
    (r: ReturnType<typeof decode>) => (r.sources[0].articleID = "PRIVATE"),
    (r: ReturnType<typeof decode>) => (r.answers = ["PRIVATE"]),
  ])
    await expect(
      parseSharedTextbook(await changed("request", mutate)),
    ).rejects.toThrow();
});

it("出典snapshotの変更・引用の不整合・検証不合格をhash整合後も拒否する", async () => {
  for (const mutate of [
    (r: ReturnType<typeof decode>) => (r.sources[0].excerpt += "変更"),
    (r: ReturnType<typeof decode>) =>
      (r.sources[0].sourceFingerprint = "0".repeat(64)),
    (r: ReturnType<typeof decode>) => r.sources.push({ ...r.sources[0] }),
  ])
    await expect(
      parseSharedTextbook(await changed("request", mutate)),
    ).rejects.toThrow();
  await expect(
    parseSharedTextbook(
      await changed("draft", (d) => {
        d.lessons[0].explanationEvidence[0].quote = "根拠にない文";
      }),
    ),
  ).rejects.toThrow();
  await expect(
    parseSharedTextbook(
      await changed("review", (r) => {
        r.sections[0].checks[0].passed = false;
      }),
    ),
  ).rejects.toThrow();
});

it("BOM付きの埋め込みJSONでも保持したbyte列そのものを照合し、BOMを落としたhashを拒否する", async () => {
  for (const base of [fixture, legacy]) {
    const record = decode(base.record);
    const requestRaw =
      "\uFEFF" + new TextDecoder().decode(bytes(record.request));
    const draftRaw = "\uFEFF" + new TextDecoder().decode(bytes(record.draft));
    const review = decode(record.review);
    review.requestDigest = await sharedTextbookDigest(
      new TextEncoder().encode(requestRaw),
    );
    review.draftDigest = await sharedTextbookDigest(
      new TextEncoder().encode(draftRaw),
    );
    const base64 = (raw: string) =>
      btoa(
        Array.from(new TextEncoder().encode(raw), (n) =>
          String.fromCharCode(n),
        ).join(""),
      );
    record.request = base64(requestRaw);
    record.draft = base64(draftRaw);
    record.review = base64("\uFEFF" + JSON.stringify(review));
    const raw = JSON.stringify({ ...base, record: encode(record) });
    expect((await parseSharedTextbook(raw)).raw).toBe(raw);
    review.requestDigest = await sharedTextbookDigest(
      new TextEncoder().encode(requestRaw.slice(1)),
    );
    record.review = base64("\uFEFF" + JSON.stringify(review));
    await expect(
      parseSharedTextbook(JSON.stringify({ ...base, record: encode(record) })),
    ).rejects.toThrow();
  }
});
