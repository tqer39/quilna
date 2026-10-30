// Shared by browser rendering and the server document catalog. No DOM access.
export const articleTextLimit = 200_000;

// UTF-16 offsets into the accompanying text, never HTML or executable markup.
export type ArticleCodeRange = { start: number; end: number; block: boolean };

export function validCodeRanges(
  text: string,
  ranges: unknown,
): ranges is ArticleCodeRange[] | undefined {
  if (ranges === undefined) return true; // Existing plain-text articles remain readable.
  if (!Array.isArray(ranges) || ranges.length > 20_000) return false;
  let previousEnd = 0;
  for (const range of ranges) {
    if (
      !range ||
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < previousEnd ||
      range.start < 0 ||
      range.end <= range.start ||
      range.end > text.length ||
      typeof range.block !== "boolean"
    )
      return false;
    // Do not split an astral character at either endpoint.
    for (const offset of [range.start, range.end]) {
      if (
        offset > 0 &&
        offset < text.length &&
        /[\uD800-\uDBFF]/.test(text[offset - 1]) &&
        /[\uDC00-\uDFFF]/.test(text[offset])
      )
        return false;
    }
    previousEnd = range.end;
  }
  return true;
}
