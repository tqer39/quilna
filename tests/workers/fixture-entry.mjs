// Local Miniflare ONLY; never imported by workers/index.mjs or wrangler.jsonc.
import { AccountVault as ProductionVault } from "../../workers/index.mjs";
import { createHandler } from "../../workers/http.mjs";
import { registry } from "../../server/registry.mjs";
import { openaiTopicTextbookTransport } from "../../server/openai-topic-textbook-transport.mjs";
import { topicTextbookBudgetAdapter } from "../../server/topic-textbook-contract.mjs";
import topicFixture from "../fixtures/shared-textbook-v2.json";
const decode = (raw) =>
  new TextDecoder().decode(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)));
const topicRecord = JSON.parse(decode(topicFixture.record));
const topicDraft = JSON.parse(decode(topicRecord.draft));
for (const lesson of topicDraft.lessons) {
  // 旧CAA用の20KB応答・32KB入力上限を越える合成データで配送を検証する。
  lesson.content.paragraphs = Array.from({ length: 6 }, () =>
    "合成データ。".repeat(160),
  );
  lesson.optionEvidence = Object.entries(lesson.optionEvidence).map(
    ([optionID, evidence]) => ({ optionID, evidence }),
  );
}
const topicReview = JSON.parse(decode(topicRecord.review));
delete topicReview.requestDigest;
delete topicReview.draftDigest;
const date = "2026-10-11T00:00:00.000Z";
const source = {
  id: "rfc8659",
  url: "https://www.rfc-editor.org/rfc/rfc8659.html",
  checkedAt: date,
  body: "The first CAA RRset is selected.",
};
export class AccountVault extends ProductionVault {
  constructor(ctx, env) {
    super(ctx, env);
    this.core.now = () => new Date(date);
    this.core.generation = {
      policy: {
        confirmedCostUpperBounds: true,
        checkedAt: date,
        fixedMilliYen: 496850,
        safetyMilliYen: 0,
        yenPerUsdMilli: 200000,
        taxFeePermille: 1200,
        providerCapsMilliYen: {},
      },
      registry: registry.map((m) => ({
        ...m,
        approval: "test-only",
        dataConditionsAccepted: true,
        tokenCountMargin: 256,
        tokenCountTermsConfirmed: true,
      })),
      selectionPolicy: {},
      sources: [source],
      timeoutMs: 20,
      makeAdapter: (_provider, secret) => ({
        generate: async (payload) => {
          if (!secret.startsWith("DUMMY-")) throw Error("dummy-only-fixture");
          if (payload.question === "WAIT-MOCK") await new Promise(() => {});
          return {
            json: JSON.stringify({
              gap: "test",
              block: {
                id: "test-block",
                title: "test",
                kind: "reading",
                markdown: "最初のRRset",
              },
              references: [{ sourceId: "rfc8659", quote: source.body }],
            }),
            usage: { inputTokens: 100, outputTokens: 50 },
          };
        },
      }),
    };
    this.core.topicGeneration = {
      ...this.core.generation,
      timeoutMs: 1000,
      makeAdapter: (_provider, secret) =>
        topicTextbookBudgetAdapter(
          openaiTopicTextbookTransport({
            model: registry[0].model,
            reasoningEffort: "none",
            mockOnly: true,
            secret,
            send: async (url, init) => {
              if (url.endsWith("input_tokens"))
                return Response.json({ input_tokens: 1000 });
              const body = JSON.parse(init.body);
              if (
                JSON.parse(body.input[0].content).request.learningGoal ===
                "WAIT-MOCK"
              )
                return new Promise(() => {});
              return Response.json({
                model: registry[0].model,
                service_tier: "default",
                status: "completed",
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [
                      {
                        type: "output_text",
                        text: JSON.stringify(
                          body.text.format.name === "topic_textbook"
                            ? topicDraft
                            : topicReview,
                        ),
                      },
                    ],
                  },
                ],
                usage: {
                  input_tokens: 1000,
                  output_tokens: 500,
                  total_tokens: 1500,
                },
              });
            },
          }),
        ),
    };
  }
}
export default {
  fetch: createHandler({
    credentialsEnabled: true,
    authenticate: async (request) => {
      const value = request.headers.get("X-Test-Principal");
      if (!["test-a", "test-b"].includes(value)) return null;
      return {
        subject: `better-auth:${value}`,
        sessionId: `local-session:${value}`,
      };
    },
  }),
};
