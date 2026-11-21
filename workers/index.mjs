import { DurableObject } from "cloudflare:workers";
import { AccountVaultCore } from "./vault.mjs";
import { handleAccount, readBody, json } from "./http.mjs";
import { productionFetch } from "./better-auth.mjs";
import { FeedCollector } from "./feed-collector.mjs";
import { DocumentGateway } from "./document-gateway.mjs";
import { topicGenerationInputSchema } from "../src/topic-generation-protocol.ts";
import { topicJobAccess } from "./topic-job-access.mjs";
import { prepareTopicEvidence } from "./topic-preparation.mjs";
import {
  verifyTopicMaterials,
  authorizeTopicMaterials,
} from "./topic-materials.mjs";
export { TopicTextbookCreations } from "./topic-creation-object.mjs";
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
    this.canDispatchTopic = (owner) => topicJobAccess(owner, env);
    this.topicJobs = {
      binding: env.TOPIC_TEXTBOOK_JOBS,
      enabled: this.topicJobsEnabled,
    };
    this.topicCreationsEnabled =
      env.TOPIC_TEXTBOOK_CREATIONS_ENABLED === "true";
    this.verifyCreationMaterials = async (owner, raw) => {
      if (!(await this.canDispatchTopic(owner)))
        throw Error("topic-author-forbidden");
      return verifyTopicMaterials(raw, env);
    };
    this.canDispatchCreation = async (owner, verifyMaterials) => {
      try {
        if (!(await this.canDispatchTopic(owner))) return false;
        await verifyMaterials();
        return true;
      } catch {
        return false;
      }
    };
    this.topicCreations = {
      canAuthor: this.canDispatchTopic,
      binding: env.TOPIC_TEXTBOOK_CREATIONS,
      enabled: this.topicCreationsEnabled,
      verifyMaterials: this.verifyCreationMaterials,
    };
  }
  async fetch(request) {
    const creation =
      new URL(request.url).pathname === "/command/creation-topic";
    if (creation || new URL(request.url).pathname === "/command/queued-topic") {
      if (
        request.method !== "POST" ||
        request.url !==
          (creation
            ? "https://account.internal/command/creation-topic"
            : "https://account.internal/command/queued-topic")
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
        if (
          !(creation ? this.topicCreationsEnabled : this.topicJobsEnabled) &&
          !command.lookup
        )
          return creation
            ? json(200, { status: "unconnected", account: command.owner })
            : json(404, { status: "not-found" });
        const input = topicGenerationInputSchema.parse(command.input);
        if (
          input.approvedMaxMilliYen === undefined ||
          !input.approvedQuoteDigest
        )
          throw Error("cost-unapproved");
        if (!command.lookup && !(await this.canDispatchTopic(command.owner)))
          return json(creation ? 200 : 403, {
            status: creation ? "account-forbidden" : "topic-job-forbidden",
            account: command.owner,
          });
        let verifyMaterials;
        if (creation && !command.lookup) {
          try {
            verifyMaterials = await authorizeTopicMaterials(
              input.requestRaw,
              this.env,
            );
            await verifyMaterials();
          } catch {
            return json(200, {
              status: "materials-unavailable",
              account: command.owner,
            });
          }
        }
        const result = await (command.lookup
          ? this.core.lookupTopic(command.owner, input)
          : this.core.proposeTopic(command.owner, input, {
              authorize: () =>
                creation
                  ? this.canDispatchCreation(command.owner, verifyMaterials)
                  : this.canDispatchTopic(command.owner),
            }));
        return json(200, { ...result, account: command.owner });
      } catch {
        return json(503, { status: "topic-job-unavailable" });
      }
    }
    return handleAccount(
      this.core,
      request,
      this.collector,
      this.documents,
      this.topicJobs,
      (owner, input) => prepareTopicEvidence(owner, input, this.env),
      this.topicCreations,
    );
  }
  async alarm() {
    await this.collector.alarm();
  }
}
// No test identity/provider may be supplied by env/header. Input remains disabled.
export default { fetch: productionFetch };
