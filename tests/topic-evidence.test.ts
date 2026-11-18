import { it, expect } from "vitest";
import { evidenceExcerpt, topicTerms } from "../src/topic-evidence";
import {
  parseTextbookRequest,
  sharedTextbookDigest,
} from "../src/shared-textbook-format";
it("日本語を語に分け、一般的な依頼表現だけを根拠に資料を選ばない", () => {
  expect(topicTerms("ＲＳＳの仕組みについて学ぶ")).toContain("rss");
  expect(topicTerms("ＲＳＳの仕組みについて学ぶ")).not.toContain("仕組み");
  expect(topicTerms("について")).toEqual([]);
  expect(topicTerms("日本語の全文検索")).toContain("検索");
});
it("ASCIIの単語境界を守り、titleの一致だけでは無関係な本文を採らない", () => {
  expect(
    evidenceExcerpt("The railway has daily information.", "AI", ["ai"]),
  ).toBeNull();
  expect(evidenceExcerpt("An AI system.", "AI", ["ai"])?.matchedTerms).toEqual([
    "ai",
  ]);
});
it("長い日本語・絵文字の後ろの根拠を6000バイト内の連続原文として採る", async () => {
  const text =
    "説明😀".repeat(3000) +
    "\n\nRSS は更新情報を配信する。キャッシュは受信した情報を再利用する。";
  const result = evidenceExcerpt(text, "RSSとキャッシュ", [
    "rss",
    "キャッシュ",
  ])!;
  expect(result).not.toBeNull();
  expect(result.excerpt).toContain("RSS は");
  expect(result.excerpt).toContain("キャッシュは");
  expect(text).toContain(result.excerpt);
  expect(new TextEncoder().encode(result.excerpt).length).toBeLessThanOrEqual(
    6000,
  );
  const source = {
    id: crypto.randomUUID(),
    title: "RSS",
    url: "https://example.test/rss",
    capturedAt: 800000000,
    sourceFingerprint: await sharedTextbookDigest(
      new TextEncoder().encode(result.excerpt),
    ),
    excerpt: result.excerpt,
  };
  await expect(
    parseTextbookRequest(
      JSON.stringify({
        schemaVersion: 2,
        id: crypto.randomUUID(),
        topic: { id: crypto.randomUUID(), name: "RSS" },
        learningGoal: "RSSを理解する",
        sources: [source],
      }),
    ),
  ).resolves.toHaveProperty("schemaVersion", 2);
});
it("窓の境界にまたがる語を失わず、無関係な本文から作り足さない", () => {
  const text = "x".repeat(5998) + " RSS キャッシュ\n後半";
  const result = evidenceExcerpt(text, "", ["rss", "キャッシュ"])!;
  expect(result.matchedTerms).toEqual(["rss", "キャッシュ"]);
  expect(text).toContain(result.excerpt);
  expect(evidenceExcerpt("本文は別の分野です", "RSS", ["rss"])).toBeNull();
});
it("日本語に続くASCII略語も一致として扱う", () => {
  expect(
    evidenceExcerpt("RSSは更新を配信します。", "RSS", ["rss"])?.matchedTerms,
  ).toEqual(["rss"]);
});
it("税・光など一文字の漢字も独立したテーマとして扱う", () => {
  expect(topicTerms("税について")).toEqual(["税"]);
  expect(topicTerms("光の仕組み")).toContain("光");
  expect(
    evidenceExcerpt(
      "税は社会の公共サービスを支える。",
      "税",
      topicTerms("税について"),
    )?.matchedTerms,
  ).toEqual(["税"]);
});
