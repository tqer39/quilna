// 合成ユーザー専用。公開アプリからこの経路や設定を読み込まない。
import {
  AccountVault as FixtureVault,
  default as fixture,
} from "./fixture-entry.mjs";
export { TopicTextbookJobs } from "../../workers/topic-job-object.mjs";
export class AccountVault extends FixtureVault {
  constructor(ctx, env) {
    super(ctx, env);
    const original = this.core.proposeTopic.bind(this.core);
    this.core.proposeTopic = async (...args) => {
      await ctx.storage.put(
        "fixture:topic-calls",
        ((await ctx.storage.get("fixture:topic-calls")) ?? 0) + 1,
      );
      await ctx.storage.put("fixture:run-instance", env.TEST_INSTANCE_ID);
      return original(...args);
    };
    this.fixtureStorage = ctx.storage;
  }
  async fetch(request) {
    if (request.url === "https://account.internal/__topic-calls")
      return Response.json({
        calls: (await this.fixtureStorage.get("fixture:topic-calls")) ?? 0,
        instance: await this.fixtureStorage.get("fixture:run-instance"),
      });
    return super.fetch(request);
  }
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (
      [
        "/__jobs",
        "/__topic-calls",
        "/__account-command",
        "/__jobs-target",
      ].includes(path)
    ) {
      const command = await request.json();
      const namespace = ["/__jobs", "/__jobs-target"].includes(path)
        ? env.TOPIC_TEXTBOOK_JOBS
        : env.ACCOUNTS;
      return namespace
        .get(namespace.idFromName(command.target ?? command.owner))
        .fetch(
          new Request(
            path === "/__account-command"
              ? command.url
              : ["/__jobs", "/__jobs-target"].includes(path)
                ? "https://topic-jobs.internal/command"
                : "https://account.internal/__topic-calls",
            {
              method: command.method ?? "POST",
              headers: { "Content-Type": "application/json" },
              body:
                command.method === "GET"
                  ? undefined
                  : JSON.stringify(command.data ?? command),
            },
          ),
        );
    }
    return fixture.fetch(request, env);
  },
};
