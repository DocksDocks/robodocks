-- Isolated prototype schema, not a migration of the Bun ledger.
CREATE TABLE native_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  quarantined INTEGER NOT NULL CHECK (quarantined IN (0, 1))
) STRICT;
INSERT INTO native_control VALUES (1, 1);
CREATE TABLE native_findings (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'published', 'closed'))
) STRICT;
CREATE TABLE native_outbox (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL UNIQUE REFERENCES native_findings(id),
  proposal TEXT NOT NULL CHECK (json_valid(proposal)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged')),
  external_reference TEXT,
  CHECK ((status = 'pending' AND external_reference IS NULL) OR
         (status = 'acknowledged' AND external_reference IS NOT NULL))
) STRICT;
CREATE TABLE native_attempts (
  intent_id TEXT PRIMARY KEY REFERENCES native_outbox(id),
  proposal TEXT NOT NULL CHECK (json_valid(proposal)),
  status TEXT NOT NULL CHECK (status IN ('sending', 'unknown', 'acknowledged')),
  comment_id INTEGER CHECK (comment_id > 0),
  CHECK ((status = 'acknowledged' AND comment_id IS NOT NULL) OR
         (status IN ('sending', 'unknown') AND comment_id IS NULL))
) STRICT;
-- An impossible insert provides a SQL-level assertion, rolling back the batch.
-- This table remains empty. No request-time DDL, PRAGMA or BEGIN is needed.
CREATE TABLE native_transition_guard (id INTEGER CHECK (id = 1)) STRICT;
