import test from "node:test";
import assert from "node:assert/strict";
import { creationRuntime, url } from "../fixtures/topic-creation-runtime.mjs";
import { parseSharedTextbook } from "../../src/shared-textbook-format.ts";
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
      const fixture = await creationRuntime((fn) => t.after(fn), { scenario });
      const { owner, database, call, request } = fixture;
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
        canAuthor: true,
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
        fixture.updateSource();
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
      await fixture.restart({ TEST_INSTANCE_ID: "after-restart" });
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
          const d = await fixture.runtime.getD1Database("DOCUMENT_ACCESS_DB");
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
        await fixture.restart({ FIXTURE_BLOCK_REVIEW: "false" });
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
            await fixture.runtime.getD1Database("DOCUMENT_ACCESS_DB")
          )
            .prepare("UPDATE document_publications SET enabled=1")
            .run();
          await fixture.restart({ FIXTURE_REVOKE_REVIEW_COUNT: "false" });
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
          await fixture.runtime.getD1Database("DOCUMENT_ACCESS_DB")
        )
          .prepare("UPDATE document_publications SET enabled=0")
          .run();
      assert.deepEqual(
        (await call("/api/topic-textbooks/creations/approve", approval))
          .creation,
        creation,
      );
      assert.equal(
        fixture.originCalls,
        ["updated", "ready"].includes(scenario) ? 2 : 1,
      );
      await fixture.restart({ TOPIC_TEXTBOOK_CREATIONS_ENABLED: "false" });
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
