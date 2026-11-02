import { librarySignedOut } from "./library-context";
import { z } from "zod";
const statusSchema = z
  .object({
    available: z.literal(true),
    authenticated: z.boolean(),
    csrfToken: z.string().min(20).max(100),
    realKeyInputEnabled: z.literal(false),
  })
  .strict();
export type AuthStatus = { available: boolean; authenticated: boolean };
export class AuthClient {
  private csrf: string | null = null;
  private epoch = 0;
  constructor(
    private send: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  async status(): Promise<AuthStatus> {
    const epoch = ++this.epoch;
    this.csrf = null;
    try {
      const r = await this.send("/api/auth/status", {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
      const s = r.ok ? statusSchema.safeParse(await r.json()) : null;
      if (epoch !== this.epoch || !s?.success)
        return { available: false, authenticated: false };
      this.csrf = s.data.csrfToken;
      return { available: true, authenticated: s.data.authenticated };
    } catch {
      return { available: false, authenticated: false };
    }
  }
  private async post(path: string) {
    if (!this.csrf) return null;
    const epoch = this.epoch;
    try {
      const r = await this.send(path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": this.csrf,
        },
        body: "{}",
      });
      if (!r.ok) return null;
      const body = (await r.json()) as unknown;
      return epoch === this.epoch ? body : null;
    } catch {
      return null;
    }
  }
  async start() {
    const r = z
      .object({ authorizationUrl: z.string().url() })
      .strict()
      .safeParse(await this.post("/api/auth/start"));
    if (!r.success) return null;
    const u = new URL(r.data.authorizationUrl);
    if (
      u.origin !== "https://accounts.google.com" ||
      u.pathname !== "/o/oauth2/v2/auth" ||
      u.username ||
      u.password
    )
      return null;
    return u.href;
  }
  async cancel() {
    const r = await this.post("/api/auth/cancel");
    this.epoch++;
    return !!r;
  }
  /** End the session before invalidating its local view; failed requests retain data. */
  async logout() {
    const r = await this.post("/api/auth/logout");
    this.epoch++;
    this.csrf = null;
    if (r) librarySignedOut();
    return !!r;
  }
}
