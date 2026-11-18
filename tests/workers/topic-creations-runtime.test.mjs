import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode, hash } from "../../workers/crypto.mjs";
import { parseSharedTextbook } from "../../src/shared-textbook-format.ts";

for (const scenario of ["ready", "budget", "revoked", "conflict"])
  test(
    `実SQLite/alarmでブラウザなしの連携と再起動後の保持を確認する: ${scenario}`,
    { timeout: 30000 },
    async (t) => {
      const directory = await mkdtemp(
        join(tmpdir(), "quilna-topic-creations-"),
      );
      const script = (
        await build({
          entryPoints: ["tests/workers/topic-creations-entry.mjs"],
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
        resourcePersistencePath: directory,
        d1Databases: { AUTH_DB: "creation-auth" },
        durableObjects: {
          ACCOUNTS: { className: "AccountVault", useSQLite: true },
          TOPIC_TEXTBOOK_JOBS: {
            className: "TopicTextbookJobs",
            useSQLite: true,
          },
          CREATIONS_FIXTURE: { className: "CreationFixture", useSQLite: true },
        },
        bindings: {
          APP_ORIGIN: origin,
          GOOGLE_ALLOWED_EMAIL: "topic@example.test",
          TEST_INSTANCE_ID: "before-restart",
          CREATIONS_FIXTURE_ENABLED: "true",
          TOPIC_TEXTBOOK_JOBS_ENABLED: "true",
          CREATION_FIXTURE_ALIAS: scenario === "conflict" ? "true" : "false",
          ...(scenario === "budget"
            ? { CREATION_FIXTURE_FIXED_MILLI_YEN: "499100" }
            : {}),
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
        await rm(directory, { recursive: true, force: true });
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
      const call = async (path, body, csrf) => {
        const response = await mf.dispatchFetch(origin + path, {
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
        const reply = await response.json();
        assert.equal(response.status, 200, JSON.stringify(reply));
        return reply;
      };
      const csrf = (await call("/api/session")).csrfToken;
      await call(
        "/api/credentials/openai",
        {
          requestId: crypto.randomUUID(),
          expectedRevision: 0,
          key: "DUMMY-ONLY-CREATION-FIXTURE",
          model: "gpt-6-luna",
        },
        csrf,
      );
      const fixture = JSON.parse(
        await readFile("tests/fixtures/shared-textbook-v2.json", "utf8"),
      );
      const content = JSON.parse(
        Buffer.from(fixture.record, "base64").toString("utf8"),
      );
      const requestRaw = Buffer.from(content.request, "base64").toString(
          "utf8",
        ),
        id = JSON.parse(requestRaw).id.toLowerCase();
      const saved = await call("/__creations", {
        action: "save",
        owner,
        requestRaw,
      });
      const quotes = (await call("/api/topic-textbooks/status")).quotes;
      let oldInput, oldResult;
      if (scenario === "conflict") {
        const oldQuote = quotes.find((q) => q.purpose === "book-addition");
        oldInput = {
          requestId: id,
          purpose: "book-addition",
          modelId: oldQuote.modelId,
          requestRaw,
          approvedPublicText: true,
          approvedMaxMilliYen: oldQuote.maxMilliYen,
          approvedQuoteDigest: oldQuote.quoteDigest,
        };
        oldResult = await call(
          "/api/topic-textbooks/proposals",
          oldInput,
          csrf,
        );
        assert.equal(oldResult.status, "complete");
      }
      const eligibleQuotes =
        scenario === "conflict"
          ? quotes.filter((q) => q.modelId === "alternate-fixture")
          : quotes;
      const approval = {
        confirm: true,
        approvedPublicText: true,
        generation: eligibleQuotes.find((q) => q.purpose === "book-addition"),
        review: eligibleQuotes.find((q) => q.purpose === "evidence-check"),
      };
      assert.ok(approval.generation);
      assert.ok(approval.review);
      const approved = await call("/__creations", {
        action: "approve",
        owner,
        id,
        approval,
        quotes,
      });
      assert.equal(approved.state, "generation");
      if (scenario === "revoked")
        await db
          .prepare('UPDATE "user" SET "emailVerified"=0 WHERE id=?')
          .bind("topic-fixture-user")
          .run();
      await mf.dispose();
      options.bindings.TEST_INSTANCE_ID = "after-restart";
      mf = new Miniflare(convertV4MiniflareOptions(options));
      let ready;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const reply = await call("/__creations", { action: "read", owner, id });
        ready = reply.creation;
        assert.notEqual(ready.state, "held", JSON.stringify(ready));
        if (scenario === "ready")
          assert.notEqual(ready.state, "rejected", JSON.stringify(ready));
        if (ready.state === (scenario === "ready" ? "ready" : "rejected")) {
          assert.equal(reply.alarmInstance, "after-restart");
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (scenario !== "ready") {
        assert.equal(ready.state, "rejected", JSON.stringify(ready));
        assert.equal(ready.book, null);
        const stages = await call("/__creations", {
          action: "stages",
          owner,
          id,
        });
        const budget = await call("/api/budget");
        if (scenario === "budget") {
          assert.equal(stages.generation.state, "complete");
          assert.equal(stages.review.state, "rejected");
          assert.equal(stages.review.result.status, "budget-exhausted");
          assert.equal(budget.spentMilliYen, 150);
        } else if (scenario === "revoked") {
          assert.equal(stages.generation.state, "rejected");
          assert.equal(stages.generation.result.status, "account-forbidden");
          assert.equal(stages.review, null);
          assert.equal(budget.spentMilliYen, 0);
          assert.equal((await call("/__topic-calls", { owner })).calls, 0);
        } else {
          assert.equal(stages.generation.state, "rejected");
          assert.equal(stages.generation.result.status, "id-conflict");
          assert.equal(stages.review, null);
          assert.equal(budget.spentMilliYen, 150);
          assert.deepEqual(
            await call("/api/topic-textbooks/operations", oldInput, csrf),
            oldResult,
          );
        }
        await call("/__creations", {
          action: "remove",
          owner,
          id,
          confirm: true,
        });
        assert.equal(
          (await call("/__creations", { action: "read", owner, id })).creation,
          null,
        );
        assert.deepEqual(await call("/api/budget"), budget);
        assert.equal(outbound, 0);
        return;
      }
      assert.equal(ready.state, "ready", JSON.stringify(ready));
      const book = await parseSharedTextbook(ready.book);
      assert.equal(book.id, `${saved.bookID}:1`);
      assert.notEqual(book.record.generator.id, book.record.reviewer.id);
      assert.equal((await call("/__topic-calls", { owner })).calls, 2);
      const budget = await call("/api/budget");
      assert.deepEqual(
        await call("/__creations", {
          action: "approve",
          owner,
          id,
          approval,
          quotes: [],
        }),
        ready,
      );
      await mf.dispose();
      mf = new Miniflare(convertV4MiniflareOptions(options));
      assert.deepEqual(
        (await call("/__creations", { action: "read", owner, id })).creation,
        ready,
      );
      assert.deepEqual(await call("/api/budget"), budget);
      assert.equal((await call("/__topic-calls", { owner })).calls, 2);
      assert.equal(outbound, 0);
    },
  );
