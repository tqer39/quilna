// 合成ユーザー専用。公開アプリからこの経路や設定を読み込まない。
import { AccountVault as FixtureVault } from "./fixture-entry.mjs";
import { createHandler } from "../../workers/http.mjs";
const handler = createHandler({
  credentialsEnabled: true,
  authenticate: async (request) =>
    request.headers.get("X-Test-Principal") === "test-a"
      ? {
          subject: "better-auth:topic-fixture-user",
          sessionId: "topic-fixture-session",
        }
      : null,
});
export { TopicTextbookJobs } from "../../workers/topic-job-object.mjs";
export class AccountVault extends FixtureVault {
  constructor(ctx, env) {
    super(ctx, env);
    const authorize = this.canDispatchTopic;
    this.canDispatchTopic = async (owner) => {
      await ctx.storage.put("fixture:checking-dispatch", true);
      const deadline = Date.now() + 10000;
      while (await ctx.storage.get("fixture:hold-dispatch")) {
        if (Date.now() >= deadline) throw Error("fixture-gate-timeout");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return authorize(owner);
    };
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
    if (request.url === "https://account.internal/__dispatch-gate") {
      const value = await request.json();
      await this.fixtureStorage.put(
        "fixture:hold-dispatch",
        value.hold === true,
      );
      if (value.hold === true)
        await this.fixtureStorage.put("fixture:checking-dispatch", false);
      return Response.json({ held: value.hold === true });
    }
    if (request.url === "https://account.internal/__topic-calls")
      return Response.json({
        calls: (await this.fixtureStorage.get("fixture:topic-calls")) ?? 0,
        instance: await this.fixtureStorage.get("fixture:run-instance"),
        checking:
          (await this.fixtureStorage.get("fixture:checking-dispatch")) === true,
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
        "/__dispatch-gate",
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
            path === "/__dispatch-gate"
              ? "https://account.internal/__dispatch-gate"
              : path === "/__account-command"
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
    return handler(request, env);
  },
};
