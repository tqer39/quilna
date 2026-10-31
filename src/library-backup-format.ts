import { validArticle, validFeed } from "./feed-store";
import type { Feed, FeedArticle } from "./feed-parser";
import { articleURL } from "./feed-parser";
import { validHighlight } from "./article-highlights";
import { validConnection } from "./article-connections";
import { validQuoteConnection } from "./quote-connections";
import { validLearningRecord } from "./article-learning";
import { validSourceDocument, validDocumentVersion } from "./source-document";

export const backupKinds = [
  "documents",
  "documentVersions",
  "feeds",
  "articles",
  "highlights",
  "connections",
  "quoteConnections",
  "learning",
] as const;
export type BackupKind = (typeof backupKinds)[number];
export type BackupCounts = Record<BackupKind, number>;
export type BackupEntry = {
  kind: BackupKind;
  key: string;
  value: Record<string, unknown>;
};
export type BackupHeader = {
  format: "quilna-reader-library";
  version: 1 | 2;
  createdAt: string;
};
export type BackupPreview = {
  id: string;
  header: BackupHeader;
  counts: BackupCounts;
  fileName: string;
};
export const backupByteLimit = 2 * 1024 ** 3;
export const backupLineLimit = 8 * 1024 ** 2;
export const backupRecordLimit = 1_000_000;
export const backupBatchSize = 100;
export const emptyBackupCounts = (): BackupCounts => ({
  documents: 0,
  documentVersions: 0,
  feeds: 0,
  articles: 0,
  highlights: 0,
  connections: 0,
  quoteConnections: 0,
  learning: 0,
});
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function validBackupHeader(v: unknown): v is BackupHeader {
  return (
    object(v) &&
    v.format === "quilna-reader-library" &&
    (v.version === 1 || v.version === 2) &&
    typeof v.createdAt === "string" &&
    Number.isFinite(Date.parse(v.createdAt))
  );
}
export function validBackupCounts(v: unknown, version = 2): v is BackupCounts {
  const kinds =
    version === 1
      ? backupKinds.filter((k) => k !== "documents" && k !== "documentVersions")
      : backupKinds;
  return (
    object(v) &&
    Object.keys(v).length === kinds.length &&
    kinds.every(
      (k) =>
        Number.isSafeInteger(v[k]) &&
        (v[k] as number) >= 0 &&
        (v[k] as number) <= backupRecordLimit,
    )
  );
}
export function validBackupPreview(v: unknown): v is BackupPreview {
  return (
    object(v) &&
    typeof v.id === "string" &&
    /^[\da-f-]{36}$/.test(v.id) &&
    validBackupHeader(v.header) &&
    (validBackupCounts(v.counts) ||
      (v.header.version === 1 && validBackupCounts(v.counts, 1))) &&
    typeof v.fileName === "string" &&
    v.fileName.length <= 1000
  );
}
export function validBackupValue(
  kind: BackupKind,
  v: unknown,
): v is Record<string, unknown> {
  if (!object(v)) return false;
  switch (kind) {
    case "documents":
      return validSourceDocument(v);
    case "documentVersions":
      return validDocumentVersion(v);
    case "feeds":
      return (
        validFeed(v as Feed) &&
        typeof v.url === "string" &&
        articleURL(v.url, v.url) === v.url
      );
    case "articles":
      return (
        validArticle(v as FeedArticle) && typeof v.id === "string" && !!v.id
      );
    case "highlights":
      return validHighlight(v);
    case "connections":
      return validConnection(v);
    case "quoteConnections":
      return validQuoteConnection(v);
    case "learning":
      return validLearningRecord(v);
  }
}
export function backupEntry(kind: BackupKind, value: unknown): BackupEntry {
  if (!validBackupValue(kind, value) || !jsonData(value))
    throw Error(
      "バックアップ対象の保存形式を確認できません。元の記録は変更していません。",
    );
  return { kind, key: String(kind === "feeds" ? value.url : value.id), value };
}
function jsonData(root: unknown): boolean {
  const stack: Array<[unknown, number]> = [[root, 0]];
  while (stack.length) {
    const [value, depth] = stack.pop()!;
    if (depth > 32) return false;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value !== "object") return false;
    if (
      !Array.isArray(value) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      return false;
    for (const child of Object.values(value)) {
      if (child === undefined) {
        if (Array.isArray(value)) return false;
        continue; // Optional object fields have the same absent/undefined meaning.
      }
      stack.push([child, depth + 1]);
    }
  }
  return true;
}
export function parseBackupEntry(v: unknown): BackupEntry {
  if (!object(v) || !backupKinds.includes(v.kind as BackupKind))
    throw Error("バックアップの記録形式を確認できません。");
  const entry = backupEntry(v.kind as BackupKind, v.value);
  if (entry.key !== v.key)
    throw Error("バックアップの識別情報が一致しません。");
  return entry;
}
// Enforce the same limits during export, validation, and target transactions.
export function capacityKeys(
  entry: BackupEntry,
): Array<[string, string, number]> {
  const v = entry.value;
  switch (entry.kind) {
    case "documents":
    case "documentVersions":
      return [];
    case "feeds":
      return [["", "", 50]];
    case "articles":
      return [];
    case "highlights":
    case "learning":
      return [["articleId", String(v.articleId), 200]];
    case "connections":
      return (v.members as string[]).map((id) => ["members", id, 200]);
    case "quoteConnections":
      return [
        ...(v.members as string[]).map(
          (id) => ["members", id, 200] as [string, string, number],
        ),
        ...(v.articles as string[]).map(
          (id) => ["articles", id, 200] as [string, string, number],
        ),
      ];
  }
}
export class BackupCounter {
  readonly counts = emptyBackupCounts();
  private readonly capacities = new Map<string, number>();
  private total = 0;
  add(entry: BackupEntry) {
    if (++this.total > backupRecordLimit)
      throw Error(
        "バックアップは合計100万記録までです。部分的な復元は開始していません。",
      );
    this.counts[entry.kind]++;
    for (const [index, id, limit] of capacityKeys(entry)) {
      const key = JSON.stringify([entry.kind, index, id]),
        count = (this.capacities.get(key) ?? 0) + 1;
      if (count > limit)
        throw Error(
          "バックアップの購読数または記事・引用ごとの上限を超えています。",
        );
      this.capacities.set(key, count);
    }
  }
}
// Property order is irrelevant when reporting identical existing JSON records.
export function sameBackupValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => sameBackupValue(x, b[i]));
  if (object(a) && object(b)) {
    const keys = Object.keys(a).filter((k) => a[k] !== undefined);
    return (
      keys.length === Object.keys(b).filter((k) => b[k] !== undefined).length &&
      keys.every((k) => Object.hasOwn(b, k) && sameBackupValue(a[k], b[k]))
    );
  }
  return false;
}
