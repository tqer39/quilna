import {
  topicGenerationInput,
  topicReviewInput,
} from "./topic-textbook-format.mjs";
import {
  parseReviewedTextbookCandidate,
  sharedTextbookDigest,
} from "../src/shared-textbook-format.ts";
import {
  topicTextbookEnvelopeSchema,
  topicGenerationInputSchema,
} from "../src/topic-generation-protocol.ts";

const utf8 = (value) => new TextEncoder().encode(value);

export const topicTextbookContract = {
  id: "topic-textbook-v2",
  requestSchema: topicGenerationInputSchema,
  bodyBytes: 384000,
  identity(input) {
    // 費用の再確認でも同じ操作を参照し、競合した古い送信が二重課金にならないようにする。
    const retained = { ...input };
    delete retained.retryUnsent;
    delete retained.approvedMaxMilliYen;
    delete retained.approvedQuoteDigest;
    return sharedTextbookDigest(
      utf8(JSON.stringify({ contract: "topic-textbook-v2", input: retained })),
    );
  },
  permits: (adapter, model) => adapter.acceptsModel?.(model) === true,
  captureOutcome: true,
  approve(input, { reserved, quoteDigest }) {
    if (
      input.approvedMaxMilliYen === undefined &&
      input.approvedQuoteDigest === undefined
    )
      return null;
    if (input.approvedMaxMilliYen === undefined || !input.approvedQuoteDigest)
      return "cost-unapproved";
    if (reserved > input.approvedMaxMilliYen) return "cost-limit";
    return input.approvedQuoteDigest === quoteDigest ? null : "quote-changed";
  },
  async prepare(input, { ledger }) {
    const prepared = await topicGenerationInput(input.requestRaw);
    const generate = input.purpose === "book-addition";
    if (generate) {
      if (
        input.requestId !== prepared.request.id.toLowerCase() ||
        input.generationRequestId !== undefined ||
        input.generatorInvocation !== undefined ||
        input.draftRaw !== undefined
      )
        throw Error("textbook-stage");
    } else {
      if (
        !input.generationRequestId ||
        !input.generatorInvocation ||
        input.draftRaw === undefined ||
        input.requestId === input.generationRequestId ||
        input.generationRequestId !== prepared.request.id.toLowerCase()
      )
        throw Error("textbook-stage");
      const candidate = await topicReviewInput(
        input.requestRaw,
        input.draftRaw,
      );
      const previous = (await ledger.read()).records.find(
        (r) => r.requestId === input.generationRequestId,
      );
      // 構造上正しい候補でも、この所有者の台帳が発行していなければ送信しない。
      if (
        previous?.state !== "complete" ||
        previous.draft?.kind !== "topic-textbook-draft" ||
        previous.draft.requestDigest !== prepared.requestDigest ||
        previous.draft.draftDigest !== candidate.draftDigest ||
        previous.draft.json !== input.draftRaw ||
        previous.draft.invocation.id !== input.generatorInvocation
      )
        throw Error("textbook-unissued-draft");
    }
    return {
      requestDigest: prepared.requestDigest,
      sources: [],
      payload: {
        requestRaw: input.requestRaw,
        ...(generate ? {} : { draftRaw: input.draftRaw }),
      },
    };
  },
  async validate(raw, prepared, input, model) {
    const generate = input.purpose === "book-addition";
    if (
      typeof raw !== "string" ||
      utf8(raw).length > (generate ? 96000 : 120000)
    )
      throw Error("textbook-output");
    let allChecksPassed;
    if (generate) await topicReviewInput(input.requestRaw, raw);
    else
      ({ allChecksPassed } = await parseReviewedTextbookCandidate(
        input.requestRaw,
        input.draftRaw,
        raw,
      ));
    return topicTextbookEnvelopeSchema.parse({
      kind: generate ? "topic-textbook-draft" : "topic-textbook-review",
      requestDigest: prepared.requestDigest,
      draftDigest: await sharedTextbookDigest(
        utf8(generate ? raw : input.draftRaw),
      ),
      json: raw,
      ...(generate ? {} : { allChecksPassed }),
      invocation: {
        id: crypto.randomUUID(),
        provider: model.provider,
        model: model.model,
      },
    });
  },
};

/** 既存の共通予算エンジンへ接続し、CAA用adapterをテーマ生成として使わない。 */
export function topicTextbookBudgetAdapter(transport) {
  if (transport?.protocol !== "topic-textbook-v2")
    throw Error("textbook-adapter-invalid");
  return {
    kind: transport.kind,
    contract: topicTextbookContract.id,
    protocol: "provider-v1",
    acceptsModel: (model) => transport.acceptsModel?.(model.model) === true,
    generate(payload, options) {
      return payload.draftRaw === undefined
        ? transport.generate(payload.requestRaw, options)
        : transport.review(payload.requestRaw, payload.draftRaw, options);
    },
  };
}
