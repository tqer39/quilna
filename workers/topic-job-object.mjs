import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { TopicJobQueue } from "./topic-job-queue.mjs";
import { readBody, json } from "./http.mjs";
import { topicJobCommandSchema } from "./topic-job-commands.mjs";

/** 内部binding専用。RSSのalarmと別のオブジェクトへ教材の予約を保持する。 */
export class TopicTextbookJobs extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.objectId = ctx.id;
    this.namespace = env.TOPIC_TEXTBOOK_JOBS;
    const call = async (account, input, lookup) => {
      if (!env.ACCOUNTS) throw Error("topic-jobs-unconfigured");
      const response = await env.ACCOUNTS.get(
        env.ACCOUNTS.idFromName(account),
      ).fetch(
        new Request("https://account.internal/command/queued-topic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner: account, input, lookup }),
        }),
      );
      if (response.status === 403) {
        const refusal = await readBody(response, 8192);
        if (
          refusal.status === "topic-job-forbidden" &&
          refusal.account === account &&
          Object.keys(refusal).length === 2
        )
          return { status: "account-forbidden", account };
        throw Error("topic-job-unconfirmed");
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw Error("topic-job-unconfirmed");
      }
      return response.json();
    };
    this.queue = new TopicJobQueue(ctx.storage, {
      enabled: env.TOPIC_TEXTBOOK_JOBS_ENABLED === "true",
      run: (account, input) => call(account, input, false),
      lookup: (account, input) => call(account, input, true),
    });
  }
  async fetch(request) {
    if (
      request.method !== "POST" ||
      request.url !== "https://topic-jobs.internal/command"
    )
      return json(404, { status: "not-found" });
    try {
      const command = topicJobCommandSchema.parse(
        await readBody(request, 400000),
      );
      if (
        !this.namespace ||
        this.objectId.toString() !==
          this.namespace.idFromName(command.owner).toString()
      )
        throw Error("topic-job-owner");
      if (command.action === "remove") {
        await this.queue.remove(command.owner, command.id);
        return json(200, { removed: true, account: command.owner });
      }
      if (command.action === "list")
        return json(200, {
          ...(await this.queue.list(command.owner, command.after)),
          account: command.owner,
        });
      const job = ["enqueue", "retry"].includes(command.action)
        ? await this.queue[command.action](command.owner, command.input)
        : await this.queue[command.action](command.owner, command.id);
      return json(200, { job, account: command.owner });
    } catch (error) {
      const statuses = {
        "topic-job-owner": 403,
        "topic-job-conflict": 409,
        "topic-job-capacity": 429,
        "topic-job-input-limit": 413,
        "body-limit": 413,
        "invalid-body": 400,
        "cost-unapproved": 400,
        "topic-job-cursor": 400,
        "topic-job-missing": 404,
        "topic-job-active": 409,
        "topic-job-retry-unavailable": 409,
        "topic-jobs-unconfigured": 503,
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
            ? "topic-job-request"
            : "topic-job-unavailable",
      });
    }
  }
  async alarm() {
    await this.queue.alarm();
  }
}
