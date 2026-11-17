import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parseSharedTextbook } from "../src/shared-textbook-format";
import {
  eligibleTopicEditions,
  type TextbookNotice,
  type TextbookNoticeState,
} from "../src/shared-textbook-store";

const raw = new TextDecoder().decode(
  await readFile("tests/fixtures/shared-textbook-v2.json"),
);
const book = await parseSharedTextbook(raw);
async function edition(version: number, bookID = book.record.bookID) {
  const envelope = JSON.parse(raw),
    record = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(envelope.record), (c) => c.charCodeAt(0)),
      ),
    );
  record.version = version;
  record.bookID = bookID;
  envelope.record = btoa(
    Array.from(new TextEncoder().encode(JSON.stringify(record)), (n) =>
      String.fromCharCode(n),
    ).join(""),
  );
  return parseSharedTextbook(JSON.stringify(envelope));
}
const later = await edition(8);
function notice(kind: TextbookNotice["kind"]): TextbookNotice {
  return {
    schemaVersion: 1,
    id: book.id,
    digest: book.digest,
    revision: "00000000-0000-4000-8000-000000000001",
    kind,
    reason: "合成の判断",
    evidence: "合成の根拠",
    writer: "library-reader",
    updatedAt: "2026-11-17T00:00:00Z",
    ...(kind === "correction"
      ? { replacement: { id: later.id, digest: later.digest } }
      : {}),
  };
}
it("同じ教材は最新の利用可能な保存版を使う", () => {
  expect(
    eligibleTopicEditions([book, later], [{}, {}]).map((b) => b.id),
  ).toEqual([later.id]);
});
it("同じ表示名やテーマIDでも別の教材IDを統合しない", async () => {
  const other = await edition(7, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  expect(
    eligibleTopicEditions([book, other], [{}, {}]).map((b) => b.id),
  ).toEqual([book.id, other.id]);
});
it("撤回・読めない記録・未取得の状態を新しい入口に使わない", () => {
  expect(
    eligibleTopicEditions([book], [{ notice: notice("withdrawn") }]),
  ).toEqual([]);
  expect(
    eligibleTopicEditions([book], [{ error: Error("未対応形式") }]),
  ).toEqual([]);
  expect(eligibleTopicEditions([book], [])).toEqual([]);
});
it("訂正先が撤回・利用不能なら旧版を新しい入口へ戻さない", () => {
  for (const replacementState of ["withdrawn", "unavailable"] as const) {
    const state: TextbookNoticeState = {
      notice: notice("correction"),
      replacementState,
    };
    expect(eligibleTopicEditions([book], [state])).toEqual([]);
  }
  expect(
    eligibleTopicEditions(
      [book],
      [{ notice: notice("correction"), replacementState: "available" }],
    ),
  ).toEqual([book]);
});
