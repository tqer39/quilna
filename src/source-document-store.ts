import { fetchArticle, type ArticleContent } from "./article-content";
import { sourceURL } from "./feed-discovery";
import {
  validSourceValidators,
  type SourceValidators,
} from "./http-validators.mjs";
import {
  browserDocumentScope,
  documentFreshnessMs,
  validSourceDocument,
  validDocumentVersion,
  representationHash,
  sourceContent,
  versionContent,
  documentIdentity,
  versionIdentity,
  verifyDocumentIdentity,
  type SourceDocument,
  type DocumentVersion,
} from "./source-document";
export const documentDatabase = "quilna.documents.v1";
export async function openDocuments(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let failed = false;
    const request = indexedDB.open(documentDatabase, 3);
    request.onupgradeneeded = (event) => {
      if (event.oldVersion < 1) {
        const docs = request.result.createObjectStore("documents", {
          keyPath: "id",
        });
        docs.createIndex("source", ["scope", "sourceURL"], { unique: true });
        const versions = request.result.createObjectStore("versions", {
          keyPath: "id",
        });
        versions.createIndex(
          "representation",
          ["documentId", "representationHash"],
          { unique: true },
        );
        versions.createIndex("history", ["documentId", "createdAt", "id"]);
      }
      if (event.oldVersion < 2)
        request
          .transaction!.objectStore("documents")
          .createIndex("url", "sourceURL");
      request
        .transaction!.objectStore("documents")
        .createIndex("aliases", "sourceAliases", { multiEntry: true });
    };
    request.onerror = request.onblocked = () => {
      failed = true;
      reject(
        Error(
          "文書の保存領域を開けませんでした。保存済みの本文は保持しています。",
        ),
      );
    };
    request.onsuccess = () => {
      const db = request.result;
      if (failed) {
        db.close();
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}
// Read only this source's metadata, never scan the article library or version bodies.
export async function documentSources(url: string): Promise<SourceDocument[]> {
  const normalized = sourceURL(url);
  const result = await withDatabase(
    (db) =>
      new Promise<SourceDocument[]>((resolve, reject) => {
        const tx = db.transaction("documents"),
          get = tx.objectStore("documents").index("url").getAll(normalized),
          aliases = tx
            .objectStore("documents")
            .index("aliases")
            .getAll(normalized);
        tx.oncomplete = () =>
          resolve([
            ...new Map(
              [...get.result, ...aliases.result].map((d: SourceDocument) => [
                d.id,
                d,
              ]),
            ).values(),
          ]);
        tx.onerror = tx.onabort = () => reject(failed());
      }),
  );
  for (const doc of result) {
    if (
      !validSourceDocument(doc) ||
      (doc.sourceURL !== normalized &&
        !doc.sourceAliases?.includes(normalized)) ||
      !(await verifyDocumentIdentity(doc))
    )
      throw failed();
  }
  return result;
}
function failed(error?: unknown) {
  return (
    error ??
    Error(
      "文書の保存処理に失敗しました。保存済みの本文は保持しています。再試行してください。",
    )
  );
}
function validatePair(
  doc: unknown,
  version: unknown,
  scope: string,
  url?: string,
): { document: SourceDocument; version: DocumentVersion } {
  if (
    !validSourceDocument(doc) ||
    !validDocumentVersion(version) ||
    doc.scope !== scope ||
    version.scope !== scope ||
    doc.id !== version.documentId ||
    doc.sourceURL !== version.sourceURL ||
    (doc.currentVersionId === version.id &&
      doc.validators !== undefined &&
      doc.validators.url !== version.content.url) ||
    (url !== undefined && doc.sourceURL !== url)
  )
    throw Error("文書と本文の版を確認できません。既存の記録は保持しています。");
  return { document: doc, version };
}
async function withDatabase<T>(run: (db: IDBDatabase) => Promise<T>) {
  const db = await openDocuments();
  try {
    return await run(db);
  } finally {
    db.close();
  }
}
export async function currentDocument(
  url: string,
  scope = browserDocumentScope,
) {
  const normalized = sourceURL(url);
  const result = await withDatabase(
    (db) =>
      new Promise<
        { document: SourceDocument; version: DocumentVersion } | undefined
      >((resolve, reject) => {
        const tx = db.transaction(["documents", "versions"]),
          get = tx
            .objectStore("documents")
            .index("source")
            .get([scope, normalized]);
        let result:
            { document: SourceDocument; version: DocumentVersion } | undefined,
          error: unknown;
        get.onsuccess = () => {
          try {
            if (get.result === undefined) return;
            if (!validSourceDocument(get.result)) throw failed();
            const doc = get.result,
              version = tx.objectStore("versions").get(doc.currentVersionId);
            version.onsuccess = () => {
              try {
                result = validatePair(doc, version.result, scope, normalized);
              } catch (e) {
                error = e;
                tx.abort();
              }
            };
          } catch (e) {
            error = e;
            tx.abort();
          }
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(failed(error));
      }),
  );
  if (
    result &&
    (!(await verifyDocumentIdentity(result.document)) ||
      !(await verifyDocumentIdentity(result.version)))
  )
    throw failed();
  return result;
}
export async function readDocumentVersion(
  documentId: string,
  versionId: string,
  scope = browserDocumentScope,
) {
  const result = await withDatabase(
    (db) =>
      new Promise<DocumentVersion>((resolve, reject) => {
        const tx = db.transaction(["documents", "versions"]),
          doc = tx.objectStore("documents").get(documentId),
          version = tx.objectStore("versions").get(versionId);
        tx.oncomplete = () => {
          try {
            resolve(validatePair(doc.result, version.result, scope).version);
          } catch (e) {
            reject(e);
          }
        };
        tx.onerror = tx.onabort = () => reject(failed());
      }),
  );
  if (!(await verifyDocumentIdentity(result))) throw failed();
  return result;
}
export async function documentHistory(
  documentId: string,
  scope = browserDocumentScope,
  after?: [string, string],
) {
  const result = await withDatabase(
    (db) =>
      new Promise<{ versions: DocumentVersion[]; more: boolean }>(
        (resolve, reject) => {
          const tx = db.transaction(["documents", "versions"]),
            get = tx.objectStore("documents").get(documentId);
          const versions: DocumentVersion[] = [];
          let error: unknown;
          get.onsuccess = () => {
            try {
              if (
                !validSourceDocument(get.result) ||
                get.result.scope !== scope
              )
                throw failed();
              const doc = get.result;
              const range = IDBKeyRange.bound(
                [documentId],
                after ? [documentId, ...after] : [documentId, []],
                false,
                true,
              );
              const cursor = tx
                .objectStore("versions")
                .index("history")
                .openCursor(range, "prev");
              cursor.onsuccess = () => {
                try {
                  if (!cursor.result) return;
                  versions.push(
                    validatePair(doc, cursor.result.value, scope).version,
                  );
                  if (versions.length < 21) cursor.result.continue();
                } catch (e) {
                  error = e;
                  tx.abort();
                }
              };
            } catch (e) {
              error = e;
              tx.abort();
            }
          };
          tx.oncomplete = () =>
            resolve({
              versions: versions.slice(0, 20),
              more: versions.length > 20,
            });
          tx.onerror = tx.onabort = () => reject(failed(error));
        },
      ),
  );
  for (const version of result.versions)
    if (!(await verifyDocumentIdentity(version))) throw failed();
  return result;
}
// Digest work happens before the write transaction. All identity/revision decisions happen inside it.
export async function retainDocument(
  url: string,
  content: ArticleContent,
  options: {
    scope?: string;
    seed?: boolean;
    validators?: SourceValidators;
  } = {},
) {
  const normalized = sourceURL(url),
    scope = options.scope ?? browserDocumentScope;
  if (!scope || scope.length > 200) throw failed();
  if (
    options.validators !== undefined &&
    (!validSourceValidators(options.validators) ||
      options.validators.url !== content.url)
  )
    throw failed();
  const clean = sourceContent(content),
    hash = await representationHash(clean),
    now = new Date().toISOString();
  const identity = await documentIdentity(scope, normalized);
  const versionId = await versionIdentity(identity, hash);
  const result = await withDatabase(
    (db) =>
      new Promise<{ document: SourceDocument; version: DocumentVersion }>(
        (resolve, reject) => {
          const tx = db.transaction(["documents", "versions"], "readwrite"),
            docs = tx.objectStore("documents"),
            versions = tx.objectStore("versions");
          const get = docs.index("source").get([scope, normalized]);
          let result: { document: SourceDocument; version: DocumentVersion },
            error: unknown;
          const refuse = (e: unknown) => {
            error = e;
            tx.abort();
          };
          get.onsuccess = () => {
            try {
              const old = get.result as SourceDocument | undefined;
              if (
                old !== undefined &&
                (!validSourceDocument(old) || old.id !== identity)
              )
                throw failed();
              const id = identity;
              const existing = versions.index("representation").get([id, hash]);
              existing.onsuccess = () => {
                try {
                  let version = existing.result as DocumentVersion | undefined;
                  if (
                    version !== undefined &&
                    (!validDocumentVersion(version) ||
                      version.documentId !== id ||
                      version.id !== versionId ||
                      version.scope !== scope ||
                      version.sourceURL !== normalized ||
                      JSON.stringify({
                        ...sourceContent(version.content),
                        fetchedAt: "",
                      }) !== JSON.stringify({ ...clean, fetchedAt: "" }))
                  )
                    throw failed();
                  if (!version) {
                    version = {
                      id: versionId,
                      documentId: id,
                      scope,
                      sourceURL: normalized,
                      representationHash: hash,
                      formatVersion: 1,
                      createdAt: now,
                      content: clean,
                    };
                    versions.add(version);
                  }
                  const document: SourceDocument =
                    old && options.seed
                      ? old
                      : {
                          id,
                          scope,
                          sourceURL: normalized,
                          currentVersionId: version.id,
                          checkedAt: options.seed ? clean.fetchedAt : now,
                          revision: (old?.revision ?? 0) + 1,
                          ...(options.validators
                            ? { validators: options.validators }
                            : {}),
                        };
                  if (!validSourceDocument(document)) throw failed();
                  if (!(old && options.seed)) docs.put(document);
                  result = { document, version };
                } catch (e) {
                  refuse(e);
                }
              };
            } catch (e) {
              refuse(e);
            }
          };
          tx.oncomplete = () => resolve(result);
          tx.onerror = tx.onabort = () => reject(failed(error));
        },
      ),
  );
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(documentDatabase);
    channel.postMessage("changed");
    channel.close();
  }
  return result;
}
export async function acquireDocument(
  url: string,
  options: { force?: boolean; scope?: string } = {},
) {
  const normalized = sourceURL(url),
    scope = options.scope ?? browserDocumentScope;
  if (!navigator.locks)
    throw Error(
      "このブラウザでは本文の重複取得を安全に調整できません。対応ブラウザで再試行してください。",
    );
  const before = await currentDocument(normalized, scope);
  return navigator.locks.request(
    `quilna.document:${JSON.stringify([scope, normalized])}`,
    async () => {
      const current = await currentDocument(normalized, scope);
      const age = current
        ? Date.now() - Date.parse(current.document.checkedAt)
        : Infinity;
      // A concurrent refresh already completed while this caller was waiting.
      if (
        current &&
        ((!options.force && age >= 0 && age < documentFreshnessMs) ||
          (options.force &&
            current.document.revision !== before?.document.revision))
      )
        return { content: versionContent(current.version), reused: true };
      try {
        const fetched = await fetchArticle(
          normalized,
          current
            ? {
                content: current.version.content,
                // Explicit format repair needs HTML, even when the source has
                // not changed. Ordinary cached reads still avoid a fetch.
                validators:
                  options.force && !current.version.content.structure
                    ? undefined
                    : current.document.validators,
              }
            : undefined,
        );
        const saved = await retainDocument(normalized, fetched.content, {
          scope,
          validators: fetched.validators,
        });
        return {
          content: versionContent(saved.version),
          reused: fetched.notModified,
        };
      } catch (error) {
        if (current)
          return {
            content: versionContent(current.version),
            reused: true,
            warning: `更新を確認できませんでした：${(error as Error).message} 保存済みの本文を表示しています。`,
          };
        throw error;
      }
    },
  );
}
