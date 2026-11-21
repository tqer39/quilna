-- 一般公開は既存の配信許可と分離し、明示した世代だけに適用する。
CREATE TABLE document_publications (
  policy_id TEXT PRIMARY KEY REFERENCES document_policies(id) ON DELETE CASCADE,
  policy_revision INTEGER NOT NULL CHECK(policy_revision > 0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  expires INTEGER NOT NULL CHECK(expires > 0),
  evidence TEXT NOT NULL CHECK(length(evidence) BETWEEN 5 AND 2000)
);
