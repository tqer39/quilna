-- Operator-managed permissions only; no browser endpoint writes these tables.
CREATE TABLE document_policies (
  id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  expires INTEGER NOT NULL CHECK(expires > 0),
  evidence TEXT NOT NULL CHECK(length(evidence) BETWEEN 5 AND 2000)
);
CREATE TABLE document_members (
  policy_id TEXT NOT NULL REFERENCES document_policies(id) ON DELETE CASCADE,
  owner_hash TEXT NOT NULL CHECK(length(owner_hash) = 64),
  PRIMARY KEY (policy_id, owner_hash)
);
