import { z } from "zod";

const account = z.string().regex(/^[a-f0-9]{64}$/);
const assignmentSchema = z
  .object({ schema: z.literal(1), account, legacy: z.boolean() })
  .strict();
type Assignment = z.infer<typeof assignmentSchema>;
const bindingSchema = assignmentSchema.extend({ key: z.string() }).strict();
const legacySchema = z
  .object({ key: z.literal("legacy"), schema: z.literal(1), account })
  .strict();
const registryName = "quilna.library-bindings.v1";
const signalKey = "quilna.library-session.v1";
let current: Assignment | null = null;
let stopped = false;
let initialization: Promise<void> | null = null;
const connections = new Set<IDBDatabase>();

/** Compare verified assignments; local signals never supply a new identity. */
function same(a: Assignment, b: Assignment) {
  return a.account === b.account && a.legacy === b.legacy;
}
/** Refuse new storage work after this document loses its account context. */
function assertActive() {
  if (stopped) throw Error("ライブラリのアカウントを確認し直してください。");
}
/** Select account-specific UI text only after server verification. */
export const hasAccountLibrary = () => current !== null && !stopped;
/** A document keeps one assignment for its lifetime, without switching databases in place. */
export function libraryName(base: string): string {
  assertActive();
  return current && !current.legacy
    ? `${base}.account.${current.account}`
    : base;
}
/** Guard cached DB handles as well as new opens after account invalidation. */
export function openLibraryDatabase(
  name: string,
  version: number,
): IDBOpenDBRequest {
  assertActive();
  const request = indexedDB.open(name, version);
  request.addEventListener("success", () => {
    const db = request.result;
    connections.add(db);
    const close = db.close.bind(db);
    db.close = () => {
      connections.delete(db);
      close();
    };
    db.transaction = ((...args: Parameters<IDBDatabase["transaction"]>) => {
      assertActive();
      return Reflect.apply(
        IDBDatabase.prototype.transaction,
        db,
        args,
      ) as IDBTransaction;
    }) as IDBDatabase["transaction"];
    if (stopped) db.close();
  });
  return request;
}
/** Probe without retaining an empty registry; preserve incompatible existing schemas. */
function openRegistry(probe: boolean): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(registryName, 1);
    let absent = false,
      failed = false;
    const fail = () => {
      failed = true;
      reject(
        Error(
          "ライブラリの割り当てを確認できません。既存の記録は保持しています。",
        ),
      );
    };
    request.onupgradeneeded = (event) => {
      if (failed) {
        request.transaction!.abort();
        return;
      }
      if (probe && event.oldVersion === 0) {
        absent = true;
        request.transaction!.abort();
      } else request.result.createObjectStore("bindings", { keyPath: "key" });
    };
    request.onerror = () => (absent ? resolve(null) : fail());
    request.onblocked = fail;
    request.onsuccess = () => {
      const db = request.result;
      if (
        failed ||
        db.objectStoreNames.length !== 1 ||
        !db.objectStoreNames.contains("bindings")
      ) {
        db.close();
        fail();
      } else {
        const store = db.transaction("bindings").objectStore("bindings");
        if (
          store.keyPath !== "key" ||
          store.autoIncrement ||
          store.indexNames.length
        ) {
          db.close();
          fail();
        } else resolve(db);
      }
    };
  });
}
/** Commit account and legacy-owner bindings together, never replacing an old assignment. */
async function bind(assignment: Assignment) {
  const db = await openRegistry(false);
  if (!db) throw Error("ライブラリを確認できません。");
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("bindings", "readwrite"),
        store = tx.objectStore("bindings");
      const key = "account:" + assignment.account;
      const saved = store.get(key),
        legacy = store.get("legacy");
      let ready = 0;
      /** Wait for both reads before validating or writing either binding. */
      const check = () => {
        if (++ready !== 2) return;
        const previous =
          saved.result === undefined
            ? null
            : bindingSchema.safeParse(saved.result);
        const owner =
          legacy.result === undefined
            ? null
            : legacySchema.safeParse(legacy.result);
        if (
          (previous?.success && previous.data.legacy && !owner) ||
          (owner?.success &&
            owner.data.account === assignment.account &&
            !previous) ||
          (previous &&
            (!previous.success ||
              previous.data.key !== key ||
              !same(previous.data, assignment))) ||
          (owner &&
            (!owner.success ||
              (assignment.legacy
                ? owner.data.account !== assignment.account
                : owner.data.account === assignment.account)))
        ) {
          tx.abort();
          return;
        }
        if (!previous) store.add({ ...assignment, key });
        if (assignment.legacy && !owner)
          store.add({ key: "legacy", schema: 1, account: assignment.account });
      };
      saved.onsuccess = legacy.onsuccess = check;
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(
          Error(
            "保存済みライブラリとアカウントの割り当てが一致しません。記録は変更せず保持しています。",
          ),
        );
    });
  } finally {
    db.close();
  }
}
/** Read bounded metadata, distinguishing known identity loss from a network failure. */
async function status(expected?: string): Promise<Assignment> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch("/api/library/status", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers: expected ? { "X-Library-Account": expected } : {},
    });
    if (!response.ok) {
      if ([401, 403, 404].includes(response.status))
        throw new IdentityChanged();
      throw Error("アカウントの確認に接続できません。");
    }
    if (
      !response.headers.get("Content-Type")?.includes("application/json") ||
      !response.body
    )
      throw new IdentityChanged();
    const reader = response.body.getReader();
    let text = "",
      bytes = 0;
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 2048) throw new IdentityChanged();
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new IdentityChanged();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new IdentityChanged();
    }
    const parsed = assignmentSchema.safeParse(value);
    if (!parsed.success) throw new IdentityChanged();
    return parsed.data;
  } finally {
    clearTimeout(timeout);
  }
}
class IdentityChanged extends Error {}
/** Hide body-mounted dialogs too, before reloading into another verified context. */
function invalidate() {
  if (stopped) return;
  stopped = true;
  document.documentElement.style.setProperty("display", "none", "important");
  for (const db of connections) db.close();
  location.reload();
}
/** Called after a successful local logout, before the old account can keep interacting. */
export function librarySignedOut() {
  if (!current) return;
  try {
    localStorage.removeItem(signalKey);
  } catch {
    // A blocked signal store must still hide the old document.
  } finally {
    invalidate();
  }
}
/** Runs before importing any module that reads personal IndexedDB or preferences. */
export function initializeLibraryContext(): Promise<void> {
  if (stopped)
    return Promise.reject(
      Error("ライブラリのアカウントを確認し直してください。"),
    );
  return (initialization ??= initializeAssignment());
}
/** Verify around registry work and install observers once per document lifetime. */
async function initializeAssignment() {
  const required = document.querySelector(
    'meta[name="account-libraries"][content="required"]',
  );
  if (!required) {
    const existing = await openRegistry(true);
    if (!existing) return;
    existing.close();
  }
  const assignment = await status();
  await bind(assignment);
  const confirmed = await status(assignment.account);
  if (!same(assignment, confirmed)) throw new IdentityChanged();
  current = assignment;
  localStorage.setItem(signalKey, JSON.stringify(assignment));
  /** A browser signal can demand reload, but cannot grant a new account context. */
  const checkSignal = () => {
    try {
      const saved = assignmentSchema.safeParse(
        JSON.parse(localStorage.getItem(signalKey) ?? "null"),
      );
      if (!saved.success || !same(saved.data, assignment)) invalidate();
    } catch {
      invalidate();
    }
  };
  window.addEventListener("storage", (event) => {
    if (event.key === signalKey || event.key === null) checkSignal();
  });
  let checking: Promise<void> | null = null;
  /** Serialize checks while preserving loaded offline data on a network failure. */
  const verify = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    checkSignal();
    if (stopped) return Promise.resolve();
    if (checking) return checking;
    const pending = (async () => {
      try {
        if (!same(await status(assignment.account), assignment)) invalidate();
      } catch (error) {
        if (error instanceof IdentityChanged) invalidate();
      }
    })();
    checking = pending;
    void pending.finally(() => {
      if (checking === pending) checking = null;
    });
    return pending;
  };
  setInterval(() => void verify(), 60000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void verify();
  });
  window.addEventListener("pagehide", (event) => {
    if (event.persisted)
      document.documentElement.style.setProperty(
        "display",
        "none",
        "important",
      );
  });
  window.addEventListener("pageshow", () => {
    checkSignal();
    void (async () => {
      // An earlier check may predate page restoration; require a fresh one.
      if (checking) await checking;
      await verify();
      if (!stopped) document.documentElement.style.removeProperty("display");
    })();
  });
}
