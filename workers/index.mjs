import { DurableObject } from "cloudflare:workers";
import { AccountVaultCore } from "./vault.mjs";
import { handleAccount, readBody, json } from "./http.mjs";
import { productionFetch } from "./better-auth.mjs";
import { FeedCollector } from "./feed-collector.mjs";
import { DocumentGateway } from "./document-gateway.mjs";
import { topicGenerationInputSchema } from "../src/topic-generation-protocol.ts";
export { TopicTextbookJobs } from "./topic-job-object.mjs";
export { SourceDocument } from "./document-object.mjs";
export class AccountVault extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new AccountVaultCore(ctx.storage, {
      keyring: env.BYOK_ENCRYPTION_KEYRING,
    });
    this.collector = new FeedCollector(ctx.storage, {
      enabled: env.RSS_COLLECTION_ENABLED === "true",
      blockedHosts: env.APP_ORIGIN ? [new URL(env.APP_ORIGIN).hostname] : [],
    });
    this.documents = new DocumentGateway(ctx.storage, env);
    this.topicJobsEnabled = env.TOPIC_TEXTBOOK_JOBS_ENABLED === "true";
  }
  async fetch(request) {
    if (new URL(request.url).pathname === "/command/queued-topic") {
      if (
        request.method !== "POST" ||
        request.url !== "https://account.internal/command/queued-topic"
      )
        return json(404, { status: "not-found" });
      try {
        const command = await readBody(request, 400000);
        if (
          !command ||
          Object.keys(command).sort().join(",") !== "input,lookup,owner" ||
          typeof command.lookup !== "boolean" ||
          !/^[a-f0-9]{64}$/.test(command.owner) ||
          (await this.core.storage.get("owner")) !== command.owner
        )
          throw Error("topic-job-owner");
        if (!this.topicJobsEnabled && !command.lookup)
          return json(404, { status: "not-found" });
        const input = topicGenerationInputSchema.parse(command.input);
        if (
          input.approvedMaxMilliYen === undefined ||
          !input.approvedQuoteDigest
        )
          throw Error("cost-unapproved");
        const result = await (command.lookup
          ? this.core.lookupTopic(command.owner, input)
          : this.core.proposeTopic(command.owner, input));
        return json(200, { ...result, account: command.owner });
      } catch {
        return json(503, { status: "topic-job-unavailable" });
      }
    }
    return handleAccount(this.core, request, this.collector, this.documents);
  }
  async alarm() {
    await this.collector.alarm();
  }
}
// No test identity/provider may be supplied by env/header. Input remains disabled.
export default { fetch: productionFetch };
