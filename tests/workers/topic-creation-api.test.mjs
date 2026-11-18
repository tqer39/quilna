import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode, hash } from "../../workers/crypto.mjs";
import { parseSharedTextbook } from "../../src/shared-textbook-format.ts";
const script = (
  await build({
    entryPoints: ["tests/workers/topic-creation-api-entry.mjs"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    external: ["cloudflare:workers"],
    logLevel: "silent",
  })
).outputFiles[0].text;
const origin = "http://creation.test",
  url = "https://publisher.example.org/model",
  policy = "11111111-1111-4111-8111-111111111111";
for (const scenario of [
  "ready",
  "updated",
  "retry-review",
  "revoked",
  "after-count",
  "review-after-count",
  "negative-review",
])
  test(
    `認証付き作成APIから実D1/SQLite/alarmで資料→生成→検証→版保存をつなぐ: ${scenario}`,
    { timeout: 30000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "quilna-creation-api-")),
        owner = await hash("better-auth:creation-fixture-user");
      let originCalls = 0,
        sourceRevision = 1;
      const options = {
        modules: true,
        script,
        compatibilityDate: "2026-10-11",
        resourcePersistencePath: directory,
        d1Databases: {
          AUTH_DB: "creation-auth",
          DOCUMENT_ACCESS_DB: "creation-documents",
        },
        durableObjects: {
          ACCOUNTS: { className: "AccountVault", useSQLite: true },
          DOCUMENTS: { className: "SourceDocument", useSQLite: true },
          TOPIC_TEXTBOOK_CREATIONS: { className: "Creations", useSQLite: true },
        },
        ratelimits: {
          PUBLIC_DOCUMENT_RATE_LIMITER: {
            namespace_id: "9001",
            simple: { limit: 1000, period: 60 },
          },
        },
        bindings: {
          APP_ORIGIN: origin,
          GOOGLE_ALLOWED_EMAIL: "creation@example.test",
          DOCUMENTS_ENABLED: "true",
          PUBLIC_DOCUMENTS_ENABLED: "true",
          TOPIC_TEXTBOOK_CREATIONS_ENABLED: "true",
          TEST_INSTANCE_ID: "before-restart",
          FIXTURE_REVOKE_REVIEW_COUNT:
            scenario === "review-after-count" ? "true" : "false",
          FIXTURE_NEGATIVE_REVIEW:
            scenario === "negative-review" ? "true" : "false",
          FIXTURE_BLOCK_REVIEW: scenario === "retry-review" ? "true" : "false",
          FIXTURE_REVOKE_AFTER_COUNT:
            scenario === "after-count" ? "true" : "false",
          BYOK_ENCRYPTION_KEYRING: JSON.stringify({
            active: "fixture",
            keys: {
              fixture: encode(crypto.getRandomValues(new Uint8Array(32))),
            },
          }),
        },
        outboundService: async (request) => {
          assert.equal(request.url, url);
          assert.equal(request.headers.get("Authorization"), null);
          assert.equal(request.headers.get("Cookie"), null);
          originCalls++;
          return new Response(
            `<article><h1>モデルと保存</h1><p>${"モデルは文章を出力します。保存の成功は保存処理の結果で確認します。".repeat(20)}</p><p>原文の版${sourceRevision}</p></article>`,
            {
              headers: {
                "Content-Type": "text/html",
                ETag: `"${sourceRevision}"`,
              },
            },
          );
        },
      };
      let mf = new Miniflare(convertV4MiniflareOptions(options));
      t.after(async () => {
        await mf.dispose();
        await rm(directory, { recursive: true, force: true });
      });
      const auth = await mf.getD1Database("AUTH_DB");
      await auth.exec(
        (
          await readFile("migrations/auth/0001_better_auth.sql", "utf8")
        ).replaceAll("\n", " "),
      );
      await auth
        .prepare(
          'INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,?,?,?)',
        )
        .bind(
          "creation-fixture-user",
          "Fixture",
          "creation@example.test",
          1,
          0,
          0,
        )
        .run();
      const database = await mf.getD1Database("DOCUMENT_ACCESS_DB");
      for (const name of [
        "0001_access.sql",
        "0002_source_aliases.sql",
        "0003_policy_management.sql",
        "0004_policy_history.sql",
        "0005_publications.sql",
        "0006_publication_management.sql",
      ])
        await database.exec(
          (await readFile("migrations/documents/" + name, "utf8"))
            .replace(/^--.*$/gm, "")
            .replaceAll("\n", " "),
        );
      await database
        .prepare(
          "INSERT INTO document_policies(id,source_url,revision,enabled,expires,evidence) VALUES(?,?,1,1,?,?)",
        )
        .bind(
          policy,
          url,
          Date.now() + 3600000,
          "Synthetic source permits fixture reuse",
        )
        .run();
      await database
        .prepare(
          "INSERT INTO document_members(policy_id,owner_hash) VALUES(?,?)",
        )
        .bind(policy, owner)
        .run();
      await database
        .prepare(
          "INSERT INTO document_publications(policy_id,policy_revision,enabled,expires,evidence) VALUES(?,1,1,?,?)",
        )
        .bind(policy, Date.now() + 3600000, "Synthetic public rights")
        .run();
      let csrf;
      const request = async (path, body, extra = {}) =>
        mf.dispatchFetch(origin + path, {
          method: body ? "POST" : "GET",
          headers: {
            Origin: origin,
            "X-Test-Principal": "owner",
            "X-Library-Account": owner,
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(csrf ? { "X-CSRF-Token": csrf } : {}),
            ...extra,
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      const call = async (path, body) => {
        const response = await request(path, body);
        const value = await response.json();
        assert.equal(response.status, 200, JSON.stringify(value));
        return value;
      };
      csrf = (await call("/api/session")).csrfToken;
      await call("/api/credentials/openai", {
        requestId: crypto.randomUUID(),
        expectedRevision: 0,
        key: "DUMMY-CREATION-API",
        model: "gpt-6-luna",
      });
      await call("/api/documents/acquire", { url, audience: "shared" });
      const prepared = await call("/api/topic-textbooks/preparations", {
        topic: "モデル",
      });
      assert.equal(prepared.sources.length, 1);
      const id = crypto.randomUUID(),
        raw = JSON.stringify({
          schemaVersion: 2,
          id,
          topic: { id: crypto.randomUUID(), name: "モデルと保存" },
          learningGoal: "文章と実行結果を区別する",
          sources: [prepared.sources[0].source],
        });
      const missing = JSON.parse(raw);
      missing.sources[0].id = crypto.randomUUID();
      const absent = await request("/api/topic-textbooks/creations/save", {
        requestRaw: JSON.stringify(missing),
      });
      assert.equal(absent.status, 409);
      assert.equal((await absent.json()).status, "document-unavailable");
      if (scenario === "ready") {
        const privateCopy = await call("/api/documents/acquire", {
          url,
          audience: "private",
        });
        const foreign = JSON.parse(raw);
        foreign.sources[0].id = privateCopy.version.id;
        const refused = await request("/api/topic-textbooks/creations/save", {
          requestRaw: JSON.stringify(foreign),
        });
        assert.equal(refused.status, 409);
        assert.equal((await refused.json()).status, "document-unavailable");
      }
      assert.equal(
        (
          await request(
            "/api/topic-textbooks/creations/save",
            { requestRaw: raw },
            { "X-CSRF-Token": "invalid" },
          )
        ).status,
        403,
      );
      const saved = await call("/api/topic-textbooks/creations/save", {
        requestRaw: raw,
      });
      assert.equal(saved.creation.state, "draft");
      assert.equal((await call("/__creation-stats", { owner })).responses, 0);
      const capability = await call("/api/topic-textbooks/status");
      assert.deepEqual(capability.creations, {
        available: true,
        enabled: true,
      });
      const approval = {
        id,
        expectedRevision: saved.creation.revision,
        confirm: true,
        approvedPublicText: true,
        generation: capability.quotes.find(
          (q) => q.purpose === "book-addition",
        ),
        review: capability.quotes.find((q) => q.purpose === "evidence-check"),
      };
      assert.equal(
        (
          await request("/api/topic-textbooks/creations/approve", {
            ...approval,
            expectedRevision: "0".repeat(64),
          })
        ).status,
        409,
      );
      const wrong = await request("/__creation-target", {
        target: owner,
        data: { action: "read", id, owner: "b".repeat(64) },
      });
      assert.equal(wrong.status, 403);
      await call("/api/topic-textbooks/creations/approve", approval);
      if (scenario === "updated") {
        sourceRevision = 2;
        await call("/api/documents/acquire", {
          url,
          audience: "shared",
          force: true,
        });
      }
      if (scenario === "revoked")
        await database
          .prepare("UPDATE document_publications SET enabled=0")
          .run();
      await mf.dispose();
      options.bindings.TEST_INSTANCE_ID = "after-restart";
      mf = new Miniflare(convertV4MiniflareOptions(options));
      const wait = async (states) => {
        const deadline = Date.now() + 15000;
        let value;
        while (Date.now() < deadline) {
          value = (await call("/api/topic-textbooks/creations/read", { id }))
            .creation;
          if (states.includes(value.state)) return value;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.fail(JSON.stringify(value));
      };
      let creation = await wait(["ready", "held", "rejected"]);
      if (scenario === "revoked" || scenario === "after-count") {
        const stats = await call("/__creation-stats", { owner });
        assert.equal(stats.responses, 0);
        assert.equal(stats.counts, scenario === "after-count" ? 1 : 0);
        assert.equal((await call("/api/budget")).spentMilliYen, 0);
        assert.equal(
          creation.state,
          scenario === "revoked" ? "held" : "rejected",
        );
        assert.equal(creation.book, null);
        if (scenario === "revoked") {
          await call("/api/topic-textbooks/creations/refresh", { id });
          assert.equal(
            (
              await request("/api/topic-textbooks/creations/remove", {
                id,
                confirm: true,
              })
            ).status,
            409,
          );
          await call("/api/topic-textbooks/creations/remove", {
            id,
            confirm: true,
            discardGeneratedResult: true,
          });
          assert.equal(
            (await call("/api/topic-textbooks/creations/read", { id }))
              .creation,
            null,
          );
        } else {
          const d = await mf.getD1Database("DOCUMENT_ACCESS_DB");
          await d.prepare("UPDATE document_publications SET enabled=1").run();
          const blocked = await request(
            "/api/topic-textbooks/creations/retry",
            {
              id,
              expectedRevision: creation.revision,
              quote: approval.generation,
              confirm: true,
              approvedPublicText: true,
            },
          );
          assert.equal(blocked.status, 409);
          assert.equal(
            (await blocked.json()).status,
            "topic-job-retry-unavailable",
          );
        }
        return;
      }
      if (scenario === "retry-review") {
        assert.equal(creation.state, "held");
        assert.equal(creation.stage, "review");
        const before = await call("/__creation-stages", { owner, id });
        assert.equal(before.generation.state, "complete");
        assert.equal(before.review.result.status, "materials-unavailable");
        assert.equal((await call("/__creation-stats", { owner })).responses, 1);
        await mf.dispose();
        options.bindings.FIXTURE_BLOCK_REVIEW = "false";
        mf = new Miniflare(convertV4MiniflareOptions(options));
        await call("/api/topic-textbooks/creations/retry", {
          id,
          expectedRevision: creation.revision,
          quote: approval.review,
          confirm: true,
          approvedPublicText: true,
        });
        creation = await wait(["ready", "held", "rejected"]);
        assert.equal(
          (await call("/__creation-stages", { owner, id })).generation.result
            .draft.invocation.id,
          before.generation.result.draft.invocation.id,
        );
      }
      if (["review-after-count", "negative-review"].includes(scenario)) {
        assert.equal(creation.state, "rejected");
        assert.equal(creation.stage, "review");
        const previous = await call("/__creation-stages", { owner, id });
        if (scenario === "review-after-count") {
          await (
            await mf.getD1Database("DOCUMENT_ACCESS_DB")
          )
            .prepare("UPDATE document_publications SET enabled=1")
            .run();
          await mf.dispose();
          options.bindings.FIXTURE_REVOKE_REVIEW_COUNT = "false";
          mf = new Miniflare(convertV4MiniflareOptions(options));
        }
        const extraReview = {
          id,
          expectedRevision: creation.revision,
          reviewRequestId: crypto.randomUUID(),
          quote: approval.review,
          confirm: true,
          approvedPublicText: true,
        };
        await call("/api/topic-textbooks/creations/review-again", extraReview);
        creation = await wait(["ready", "held", "rejected"]);
        assert.deepEqual(
          (
            await call(
              "/api/topic-textbooks/creations/review-again",
              extraReview,
            )
          ).creation,
          creation,
        );
        assert.equal(
          (await call("/__creation-stages", { owner, id })).generation.result
            .draft.invocation.id,
          previous.generation.result.draft.invocation.id,
        );
      }
      assert.equal(creation.state, "ready", JSON.stringify(creation));
      const book = await parseSharedTextbook(creation.book);
      assert.equal(book.request.sources[0].id, prepared.sources[0].source.id);
      assert.equal(
        (await call("/__creation-stats", { owner })).responses,
        scenario === "negative-review" ? 3 : 2,
      );
      assert.equal(
        (await call("/__creation-stats", { owner })).counts,
        ["review-after-count", "negative-review"].includes(scenario) ? 3 : 2,
      );
      const stages = await call("/__creation-stages", { owner, id });
      assert.equal(stages.instance, "after-restart");
      const budget = await call("/api/budget");
      assert.equal(
        budget.spentMilliYen,
        scenario === "negative-review" ? 450 : 300,
      );
      if (scenario === "ready")
        await (
          await mf.getD1Database("DOCUMENT_ACCESS_DB")
        )
          .prepare("UPDATE document_publications SET enabled=0")
          .run();
      assert.deepEqual(
        (await call("/api/topic-textbooks/creations/approve", approval))
          .creation,
        creation,
      );
      assert.equal(
        originCalls,
        ["updated", "ready"].includes(scenario) ? 2 : 1,
      );
      await mf.dispose();
      options.bindings.TOPIC_TEXTBOOK_CREATIONS_ENABLED = "false";
      mf = new Miniflare(convertV4MiniflareOptions(options));
      assert.deepEqual(
        (await call("/api/topic-textbooks/creations/read", { id })).creation,
        creation,
      );
      assert.deepEqual(await call("/api/budget"), budget);
      await call("/api/topic-textbooks/creations/remove", {
        id,
        confirm: true,
      });
      assert.equal(
        (await call("/api/topic-textbooks/creations/read", { id })).creation,
        null,
      );
      assert.deepEqual(await call("/api/budget"), budget);
    },
  );
