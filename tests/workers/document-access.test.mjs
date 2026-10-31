import test from "node:test";
import assert from "node:assert/strict";
import { documentAccess } from "../../workers/document-access.mjs";

test("a grant expiring while the primary lookup is pending is denied at completion", async () => {
  let clock = 100;
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    const env = {
      DOCUMENT_ACCESS_DB: {
        withSession(mode) {
          assert.equal(mode, "first-primary");
          return {
            prepare() {
              return {
                bind() {
                  return {
                    async first() {
                      clock = 200;
                      return {
                        id: "77777777-7777-4777-8777-777777777777",
                        revision: 1,
                        expires: 150,
                        evidence: "Test permission",
                      };
                    },
                  };
                },
              };
            },
          };
        },
      },
    };
    await assert.rejects(
      documentAccess(
        env,
        "a".repeat(64),
        "https://publisher.example.org/article",
        "shared",
      ),
      /document-unavailable/,
    );
  } finally {
    Date.now = realNow;
  }
});
