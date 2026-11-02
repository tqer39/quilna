export const readerContentSecurityPolicy =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
import { loginPage } from "./login-page.mjs";
import { betterAuth } from "better-auth";
import { verifyProviderIdToken } from "better-auth/oauth2";
import { z } from "zod";
import { createHandler, json, readBody } from "./http.mjs";
import { hash } from "./crypto.mjs";
import {
  AuthGuard,
  randomToken,
  cookieValue,
  browserHeader,
} from "./auth-guard.mjs";
export const sessionFields = {
  appBrowser: { type: "string", required: false, input: false },
  appEpoch: { type: "number", required: false, input: false },
  appAttempt: { type: "string", required: false, input: false },
};
const permitted = (email, allowed) =>
  typeof email === "string" && allowed.includes(email.toLowerCase());
const googleBinding = (allowed) => ({
  id: "google-nonce-binding",
  init(context) {
    return {
      context: {
        socialProviders: context.socialProviders.map((provider) => {
          if (provider.id !== "google") return provider;
          const verifier = {
            ...provider,
            options: { ...provider.options, disableIdTokenSignIn: false },
            idToken: {
              ...provider.idToken,
              algorithms: ["RS256"],
              verifyClaims: (claims) =>
                typeof claims.exp === "number" &&
                typeof claims.sub === "string" &&
                !!claims.sub &&
                claims.email_verified === true &&
                permitted(claims.email, allowed) &&
                (!claims.azp || claims.azp === provider.options.clientId),
            },
          };
          return {
            ...provider,
            requiresIdTokenNonce: true,
            issuer: "https://accounts.google.com",
            createAuthorizationURL: async (params) => {
              if (!params.idTokenNonce) throw Error("nonce-required");
              const url = await provider.createAuthorizationURL(params);
              url.searchParams.set("nonce", params.idTokenNonce);
              return url;
            },
            getUserInfo: async (tokens) => {
              if (
                !tokens.expectedIdTokenNonce ||
                typeof tokens.idToken !== "string" ||
                tokens.idToken.length > 8192 ||
                !(await verifyProviderIdToken(
                  verifier,
                  tokens.idToken,
                  tokens.expectedIdTokenNonce,
                ))
              )
                return null;
              return provider.getUserInfo(tokens);
            },
          };
        }),
      },
    };
  },
});
function stripTokens(data) {
  return {
    data: {
      ...data,
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    },
  };
}
export function authOptions(
  env,
  { attempt = null, allowedEmails = [env.GOOGLE_ALLOWED_EMAIL] } = {},
) {
  const guard = new AuthGuard(env.AUTH_DB);
  return {
    plugins: [googleBinding(allowedEmails)],
    database: env.AUTH_DB,
    secret: env.BETTER_AUTH_SECRET,
    secrets: [{ version: 1, value: env.BETTER_AUTH_SECRET }],
    baseURL: env.APP_ORIGIN,
    basePath: "/api/auth",
    trustedOrigins: [env.APP_ORIGIN],
    logger: { disabled: true },
    telemetry: { enabled: false },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        disableDefaultScope: true,
        scope: ["openid", "email"],
        mapProfileToUser: () => ({ name: "Learner", image: null }),
        disableIdTokenSignIn: true,
        includeGrantedScopes: false,
        accessType: "online",
        prompt: "select_account",
      },
    },
    emailAndPassword: { enabled: false },
    session: {
      expiresIn: 3600,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
      additionalFields: sessionFields,
    },
    account: {
      encryptOAuthTokens: true,
      storeStateStrategy: "cookie",
      skipStateCookieCheck: false,
      storeAccountCookie: false,
      accountLinking: { enabled: false },
    },
    advanced: {
      useSecureCookies: true,
      cookiePrefix: "textbook-auth",
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
      },
      database: { generateId: () => crypto.randomUUID() },
    },
    databaseHooks: {
      account: {
        create: { before: stripTokens },
        update: { before: stripTokens },
      },
      session: {
        create: {
          before: async (data) =>
            (await guard.active(attempt))
              ? {
                  data: {
                    ...data,
                    appBrowser: attempt.browser,
                    appEpoch: attempt.epoch,
                    appAttempt: attempt.state,
                    ipAddress: null,
                    userAgent: null,
                  },
                }
              : false,
        },
      },
    },
    onAPIError: { errorURL: env.APP_ORIGIN + "/?auth=failed", throw: false },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: { "/sign-in/social": { window: 60, max: 20 } },
    },
  };
}
const schema = z
  .object({
    origin: z.string().url(),
    clientId: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,200}\.apps\.googleusercontent\.com$/),
    clientSecret: z.string().min(10).max(500),
    secret: z.string().min(32).max(500),
    allowedEmail: z.email().max(254),
  })
  .strict();
export function productionAuth(env) {
  const c = schema.safeParse({
    origin: env.APP_ORIGIN,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    secret: env.BETTER_AUTH_SECRET,
    allowedEmail: env.GOOGLE_ALLOWED_EMAIL,
  });
  if (!c.success || !env.AUTH_DB?.prepare) return null;
  const u = new URL(c.data.origin);
  if (
    u.protocol !== "https:" ||
    u.origin !== c.data.origin ||
    u.username ||
    u.password
  )
    return null;
  return createAuthBridge(env);
}
function response(status, value, cookies = []) {
  const r = json(status, value);
  for (const c of cookies) r.headers.append("Set-Cookie", c);
  r.headers.set("Referrer-Policy", "no-referrer");
  r.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'",
  );
  return r;
}
function back(status, cookies = []) {
  const r = response(303, {}, cookies);
  r.headers.set("Location", "/?auth=" + status);
  return r;
}
/** Provider overrides exist only as dependency injection in isolated test bundles, never environment selection. */
export function createAuthBridge(
  env,
  {
    credentialsEnabled = false,
    allowedEmails = [env.GOOGLE_ALLOWED_EMAIL],
  } = {},
) {
  allowedEmails = allowedEmails
    .filter((email) => typeof email === "string")
    .map((email) => email.toLowerCase());
  const guard = new AuthGuard(env.AUTH_DB),
    auth = betterAuth(authOptions(env, { allowedEmails }));
  const principal = async (request) => {
    const browser = cookieValue(request);
    if (!browser) return null;
    const session = await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    });
    if (
      !session ||
      session.user.emailVerified !== true ||
      !permitted(session.user.email, allowedEmails) ||
      !(await guard.sessionValid(session.session, await hash(browser)))
    )
      return null;
    return {
      subject: "better-auth:" + session.user.id,
      sessionId: session.session.id,
    };
  };
  const libraryRequest = (request, path, body) =>
    new Request(env.APP_ORIGIN + "/api/auth" + path, {
      method: body ? "POST" : "GET",
      headers: {
        Cookie: request.headers.get("Cookie") ?? "",
        Origin: env.APP_ORIGIN,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  return {
    auth,
    guard,
    principal,
    async fetch(request) {
      const url = new URL(request.url),
        path = url.pathname;
      try {
        if (url.origin !== env.APP_ORIGIN)
          return response(403, { status: "forbidden" });
        if (path === "/api/auth/callback/google") {
          if (
            request.method !== "GET" ||
            url.href.length > 4096 ||
            ["state", "code", "error"].some(
              (k) => url.searchParams.getAll(k).length > 1,
            )
          )
            return back("failed");
          const browser = cookieValue(request),
            state = url.searchParams.get("state");
          if (!browser || !state || state.length > 200) return back("failed");
          const attempt = await guard.claim(state, await hash(browser));
          if (!attempt) return back("failed");
          const scoped = betterAuth(
            authOptions(env, { attempt, allowedEmails }),
          );
          const result = await scoped.handler(request);
          const success =
            result.status >= 300 &&
            result.status < 400 &&
            result.headers.get("Location") ===
              env.APP_ORIGIN + "/?auth=success";
          if (!success || !(await guard.complete(attempt))) {
            await env.AUTH_DB.prepare("DELETE FROM session WHERE appAttempt=?")
              .bind(attempt.state)
              .run();
            return back(url.searchParams.has("error") ? "cancelled" : "failed");
          }
          await env.AUTH_DB.prepare(
            "UPDATE app_auth_browser SET expires=? WHERE id=? AND epoch=?",
          )
            .bind(Date.now() + 3600000, attempt.browser, attempt.epoch)
            .run();
          return back("success", [
            ...result.headers.getSetCookie(),
            browserHeader(browser),
          ]);
        }
        if (!path.startsWith("/api/auth/"))
          return createHandler({ authenticate: principal, credentialsEnabled })(
            request,
            env,
          );
        const origin = request.headers.get("Origin");
        const read =
          request.method === "GET" &&
          origin === null &&
          request.headers.get("Sec-Fetch-Site") === "same-origin";
        if (url.search || (origin !== env.APP_ORIGIN && !read))
          return response(403, { status: "forbidden" });
        // Verify prepared schema before accepting any auth request; no runtime auto-migration.
        await env.AUTH_DB.prepare(
          "SELECT appAttempt FROM session LIMIT 1",
        ).first();
        if (path === "/api/auth/status" && request.method === "GET") {
          let browser = cookieValue(request);
          const fresh = !browser;
          browser ??= randomToken();
          const c = await guard.context(await hash(browser));
          const p = await principal(request);
          return response(
            200,
            {
              available: true,
              authenticated: !!p,
              csrfToken: c.csrf,
              realKeyInputEnabled: false,
            },
            fresh ? [browserHeader(browser)] : [],
          );
        }
        if (
          request.method === "POST" &&
          ["/api/auth/start", "/api/auth/cancel", "/api/auth/logout"].includes(
            path,
          )
        ) {
          const browser = cookieValue(request);
          if (!browser) return response(403, { status: "forbidden" });
          if (
            !z
              .object({})
              .strict()
              .safeParse(await readBody(request)).success
          )
            return response(400, { status: "invalid-body" });
          const id = await hash(browser),
            c = await guard.advance(
              id,
              request.headers.get("X-CSRF-Token"),
              path.endsWith("/start"),
            );
          if (path.endsWith("/start")) {
            const r = await auth.handler(
              libraryRequest(request, "/sign-in/social", {
                provider: "google",
                disableRedirect: true,
                callbackURL: env.APP_ORIGIN + "/?auth=success",
                errorCallbackURL: env.APP_ORIGIN + "/?auth=failed",
              }),
            );
            if (!r.ok) throw Error();
            const data = await r.json(),
              u = new URL(data.url);
            if (
              u.origin !== "https://accounts.google.com" ||
              !u.searchParams.get("state")
            )
              throw Error();
            await guard.issued(u.searchParams.get("state"), id, c.epoch);
            await guard.cleanup();
            return response(
              200,
              { authorizationUrl: u.href },
              r.headers.getSetCookie(),
            );
          }
          const cookies = [];
          if (path.endsWith("/logout")) {
            const r = await auth.handler(
              libraryRequest(request, "/sign-out", {}),
            );
            cookies.push(...r.headers.getSetCookie());
          }
          return response(
            200,
            { status: "signed-out", realKeyInputEnabled: false },
            cookies,
          );
        }
        return response(404, { status: "not-found" });
      } catch {
        return response(503, {
          status: "auth-unavailable",
          realKeyInputEnabled: false,
        });
      }
    },
  };
}
export async function productionFetch(request, env) {
  const path = new URL(request.url).pathname;
  if (env.PRIVATE_DEV === "true" && !path.startsWith("/api/")) {
    const bridge = productionAuth(env);
    let principal = null;
    try {
      principal = bridge ? await bridge.principal(request) : null;
    } catch {
      principal = null;
    }
    if (!principal) {
      if (path === "/" && ["GET", "HEAD"].includes(request.method))
        return loginPage(!!bridge, request);
      return response(401, { status: "authentication-required" });
    }
    const asset = await createHandler()(request, env);
    const headers = new Headers(asset.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Content-Security-Policy", readerContentSecurityPolicy);
    if (
      headers.get("Content-Type")?.includes("text/html") &&
      request.method !== "HEAD" &&
      ![204, 205, 304].includes(asset.status)
    )
      return new Response(
        (await asset.text()).replace(
          "</head>",
          '<meta name="private-dev" content="true"></head>',
        ),
        { status: asset.status, headers },
      );
    return new Response(asset.body, { status: asset.status, headers });
  }
  if (!path.startsWith("/api/")) return createHandler()(request, env);
  const bridge = productionAuth(env);
  if (!bridge) {
    if (new URL(request.url).pathname.startsWith("/api/auth/"))
      return response(503, {
        status: "auth-unconfigured",
        available: false,
        realKeyInputEnabled: false,
      });
    return createHandler()(request, env);
  }
  return bridge.fetch(request);
}
