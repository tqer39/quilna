-- 管理画面の更新は公開許可の世代と、追記専用の操作履歴で保護する。
ALTER TABLE document_publications ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE document_publications ADD COLUMN operation TEXT;
ALTER TABLE document_publications ADD COLUMN actor TEXT CHECK(actor IS NULL OR length(actor) = 64);
ALTER TABLE document_publications ADD COLUMN updated INTEGER NOT NULL DEFAULT 0 CHECK(updated >= 0);
CREATE TABLE document_publication_history (
  policy_id TEXT NOT NULL REFERENCES document_policies(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  actor TEXT CHECK(actor IS NULL OR length(actor) = 64),
  recorded INTEGER NOT NULL CHECK(recorded > 0),
  kind TEXT NOT NULL CHECK(kind IN ('baseline', 'create', 'update')),
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  PRIMARY KEY (policy_id, revision),
  CHECK((kind = 'baseline') = (actor IS NULL))
);
CREATE TRIGGER publication_history_no_update BEFORE UPDATE ON document_publication_history
BEGIN SELECT RAISE(ABORT, 'publication-history-immutable'); END;
CREATE TRIGGER publication_history_no_delete BEFORE DELETE ON document_publication_history
BEGIN SELECT RAISE(ABORT, 'publication-history-immutable'); END;
