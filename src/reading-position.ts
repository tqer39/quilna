export type ReadingPosition = {
  fingerprint: string;
  offset: number;
  furthest: number;
  updatedAt: number;
};
export type ReadingPositions = {
  original?: ReadingPosition;
  translation?: ReadingPosition;
};
export function validReadingPositions(
  value: unknown,
): value is ReadingPositions | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, p]) =>
      ["original", "translation"].includes(key) &&
      p &&
      typeof p === "object" &&
      /^[a-f0-9]{64}$/.test(p.fingerprint) &&
      Number.isSafeInteger(p.offset) &&
      p.offset >= 0 &&
      p.offset <= 400000 &&
      Number.isSafeInteger(p.furthest) &&
      p.furthest >= p.offset &&
      p.furthest <= 400000 &&
      Number.isSafeInteger(p.updatedAt) &&
      p.updatedAt > 0,
  );
}
export async function readingFingerprint(text: string, language: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([text, language])),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
