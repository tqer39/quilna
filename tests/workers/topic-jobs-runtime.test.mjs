import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode, hash } from "../../workers/crypto.mjs";

test(
  "実alarmが画面なしで教材生成を実行し、再起動・重複予約後も同じ結果と台帳を再利用する",
  { timeout: 30000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "quilna-topic-jobs-"));
    const script = (
      await build({
        entryPoints: ["tests/workers/topic-jobs-entry.mjs"],
        bundle: true,
        write: false,
        format: "esm",
        platform: "neutral",
        external: ["cloudflare:workers"],
        logLevel: "silent",
      })
    ).outputFiles[0].text;
    const origin = "http://app.test",
      owner = await hash("better-auth:topic-fixture-user");
    let outbound = 0;
    const options = {
      modules: true,
      script,
      compatibilityDate: "2026-10-11",
      resourcePersistencePath: dir,
      d1Databases: { AUTH_DB: "topic-job-auth" },
      durableObjects: {
        ACCOUNTS: { className: "AccountVault", useSQLite: true },
        TOPIC_TEXTBOOK_JOBS: {
          className: "TopicTextbookJobs",
          useSQLite: true,
        },
      },
      bindings: {
        APP_ORIGIN: origin,
        GOOGLE_ALLOWED_EMAIL: "topic@example.test",
        TEST_INSTANCE_ID: "before-restart",
        TOPIC_TEXTBOOK_JOBS_ENABLED: "true",
        BYOK_ENCRYPTION_KEYRING: JSON.stringify({
          active: "test",
          keys: { test: encode(crypto.getRandomValues(new Uint8Array(32))) },
        }),
      },
      outboundService: () => {
        outbound++;
        throw Error("外部通信を禁止");
      },
    };
    let mf = new Miniflare(convertV4MiniflareOptions(options));
    t.after(async () => {
      await mf.dispose();
      await rm(dir, { recursive: true, force: true });
    });
    const db = await mf.getD1Database("AUTH_DB");
    await db.exec(
      (
        await readFile("migrations/auth/0001_better_auth.sql", "utf8")
      ).replaceAll("\n", " "),
    );
    await db
      .prepare(
        'INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)',
      )
      .bind("topic-fixture-user", "Fixture", "topic@example.test", 1, 0, 0)
      .run();
    const request = async (path, body, csrf) =>
      mf.dispatchFetch(origin + path, {
        method: body ? "POST" : "GET",
        headers: {
          Origin: origin,
          "X-Test-Principal": "test-a",
          "X-Library-Account": owner,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const call = async (path, body, csrf) => {
      const response = await request(path, body, csrf);
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    };
    const csrf = (await call("/api/session")).csrfToken;
    assert.equal(
      (await request("/api/topic-textbooks/jobs/list", {}, "invalid-csrf"))
        .status,
      403,
    );
    await call(
      "/api/credentials/openai",
      {
        requestId: crypto.randomUUID(),
        expectedRevision: 0,
        key: "DUMMY-ONLY-ASYNC-FIXTURE",
        model: "gpt-6-luna",
      },
      csrf,
    );
    const book = JSON.parse(
      await readFile("tests/fixtures/shared-textbook-v2.json", "utf8"),
    );
    const record = JSON.parse(
      Buffer.from(book.record, "base64").toString("utf8"),
    );
    const requestRaw = Buffer.from(record.request, "base64").toString("utf8");
    const quote = (await call("/api/topic-textbooks/status")).quotes.find(
      (q) => q.purpose === "book-addition",
    );
    assert.ok(quote);
    const input = {
      requestId: JSON.parse(requestRaw).id,
      purpose: "book-addition",
      requestRaw,
      modelId: quote.modelId,
      approvedPublicText: true,
      approvedMaxMilliYen: quote.maxMilliYen,
      approvedQuoteDigest: quote.quoteDigest,
    };
    const internal = "https://account.internal/command/queued-topic";
    for (const value of [
      {
        url: internal + "?invalid=1",
        data: { owner, input, lookup: true },
        status: 404,
      },
      { url: internal, method: "GET", status: 404 },
      {
        url: internal,
        data: { owner: "b".repeat(64), input, lookup: true },
        status: 503,
      },
      {
        url: internal,
        data: { owner, input, lookup: true, extra: true },
        status: 503,
      },
      {
        url: internal,
        data: {
          owner,
          input: { ...input, approvedQuoteDigest: undefined },
          lookup: false,
        },
        status: 503,
      },
    ]) {
      const response = await request("/__account-command", {
        target: owner,
        ...value,
      });
      assert.equal(response.status, value.status);
    }
    assert.equal((await call("/__topic-calls", { owner })).calls, 0);
    const wrongObject = await request("/__jobs-target", {
      target: owner,
      data: { owner: "b".repeat(64), action: "enqueue", input },
    });
    assert.equal(wrongObject.status, 403);
    assert.equal(
      (await request("/api/topic-textbooks/jobs/enqueue", input, csrf)).status,
      400,
    );
    const queued = await call(
      "/api/topic-textbooks/jobs/enqueue",
      { input },
      csrf,
    );
    assert.equal(queued.job.state, "queued");
    assert.equal(
      (
        await call("/__jobs", {
          action: "resume",
          owner,
          id: input.requestId,
          confirm: true,
        })
      ).job.state,
      "queued",
    );
    await mf.dispose();
    options.bindings.TEST_INSTANCE_ID = "after-restart";
    mf = new Miniflare(convertV4MiniflareOptions(options));
    let completed;
    await t.test(
      "ブラウザの継続要求やalarmの手動発火なしで完了する",
      async () => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          completed = await call("/__jobs", {
            action: "read",
            owner,
            id: input.requestId,
          });
          if (completed.job.state === "complete") break;
          assert.notEqual(
            completed.job.state,
            "held",
            JSON.stringify(completed),
          );
          assert.notEqual(
            completed.job.state,
            "rejected",
            JSON.stringify(completed),
          );
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(
          completed.job.state,
          "complete",
          JSON.stringify(completed),
        );
      },
    );
    assert.equal(completed.job.result.draft.kind, "topic-textbook-draft");
    const budget = await call("/api/budget");
    const duplicate = await call("/__jobs", {
      action: "enqueue",
      owner,
      input,
    });
    assert.deepEqual(duplicate, completed);
    await mf.dispose();
    mf = new Miniflare(convertV4MiniflareOptions(options));
    assert.deepEqual(
      await call("/__jobs", { action: "read", owner, id: input.requestId }),
      completed,
    );
    assert.deepEqual(await call("/api/budget"), budget);
    assert.equal((await call("/__topic-calls", { owner })).calls, 1);
    assert.equal(
      (await call("/__topic-calls", { owner })).instance,
      "after-restart",
    );
    assert.equal(
      (await call("/api/topic-textbooks/jobs/list", {}, csrf)).jobs.length,
      1,
    );
    assert.deepEqual(
      await call(
        "/api/topic-textbooks/jobs/refresh",
        { id: input.requestId },
        csrf,
      ),
      completed,
    );
    assert.equal(
      (
        await request("/__jobs", {
          action: "retry",
          owner,
          input,
          confirm: false,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/__jobs", {
          action: "retry",
          owner,
          input,
          confirm: true,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request("/__jobs", {
          action: "remove",
          owner,
          id: input.requestId,
          confirm: false,
        })
      ).status,
      400,
    );
    const cancelRaw = JSON.parse(requestRaw);
    cancelRaw.id = crypto.randomUUID();
    const cancelInput = {
      ...input,
      requestId: cancelRaw.id,
      requestRaw: JSON.stringify(cancelRaw),
    };
    await call("/__jobs", { action: "enqueue", owner, input: cancelInput });
    assert.equal(
      (
        await call("/__jobs", {
          action: "cancel",
          owner,
          id: cancelInput.requestId,
          confirm: true,
        })
      ).job.state,
      "cancelled",
    );
    await call("/__jobs", {
      action: "remove",
      owner,
      id: cancelInput.requestId,
      confirm: true,
    });
    assert.equal(
      (
        await call("/__jobs", {
          action: "read",
          owner,
          id: cancelInput.requestId,
        })
      ).job,
      null,
    );
    const oversized = {
      ...input,
      requestId: crypto.randomUUID(),
      requestRaw: "あ".repeat(81000),
      draftRaw: "い".repeat(50000),
    };
    assert.equal(
      (await request("/__jobs", { action: "enqueue", owner, input: oversized }))
        .status,
      413,
    );
    const revokedRaw = JSON.parse(requestRaw);
    revokedRaw.id = crypto.randomUUID();
    const revokedInput = {
      ...input,
      requestId: revokedRaw.id,
      requestRaw: JSON.stringify(revokedRaw),
    };
    await call("/__dispatch-gate", { owner, hold: true });
    try {
      await call(
        "/api/topic-textbooks/jobs/enqueue",
        { input: revokedInput },
        csrf,
      );
      const checkingDeadline = Date.now() + 10000;
      let checking = false;
      do {
        checking = (await call("/__topic-calls", { owner })).checking;
        if (checking) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < checkingDeadline);
      assert.equal(checking, true);
      await (
        await mf.getD1Database("AUTH_DB")
      )
        .prepare('UPDATE "user" SET "emailVerified"=0 WHERE id=?')
        .bind("topic-fixture-user")
        .run();
    } finally {
      await call("/__dispatch-gate", { owner, hold: false });
    }
    const deadline = Date.now() + 10000;
    let revoked;
    do {
      revoked = await call(
        "/api/topic-textbooks/jobs/read",
        { id: revokedInput.requestId },
        csrf,
      );
      if (revoked.job.state === "rejected") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.equal(revoked.job.state, "rejected", JSON.stringify(revoked));
    assert.equal(revoked.job.reason, "access-unavailable");
    assert.equal(revoked.job.result.status, "account-forbidden");
    assert.deepEqual(
      await call(
        "/api/topic-textbooks/jobs/refresh",
        { id: revokedInput.requestId },
        csrf,
      ),
      revoked,
    );
    assert.equal((await call("/__topic-calls", { owner })).calls, 1);
    assert.deepEqual(await call("/api/budget"), budget);
    await (
      await mf.getD1Database("AUTH_DB")
    )
      .prepare('UPDATE "user" SET "emailVerified"=1 WHERE id=?')
      .bind("topic-fixture-user")
      .run();
    await call(
      "/api/topic-textbooks/jobs/retry",
      { input: revokedInput, confirm: true },
      csrf,
    );
    const retryDeadline = Date.now() + 10000;
    let retried;
    do {
      retried = await call(
        "/api/topic-textbooks/jobs/read",
        { id: revokedInput.requestId },
        csrf,
      );
      if (retried.job.state === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < retryDeadline);
    assert.equal(retried.job.state, "complete", JSON.stringify(retried));
    assert.equal((await call("/__topic-calls", { owner })).calls, 2);
    options.bindings.TOPIC_TEXTBOOK_JOBS_ENABLED = "false";
    await mf.dispose();
    mf = new Miniflare(convertV4MiniflareOptions(options));
    assert.equal(
      (
        await request("/__account-command", {
          target: owner,
          url: internal,
          data: { owner, input, lookup: false },
        })
      ).status,
      404,
    );
    const retained = await call("/__account-command", {
      target: owner,
      url: internal,
      data: { owner, input, lookup: true },
    });
    assert.equal(retained.status, "complete");
    assert.deepEqual(retained.draft, completed.job.result.draft);
    assert.deepEqual(
      await call("/__jobs", { action: "read", owner, id: input.requestId }),
      completed,
    );
    assert.equal((await call("/__topic-calls", { owner })).calls, 2);
    assert.equal(outbound, 0);
  },
);
