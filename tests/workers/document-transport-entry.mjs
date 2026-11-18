// Isolated test principal, never exported by production.
export { AccountVault, SourceDocument } from "../../workers/index.mjs";
import { createHandler } from "../../workers/http.mjs";
import { productionFetch } from "../../workers/better-auth.mjs";
import { publicDocumentPaths } from "../../workers/public-documents.mjs";
const handler = createHandler({
  authenticate: async (request) => {
    const user = request.headers.get("X-Test-Principal");
    return ["alice", "bob"].includes(user)
      ? {
          subject: `document-test:${user}`,
          sessionId: `document-session:${user}`,
        }
      : null;
  },
});
export default {
  fetch(request, env) {
    const testResponse = request.headers.get("X-Test-Withdraw-Public");
    if (["after-read", "additional-fields"].includes(testResponse)) {
      const binding = env.DOCUMENTS;
      env = {
        ...env,
        DOCUMENTS: {
          idFromName: (id) => binding.idFromName(id),
          get: (id) => ({
            fetch: async (command) => {
              const response = await binding.get(id).fetch(command);
              if (
                testResponse === "additional-fields" &&
                response.status === 200
              ) {
                const value = await response.json();
                value.content.privateNote =
                  "Synthetic personal note must never be public";
                value.account = "another-user";
                return Response.json(value);
              }
              await env.DOCUMENT_ACCESS_DB.withSession("first-primary")
                .prepare("UPDATE document_publications SET enabled=0")
                .run();
              return response;
            },
          }),
        },
      };
    }
    // 公開経路は本番の入口でも、本人限定ライブラリの認証と分離する。
    return publicDocumentPaths.has(new URL(request.url).pathname)
      ? productionFetch(request, { ...env, PRIVATE_DEV: "true" })
      : handler(request, env);
  },
};
