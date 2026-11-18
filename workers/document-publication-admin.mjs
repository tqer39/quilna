import { z } from "zod";
import { DocumentPolicyAdmin } from "./document-policy-admin.mjs";
import { documentError } from "./document-access.mjs";
import { json } from "./http.mjs";

const revision = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER - 1);
const timestamp = z.number().int().positive().max(8.64e15);
const evidence = z
  .string()
  .max(2000)
  .refine((v) => v.trim().length >= 5);
const id = z.string().uuid();
const fields = {
  policyRevision: revision,
  sourceGeneration: revision,
  enabled: z.boolean(),
  expires: timestamp,
  evidence,
};
const record = z
  .object({
    ...fields,
    revision,
    actor: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    updated: z.number().int().nonnegative().max(8.64e15),
  })
  .strict()
  .refine((v) => (v.actor === null) === (v.updated === 0));
const commands = {
  "admin-publication-read": z.object({ id }).strict(),
  "admin-publication-history": z
    .object({ id, before: revision.optional() })
    .strict(),
  "admin-publication-save": z
    .object({
      id,
      expectedPolicyRevision: revision,
      expectedManagementRevision: revision,
      expectedGeneration: revision,
      expectedRevision: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER - 2),
      enabled: z.boolean(),
      expires: timestamp,
      evidence,
    })
    .strict(),
};
const columns = `p.id,p.revision AS policyRevision,p.management_revision AS managementRevision,p.publication_revision AS publicationGeneration,
  p.enabled AS policyEnabled,p.expires AS policyExpires,
  u.policy_revision,u.source_revision,u.enabled,u.expires,u.evidence,u.revision,u.actor,u.updated`;
const select = `SELECT ${columns} FROM document_policies p
  LEFT JOIN document_publications u ON u.policy_id=p.id`;
const snapshot = `json_object('policyRevision',policy_revision,'sourceGeneration',source_revision,'enabled',json(CASE WHEN enabled=1 THEN 'true' ELSE 'false' END),'expires',expires,'evidence',evidence)`;

export class DocumentPublicationAdmin {
  constructor(env, now = Date.now) {
    Object.assign(this, { env, now });
  }
  state(row) {
    if (!row) throw Error("document-unavailable");
    const parent = z
      .object({
        id,
        policyRevision: revision,
        managementRevision: revision,
        publicationGeneration: revision,
        policyEnabled: z.union([z.literal(0), z.literal(1)]),
        policyExpires: timestamp,
      })
      .parse(row);
    let publication = null;
    if (row.revision !== null) {
      if (![0, 1].includes(row.enabled)) throw Error("document-invalid");
      publication = record.parse({
        policyRevision: row.policy_revision,
        sourceGeneration: row.source_revision,
        enabled: row.enabled === 1,
        expires: row.expires,
        evidence: row.evidence,
        revision: row.revision,
        actor: row.actor,
        updated: row.updated,
      });
    }
    return {
      ...parent,
      policyEnabled: parent.policyEnabled === 1,
      publication,
    };
  }
  async handle(owner, action, raw) {
    try {
      if (!new DocumentPolicyAdmin(this.env).enabled(owner))
        throw Error("document-unavailable");
      if (this.env.PUBLIC_DOCUMENTS_ENABLED !== "true")
        throw Error("document-unconfigured");
      if (!Object.hasOwn(commands, action)) throw Error("document-request");
      const input = commands[action].parse(raw);
      const db = this.env.DOCUMENT_ACCESS_DB.withSession("first-primary");
      const sql = (query, ...args) => db.prepare(query).bind(...args);
      let state;
      if (action === "admin-publication-save") {
        this.state(await sql(`${select} WHERE p.id=?`, input.id).first());
        const at = this.now(),
          token = crypto.randomUUID();
        if (input.enabled && input.expires <= at)
          throw Error("document-request");
        const matching = `SELECT p.id FROM document_policies p WHERE p.id=? AND p.revision=?
          AND p.management_revision=? AND p.publication_revision=? AND (?=0 OR (p.enabled=1 AND p.expires>=?))`;
        const matchArgs = [
          input.id,
          input.expectedPolicyRevision,
          input.expectedManagementRevision,
          input.expectedGeneration,
          Number(input.enabled),
          input.expires,
        ];
        const result = await db.batch([
          sql(
            `INSERT INTO document_publication_history(policy_id,revision,actor,recorded,kind,snapshot)
            SELECT policy_id,revision,NULL,?,'baseline',${snapshot} FROM document_publications
            WHERE policy_id IN (${matching}) AND revision=?
            AND NOT EXISTS (SELECT 1 FROM document_publication_history h WHERE h.policy_id=document_publications.policy_id AND h.revision=document_publications.revision)`,
            at,
            ...matchArgs,
            input.expectedRevision,
          ),
          sql(
            `INSERT INTO document_publications(policy_id,policy_revision,source_revision,enabled,expires,evidence,revision,operation,actor,updated)
            SELECT p.id,p.revision,p.publication_revision,?,?,?,?,?,?,? FROM document_policies p
            WHERE p.id IN (${matching})
              AND COALESCE((SELECT revision FROM document_publications WHERE policy_id=p.id),0)=?
            ON CONFLICT(policy_id) DO UPDATE SET policy_revision=excluded.policy_revision,source_revision=excluded.source_revision,enabled=excluded.enabled,
              expires=excluded.expires,evidence=excluded.evidence,revision=excluded.revision,
              operation=excluded.operation,actor=excluded.actor,updated=excluded.updated
            WHERE document_publications.revision=?`,
            Number(input.enabled),
            input.expires,
            input.evidence,
            input.expectedRevision + 1,
            token,
            owner,
            at,
            ...matchArgs,
            input.expectedRevision,
            input.expectedRevision,
          ),
          sql(
            `INSERT INTO document_publication_history(policy_id,revision,actor,recorded,kind,snapshot)
            SELECT policy_id,revision,?,?,?,${snapshot} FROM document_publications WHERE policy_id=? AND operation=?`,
            owner,
            at,
            input.expectedRevision === 0 ? "create" : "update",
            input.id,
            token,
          ),
          sql(`${select} WHERE p.id=? AND u.operation=?`, input.id, token),
        ]);
        if (!result.at(-1).results.length) throw Error("document-conflict");
        state = this.state(result.at(-1).results[0]);
      } else {
        state = this.state(
          await sql(`${select} WHERE p.id=?`, input.id).first(),
        );
      }
      let history;
      if (action === "admin-publication-history") {
        const rows = (
          await sql(
            `SELECT revision,actor,recorded,kind,snapshot FROM document_publication_history
          WHERE policy_id=? AND revision<? ORDER BY revision DESC LIMIT 21`,
            input.id,
            input.before ?? Number.MAX_SAFE_INTEGER,
          ).all()
        ).results;
        const item = z.object({
          revision,
          actor: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
          recorded: timestamp,
          kind: z.enum(["baseline", "create", "update"]),
        });
        history = {
          entries: rows.slice(0, 20).map((row) => {
            const meta = item.parse(row);
            if ((meta.kind === "baseline") !== (meta.actor === null))
              throw Error("document-invalid");
            return {
              ...meta,
              ...z.object(fields).strict().parse(JSON.parse(row.snapshot)),
            };
          }),
          before: rows.length > 20 ? rows[19].revision : null,
        };
      }
      return json(200, { account: owner, state, ...history });
    } catch (error) {
      const failure = documentError(error);
      return json(failure.code, { account: owner, status: failure.status });
    }
  }
}
