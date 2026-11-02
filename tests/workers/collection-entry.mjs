// Isolated local fixture; production has no test identity route or header.
export { AccountVault } from "../../workers/index.mjs";
import { createHandler } from "../../workers/http.mjs";
export default {
  fetch: createHandler({
    authenticate: async (request) => {
      const user = request.headers.get("X-Test-Principal");
      return ["test-a", "test-b"].includes(user)
        ? { subject: `collection-test:${user}`, sessionId: `session:${user}` }
        : null;
    },
  }),
};
