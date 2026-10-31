import { hash } from "./crypto.mjs";
import { documentIdentity } from "../src/source-document.ts";
import { sourceURL } from "../src/feed-discovery.ts";
import {
  documentAccess,
  documentRequest,
  documentError,
} from "./document-access.mjs";
import { json } from "./http.mjs";
import { DocumentPolicyAdmin } from "./document-policy-admin.mjs";

export class DocumentGateway {
  constructor(storage, env) {
    Object.assign(this, { storage, env });
  }
  get enabled() {
    return this.env.DOCUMENTS_ENABLED === "true" && !!this.env.DOCUMENTS;
  }
  async reserve(owner, url, audience) {
    const key = "documents:source:" + (await hash([owner, url, audience]));
    await this.storage.transaction(async (tx) => {
      const count = await tx.get("documents:source-count");
      if (
        count !== undefined &&
        (!Number.isInteger(count) || count < 0 || count > 1000)
      )
        throw Error("document-invalid");
      const existing = await tx.get(key);
      if (existing !== undefined) {
        if (existing !== true || !count) throw Error("document-invalid");
        return;
      }
      if ((count ?? 0) >= 1000) throw Error("document-capacity");
      await tx.put(key, true);
      await tx.put("documents:source-count", (count ?? 0) + 1);
    });
  }
  async handle(owner, action, data) {
    if (action.startsWith("admin-"))
      return new DocumentPolicyAdmin(this.env).handle(owner, action, data);
    if (action === "status")
      return json(200, { account: owner, enabled: this.enabled });
    try {
      if (!this.enabled) throw Error("document-unconfigured");
      if (data && Object.hasOwn(data, "action"))
        throw Error("document-request");
      const input = documentRequest.parse({ ...data, action });
      const access = await documentAccess(
        this.env,
        owner,
        input.url,
        input.audience,
      );
      if (action === "acquire")
        await this.reserve(owner, access.url, input.audience);
      const id = await documentIdentity(access.scope, access.url);
      const response = await this.env.DOCUMENTS.get(
        this.env.DOCUMENTS.idFromName(id),
      ).fetch(
        new Request("https://document.internal/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner,
            scope: access.scope,
            request: input,
          }),
        }),
      );
      // Check permission again before delivery, including cache hits/failures.
      // Revocation after this check cannot retract a response already authorized.
      const value = await response.json();
      const current = await documentAccess(
        this.env,
        owner,
        input.url,
        input.audience,
      );
      if (current.scope !== access.scope || current.url !== access.url)
        throw Error("document-unavailable");
      return json(response.status, {
        ...value,
        account: owner,
        ...(access.url !== sourceURL(input.url)
          ? {
              resolution: {
                requestedURL: sourceURL(input.url),
                sourceURL: access.url,
                scope: access.scope,
              },
            }
          : {}),
      });
    } catch (error) {
      const failure = documentError(error);
      return json(failure.code, { status: failure.status, account: owner });
    }
  }
}
