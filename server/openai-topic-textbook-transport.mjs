import { z } from "zod";
import { postJson, secretHeaders, tokenCount } from "./provider-http.mjs";
import {
  topicGenerationInput,
  topicReviewInput,
  normalizeTopicDraft,
  normalizeTopicReview,
  topicDraftOutputSchema,
  topicReviewOutputSchema,
  topicGenerationInstructions,
  topicReviewInstructions,
} from "./topic-textbook-format.mjs";
const optionsSchema = z
  .object({
    model: z.string().min(1).max(200),
    inputTokens: z.number().int().min(1).max(32000),
    outputTokens: z.number().int().min(1).max(16000),
    tokenCountMargin: z.number().int().min(0).max(2000),
    tokenCountTermsConfirmed: z.literal(true),
    retries: z.literal(0),
    store: z.literal(false),
    tools: z.array(z.never()).length(0),
    signal: z.custom((v) => v instanceof globalThis.AbortSignal),
  })
  .strict();

/** 通常起動へは組み込まず、明示的に渡された送信境界・モデル・資格情報だけを使う。 */
export function openaiTopicTextbookTransport({
  send,
  secret,
  model,
  reasoningEffort,
  mockOnly = false,
}) {
  const configured =
    typeof model === "string" &&
    /^[A-Za-z0-9._:-]{1,200}$/.test(model) &&
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      reasoningEffort,
    );
  const run = async (stage, requestRaw, draftRaw, inputOptions) => {
    const checked = optionsSchema.safeParse(inputOptions);
    if (
      !configured ||
      !checked.success ||
      checked.data.model !== model ||
      checked.data.signal.aborted
    )
      throw Error("transport-unconfigured");
    const options = checked.data;
    const prepared =
      stage === "generate"
        ? await topicGenerationInput(requestRaw)
        : await topicReviewInput(requestRaw, draftRaw);
    const headers = secretHeaders(secret, "openai");
    const common = {
      model,
      reasoning: { effort: reasoningEffort },
      input: [{ role: "user", content: JSON.stringify(prepared.payload) }],
      instructions:
        stage === "generate"
          ? topicGenerationInstructions
          : topicReviewInstructions,
      tools: [],
      text: {
        format: {
          type: "json_schema",
          name:
            stage === "generate" ? "topic_textbook" : "topic_textbook_review",
          strict: true,
          schema:
            stage === "generate"
              ? topicDraftOutputSchema
              : topicReviewOutputSchema,
        },
      },
    };
    const counted = await postJson(
      send,
      "https://api.openai.com/v1/responses/input_tokens",
      headers,
      common,
      options.signal,
    );
    if (
      tokenCount(counted.input_tokens) + options.tokenCountMargin >
      options.inputTokens
    )
      return {
        json: "",
        usage: { inputTokens: 0, outputTokens: 0 },
        outcome: "input-limit",
      };
    const response = await postJson(
      send,
      "https://api.openai.com/v1/responses",
      headers,
      {
        ...common,
        store: false,
        stream: false,
        max_output_tokens: options.outputTokens,
        service_tier: "default",
      },
      options.signal,
      192000,
    );
    const usage = {
      inputTokens: tokenCount(response.usage?.input_tokens),
      outputTokens: tokenCount(response.usage?.output_tokens),
    };
    if (
      response.model !== model ||
      response.service_tier !== "default" ||
      tokenCount(response.usage?.total_tokens) !==
        usage.inputTokens + usage.outputTokens ||
      tokenCount(response.usage?.input_tokens_details?.cached_tokens ?? 0) >
        usage.inputTokens ||
      tokenCount(response.usage?.output_tokens_details?.reasoning_tokens ?? 0) >
        usage.outputTokens ||
      usage.inputTokens > options.inputTokens ||
      usage.outputTokens > options.outputTokens ||
      !Array.isArray(response.output) ||
      response.output.some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          !["message", "reasoning"].includes(item.type),
      )
    )
      throw Error("usage-unconfirmed");
    if (options.signal.aborted)
      return { json: "", usage, outcome: "cancelled" };
    const messages = response.output.filter((item) => item.type === "message");
    const content = messages.flatMap((item) =>
      Array.isArray(item.content) ? item.content : [],
    );
    let json = "",
      outcome = "invalid-output",
      allChecksPassed;
    if (
      response.status === "completed" &&
      !response.error &&
      messages.length === 1 &&
      messages[0].role === "assistant" &&
      messages[0].status === "completed" &&
      content.length === 1 &&
      content[0]?.type === "output_text"
    ) {
      try {
        if (stage === "generate")
          json = await normalizeTopicDraft(requestRaw, content[0].text);
        else {
          const result = await normalizeTopicReview(
            requestRaw,
            draftRaw,
            content[0].text,
          );
          json = result.raw;
          allChecksPassed = result.allChecksPassed;
        }
        outcome = "complete";
      } catch {
        /* 使用量を保持し、不正な有料出力を採用しない。 */
      }
    } else if (content.some((c) => c?.type === "refusal")) outcome = "refused";
    else if (response.status === "incomplete") outcome = "incomplete";
    if (options.signal.aborted)
      return { json: "", usage, outcome: "cancelled" };
    return {
      json,
      usage,
      outcome,
      ...(stage === "review" && outcome === "complete"
        ? { allChecksPassed }
        : {}),
    };
  };
  return {
    kind: mockOnly ? "test-only" : "prepared",
    protocol: "topic-textbook-v2",
    acceptsModel(requested) {
      if (!configured || requested !== model || typeof send !== "function")
        return false;
      try {
        secretHeaders(secret, "openai");
        return true;
      } catch {
        return false;
      }
    },
    generate: (requestRaw, options) =>
      run("generate", requestRaw, undefined, options),
    review: (requestRaw, draftRaw, options) =>
      run("review", requestRaw, draftRaw, options),
  };
}
