import { describe, it, expect, vi } from "vitest";
import { DocumentPolicyClient } from "../src/document-policy-client";
import { documentIdentity } from "../src/source-document";
import {
  lifecyclePreview,
  type LifecycleContext,
} from "../src/document-lifecycle-client";
import {
  lifecycleState,
  changeLifecycle,
  type LifecycleCommand,
} from "../src/document-lifecycle.mjs";
const account = "a".repeat(64),
  other = "b".repeat(64);
const url = "https://publisher.example.org/article";
const context: LifecycleContext = {
  target: { audience: "private", url },
  scope: `private:${account}`,
  url,
};
async function fixture() {
  const state = lifecycleState(
    undefined,
    await documentIdentity(context.scope, url),
  );
  const preview = () => ({
    ...structuredClone(state),
    scope: context.scope,
    sourceURL: url,
    expired: false,
    cleanupPending: false,
    catalogRevision: 1,
    versionCount: 1,
    bytes: 1234,
    reservation: {
      reserved: false,
      token: null,
      revision: 0,
      scopeCount: 0,
      legacy: false,
      containsTarget: false,
    },
  });
  return { state, preview };
}
describe("lifecycle response validation", () => {
  it("distinguishes unavailable accounting from an unreserved source", async () => {
    const f = await fixture();
    const value = { ...f.preview(), reservation: { status: "unavailable" } };
    await expect(lifecyclePreview(value, context)).resolves.toMatchObject({
      reservation: { status: "unavailable" },
      status: "active",
    });
    for (const reservation of [
      { status: "unknown" },
      { status: "unavailable", reserved: false },
      null,
    ])
      await expect(
        lifecyclePreview({ ...value, reservation }, context),
      ).rejects.toThrow();
  });

  it("binds the source, scope and computed document ID and validates the audit's state", async () => {
    const f = await fixture();
    await expect(lifecyclePreview(f.preview(), context)).resolves.toMatchObject(
      { revision: 0, status: "active" },
    );
    for (const patch of [
      { scope: `private:${other}` },
      { sourceURL: url + "?different" },
      { id: crypto.randomUUID() },
      { revision: 1 },
      { status: "deleted" },
      { cleanupPending: true },
      { bytes: 10000001 },
    ])
      await expect(
        lifecyclePreview({ ...f.preview(), ...patch }, context),
      ).rejects.toThrow();
  });
  it("rejects a successful response acknowledging a different command or audit", async () => {
    const f = await fixture();
    const command: LifecycleCommand = {
      operationId: crypto.randomUUID(),
      action: "withdraw",
      expectedRevision: 0,
      reason: "Explicit fixture decision",
    };
    const outcome = changeLifecycle(f.state, command, 1, Date.now());
    for (const malformed of [true, false]) {
      const client = new DocumentPolicyClient(async (path, options) => {
        if (path === "/api/documents/admin-status")
          return Response.json({ account, enabled: true });
        if (path === "/api/session")
          return Response.json({ csrfToken: "synthetic-long-csrf-token" });
        expect(path).toBe("/api/documents/admin-document-change");
        expect(JSON.parse(String(options?.body))).toEqual({
          target: context.target,
          command,
        });
        const operation = structuredClone(outcome.operation);
        if (malformed) operation.command.reason = "Different decision";
        return Response.json({
          account,
          ...outcome,
          operation,
          current: f.preview(),
        });
      });
      client.account = account;
      if (malformed)
        await expect(
          client.changeDocument(context, command, new AbortController().signal),
        ).rejects.toThrow();
      else
        await expect(
          client.changeDocument(context, command, new AbortController().signal),
        ).resolves.toMatchObject({ current: { status: "withdrawn" } });
    }
  });
  it("does not return a preview when the session changes after the management response", async () => {
    const f = await fixture();
    let delivered = false;
    const client = new DocumentPolicyClient(async (path) => {
      if (path === "/api/documents/admin-status")
        return Response.json({
          account: delivered ? other : account,
          enabled: true,
        });
      if (path === "/api/session")
        return Response.json({ csrfToken: "synthetic-long-csrf-token" });
      delivered = true;
      return Response.json({ account, ...f.preview() });
    });
    client.account = account;
    await expect(
      client.previewDocument(context, new AbortController().signal),
    ).rejects.toMatchObject({ locked: true });
  });
});

it("does not publish a lifecycle preview after cancellation during identity verification", async () => {
  const f = await fixture();
  const client = new DocumentPolicyClient(async (path) => {
    if (path === "/api/documents/admin-status")
      return Response.json({ account, enabled: true });
    if (path === "/api/session")
      return Response.json({ csrfToken: "synthetic-long-csrf-token" });
    return Response.json({ account, ...f.preview() });
  });
  client.account = account;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const spy = vi
    .spyOn(crypto.subtle, "digest")
    .mockImplementationOnce(async (...args) => {
      enter();
      await pending;
      return digest(...args);
    });
  const controller = new AbortController();
  const result = client.previewDocument(context, controller.signal).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    await entered;
    controller.abort();
    release();
    expect(await result).toHaveProperty("error");
  } finally {
    release();
    spy.mockRestore();
  }
});
