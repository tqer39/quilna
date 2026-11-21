import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { TopicCreationCoordinator } from "./topic-creation-coordinator.mjs";
import { topicCreationCommandSchema } from "./topic-creation-commands.mjs";
import { json, readBody } from "./http.mjs";

/** 作成専用の保存領域。汎用ジョブ操作は公開せず、認証済みAccountからだけ受け付ける。 */
export class TopicTextbookCreations extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.objectId = ctx.id;
    this.namespace = env.TOPIC_TEXTBOOK_CREATIONS;
    const call = async (owner, input, lookup) => {
      if (!env.ACCOUNTS) throw Error("topic-creations-unconfigured");
      const response = await env.ACCOUNTS.get(
        env.ACCOUNTS.idFromName(owner),
      ).fetch(
        new Request("https://account.internal/command/creation-topic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner, input, lookup }),
        }),
      );
      if (response.status !== 200) {
        await response.body?.cancel();
        throw Error("topic-creation-unconfirmed");
      }
      return readBody(response, 270336);
    };
    this.coordinator = new TopicCreationCoordinator(ctx.storage, {
      enabled: env.TOPIC_TEXTBOOK_CREATIONS_ENABLED === "true",
      run: (owner, input) => call(owner, input, false),
      lookup: (owner, input) => call(owner, input, true),
    });
  }
  async fetch(request) {
    if (
      request.method !== "POST" ||
      request.url !== "https://topic-creations.internal/command"
    )
      return json(404, { status: "not-found" });
    try {
      const c = topicCreationCommandSchema.parse(
        await readBody(request, 400000),
      );
      if (
        !this.namespace ||
        this.objectId.toString() !==
          this.namespace.idFromName(c.owner).toString()
      )
        throw Error("topic-creation-owner");
      if (c.action === "remove") {
        await this.coordinator.remove(
          c.owner,
          c.id,
          c.confirm,
          c.discardGeneratedResult === true,
        );
        return json(200, { removed: true, account: c.owner });
      }
      if (c.action === "list")
        return json(200, {
          ...(await this.coordinator.list(c.owner, c.after)),
          account: c.owner,
        });
      const creation =
        c.action === "save"
          ? await this.coordinator.save(c.owner, c.requestRaw)
          : c.action === "approve"
            ? await this.coordinator.approve(
                c.owner,
                c.id,
                {
                  expectedRevision: c.expectedRevision,
                  confirm: c.confirm,
                  approvedPublicText: c.approvedPublicText,
                  generation: c.generation,
                  review: c.review,
                },
                c.currentQuotes,
              )
            : c.action === "retry"
              ? await this.coordinator.retry(
                  c.owner,
                  c.id,
                  {
                    expectedRevision: c.expectedRevision,
                    confirm: c.confirm,
                    approvedPublicText: c.approvedPublicText,
                    quote: c.quote,
                  },
                  c.currentQuotes,
                )
              : c.action === "review-again"
                ? await this.coordinator.reviewAgain(
                    c.owner,
                    c.id,
                    {
                      expectedRevision: c.expectedRevision,
                      reviewRequestId: c.reviewRequestId,
                      quote: c.quote,
                      confirm: c.confirm,
                      approvedPublicText: c.approvedPublicText,
                    },
                    c.currentQuotes,
                  )
                : c.action === "resume"
                  ? await this.coordinator.resume(c.owner, c.id, c.confirm)
                  : await this.coordinator[c.action](c.owner, c.id);
      return json(200, { creation, account: c.owner });
    } catch (error) {
      const statuses = {
        "topic-creation-owner": 403,
        "topic-creation-conflict": 409,
        "topic-creation-capacity": 429,
        "topic-creation-active": 409,
        "topic-job-active": 409,
        "topic-job-retry-unavailable": 409,
        "topic-job-missing": 404,
        "topic-job-capacity": 429,
        "topic-job-conflict": 409,
        "topic-job-invalid": 503,
        "topic-creation-invalid": 503,
        "topic-creation-missing": 404,
        "topic-creation-cursor": 400,
        "quote-changed": 409,
        "topic-creations-unconfigured": 503,
        "invalid-body": 400,
        "body-limit": 413,
      };
      const status =
        statuses[error.message] ??
        (error instanceof z.ZodError || error instanceof SyntaxError
          ? 400
          : 503);
      return json(status, {
        status: statuses[error.message]
          ? error.message
          : status === 400
            ? "invalid-request"
            : "topic-creation-unavailable",
      });
    }
  }
  async alarm() {
    await this.coordinator.alarm();
  }
}
