-- Management edits do not change the immutable document scope unless the
-- delivery-permission evidence changes. Existing policy/alias data is retained.
ALTER TABLE document_policies ADD COLUMN management_revision INTEGER NOT NULL DEFAULT 1 CHECK(management_revision > 0);
ALTER TABLE document_policies ADD COLUMN management_operation TEXT;
ALTER TABLE document_policies ADD COLUMN management_updated INTEGER NOT NULL DEFAULT 0 CHECK(management_updated >= 0);
CREATE TRIGGER document_alias_not_primary BEFORE INSERT ON document_aliases
WHEN EXISTS (SELECT 1 FROM document_policies WHERE source_url = NEW.alias_url)
BEGIN SELECT RAISE(ABORT, 'document-policy-conflict'); END;
CREATE TRIGGER document_primary_not_alias BEFORE INSERT ON document_policies
WHEN EXISTS (SELECT 1 FROM document_aliases WHERE alias_url = NEW.source_url)
BEGIN SELECT RAISE(ABORT, 'document-policy-conflict'); END;
CREATE TRIGGER document_alias_current_approval BEFORE INSERT ON document_aliases
WHEN NEW.enabled=1 AND NEW.policy_revision <> (SELECT revision FROM document_policies WHERE id=NEW.policy_id)
BEGIN SELECT RAISE(ABORT, 'document-policy-conflict'); END;
