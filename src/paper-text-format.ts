import { paperDOI, parsePaper, type PaperSnapshot } from "./paper-format";
import { parseSharedJSON } from "./shared-textbook-format";

export const paperXMLLimit = 2_000_000;
export const paperTextFactLimit = 1_500_000;
export const paperExcerptLimit = 3_000_000;
export interface PaperTextBlock {
  path: string;
  sections: string[];
  text: string;
}
export interface PaperTextFacts {
  pmcid: string;
  doi: string;
  title: string | null;
  authors: string[];
  articleType: string | null;
  version: string | null;
  license: { url: string; statement: string; copyright: string };
  xmlTextDigest: string;
  blocks: PaperTextBlock[];
  omitted: number;
}
export interface PaperTextSnapshot {
  provider: "Europe PMC";
  textFormat: "jats-paragraphs-v1";
  endpoint: string;
  capturedAt: string;
  paper: PaperSnapshot;
  facts: PaperTextFacts;
  digest: string;
}
export interface PaperExcerpt {
  format: "QuilnaPaperExcerpt";
  schemaVersion: 1;
  source: PaperTextSnapshot;
  block: string;
  start: number;
  end: number;
  text: string;
  createdAt: string;
  digest: string;
}
const invalid = () =>
  Error(
    "論文本文・引用・版の対応を確認できません。保存済みの記録は保持しています。",
  );
/** Accept one archive identifier without accepting a caller-controlled URL. */
export function paperPMCID(input: string) {
  const value = input.trim().toUpperCase();
  if (!/^PMC[1-9][0-9]{0,11}$/.test(value))
    throw Error("PMCに続く番号を入力してください（例: PMC1234567）。");
  return value;
}
/** Fix the only body endpoint; no resolver, publisher, PDF or supplementary fetch follows. */
export const paperTextEndpoint = (pmcid: string) =>
  `https://www.ebi.ac.uk/europepmc/webservices/rest/${paperPMCID(pmcid)}/fullTextXML`;
/** Recognize only the explicitly supported grant URLs, without interpreting arbitrary license prose. */
export function paperLicense(input: string) {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["creativecommons.org", "www.creativecommons.org"].includes(
      url.hostname,
    ) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw invalid();
  const path = url.pathname.replace(/\/$/, "") + "/";
  if (!["/licenses/by/4.0/", "/publicdomain/zero/1.0/"].includes(path))
    throw invalid();
  return `https://creativecommons.org${path}`;
}
/** Hash the declared representation; a hash detects changed records, not provider authenticity. */
export async function paperTextHash(text: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
/** Read only an exact object shape so portable files cannot conceal account/history fields. */
function object(value: unknown, keys: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",")
  )
    throw invalid();
  return value as Record<string, unknown>;
}
/** Preserve exact stored strings instead of silently repairing imported source text. */
function string(value: unknown, maximum: number, empty = false): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!empty && !value.trim()) ||
    value.includes("\u0000")
  )
    throw invalid();
  return value;
}
/** Require a real canonical UTC instant, including for source and quote capture times. */
function instant(value: unknown) {
  const text = string(value, 24);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(text) ||
    !Number.isFinite(Date.parse(text)) ||
    new Date(text).toISOString() !== text
  )
    throw invalid();
  return text;
}
/** Validate only bounded text blocks and attribution facts; never infer an unknown manuscript version. */
function facts(value: unknown): PaperTextFacts {
  const f = object(
      value,
      "pmcid,doi,title,authors,articleType,version,license,xmlTextDigest,blocks,omitted",
    ),
    license = object(f.license, "url,statement,copyright");
  const pmcid = string(f.pmcid, 15),
    doi = string(f.doi, 2048),
    licenseURL = string(license.url, 200),
    hash = string(f.xmlTextDigest, 64);
  if (
    paperPMCID(pmcid) !== pmcid ||
    paperDOI(doi) !== doi ||
    paperLicense(licenseURL) !== licenseURL ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    !Array.isArray(f.authors) ||
    f.authors.length > 500 ||
    !Array.isArray(f.blocks) ||
    !f.blocks.length ||
    f.blocks.length > 2000 ||
    !Number.isSafeInteger(f.omitted) ||
    (f.omitted as number) < 0 ||
    (f.omitted as number) > 20000
  )
    throw invalid();
  const selected: PaperTextFacts = {
    pmcid,
    doi,
    title: f.title === null ? null : string(f.title, 4096),
    authors: f.authors.map((a) => string(a, 500)),
    articleType: f.articleType === null ? null : string(f.articleType, 200),
    version: f.version === null ? null : string(f.version, 200),
    license: {
      url: licenseURL,
      statement: string(license.statement, 16000, true),
      copyright: string(license.copyright, 4000, true),
    },
    xmlTextDigest: hash,
    blocks: [],
    omitted: f.omitted as number,
  };
  const paths = new Set<string>();
  let total = 0;
  const encoder = new TextEncoder();
  let retainedBytes = encoder.encode(JSON.stringify(selected)).byteLength;
  if (retainedBytes > paperTextFactLimit) throw invalid();
  selected.blocks = f.blocks.map((value) => {
    const b = object(value, "path,sections,text"),
      path = string(b.path, 1024),
      text = string(b.text, 100000);
    if (
      !/^\/article\[1\]\/body\[1\](?:\/[a-z][a-z0-9-]*\[[1-9][0-9]*\]){1,24}$/.test(
        path,
      ) ||
      paths.has(path) ||
      !Array.isArray(b.sections) ||
      b.sections.length > 16
    )
      throw invalid();
    paths.add(path);
    total += text.length;
    if (total > 500000) throw invalid();
    const block = {
      path,
      sections: b.sections.map((s) => string(s, 500)),
      text,
    };
    // Count duplicated headings, paths, escaped text and separators before hashing the whole representation.
    retainedBytes += encoder.encode(JSON.stringify(block)).byteLength + 1;
    if (retainedBytes > paperTextFactLimit) throw invalid();
    return block;
  });
  return selected;
}
/** Bind text to one bibliographic fact version while allowing identical recaptures to retain their first timestamp. */
export async function paperTextSnapshot(
  paper: PaperSnapshot,
  input: PaperTextFacts,
  capturedAt = new Date().toISOString(),
): Promise<PaperTextSnapshot> {
  const retained = await parsePaper(JSON.stringify(paper)),
    selected = facts(input);
  if (selected.doi !== retained.metadata.doi) throw invalid();
  const digest = await paperTextHash(
    JSON.stringify({
      paperDigest: retained.digest,
      facts: selected,
      textFormat: "jats-paragraphs-v1",
    }),
  );
  return {
    provider: "Europe PMC",
    textFormat: "jats-paragraphs-v1",
    endpoint: paperTextEndpoint(selected.pmcid),
    capturedAt: instant(capturedAt),
    paper: retained,
    facts: selected,
    digest,
  };
}
/** Refuse quote boundaries through a UTF-16 surrogate pair. Offsets name this retained text representation only. */
function boundary(text: string, offset: number) {
  return !(
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[offset])
  );
}
/** Select an exact bounded substring from one retained paragraph without copying private notes or answers. */
export async function paperExcerpt(
  source: PaperTextSnapshot,
  block: string,
  start: number,
  end: number,
  createdAt = new Date().toISOString(),
): Promise<PaperExcerpt> {
  const selected = source.facts.blocks.find((b) => b.path === block);
  if (
    !selected ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > selected.text.length ||
    end - start > 6000 ||
    !boundary(selected.text, start) ||
    !boundary(selected.text, end)
  )
    throw invalid();
  const text = selected.text.slice(start, end);
  if (!text.trim()) throw invalid();
  const digest = await paperTextHash(
    JSON.stringify({ source: source.digest, block, start, end, text }),
  );
  return {
    format: "QuilnaPaperExcerpt",
    schemaVersion: 1,
    source,
    block,
    start,
    end,
    text,
    createdAt: instant(createdAt),
    digest,
  };
}
/** Validate bounded portable excerpts, exact source/quote correspondence and both hashes, with no provider request. */
export async function parsePaperExcerpt(raw: string): Promise<PaperExcerpt> {
  try {
    if (new TextEncoder().encode(raw).byteLength > paperExcerptLimit)
      throw invalid();
    const e = object(
        parseSharedJSON(raw),
        "format,schemaVersion,source,block,start,end,text,createdAt,digest",
      ),
      s = object(
        e.source,
        "provider,textFormat,endpoint,capturedAt,paper,facts,digest",
      );
    if (
      e.format !== "QuilnaPaperExcerpt" ||
      e.schemaVersion !== 1 ||
      s.provider !== "Europe PMC" ||
      s.textFormat !== "jats-paragraphs-v1"
    )
      throw invalid();
    const source = await paperTextSnapshot(
      await parsePaper(JSON.stringify(s.paper)),
      facts(s.facts),
      instant(s.capturedAt),
    );
    if (source.endpoint !== s.endpoint || source.digest !== s.digest)
      throw invalid();
    const excerpt = await paperExcerpt(
      source,
      string(e.block, 1024),
      e.start as number,
      e.end as number,
      instant(e.createdAt),
    );
    if (excerpt.text !== e.text || excerpt.digest !== e.digest) throw invalid();
    return excerpt;
  } catch {
    throw invalid();
  }
}
