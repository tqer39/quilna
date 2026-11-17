import {
  modelSchema,
  policySchema,
  requestSchema,
  fresh,
  validateSources,
  validateDraft,
  usageSchema,
  limits,
} from "./contracts.mjs";
import { providerOutcomeSchema } from "./ledger-schema.mjs";

const digest = async (value) => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(bytes)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
};
export function reservationMilliYen(policy, model) {
  return usageCostMilliYen(policy, model, {
    inputTokens: model.inputTokens,
    outputTokens: model.outputTokens,
  });
}
export function usageCostMilliYen(policy, model, usage) {
  const checked = usageSchema.parse(usage);
  const numerator =
    (BigInt(checked.inputTokens) * BigInt(model.inputUsdMicrosPerMillion) +
      BigInt(checked.outputTokens) * BigInt(model.outputUsdMicrosPerMillion)) *
    BigInt(policy.yenPerUsdMilli) *
    BigInt(policy.taxFeePermille);
  const divisor = 1000000000000000n;
  return Number((numerator + divisor - 1n) / divisor);
}
const additionContract = {
  requestSchema,
  bodyBytes: limits.bodyBytes,
  async prepare(request, { sources, now }) {
    const verified = validateSources(request, sources, now);
    return {
      sources: verified,
      payload: {
        question: request.question,
        excerpt: request.excerpt,
        sources: verified.map(({ id, body }) => ({ id, body })),
      },
    };
  },
  validate(raw, prepared) {
    return validateDraft(raw, prepared.sources);
  },
};
export class GenerationService {
  constructor({
    ledger,
    policy = null,
    registry = [],
    selectionPolicy = {},
    adapters = {},
    sources = [],
    now = () => new Date(),
    timeoutMs = 5000,
    contract = additionContract,
  }) {
    Object.assign(this, {
      ledger,
      policy,
      registry,
      selectionPolicy,
      adapters,
      sources,
      now,
      timeoutMs,
      contract,
    });
  }
  async propose(input) {
    const request = this.contract.requestSchema.parse(input);
    const operationDigest = this.contract.identity
      ? await this.contract.identity(request)
      : undefined;
    if (operationDigest) {
      const previous = (await this.ledger.read()).records.find(
        (r) => r.requestId === request.requestId,
      );
      if (previous)
        return previous.operationDigest === operationDigest
          ? {
              status: previous.state,
              draft: previous.draft,
              ...(previous.outcome ? { outcome: previous.outcome } : {}),
            }
          : { status: "id-conflict" };
    }
    // Prepared provider transports cannot run through this service; only test injection is allowed.
    const candidate = modelSchema.safeParse(
      this.registry.find(
        (m) =>
          m.id === (request.modelId ?? this.selectionPolicy[request.purpose]),
      ),
    );
    if (!candidate.success || candidate.data.approval !== "test-only")
      return { status: "unconnected" };
    const model = candidate.data;
    const adapter = this.adapters[model.provider];
    if (!adapter || adapter.kind !== "test-only")
      return { status: "unconnected" };
    if (
      !model.purposes.includes(request.purpose) ||
      !model.structuredOutput ||
      !model.dataConditionsAccepted
    )
      return { status: "model-unapproved" };
    if ((this.contract.id ?? null) !== (adapter.contract ?? null))
      return { status: "unconnected" };
    if (this.contract.permits && !this.contract.permits(adapter, model))
      return { status: "unconnected" };
    const now = this.now();
    const checked = policySchema.safeParse(this.policy);
    if (!checked.success || !fresh(checked.data.checkedAt, now))
      return { status: "cost-unconfigured" };
    const policy = checked.data;
    if (
      adapter.protocol === "provider-v1" &&
      (model.tokenCountMargin === null || !model.tokenCountTermsConfirmed)
    )
      return { status: "count-unconfigured" };
    if (
      !fresh(model.priceCheckedAt, now) ||
      model.inputUsdMicrosPerMillion === null ||
      model.outputUsdMicrosPerMillion === null
    )
      return { status: "cost-unconfigured" };
    const prepared = await this.contract.prepare(request, {
      sources: this.sources,
      now,
      ledger: this.ledger,
    });
    const { sources, payload } = prepared;
    // Resource cap only. Provider transports count the complete prompt/schema after reservation.
    if (
      new TextEncoder().encode(JSON.stringify(payload)).byteLength >
      this.contract.bodyBytes
    )
      return { status: "input-limit" };
    const requestDigest = await digest({ request, sources, model });
    const policyDigest = await digest(policy);
    const month = now.toISOString().slice(0, 7);
    const reserved = reservationMilliYen(policy, model);
    const reservation = await this.ledger.transaction((ledger) => {
      const previous = ledger.records.find(
        (r) => r.requestId === request.requestId,
      );
      if (previous)
        return (
          operationDigest
            ? previous.operationDigest === operationDigest
            : previous.operationDigest === undefined &&
              previous.digest === requestDigest
        )
          ? {
              status: previous.state,
              draft: previous.draft,
              ...(previous.outcome ? { outcome: previous.outcome } : {}),
            }
          : { status: "id-conflict" };
      if (
        ledger.records.some(
          (r) => r.state === "reserved" || r.state === "unknown",
        )
      )
        return { status: "busy" };
      const monthly = ledger.records.filter((r) => r.month === month);
      if (monthly.some((r) => r.policyDigest !== policyDigest))
        return { status: "cost-policy-changed" };
      const committed = monthly.reduce((sum, r) => sum + r.spentMilliYen, 0);
      if (
        !reserved ||
        committed + reserved + policy.fixedMilliYen + policy.safetyMilliYen >
          500000
      )
        return { status: "budget-exhausted" };
      const providerCap = policy.providerCapsMilliYen[model.provider];
      if (
        providerCap !== undefined &&
        monthly
          .filter((r) => r.provider === model.provider)
          .reduce((sum, r) => sum + r.spentMilliYen, 0) +
          reserved >
          providerCap
      )
        return { status: "provider-budget-exhausted" };
      ledger.records.push({
        requestId: request.requestId,
        digest: requestDigest,
        ...(operationDigest ? { operationDigest } : {}),
        month,
        policyDigest,
        modelId: model.id,
        provider: model.provider,
        reservedMilliYen: reserved,
        spentMilliYen: 0,
        state: "reserved",
        draft: null,
      });
      return { status: "dispatch" };
    });
    if (reservation.status !== "dispatch") return reservation;
    let timer, deadline;
    const controller = new AbortController();
    let state = "unknown",
      draft = null,
      spentMilliYen = 0,
      usage,
      outcome;
    try {
      const response = await Promise.race([
        adapter.generate(payload, {
          model: model.model,
          inputTokens: model.inputTokens,
          outputTokens: model.outputTokens,
          signal: controller.signal,
          retries: 0,
          store: false,
          tools: [],
          tokenCountMargin: model.tokenCountMargin,
          tokenCountTermsConfirmed: model.tokenCountTermsConfirmed,
        }),
        (deadline = new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(Error("timeout"));
          }, this.timeoutMs);
        })),
      ]);
      // These are conservative usage costs, never a claim to have reconciled the final invoice.
      const costUpperMilliYen =
        adapter.protocol === "provider-v1"
          ? usageCostMilliYen(policy, model, response.usage)
          : response.costUpperMilliYen; // Legacy test-only stubs; no production transport uses this branch.
      const outputTokens =
        adapter.protocol === "provider-v1"
          ? response.usage.outputTokens
          : response.outputTokens;
      if (
        !Number.isSafeInteger(costUpperMilliYen) ||
        costUpperMilliYen < 0 ||
        costUpperMilliYen > reserved ||
        !Number.isSafeInteger(outputTokens) ||
        outputTokens < 0 ||
        outputTokens > model.outputTokens ||
        (response.usage && response.usage.inputTokens > model.inputTokens)
      )
        throw Error("usage-unconfirmed");
      spentMilliYen = costUpperMilliYen;
      if (adapter.protocol === "provider-v1")
        usage = usageSchema.parse(response.usage);
      state = "rejected";
      if (this.contract.captureOutcome)
        outcome = providerOutcomeSchema.parse(response.outcome);
      try {
        if (outcome && outcome !== "complete") throw Error("provider-rejected");
        const validated = await Promise.race([
          this.contract.validate(response.json, prepared, request, model),
          deadline,
        ]);
        if (controller.signal.aborted) throw Error("timeout");
        draft = validated;
        state = "complete";
      } catch {
        /* Paid invalid output is still spent. */
        if (outcome === "complete")
          outcome = controller.signal.aborted ? "cancelled" : "invalid-output";
      }
    } catch {
      /* No retry or refund on uncertain dispatch. No provider errors or secrets in logs. */
    } finally {
      clearTimeout(timer);
    }
    return this.ledger.transaction((ledger) => {
      const record = ledger.records.find(
        (r) => r.requestId === request.requestId,
      );
      if (!record || record.state !== "reserved")
        throw Error("reservation-invalid");
      Object.assign(record, {
        state,
        draft,
        spentMilliYen,
        ...(usage ? { usage } : {}),
        ...(outcome ? { outcome } : {}),
      });
      return { status: state, draft, ...(outcome ? { outcome } : {}) };
    });
  }
}
