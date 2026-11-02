/** The selected bibliographic facts, rather than a publisher's abstract or full text. */
export interface PaperMetadata {
  doi: string;
  type: string | null;
  version: string | null;
  titles: string[];
  authors: {
    given: string | null;
    family: string | null;
    name: string | null;
    orcid: string | null;
  }[];
  container: string[];
  publisher: string | null;
  publisherURL: string | null;
  dates: Record<
    "published" | "online" | "print" | "created" | "deposited" | "indexed",
    { parts: number[] | null; timestamp: string | null }
  >;
  volume: string | null;
  issue: string | null;
  page: string | null;
  articleNumber: string | null;
  relations: {
    kind: string;
    identifier: string;
    identifierType: string | null;
  }[];
  updates: {
    doi: string;
    type: string | null;
    label: string | null;
    date: number[] | null;
  }[];
}
export interface PaperSnapshot {
  format: "QuilnaPaper";
  schemaVersion: 1;
  provider: "Crossref";
  endpoint: string;
  capturedAt: string;
  digest: string;
  metadata: PaperMetadata;
}
export const paperFileLimit = 1_000_000;
const invalid = () =>
  Error(
    "書誌情報の形式または保存記録を確認できません。既存の記録は保持しています。",
  );

/** Normalize a literal DOI or an exact HTTPS DOI resolver URL without visiting it. */
export function paperDOI(input: string): string {
  let value = input.trim();
  if (/^https:\/\//i.test(value)) {
    const url = new URL(value);
    if (
      !["doi.org", "dx.doi.org"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      throw invalid();
    value = decodeURIComponent(url.pathname.slice(1));
  } else value = value.replace(/^doi:\s*/i, "");
  if (value.length > 2048 || !/^10\.\d{4,9}\/[\x21-\x7e]+$/.test(value))
    throw invalid();
  return value.toLowerCase();
}
/** Keep the whole DOI in one encoded path segment, including literal query characters. */
export const paperEndpoint = (doi: string) =>
  `https://api.crossref.org/works/${encodeURIComponent(paperDOI(doi))}`;

/** Refuse malformed nonempty values; absent provider fields remain explicitly unknown. */
function text(value: unknown, max = 4096): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > max ||
    Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)),
    )
  )
    throw invalid();
  return value;
}
/** Bound arrays before walking them, preserving provider order and refusing truncation. */
function array(value: unknown, max: number): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw invalid();
  return value;
}
/** Accept a provider object without treating arbitrary primitive values as missing metadata. */
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  return value as Record<string, unknown>;
}
/** Preserve partial-date precision and reject impossible Gregorian dates. */
function parts(value: unknown): number[] | null {
  if (value === undefined || value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 3 ||
    value.some((v) => !Number.isInteger(v))
  )
    throw invalid();
  const [y, m, d] = value as number[];
  if (y < 1 || y > 9999 || (m !== undefined && (m < 1 || m > 12)))
    throw invalid();
  const days =
    m === 2
      ? y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
        ? 29
        : 28
      : [4, 6, 9, 11].includes(m)
        ? 30
        : 31;
  if (d !== undefined && (d < 1 || d > days)) throw invalid();
  return [...value];
}
/** Keep provider date/time separately from the date precision instead of inventing missing parts. */
function date(value: unknown) {
  if (value === undefined || value === null)
    return { parts: null, timestamp: null };
  const v = object(value),
    a = array(v["date-parts"], 1),
    timestamp = text(v["date-time"], 40);
  if (timestamp !== null) {
    if (
      !/^\d{4}-\d{2}-\d{2}T/.test(timestamp) ||
      !Number.isFinite(Date.parse(timestamp))
    )
      throw invalid();
    parts(timestamp.slice(0, 10).split("-").map(Number));
  }
  return { parts: a.length ? parts(a[0]) : null, timestamp };
}
/** Select only the documented facts; abstracts, references, licenses and private fields are never copied. */
export function crossrefMetadata(
  raw: unknown,
  requestedDOI: string,
): PaperMetadata {
  const envelope = object(raw),
    v = object(envelope.message);
  if (
    envelope.status !== "ok" ||
    envelope["message-type"] !== "work" ||
    typeof v.DOI !== "string" ||
    paperDOI(v.DOI) !== paperDOI(requestedDOI)
  )
    throw invalid();
  /** Preserve title/container order without silently dropping malformed entries. */
  const strings = (value: unknown) =>
    array(value, 32).map((item) => {
      const s = text(item);
      if (!s) throw invalid();
      return s;
    });
  const relation =
    v.relation === undefined || v.relation === null ? {} : object(v.relation);
  if (Object.keys(relation).length > 32) throw invalid();
  const relations: PaperMetadata["relations"] = [];
  for (const [kind, entries] of Object.entries(relation)) {
    if (!text(kind, 100)) throw invalid();
    for (const entry of array(entries, 100)) {
      const e = object(entry),
        identifier = text(e.id, 2048);
      if (!identifier || relations.length >= 100) throw invalid();
      relations.push({
        kind,
        identifier,
        identifierType: text(e["id-type"], 100),
      });
    }
  }
  return {
    doi: paperDOI(v.DOI),
    type: text(v.type, 100),
    version: text(v.version, 256),
    titles: strings(v.title),
    authors: array(v.author, 500).map((entry) => {
      const a = object(entry),
        orcid = text(a.ORCID, 100);
      if (
        orcid !== null &&
        !/^https?:\/\/orcid\.org\/\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(orcid)
      )
        throw invalid();
      return {
        given: text(a.given, 512),
        family: text(a.family, 512),
        name: text(a.name, 1024),
        orcid,
      };
    }),
    container: strings(v["container-title"]),
    publisher: text(v.publisher),
    publisherURL:
      v.resource === undefined || v.resource === null
        ? null
        : (() => {
            const r = object(v.resource);
            return r.primary === undefined || r.primary === null
              ? null
              : text(object(r.primary).URL, 2048);
          })(),
    dates: {
      published: date(v.published),
      online: date(v["published-online"]),
      print: date(v["published-print"]),
      created: date(v.created),
      deposited: date(v.deposited),
      indexed: date(v.indexed),
    },
    volume: text(v.volume, 256),
    issue: text(v.issue, 256),
    page: text(v.page, 256),
    articleNumber: text(v["article-number"], 256),
    relations,
    updates: array(v["update-to"], 100).map((entry) => {
      const u = object(entry);
      if (typeof u.DOI !== "string") throw invalid();
      return {
        doi: paperDOI(u.DOI),
        type: text(u.type, 100),
        label: text(u.label, 512),
        date: date(u.updated).parts,
      };
    }),
  };
}

/** Rebuild a saved metadata object through the same bounded field selectors and reject unknown fields. */
function storedMetadata(value: unknown): PaperMetadata {
  const m = object(value),
    d = object(m.dates);
  const converted = crossrefMetadata(
    {
      status: "ok",
      "message-type": "work",
      message: {
        DOI: m.doi,
        type: m.type,
        version: m.version,
        title: m.titles,
        author: array(m.authors, 500).map((entry) => {
          const a = object(entry);
          return {
            given: a.given,
            family: a.family,
            name: a.name,
            ORCID: a.orcid,
          };
        }),
        "container-title": m.container,
        publisher: m.publisher,
        resource: { primary: { URL: m.publisherURL } },
        ...Object.fromEntries(
          Object.entries({
            published: "published",
            online: "published-online",
            print: "published-print",
            created: "created",
            deposited: "deposited",
            indexed: "indexed",
          }).map(([key, name]) => {
            const v = object(d[key]);
            return [
              name,
              {
                "date-parts": v.parts === null ? [] : [v.parts],
                "date-time": v.timestamp,
              },
            ];
          }),
        ),
        volume: m.volume,
        issue: m.issue,
        page: m.page,
        "article-number": m.articleNumber,
        relation: Object.fromEntries(
          [
            ...new Set(
              array(m.relations, 100).map((entry) => object(entry).kind),
            ),
          ].map((kind) => [
            String(kind),
            (m.relations as unknown[])
              .map(object)
              .filter((r) => r.kind === kind)
              .map((r) => ({ id: r.identifier, "id-type": r.identifierType })),
          ]),
        ),
        "update-to": array(m.updates, 100).map((entry) => {
          const u = object(entry);
          return {
            DOI: u.doi,
            type: u.type,
            label: u.label,
            updated: u.date === null ? undefined : { "date-parts": [u.date] },
          };
        }),
      },
    },
    String(m.doi),
  );
  if (!sameShape(converted, m)) throw invalid();
  return converted;
}
/** Compare only the bounded expected shape, independent of JSON object key order. */
function sameShape(expected: unknown, value: unknown): boolean {
  if (expected === null || typeof expected !== "object")
    return expected === value;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(expected) !== Array.isArray(value)
  )
    return false;
  const a = expected as Record<string, unknown>,
    b = value as Record<string, unknown>;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((k) => Object.hasOwn(b, k) && sameShape(a[k], b[k]))
  );
}
/** Digest selected facts in a stable field order; this detects conflicts, not publisher authenticity. */
export async function paperDigest(metadata: PaperMetadata) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(metadata)),
  );
  return Array.from(new Uint8Array(hash), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
/** Create one immutable observation; a later changed deposit becomes another snapshot. */
export async function paperSnapshot(
  metadata: PaperMetadata,
  capturedAt = new Date().toISOString(),
): Promise<PaperSnapshot> {
  return {
    format: "QuilnaPaper",
    schemaVersion: 1,
    provider: "Crossref",
    endpoint: paperEndpoint(metadata.doi),
    capturedAt,
    digest: await paperDigest(metadata),
    metadata,
  };
}
/** Validate imported or persisted snapshots without fetching a provider or filling unknown facts. */
export async function parsePaper(raw: string): Promise<PaperSnapshot> {
  if (new TextEncoder().encode(raw).byteLength > paperFileLimit)
    throw invalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  const v = object(decoded);
  if (
    Object.keys(v).sort().join(",") !==
      "capturedAt,digest,endpoint,format,metadata,provider,schemaVersion" ||
    v.format !== "QuilnaPaper" ||
    v.schemaVersion !== 1 ||
    v.provider !== "Crossref" ||
    typeof v.capturedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.capturedAt) ||
    !Number.isFinite(Date.parse(v.capturedAt))
  )
    throw invalid();
  const metadata = storedMetadata(v.metadata),
    result = await paperSnapshot(metadata, v.capturedAt);
  if (new Date(v.capturedAt).toISOString() !== v.capturedAt) throw invalid();
  if (result.endpoint !== v.endpoint || result.digest !== v.digest)
    throw invalid();
  return result;
}
