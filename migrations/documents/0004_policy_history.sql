-- Append-only policy snapshots. Legacy policies are captured on their first edit.
CREATE TABLE document_policy_history (
  policy_id TEXT NOT NULL REFERENCES document_policies(id),
  management_revision INTEGER NOT NULL CHECK(management_revision > 0),
  actor TEXT CHECK(actor IS NULL OR length(actor) = 64),
  recorded INTEGER NOT NULL CHECK(recorded > 0),
  kind TEXT NOT NULL CHECK(kind IN ('baseline','create','update')),
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  PRIMARY KEY (policy_id, management_revision),
  CHECK((kind = 'baseline') = (actor IS NULL))
);
CREATE TRIGGER document_history_no_update BEFORE UPDATE ON document_policy_history
BEGIN SELECT RAISE(ABORT, 'document-history-immutable'); END;
CREATE TRIGGER document_history_no_delete BEFORE DELETE ON document_policy_history
BEGIN SELECT RAISE(ABORT, 'document-history-immutable'); END;
