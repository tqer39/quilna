-- 管理画面の更新は公開許可の世代と、追記専用の操作履歴で保護する。
ALTER TABLE document_policies ADD COLUMN publication_revision INTEGER NOT NULL DEFAULT 1 CHECK(publication_revision > 0 AND publication_revision < 9007199254740991);
ALTER TABLE document_publications ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 1 CHECK(source_revision > 0 AND source_revision < 9007199254740991);
-- 停止後の再開や期限の再延長で、以前の匿名配信許可を復活させない。
CREATE TRIGGER document_publication_fence AFTER UPDATE OF enabled,expires ON document_policies
WHEN OLD.enabled<>NEW.enabled OR OLD.expires<>NEW.expires
BEGIN
  UPDATE document_policies SET publication_revision=publication_revision+1 WHERE id=NEW.id;
END;
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
