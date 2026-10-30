// Isolated test principal, never exported by production.
export { AccountVault, SourceDocument } from "../../workers/index.mjs";
import { createHandler } from "../../workers/http.mjs";
export default {
  fetch: createHandler({
    authenticate: async (request) => {
      const user = request.headers.get("X-Test-Principal");
      return ["alice", "bob"].includes(user)
        ? {
            subject: `document-test:${user}`,
            sessionId: `document-session:${user}`,
          }
        : null;
    },
  }),
};
