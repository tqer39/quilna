// Offline browser fixture only; never imported by a production entry/configuration.
import { createAuthBridge } from "../../workers/better-auth.mjs";
import { loginPage } from "../../workers/login-page.mjs";
export { AccountVault, SourceDocument } from "../../workers/index.mjs";
export default {
  async fetch(request, env) {
    const bridge = createAuthBridge(env, {
      allowedEmails: ["a@example.test", "b@example.test"],
    });
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/") && !(await bridge.principal(request)))
      return path === "/"
        ? loginPage(true, request)
        : new Response("", { status: 401 });
    return bridge.fetch(request);
  },
};
