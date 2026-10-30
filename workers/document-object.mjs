import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { DocumentCatalog } from "./document-catalog.mjs";
import { createArticleLoader } from "./article-loader.mjs";
import {
  documentAccess,
  documentRequest,
  documentError,
} from "./document-access.mjs";
import { documentIdentity } from "../src/source-document.ts";
import { json, readBody } from "./http.mjs";

const commandSchema = z
  .object({
    owner: z.string().regex(/^[a-f0-9]{64}$/),
    scope: z.string().min(1).max(200),
    request: documentRequest,
  })
  .strict();

export class SourceDocument extends DurableObject {
  async fetch(request) {
    try {
      if (this.env.DOCUMENTS_ENABLED !== "true" || !this.env.DOCUMENTS)
        throw Error("document-unconfigured");
      if (
        request.method !== "POST" ||
        request.url !== "https://document.internal/command"
      )
        throw Error("document-unavailable");
      const {
        owner,
        scope,
        request: input,
      } = commandSchema.parse(await readBody(request));
      const authorize = async (principal) => {
        if (principal !== owner) return false;
        const access = await documentAccess(
          this.env,
          owner,
          input.url,
          input.audience,
        );
        return access.scope === scope && access.url === input.url;
      };
      if (!(await authorize(owner))) throw Error("document-unavailable");
      const id = await documentIdentity(scope, input.url);
      if (
        this.ctx.id.toString() !== this.env.DOCUMENTS.idFromName(id).toString()
      )
        throw Error("document-unavailable");
      const catalog = new DocumentCatalog(this.ctx.storage, {
        scope,
        sourceURL: input.url,
        authorize,
        load: createArticleLoader({
          blockedHosts: this.env.APP_ORIGIN
            ? [new URL(this.env.APP_ORIGIN).hostname]
            : [],
          send: (target, options) => {
            // Sharing permission names one exact source, not arbitrary redirect
            // destinations. Alias approval is a separate, unimplemented policy.
            if (input.audience === "shared" && target !== input.url)
              throw Error("document-unavailable");
            return fetch(target, options);
          },
        }),
      });
      const value =
        input.action === "read"
          ? await catalog.read(owner, input.versionId)
          : input.action === "history"
            ? await catalog.history(owner, input.after)
            : await catalog.acquire(owner, { force: input.force ?? false });
      if (!(await authorize(owner))) throw Error("document-unavailable");
      return json(value.status === "pending" ? 202 : 200, value);
    } catch (error) {
      const failure = documentError(error);
      return json(failure.code, { status: failure.status });
    }
  }
}
