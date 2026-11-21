import test from "node:test";
import assert from "node:assert/strict";
import { topicJobAccess } from "../../workers/topic-job-access.mjs";
import { hash } from "../../workers/crypto.mjs";

test("背景送信は現在の許可メールの確認済みユーザーと一致する所有者だけに許可する", async () => {
  const owner = await hash("better-auth:user-a");
  let rows = [{ id: "user-a", emailVerified: 1 }],
    fail = false;
  const env = {
    GOOGLE_ALLOWED_EMAIL: "Reader@Example.test",
    AUTH_DB: {
      prepare(sql) {
        assert.match(sql, /LIMIT 2/);
        return {
          bind(email) {
            assert.equal(email, "reader@example.test");
            return {
              async all() {
                if (fail) throw Error("DB障害");
                return { success: true, results: rows };
              },
            };
          },
        };
      },
    },
  };
  assert.equal(await topicJobAccess(owner, env), true);
  for (const value of [
    [],
    [{ id: "user-b", emailVerified: 1 }],
    [{ id: "user-a", emailVerified: 0 }],
    [{ id: "user-a", emailVerified: true }],
    [
      { id: "user-a", emailVerified: 1 },
      { id: "user-b", emailVerified: 1 },
    ],
  ]) {
    rows = value;
    assert.equal(await topicJobAccess(owner, env), false);
  }
  rows = [{ id: "user-a", emailVerified: 1 }];
  fail = true;
  assert.equal(await topicJobAccess(owner, env), false);
  assert.equal(await topicJobAccess(owner, {}), false);
  assert.equal(await topicJobAccess("unverified-owner", env), false);
});
