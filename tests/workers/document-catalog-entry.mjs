// Isolated runtime fixture only. Production exports no catalog or test identity route.
import { DurableObject } from "cloudflare:workers";
import { DocumentCatalog } from "../../workers/document-catalog.mjs";
const url = "https://publisher.example.org/article";
export class CatalogFixture extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname.split("/"),
      scope = path[1];
    if (!["shared", "private"].includes(scope))
      return new Response(null, { status: 404 });
    const catalog = new DocumentCatalog(this.ctx.storage, {
      scope: scope === "shared" ? "shared:approved-fixture" : "private:alice",
      sourceURL: url,
      authorize: async (principal) =>
        principal === "alice" || (scope === "shared" && principal === "bob"),
      load: async (_url, previous) => {
        const response = await fetch(url, {
          headers: previous?.validators
            ? { "If-None-Match": previous.validators.etag }
            : {},
        });
        if (response.status === 304) return { url, notModified: true };
        if (!response.ok) throw Error("fixture-fetch");
        return {
          content: await response.json(),
          validators: { url, etag: response.headers.get("ETag") },
        };
      },
    });
    const principal = request.headers.get("X-Test-Principal");
    try {
      const result =
        path[2] === "read"
          ? await catalog.read(principal)
          : path[2] === "history"
            ? await catalog.history(principal)
            : await catalog.acquire(principal, {
                force: new URL(request.url).searchParams.has("force"),
              });
      return Response.json(result);
    } catch (error) {
      return Response.json(
        { error: error.message },
        { status: error.message === "document-unavailable" ? 404 : 409 },
      );
    }
  }
}
export default {
  async fetch(request, env) {
    const scope = new URL(request.url).pathname.split("/")[1];
    return env.CATALOG.get(env.CATALOG.idFromName(scope)).fetch(request);
  },
};
