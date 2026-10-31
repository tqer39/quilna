// Test-only entry. Uses real Better Auth/Google verification with offline mock endpoints in Miniflare.
import { createAuthBridge } from "../../workers/better-auth.mjs";
export { AccountVault, SourceDocument } from "../../workers/index.mjs";
export default {
  fetch(request, env) {
    return createAuthBridge(env, {
      credentialsEnabled: true,
      allowedEmails: ["a@example.test", "b@example.test"],
    }).fetch(request);
  },
};
