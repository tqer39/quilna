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
import {
  documentLifecycleAccess,
  lifecycleRequest,
} from "./document-lifecycle-access.mjs";

const commandSchema = z
  .object({
    owner: z.string().regex(/^[a-f0-9]{64}$/),
    scope: z.string().min(1).max(200),
    request: documentRequest,
  })
  .strict();

const managementSchema = commandSchema.extend({ request: lifecycleRequest });

export class SourceDocument extends DurableObject {
  /** Execute the stored retention decision only in its exact document object. */
  async alarm() {
    const retained = await this.ctx.storage.get("document:catalog:v1");
    if (retained === undefined) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (!retained || typeof retained !== "object")
      throw Error("document-invalid");
    const { scope, sourceURL } = retained;
    const id = await documentIdentity(scope, sourceURL);
    if (this.ctx.id.toString() !== this.env.DOCUMENTS.idFromName(id).toString())
      throw Error("document-invalid");
    const catalog = new DocumentCatalog(this.ctx.storage, {
      scope,
      sourceURL,
      authorize: async () => false,
      load: async () => {
        throw Error("document-unavailable");
      },
    });
    await catalog.retentionAlarm();
  }
  /** Authenticate an internal management request and bind it to the actual object ID. */
  async lifecycle(request) {
    const {
      owner,
      scope,
      request: input,
    } = managementSchema.parse(await readBody(request));
    if (input.action === "reconcile") throw Error("document-request");
    const options = { restore: input.command?.action === "restore" };
    const initial = await documentLifecycleAccess(
      this.env,
      owner,
      input.target,
      options,
    );
    if (initial.scope !== scope) throw Error("document-unavailable");
    const sourceURL = initial.url;
    const authorizeManagement = async (principal) => {
      if (principal !== owner) return false;
      const access = await documentLifecycleAccess(
        this.env,
        owner,
        input.target,
        options,
      );
      return access.scope === scope && access.url === sourceURL;
    };
    const id = await documentIdentity(scope, sourceURL);
    if (this.ctx.id.toString() !== this.env.DOCUMENTS.idFromName(id).toString())
      throw Error("document-unavailable");
    const catalog = new DocumentCatalog(this.ctx.storage, {
      scope,
      sourceURL,
      authorizeManagement,
      authorize: async () => false,
      load: async () => {
        throw Error("document-unavailable");
      },
    });
    const value =
      input.action === "preview"
        ? await catalog.lifecyclePreview(owner)
        : await catalog.manageLifecycle(owner, input.command);
    if (!(await authorizeManagement(owner)))
      throw Error("document-unavailable");
    return json(200, value);
  }
  async fetch(request) {
    try {
      if (this.env.DOCUMENTS_ENABLED !== "true" || !this.env.DOCUMENTS)
        throw Error("document-unconfigured");
      if (
        request.method !== "POST" ||
        ![
          "https://document.internal/command",
          "https://document.internal/lifecycle",
        ].includes(request.url)
      )
        throw Error("document-unavailable");
      if (request.url === "https://document.internal/lifecycle")
        return await this.lifecycle(request);
      const {
        owner,
        scope,
        request: input,
      } = commandSchema.parse(await readBody(request));
      const initial = await documentAccess(
        this.env,
        owner,
        input.url,
        input.audience,
      );
      if (initial.scope !== scope) throw Error("document-unavailable");
      const sourceURL = initial.url;
      const authorize = async (principal) => {
        if (principal !== owner) return false;
        const access = await documentAccess(
          this.env,
          owner,
          input.url,
          input.audience,
        );
        return access.scope === scope && access.url === sourceURL;
      };
      if (!(await authorize(owner))) throw Error("document-unavailable");
      const id = await documentIdentity(scope, sourceURL);
      if (
        this.ctx.id.toString() !== this.env.DOCUMENTS.idFromName(id).toString()
      )
        throw Error("document-unavailable");
      const catalog = new DocumentCatalog(this.ctx.storage, {
        scope,
        sourceURL,
        authorize,
        load: createArticleLoader({
          blockedHosts: this.env.APP_ORIGIN
            ? [new URL(this.env.APP_ORIGIN).hostname]
            : [],
          send: (target, options) => {
            // Approved aliases resolve before acquisition. Fetch only the exact
            // policy source; a redirect is not another alias grant.
            if (input.audience === "shared" && target !== sourceURL)
              throw Error("document-unavailable");
            return fetch(target, options);
          },
        }),
      });
      let value;
      try {
        value =
          input.action === "read"
            ? await catalog.read(owner, input.versionId)
            : input.action === "history"
              ? await catalog.history(owner, input.after)
              : await catalog.acquire(owner, { force: input.force ?? false });
      } catch (error) {
        if (
          input.action === "acquire" &&
          error.message === "document-unavailable"
        ) {
          const deletion = await catalog.permanentDeletion(owner);
          if (deletion)
            return json(404, { status: "document-unavailable", deletion });
        }
        throw error;
      }
      if (!(await authorize(owner))) throw Error("document-unavailable");
      return json(value.status === "pending" ? 202 : 200, value);
    } catch (error) {
      const failure = documentError(error);
      return json(failure.code, { status: failure.status });
    }
  }
}
