import { z } from "zod";
import { hash } from "./crypto.mjs";

const account = z.string().regex(/^[a-f0-9]{64}$/);
const user = z
  .object({ id: z.string().min(1).max(288), emailVerified: z.literal(1) })
  .strict();

/** ブラウザの生存とは独立して、現在許可された確認済みユーザーかを照合する。 */
export async function topicJobAccess(owner, env) {
  const email = z.email().max(254).safeParse(env.GOOGLE_ALLOWED_EMAIL);
  if (
    !account.safeParse(owner).success ||
    !email.success ||
    !env.AUTH_DB?.prepare
  )
    return false;
  try {
    const result = await env.AUTH_DB.prepare(
      'SELECT id, "emailVerified" FROM "user" WHERE lower(email)=? LIMIT 2',
    )
      .bind(email.data.toLowerCase())
      .all();
    if (
      result.success !== true ||
      !Array.isArray(result.results) ||
      result.results.length !== 1
    )
      return false;
    const row = user.safeParse(result.results[0]);
    return row.success && (await hash("better-auth:" + row.data.id)) === owner;
  } catch {
    return false;
  }
}
