import { productionFetch } from "../../workers/better-auth.mjs";
// 合成接続専用。本番の作成DO/資料/予算経路を使い、提供元の送信だけを置き換える。
import { AccountVault as FixtureVault } from "./fixture-entry.mjs";
import { TopicTextbookCreations } from "../../workers/topic-creation-object.mjs";
import { createHandler } from "../../workers/http.mjs";
import { openaiTopicTextbookTransport } from "../../server/openai-topic-textbook-transport.mjs";
import { topicTextbookBudgetAdapter } from "../../server/topic-textbook-contract.mjs";
import { registry } from "../../server/registry.mjs";
import fixture from "../fixtures/shared-textbook-v2.json";
export { SourceDocument } from "../../workers/index.mjs";
const decode = (v) =>
  new TextDecoder().decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0)));
const record = JSON.parse(decode(fixture.record)),
  draft = JSON.parse(decode(record.draft)),
  review = JSON.parse(decode(record.review));
for (const lesson of draft.lessons)
  lesson.optionEvidence = Object.entries(lesson.optionEvidence).map(
    ([optionID, evidence]) => ({ optionID, evidence }),
  );
delete review.requestDigest;
delete review.draftDigest;
function sources(value, id) {
  if (!value || typeof value !== "object") return;
  if (Object.hasOwn(value, "sourceID")) value.sourceID = id;
  for (const item of Object.values(value)) sources(item, id);
}
export class AccountVault extends FixtureVault {
  constructor(ctx, env) {
    const actual = env.PUBLIC_DOCUMENT_RATE_LIMITER;
    super(ctx, {
      ...env,
      PUBLIC_DOCUMENT_RATE_LIMITER: {
        limit: async (request) => {
          if (
            env.FIXTURE_BLOCK_REVIEW === "true" &&
            request.key === "topic-creation-dispatch" &&
            ((await ctx.storage.get("fixture:responses")) ?? 0) >= 1
          )
            return { success: false };
          return actual.limit(request);
        },
      },
    });
    this.core.topicGeneration.makeAdapter = (_provider, secret) =>
      topicTextbookBudgetAdapter(
        openaiTopicTextbookTransport({
          model: registry[0].model,
          reasoningEffort: "none",
          mockOnly: true,
          secret,
          send: async (url, init) => {
            if (url.endsWith("input_tokens")) {
              await ctx.storage.put(
                "fixture:counts",
                ((await ctx.storage.get("fixture:counts")) ?? 0) + 1,
              );
              if (
                env.FIXTURE_REVOKE_AFTER_COUNT === "true" ||
                (env.FIXTURE_REVOKE_REVIEW_COUNT === "true" &&
                  ((await ctx.storage.get("fixture:responses")) ?? 0) >= 1)
              )
                await env.DOCUMENT_ACCESS_DB.prepare(
                  "UPDATE document_publications SET enabled=0",
                ).run();
              if (env.FIXTURE_REVOKE_AUTHOR_AFTER_COUNT === "true")
                await env.AUTH_DB.prepare(
                  'UPDATE "user" SET "emailVerified"=0 WHERE id=?',
                )
                  .bind("creation-fixture-user")
                  .run();
              return Response.json({ input_tokens: 1000 });
            }
            await ctx.storage.put(
              "fixture:responses",
              ((await ctx.storage.get("fixture:responses")) ?? 0) + 1,
            );
            const body = JSON.parse(init.body),
              payload = JSON.parse(body.input[0].content);
            const output = structuredClone(
              body.text.format.name === "topic_textbook" ? draft : review,
            );
            sources(output, payload.request.sources[0].id);
            if (
              body.text.format.name !== "topic_textbook" &&
              env.FIXTURE_NEGATIVE_REVIEW === "true" &&
              !(await ctx.storage.get("fixture:negative-used"))
            ) {
              output.sections[0].checks[0].passed = false;
              await ctx.storage.put("fixture:negative-used", true);
            }
            return Response.json({
              model: registry[0].model,
              service_tier: "default",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [
                    { type: "output_text", text: JSON.stringify(output) },
                  ],
                },
              ],
              usage: {
                input_tokens: 1000,
                output_tokens: 500,
                total_tokens: 1500,
              },
            });
          },
        }),
      );
  }
  async fetch(request) {
    if (request.url === "https://account.internal/fixture/stats")
      return Response.json({
        counts: (await this.ctx.storage.get("fixture:counts")) ?? 0,
        responses: (await this.ctx.storage.get("fixture:responses")) ?? 0,
      });
    return super.fetch(request);
  }
}
export class Creations extends TopicTextbookCreations {
  async alarm() {
    await this.ctx.storage.put("fixture:instance", this.env.TEST_INSTANCE_ID);
    await super.alarm();
  }
  async fetch(request) {
    if (request.url === "https://topic-creations.internal/fixture/stages") {
      const c = await request.json();
      if (
        this.ctx.id.toString() !==
        this.env.TOPIC_TEXTBOOK_CREATIONS.idFromName(c.owner).toString()
      )
        return new Response(null, { status: 403 });
      const r = await this.ctx.storage.get(`topic-creations:record:${c.id}`);
      return Response.json({
        generation: await this.coordinator.queue.read(c.owner, r.id),
        review: await this.coordinator.queue.read(c.owner, r.reviewId),
        instance: await this.ctx.storage.get("fixture:instance"),
      });
    }
    return super.fetch(request);
  }
}
const handler = createHandler({
  credentialsEnabled: true,
  authenticate: async (request) =>
    request.headers.get("X-Test-Principal") === "owner"
      ? {
          subject: "better-auth:creation-fixture-user",
          sessionId: "creation-fixture-session",
        }
      : null,
});
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/" && !request.headers.has("X-Test-Principal"))
      return productionFetch(request, env);
    if (
      path === "/__creation-stats" ||
      path === "/__creation-stages" ||
      path === "/__creation-target"
    ) {
      const command = await request.json(),
        account = path === "/__creation-stats";
      const binding = account ? env.ACCOUNTS : env.TOPIC_TEXTBOOK_CREATIONS;
      return binding
        .get(binding.idFromName(command.target ?? command.owner))
        .fetch(
          new Request(
            account
              ? "https://account.internal/fixture/stats"
              : path === "/__creation-stages"
                ? "https://topic-creations.internal/fixture/stages"
                : "https://topic-creations.internal/command",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(command.data ?? command),
            },
          ),
        );
    }
    return handler(request, env);
  },
};
