import { openDocuments, documentDatabase } from "./source-document-store";
import { sourceURL } from "./feed-discovery";
import {
  validSourceDocument,
  validDocumentVersion,
  verifyDocumentIdentity,
  sourceContent,
  type SourceDocument,
  type DocumentVersion,
} from "./source-document";

const invalid = () =>
  Error("取得した本文の保存情報を確認できません。以前の本文は保持しています。");
function cleanDocument(d: SourceDocument): SourceDocument {
  return {
    id: d.id,
    scope: d.scope,
    sourceURL: d.sourceURL,
    currentVersionId: d.currentVersionId,
    checkedAt: d.checkedAt,
    revision: d.revision,
    ...(d.validators
      ? {
          validators: {
            url: d.validators.url,
            ...(d.validators.etag ? { etag: d.validators.etag } : {}),
            ...(d.validators.lastModified
              ? { lastModified: d.validators.lastModified }
              : {}),
          },
        }
      : {}),
  };
}
function cleanVersion(v: DocumentVersion): DocumentVersion {
  return {
    id: v.id,
    documentId: v.documentId,
    scope: v.scope,
    sourceURL: v.sourceURL,
    representationHash: v.representationHash,
    formatVersion: 1,
    createdAt: v.createdAt,
    content: sourceContent(v.content),
  };
}
// Import immutable server identities/timestamps without minting a browser version.
export async function retainRemoteDocument(
  document: SourceDocument,
  version: DocumentVersion,
  signal: AbortSignal,
  requestedURL = document.sourceURL,
) {
  if (
    !validSourceDocument(document) ||
    !validDocumentVersion(version) ||
    document.currentVersionId !== version.id ||
    document.id !== version.documentId ||
    document.scope !== version.scope ||
    document.sourceURL !== version.sourceURL ||
    (document.validators && document.validators.url !== version.content.url) ||
    !(await verifyDocumentIdentity(document)) ||
    !(await verifyDocumentIdentity(version))
  )
    throw invalid();
  const requested = sourceURL(requestedURL);
  if (requested !== document.sourceURL && !document.scope.startsWith("shared:"))
    throw invalid();
  const incoming = cleanDocument(document),
    immutable = cleanVersion(version);
  signal.throwIfAborted();
  const db = await openDocuments();
  try {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["documents", "versions"], "readwrite"),
        docs = tx.objectStore("documents"),
        versions = tx.objectStore("versions"),
        old = docs.get(incoming.id),
        existing = versions.get(immutable.id);
      const abort = () => {
        try {
          tx.abort();
        } catch {
          /* Already complete. */
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      existing.onsuccess = () => {
        try {
          const previous = old.result,
            stored = existing.result;
          if (
            (previous !== undefined &&
              (!validSourceDocument(previous) ||
                previous.id !== incoming.id ||
                previous.scope !== incoming.scope ||
                previous.sourceURL !== incoming.sourceURL ||
                (previous.revision === incoming.revision &&
                  JSON.stringify(cleanDocument(previous)) !==
                    JSON.stringify(incoming)))) ||
            (stored !== undefined &&
              (!validDocumentVersion(stored) ||
                JSON.stringify(cleanVersion(stored)) !==
                  JSON.stringify(immutable)))
          ) {
            abort();
            return;
          }
          const aliases = [
            ...new Set([
              ...(previous?.sourceAliases ?? []),
              ...(requested !== incoming.sourceURL ? [requested] : []),
            ]),
          ];
          if (aliases.length > 50) throw invalid();
          if (!stored) versions.add(immutable);
          // Late responses can add historical evidence but cannot rewind the latest pointer.
          const current =
            !previous || previous.revision < incoming.revision
              ? incoming
              : previous;
          docs.put({
            ...current,
            ...(aliases.length ? { sourceAliases: aliases } : {}),
          });
        } catch {
          abort();
        }
      };
      tx.oncomplete = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      tx.onabort = tx.onerror = () => {
        signal.removeEventListener("abort", abort);
        reject(invalid());
      };
    });
  } finally {
    db.close();
  }
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(documentDatabase);
    channel.postMessage("changed");
    channel.close();
  }
  return { document: incoming, version: immutable };
}
