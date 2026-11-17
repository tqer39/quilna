import { z } from "zod";
import { encrypt, decrypt, hash, fingerprint, encode } from "./crypto.mjs";
import { ledgerSchema } from "../server/ledger-schema.mjs";
import { GenerationService } from "../server/service.mjs";
import { registry } from "../server/registry.mjs";
import { requestSchema } from "../server/contracts.mjs";
import { topicTextbookContract } from "../server/topic-textbook-contract.mjs";
const providerSchema = z.enum(["openai", "anthropic"]);
const principalSchema = z
  .object({
    subject: z.string().min(1).max(300),
    sessionId: z.string().min(1).max(300),
  })
  .strict();
const metadataSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    model: z.string().nullable(),
    state: z.enum(["registered", "deleted"]),
    checked: z.boolean(),
    blob: z.unknown().nullable(),
  })
  .strict();
const mutationSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    key: z
      .string()
      .regex(/^[\x21-\x7e]{10,500}$/)
      .optional(),
    model: z.string().max(100).optional(),
  })
  .strict();
const publicSetting = (record) =>
  record
    ? {
        revision: record.revision,
        model: record.model,
        state: record.state,
        checked: record.checked,
        connection: "unconnected",
      }
    : {
        revision: 0,
        model: null,
        state: "deleted",
        checked: false,
        connection: "unconnected",
      };

export class AccountVaultCore {
  constructor(
    storage,
    {
      keyring,
      generation = null,
      topicGeneration = null,
      now = () => new Date(),
    } = {},
  ) {
    Object.assign(this, { storage, keyring, generation, topicGeneration, now });
    if (storage.sql)
      storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS budget_records (request_id TEXT PRIMARY KEY, record TEXT NOT NULL)",
      );
  }
  readLedger(tx) {
    if (this.storage.sql)
      return Promise.resolve(
        ledgerSchema.parse({
          schema: 1,
          records: this.storage.sql
            .exec("SELECT record FROM budget_records ORDER BY rowid")
            .toArray()
            .map((row) => JSON.parse(row.record)),
        }),
      );
    return tx
      .get("budget")
      .then((value) => ledgerSchema.parse(value ?? { schema: 1, records: [] }));
  }
  async updateLedger(tx, ledger, before) {
    const checked = ledgerSchema.parse(ledger);
    if (!this.storage.sql) return tx.put("budget", checked);
    const previous = new Map(
      before.records.map((record) => [
        record.requestId,
        JSON.stringify(record),
      ]),
    );
    for (const record of checked.records) {
      const json = JSON.stringify(record);
      if (previous.get(record.requestId) !== json)
        this.storage.sql.exec(
          "INSERT INTO budget_records(request_id,record) VALUES (?,?) ON CONFLICT(request_id) DO UPDATE SET record=excluded.record",
          record.requestId,
          json,
        );
    }
  }
  async transaction(owner, update) {
    const result = await this.storage.transaction(async (tx) => {
      const bound = await tx.get("owner");
      if (bound && bound !== owner) throw Error("owner-mismatch");
      if (!bound) await tx.put("owner", owner);
      return update(tx);
    });
    await this.storage.sync();
    return result;
  }
  async session(principal) {
    principalSchema.parse(principal);
    const owner = await hash(principal.subject);
    const sid = await hash(principal.sessionId);
    return this.transaction(owner, async (tx) => {
      const now = this.now().getTime();
      const sessions = ((await tx.get("sessions")) ?? []).filter(
        (s) => s.expires > now,
      );
      let session = sessions.find((s) => s.sid === sid);
      if (!session) {
        session = {
          sid,
          token: encode(crypto.getRandomValues(new Uint8Array(32))),
          expires: now + 3600000,
        };
        sessions.push(session);
      }
      if (sessions.length > 20) sessions.shift();
      await tx.put("sessions", sessions);
      return {
        csrfToken: session.token,
        connection: "unconnected",
        realKeyInputEnabled: false,
      };
    });
  }
  async authorize(principal, csrf, mutating, { countRate = true } = {}) {
    principalSchema.parse(principal);
    const owner = await hash(principal.subject);
    await this.transaction(owner, async (tx) => {
      if (!mutating) return;
      const sid = await hash(principal.sessionId);
      const now = this.now().getTime();
      const sessions = (await tx.get("sessions")) ?? [];
      if (
        !sessions.some(
          (s) => s.sid === sid && s.token === csrf && s.expires > now,
        )
      )
        throw Error("csrf-invalid");
      // 保存結果の照会にもCSRFは必要だが、生成・キー変更の回数枠は消費しない。
      if (!countRate) return;
      const recent = ((await tx.get("rate")) ?? []).filter(
        (t) => t > now - 60000,
      );
      if (recent.length >= 20) throw Error("rate-limit");
      await tx.put("rate", [...recent, now]);
    });
    return owner;
  }
  async mutate(owner, provider, action, input) {
    providerSchema.parse(provider);
    const data = mutationSchema.parse(input);
    if (!["register", "replace", "delete", "model"].includes(action))
      throw Error("invalid-command");
    if (["register", "replace"].includes(action) !== (data.key !== undefined))
      throw Error("invalid-command");
    if (
      action === "delete"
        ? data.model !== undefined
        : !registry.some(
            (m) => m.provider === provider && m.model === data.model,
          )
    )
      throw Error("model-unapproved");
    const revision = data.expectedRevision + 1;
    // Crypto before the storage transaction: no network inside a retryable transaction.
    const encrypted = data.key
      ? await encrypt(data.key, owner, provider, revision, this.keyring)
      : null;
    const command = { owner, provider, action, data };
    const currentFingerprint = await fingerprint(command, this.keyring);
    return this.transaction(owner, async (tx) => {
      const old = await tx.get(`credential:${provider}`);
      const record = old ? metadataSchema.parse(old) : null;
      const previous = await tx.get(`mutation:${data.requestId}`);
      if (previous) {
        const actual =
          previous.keyVersion === currentFingerprint.keyVersion
            ? currentFingerprint
            : await fingerprint(command, this.keyring, previous.keyVersion);
        if (previous.digest !== actual.digest) throw Error("id-conflict");
        // Never replay old registered metadata after a later deletion or replacement.
        return publicSetting(record);
      }
      if ((record?.revision ?? 0) !== data.expectedRevision)
        throw Error("revision-conflict");
      const registered = record?.state === "registered";
      if (action === "register" ? registered : !registered)
        throw Error("state-conflict");
      let blob = encrypted;
      if (action === "model") {
        const secret = await decrypt(
          record.blob,
          owner,
          provider,
          record.revision,
          this.keyring,
        );
        blob = await encrypt(secret, owner, provider, revision, this.keyring);
      }
      const next = {
        revision,
        model: action === "delete" ? null : data.model,
        state: action === "delete" ? "deleted" : "registered",
        checked: false,
        blob,
      };
      await tx.put(`credential:${provider}`, metadataSchema.parse(next));
      await tx.put(`mutation:${data.requestId}`, {
        ...currentFingerprint,
        revision,
      });
      const count = ((await tx.get("mutation-count")) ?? 0) + 1;
      if (count > 2000) throw Error("mutation-limit");
      await tx.put("mutation-count", count);
      return publicSetting(next);
    });
  }
  async status(owner, provider) {
    providerSchema.parse(provider);
    return this.transaction(owner, async (tx) => {
      const record = await tx.get(`credential:${provider}`);
      return publicSetting(record ? metadataSchema.parse(record) : null);
    });
  }
  async budget(owner) {
    return this.transaction(owner, async (tx) => {
      const ledger = await this.readLedger(tx);
      const monthly = ledger.records.filter(
        (r) => r.month === this.now().toISOString().slice(0, 7),
      );
      return {
        limitMilliYen: 500000,
        spentMilliYen: monthly.reduce((n, r) => n + r.spentMilliYen, 0),
        heldMilliYen: ledger.records
          .filter((r) => ["unknown", "reserved"].includes(r.state))
          .reduce((n, r) => n + r.reservedMilliYen, 0),
        connection: "unconnected",
      };
    });
  }
  async check(owner, provider, input) {
    providerSchema.parse(provider);
    const data = z
      .object({
        requestId: z.string().uuid(),
        expectedRevision: z.number().int().positive(),
        approvedPublicText: z.literal(true),
      })
      .strict()
      .parse(input);
    const current = await this.status(owner, provider);
    if (
      current.state !== "registered" ||
      current.revision !== data.expectedRevision
    )
      throw Error("revision-conflict");
    const model = this.generation?.registry.find(
      (m) => m.provider === provider && m.model === current.model,
    );
    if (!model) return { status: "unconnected" };
    // Checking also uses an explicitly approved public prompt and the same usage reservation.
    const result = await this.propose(owner, {
      requestId: data.requestId,
      bookId: "connection-check",
      version: "1",
      blockId: "caa-public-check",
      question: "CAAで最初のRRsetを採用する理由を説明してください。",
      excerpt: "最初のCAA RRsetを採用し、親子を合算しません。",
      purpose: "evidence-check",
      modelId: model.id,
      sourceIds: ["rfc8659"],
      approvedPublicText: true,
    });
    if (result.status !== "complete") return { status: result.status };
    return this.transaction(owner, async (tx) => {
      const record = metadataSchema.parse(
        await tx.get(`credential:${provider}`),
      );
      if (
        record.state !== "registered" ||
        record.revision !== data.expectedRevision
      )
        throw Error("revision-conflict");
      await tx.put(`credential:${provider}`, { ...record, checked: true });
      return publicSetting({ ...record, checked: true });
    });
  }
  async propose(owner, input) {
    const request = requestSchema.parse(input);
    return this.proposeUsing(owner, request, this.generation);
  }
  async proposeTopic(owner, input) {
    const request = topicTextbookContract.requestSchema.parse(input);
    return this.proposeUsing(owner, request, this.topicGeneration, true);
  }
  async lookupTopic(owner, input) {
    const request = topicTextbookContract.requestSchema.parse(input);
    const identity = await topicTextbookContract.identity(request);
    return this.storage.transaction(async (tx) => {
      const bound = await tx.get("owner");
      if (!bound) return { status: "not-found" };
      if (bound !== owner) throw Error("owner-mismatch");
      const ledger = await this.readLedger(tx);
      const previous = ledger.records.find(
        (r) => r.requestId === request.requestId,
      );
      if (!previous) return { status: "not-found" };
      if (previous.operationDigest !== identity)
        return { status: "id-conflict" };
      // キー削除で有料結果を消さず、同じ所有者の明示的な照会だけで回収する。
      return {
        status: previous.state,
        draft: previous.draft,
        ...(previous.outcome ? { outcome: previous.outcome } : {}),
      };
    });
  }
  async proposeUsing(owner, request, configuration, topic = false) {
    if (!configuration) return { status: "unconnected" };
    const model = configuration.registry.find(
      (m) =>
        m.id ===
        (request.modelId ?? configuration.selectionPolicy[request.purpose]),
    );
    if (!model) return { status: "unconnected" };
    const provider = providerSchema.parse(model.provider);
    const credential = await this.transaction(owner, async (tx) => {
      const r = await tx.get(`credential:${provider}`);
      return r ? metadataSchema.parse(r) : null;
    });
    if (
      !credential ||
      credential.state !== "registered" ||
      credential.model !== model.model
    )
      return { status: "unconnected" };
    const ledger = {
      read: () => this.transaction(owner, (tx) => this.readLedger(tx)),
      transaction: (update) =>
        this.transaction(owner, async (tx) => {
          const records = await this.readLedger(tx);
          const before = structuredClone(records);
          const result = update(records);
          await this.updateLedger(tx, records, before);
          return result;
        }),
    };
    let dispatchReady = false,
      credentialReleased = false,
      operationSignal;
    const resolveSecret = async () => {
      if (!dispatchReady) throw Error("credential-before-reservation");
      if (operationSignal.aborted) throw Error("credential-cancelled");
      const latest = await this.status(owner, provider);
      if (operationSignal.aborted) throw Error("credential-cancelled");
      if (
        latest.state !== "registered" ||
        latest.revision !== credential.revision
      )
        throw Error("credential-changed");
      const secret = await decrypt(
        credential.blob,
        owner,
        provider,
        credential.revision,
        this.keyring,
      );
      if (operationSignal.aborted) throw Error("credential-cancelled");
      credentialReleased = true;
      return secret;
    };
    let adapter;
    if (topic) {
      let resolved;
      try {
        resolved = configuration.makeAdapter(provider, resolveSecret);
      } catch {
        return { status: "unconnected" };
      }
      if (resolved?.protocol !== "provider-v1")
        return { status: "unconnected" };
      // 本物のkind・contract・モデル検査を予約前に通し、秘密の解決だけを遅らせる。
      adapter = {
        ...resolved,
        confirmUnsent: () => !credentialReleased,
        generate: (payload, options) => {
          dispatchReady = true;
          operationSignal = options.signal;
          return resolved.generate(payload, options);
        },
      };
    } else {
      adapter = {
        kind: "test-only",
        protocol: "provider-v1",
        confirmUnsent: () => !credentialReleased,
        generate: async (payload, options) => {
          dispatchReady = true;
          operationSignal = options.signal;
          let secret;
          try {
            secret = await resolveSecret();
          } catch {
            // この境界ではまだadapterを呼んでおらず、外部使用量は0と確定できる。
            return { json: "", usage: { inputTokens: 0, outputTokens: 0 } };
          }
          return configuration
            .makeAdapter(provider, secret)
            .generate(payload, options);
        },
      };
    }
    const service = new GenerationService({
      ...configuration,
      ledger,
      adapters: { [provider]: adapter },
      ...(topic ? { contract: topicTextbookContract } : {}),
      now: this.now,
    });
    const result = await service.propose(request);
    const latest = await this.status(owner, provider);
    if (
      latest.state !== "registered" ||
      latest.revision !== credential.revision
    )
      return { status: "credential-changed", draft: null };
    return result;
  }
}
