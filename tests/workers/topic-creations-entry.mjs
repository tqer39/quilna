// 合成検証専用。公開Workerに作成受付を追加せず、既存の台帳/権限境界を通す。
import { DurableObject } from "cloudflare:workers";
import jobsFixture, {
  AccountVault as JobsAccountVault,
  TopicTextbookJobs,
} from "./topic-jobs-entry.mjs";
import { TopicCreationCoordinator } from "../../workers/topic-creation-coordinator.mjs";
import { readBody } from "../../workers/http.mjs";
export { TopicTextbookJobs };
export class AccountVault extends JobsAccountVault {
  constructor(ctx, env) {
    super(ctx, env);
    if (env.CREATION_FIXTURE_ALIAS === "true") {
      const original = this.core.topicGeneration.registry.find(
        (m) => m.provider === "openai",
      );
      this.core.topicGeneration.registry = [
        ...this.core.topicGeneration.registry,
        { ...original, id: "alternate-fixture" },
      ];
    }
    if (env.CREATION_FIXTURE_FIXED_MILLI_YEN)
      this.core.topicGeneration.policy = {
        ...this.core.topicGeneration.policy,
        fixedMilliYen: Number(env.CREATION_FIXTURE_FIXED_MILLI_YEN),
      };
  }
}
export class CreationFixture extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.storage = ctx.storage;
    this.instance = env.TEST_INSTANCE_ID;
    const call = async (owner, input, lookup) => {
      const response = await env.ACCOUNTS.get(
        env.ACCOUNTS.idFromName(owner),
      ).fetch(
        new Request("https://account.internal/command/queued-topic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner, input, lookup }),
        }),
      );
      if (response.status === 403) {
        const refusal = await readBody(response, 8192);
        if (
          refusal.status === "topic-job-forbidden" &&
          refusal.account === owner &&
          Object.keys(refusal).length === 2
        )
          return { status: "account-forbidden", account: owner };
      }
      if (response.status !== 200) throw Error("fixture-dispatch-failed");
      return response.json();
    };
    this.coordinator = new TopicCreationCoordinator(ctx.storage, {
      enabled: env.CREATIONS_FIXTURE_ENABLED === "true",
      run: (owner, input) => call(owner, input, false),
      lookup: (owner, input) => call(owner, input, true),
    });
  }
  async fetch(request) {
    const command = await request.json();
    if (command.action === "stages") {
      const r = await this.storage.get(`topic-creations:record:${command.id}`);
      return Response.json({
        generation: await this.coordinator.queue.read(command.owner, r.id),
        review: await this.coordinator.queue.read(command.owner, r.reviewId),
      });
    }
    if (command.action === "remove") {
      await this.coordinator.remove(command.owner, command.id, command.confirm);
      return Response.json({ removed: true });
    }
    if (command.action === "save")
      return Response.json(
        await this.coordinator.save(command.owner, command.requestRaw),
      );
    if (command.action === "approve")
      return Response.json(
        await this.coordinator.approve(
          command.owner,
          command.id,
          command.approval,
          command.quotes,
        ),
      );
    if (command.action === "read")
      return Response.json({
        creation: await this.coordinator.read(command.owner, command.id),
        alarmInstance:
          (await this.storage.get("fixture:alarm-instance")) ?? null,
      });
    return new Response(null, { status: 404 });
  }
  async alarm() {
    await this.storage.put("fixture:alarm-instance", this.instance);
    return this.coordinator.alarm();
  }
}
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/__creations")
      return jobsFixture.fetch(request, env);
    const command = await request.clone().json();
    return env.CREATIONS_FIXTURE.get(
      env.CREATIONS_FIXTURE.idFromName(command.owner),
    ).fetch(request);
  },
};
