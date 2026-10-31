-- Exact, operator-reviewed aliases. No query stripping or publisher canonical trust.
CREATE TABLE document_aliases (
  alias_url TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES document_policies(id) ON DELETE CASCADE,
  policy_revision INTEGER NOT NULL CHECK(policy_revision > 0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  expires INTEGER NOT NULL CHECK(expires > 0),
  evidence TEXT NOT NULL CHECK(length(evidence) BETWEEN 5 AND 2000)
);
CREATE INDEX document_aliases_policy ON document_aliases(policy_id);
