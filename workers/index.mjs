import { DurableObject } from "cloudflare:workers";
import { AccountVaultCore } from "./vault.mjs";
import { handleAccount } from "./http.mjs";
import { productionFetch } from "./better-auth.mjs";
import { FeedCollector } from "./feed-collector.mjs";
import { DocumentGateway } from "./document-gateway.mjs";
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
  }
  async fetch(request) {
    return handleAccount(this.core, request, this.collector, this.documents);
  }
  async alarm() {
    await this.collector.alarm();
  }
}
// No test identity/provider may be supplied by env/header. Input remains disabled.
export default { fetch: productionFetch };
