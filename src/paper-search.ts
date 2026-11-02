import { crossrefMetadata, paperDOI, type PaperMetadata } from "./paper-format";

export const paperSearchLimit = 20;
export type PaperSearchItem = Pick<
  PaperMetadata,
  "doi" | "titles" | "authors" | "type" | "container" | "publisher"
> & {
  published: PaperMetadata["dates"]["published"];
};
export type PaperSearchResults = {
  items: PaperSearchItem[];
  total: number;
  duplicates: number;
};
const invalid = () =>
  Error(
    "Crossrefの検索結果を確認できません。前の結果と保存済みの記録は保持しています。",
  );
/** Bound the exact bibliographic query before any provider request; never add contact parameters. */
export function paperQuery(input: string) {
  const query = input.trim();
  if (
    !query ||
    query.length > 200 ||
    [...query].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw Error(
      "書誌キーワードは1〜200文字で入力してください。改行や制御文字は使えません。",
    );
  return query;
}
/** Request only bibliographic fields for a bounded first page, without a full-text or abstract request. */
export function paperSearchEndpoint(input: string) {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic", paperQuery(input));
  url.searchParams.set("rows", String(paperSearchLimit));
  url.searchParams.set(
    "select",
    "DOI,title,author,type,container-title,publisher,published",
  );
  return url.href;
}
/** Select summaries from list Work items; they have no snapshot endpoint/capture identity and cannot be saved as observations. */
export function parsePaperSearch(raw: unknown): PaperSearchResults {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const envelope = raw as Record<string, unknown>;
  if (
    envelope.status !== "ok" ||
    envelope["message-type"] !== "work-list" ||
    !envelope.message ||
    typeof envelope.message !== "object" ||
    Array.isArray(envelope.message)
  )
    throw invalid();
  const message = envelope.message as Record<string, unknown>,
    entries = message.items,
    total = message["total-results"];
  if (
    !Array.isArray(entries) ||
    entries.length > paperSearchLimit ||
    !Number.isSafeInteger(total) ||
    (total as number) < entries.length
  )
    throw invalid();
  const items: PaperSearchItem[] = [],
    seen = new Map<string, string>();
  let duplicates = 0;
  try {
    for (const entry of entries) {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry.DOI !== "string"
      )
        throw invalid();
      const doi = paperDOI(entry.DOI);
      // List items use the documented Work shape. Only the selected summary is retained.
      const metadata = crossrefMetadata(
        {
          status: "ok",
          "message-type": "work",
          message: Object.fromEntries(
            [
              "DOI",
              "title",
              "author",
              "type",
              "container-title",
              "publisher",
              "published",
            ]
              .filter((key) => Object.hasOwn(entry, key))
              .map((key) => [key, entry[key]]),
          ),
        },
        doi,
      );
      const item: PaperSearchItem = {
        doi,
        titles: metadata.titles,
        authors: metadata.authors,
        type: metadata.type,
        container: metadata.container,
        publisher: metadata.publisher,
        published: metadata.dates.published,
      };
      const encoded = JSON.stringify(item),
        previous = seen.get(doi);
      if (previous !== undefined) {
        if (previous !== encoded) throw invalid();
        duplicates++;
      } else {
        seen.set(doi, encoded);
        items.push(item);
      }
    }
  } catch {
    throw invalid();
  }
  return { items, total: total as number, duplicates };
}
