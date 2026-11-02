import { z } from "zod";
import { cloudFeedURL } from "./feed-fetch.mjs";
import { json } from "./http.mjs";
import { documentError } from "./document-access.mjs";

const uuid = z.string().uuid();
const revision = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER - 1);
const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ownerHash = z.string().regex(/^[a-f0-9]{64}$/);
const evidence = z
  .string()
  .min(5)
  .max(2000)
  .refine((v) => v.trim().length >= 5);
const alias = z
  .object({
    url: z.string().max(2048),
    enabled: z.boolean(),
    expires: timestamp,
    evidence,
    policyRevision: revision,
  })
  .strict();
const fields = {
  enabled: z.boolean(),
  expires: timestamp,
  evidence,
  members: z.array(ownerHash).max(100),
  aliases: z.array(alias).max(50),
};
const commands = {
  "admin-list": z.object({ after: uuid.optional() }).strict(),
  "admin-read": z.object({ id: uuid }).strict(),
  "admin-history": z.object({ id: uuid, before: revision.optional() }).strict(),
  "admin-revision": z.object({ id: uuid, revision }).strict(),
  "admin-create": z.object({ url: z.string().max(2048), ...fields }).strict(),
  "admin-update": z
    .object({ id: uuid, expectedRevision: revision, ...fields })
    .strict(),
};
const baseColumns = `p.id, p.source_url, p.revision, p.enabled, p.expires, p.evidence,
  p.management_revision, p.management_updated`;
const policySelect = `SELECT ${baseColumns},
  (SELECT json_group_array(owner_hash) FROM
    (SELECT owner_hash FROM document_members WHERE policy_id=p.id ORDER BY owner_hash)) AS members,
  (SELECT json_group_array(json_object('url',alias_url,'enabled',enabled,'expires',expires,'evidence',evidence,'policyRevision',policy_revision)) FROM
    (SELECT * FROM document_aliases WHERE policy_id=p.id ORDER BY alias_url)) AS aliases
  FROM document_policies p`;

const snapshot = `json_object('id',id,'source_url',source_url,'revision',revision,
  'enabled',enabled,'expires',expires,'evidence',evidence,
  'management_revision',management_revision,'management_updated',management_updated,
  'members',CAST(members AS TEXT),'aliases',CAST(aliases AS TEXT))`;
const auditMetadata = z
  .object({
    revision,
    actor: ownerHash.nullable(),
    recorded: timestamp,
    kind: z.enum(["baseline", "create", "update"]),
  })
  .refine((v) => (v.kind === "baseline") === (v.actor === null));

export class DocumentPolicyAdmin {
  constructor(env, now = Date.now) {
    Object.assign(this, { env, now });
  }
  enabled(owner) {
    return (
      this.env.DOCUMENT_ADMIN_ENABLED === "true" &&
      ownerHash.safeParse(owner).success &&
      owner === this.env.DOCUMENT_ADMIN_OWNER_HASH &&
      !!this.env.DOCUMENT_ACCESS_DB?.withSession
    );
  }
  url(value) {
    try {
      return cloudFeedURL(
        value,
        this.env.APP_ORIGIN ? [new URL(this.env.APP_ORIGIN).hostname] : [],
      ).href;
    } catch {
      throw Error("document-request");
    }
  }
  normalize(input) {
    const members = [...input.members].sort();
    const aliases = input.aliases
      .map((a) => ({ ...a, url: this.url(a.url) }))
      .sort((a, b) => a.url.localeCompare(b.url));
    if (
      new Set(members).size !== members.length ||
      new Set(aliases.map((a) => a.url)).size !== aliases.length ||
      (input.enabled &&
        (input.expires <= this.now() ||
          aliases.some(
            (a) =>
              a.enabled &&
              (a.expires <= this.now() || a.expires > input.expires),
          )))
    )
      throw Error("document-request");
    return { ...input, members, aliases };
  }
  metadata(row) {
    if (!row) throw Error("document-unavailable");
    const data = z
      .object({
        id: uuid,
        source_url: z.string(),
        revision,
        enabled: z.union([z.literal(0), z.literal(1)]),
        expires: timestamp,
        evidence,
        management_revision: revision,
        management_updated: z.number().int().nonnegative(),
      })
      .parse(row);
    if (this.url(data.source_url) !== data.source_url)
      throw Error("document-invalid");
    return {
      id: data.id,
      url: data.source_url,
      policyRevision: data.revision,
      managementRevision: data.management_revision,
      updated: data.management_updated,
      enabled: data.enabled === 1,
      expires: data.expires,
      evidence: data.evidence,
    };
  }
  decode(row) {
    const data = this.metadata(row);
    const members = z.array(ownerHash).max(100).parse(JSON.parse(row.members));
    const aliases = z
      .array(alias)
      .max(50)
      .parse(
        JSON.parse(row.aliases).map((a) => {
          if (a.enabled !== 0 && a.enabled !== 1)
            throw Error("document-invalid");
          return { ...a, enabled: a.enabled === 1 };
        }),
      );
    if (aliases.some((a) => this.url(a.url) !== a.url))
      throw Error("document-invalid");
    return {
      ...data,
      members,
      aliases,
    };
  }
  /** Validate stored audit metadata; reject malformed actors, kinds or revisions. */
  historyMetadata(row) {
    const parsed = auditMetadata.safeParse(row);
    if (!parsed.success) throw Error("document-invalid");
    return parsed.data;
  }
  /** Decode an immutable snapshot, reporting corrupt JSON or policy data as invalid. */
  historyPolicy(row) {
    try {
      return this.decode(JSON.parse(row.snapshot));
    } catch {
      throw Error("document-invalid");
    }
  }
  /**
   * Report admin availability or dispatch commands for the configured admin only.
   * History reads are bounded; writes atomically persist policy and audit snapshots
   * with revision checks, rolling back on SQL failure. Failures become account-bound
   * error responses rather than automatic retries or partial-success responses.
   */
  async handle(owner, action, raw) {
    if (action === "admin-status")
      return json(200, { account: owner, enabled: this.enabled(owner) });
    try {
      if (!this.enabled(owner)) throw Error("document-unavailable");
      if (!Object.hasOwn(commands, action)) throw Error("document-request");
      const input = commands[action].parse(raw);
      const db = this.env.DOCUMENT_ACCESS_DB.withSession("first-primary");
      let value;
      if (action === "admin-list") {
        const rows = (
          await db
            .prepare(
              `SELECT ${baseColumns} FROM document_policies p WHERE p.id > ? ORDER BY p.id LIMIT 21`,
            )
            .bind(input.after ?? "")
            .all()
        ).results;
        // No partial-success response if retained policy data is unreadable.
        value = {
          policies: rows.slice(0, 20).map((r) => this.metadata(r)),
          after: rows.length > 20 ? rows[19].id : null,
        };
      } else if (action === "admin-history" || action === "admin-revision") {
        // Check existence without exposing historical records to ordinary readers.
        if (
          !(await db
            .prepare("SELECT id FROM document_policies WHERE id=?")
            .bind(input.id)
            .first())
        )
          throw Error("document-unavailable");
        if (action === "admin-history") {
          const rows = (
            await db
              .prepare(
                `SELECT management_revision AS revision, actor, recorded, kind
            FROM document_policy_history WHERE policy_id=? AND management_revision<?
            ORDER BY management_revision DESC LIMIT 21`,
              )
              .bind(input.id, input.before ?? Number.MAX_SAFE_INTEGER)
              .all()
          ).results;
          value = {
            id: input.id,
            entries: rows.slice(0, 20).map((r) => this.historyMetadata(r)),
            before: rows.length > 20 ? rows[19].revision : null,
          };
        } else {
          const row = await db
            .prepare(
              `SELECT management_revision AS revision,actor,recorded,kind,snapshot
            FROM document_policy_history WHERE policy_id=? AND management_revision=?`,
            )
            .bind(input.id, input.revision)
            .first();
          if (!row) throw Error("document-unavailable");
          const entry = this.historyMetadata(row),
            policy = this.historyPolicy(row);
          if (
            policy.id !== input.id ||
            policy.managementRevision !== entry.revision
          )
            throw Error("document-invalid");
          value = { entry, policy };
        }
      } else if (action === "admin-read") {
        value = {
          policy: this.decode(
            await db
              .prepare(`${policySelect} WHERE p.id=?`)
              .bind(input.id)
              .first(),
          ),
        };
      } else {
        const data = this.normalize(input);
        const id = input.id ?? crypto.randomUUID(),
          operation = crypto.randomUUID();
        const now = this.now();
        const sql = (query, ...args) => db.prepare(query).bind(...args);
        const owned =
          "SELECT id FROM document_policies WHERE id=? AND management_operation=?";
        const first =
          action === "admin-create"
            ? sql(
                `INSERT INTO document_policies(id,source_url,revision,enabled,expires,evidence,management_revision,management_operation,management_updated)
              SELECT ?,?,1,?,?,?,1,?,? WHERE (SELECT COUNT(*) FROM document_policies)<1000`,
                id,
                this.url(input.url),
                Number(data.enabled),
                data.expires,
                data.evidence,
                operation,
                now,
              )
            : sql(
                `UPDATE document_policies SET revision=revision+CASE WHEN evidence=? THEN 0 ELSE 1 END,
              evidence=?,enabled=?,expires=?,management_revision=management_revision+1,management_operation=?,management_updated=?
              WHERE id=? AND management_revision=? AND management_revision<? AND (evidence=? OR revision<?)`,
                data.evidence,
                data.evidence,
                Number(data.enabled),
                data.expires,
                operation,
                now,
                id,
                input.expectedRevision,
                Number.MAX_SAFE_INTEGER - 1,
                data.evidence,
                Number.MAX_SAFE_INTEGER - 1,
              );
        // All dependent writes are gated by a fresh server-only token. A losing
        // compare-and-swap cannot delete or replace another edit's membership.
        const result = await db.batch([
          // Retain the pre-audit state once, without inventing its original actor/date.
          ...(action === "admin-update"
            ? [
                sql(
                  `INSERT INTO document_policy_history(policy_id,management_revision,actor,recorded,kind,snapshot)
            SELECT id,management_revision,NULL,?,'baseline',${snapshot} FROM (${policySelect} WHERE p.id=? AND p.management_revision=? AND p.management_revision<? AND (p.evidence=? OR p.revision<?)) q
            WHERE NOT EXISTS (SELECT 1 FROM document_policy_history h WHERE h.policy_id=q.id AND h.management_revision=q.management_revision)`,
                  now,
                  id,
                  input.expectedRevision,
                  Number.MAX_SAFE_INTEGER - 1,
                  data.evidence,
                  Number.MAX_SAFE_INTEGER - 1,
                ),
              ]
            : []),
          first,
          sql(
            `DELETE FROM document_members WHERE policy_id IN (${owned})`,
            id,
            operation,
          ),
          sql(
            `DELETE FROM document_aliases WHERE policy_id IN (${owned})`,
            id,
            operation,
          ),
          sql(
            `INSERT INTO document_members(policy_id,owner_hash)
            SELECT p.id,j.value FROM document_policies p,json_each(?) j WHERE p.id=? AND p.management_operation=?`,
            JSON.stringify(data.members),
            id,
            operation,
          ),
          sql(
            `INSERT INTO document_aliases(alias_url,policy_id,policy_revision,enabled,expires,evidence)
            SELECT json_extract(j.value,'$.url'),p.id,json_extract(j.value,'$.policyRevision'),json_extract(j.value,'$.enabled'),json_extract(j.value,'$.expires'),json_extract(j.value,'$.evidence')
            FROM document_policies p,json_each(?) j WHERE p.id=? AND p.management_operation=?`,
            JSON.stringify(data.aliases),
            id,
            operation,
          ),
          sql(
            `INSERT INTO document_policy_history(policy_id,management_revision,actor,recorded,kind,snapshot)
            SELECT id,management_revision,?,?,?,${snapshot} FROM (${policySelect} WHERE p.id=? AND p.management_operation=?)`,
            owner,
            now,
            action === "admin-create" ? "create" : "update",
            id,
            operation,
          ),
          sql(
            `${policySelect} WHERE p.id=? AND p.management_operation=?`,
            id,
            operation,
          ),
        ]);
        if (!result.at(-1).results.length) throw Error("document-conflict");
        value = { policy: this.decode(result.at(-1).results[0]) };
      }
      return json(200, { ...value, account: owner });
    } catch (error) {
      const conflict =
        /document-policy-conflict|UNIQUE constraint failed: document_(policies|aliases)/.test(
          error.message,
        );
      const failure = documentError(
        conflict ? Error("document-conflict") : error,
      );
      return json(failure.code, { status: failure.status, account: owner });
    }
  }
}
