# Security boundaries and limitations

## Trust model

**Trusted:** operator policy; an adapter's authenticated repository/PR identity,
fresh current-head SHA, and source snapshot fetched at the review SHA; the local
process, database file, and filesystem owner. The JSON CLI is a fixture harness,
not an authenticated source adapter. Inventing both source and evidence can pass
structural validation.

**Untrusted:** repository files, PR text, comments, proposed findings, and future
model output. They may contain malicious instructions, sensitive data, false
claims, or misleading confidence scores. They never select policy or call tools.

There is no model, source-code interpreter, or network client in the review core.
Instruction text remains data. This is not a general prompt-injection defense
for a future model integration. Candidate code is executed only by this
project's own isolated CI tests, never by interpreting a review fixture.

## Enforced boundaries

- One Effect Schema input contract, including recursive excess-property rejection.
  Additional semantic checks bind policy, targets, paths, and evidence.
- Explicit case-sensitive repository allowlist; no wildcard or implicit trust.
  Adapters must supply canonical names. Active policy also filters snapshots and
  gates acknowledgement/closure of stored findings.
- Only read-only / publication-disabled policy. Local ledger writes are explicit
  and separate from external repository permissions.
- Full lowercase SHA; finding repo, PR, and head must exactly match context.
- Normalized relative POSIX source paths; no traversal, absolute paths, drive
  prefixes, backslashes, or control characters. Source paths are never opened.
- Exact evidence equality, including whitespace, across one-based inclusive line
  ranges spanning at most 100 lines. There is no CRLF normalization.
- Failed review batches create no delivery, finding, or outbox records. A SQL
  failure partway through reservation rolls back the entire write transaction.
- SQLite primary/unique/foreign-key constraints and bound candidate parameters.
  Deduplication survives successful close/reopen and CLI process restarts.
- Acknowledgement does not publish anything; proposed and acknowledged state are
  distinct. Closing an observation does not prove a fix or create follow-up work.
- Source/policy input, returned plans, and snapshots cannot mutate accepted state.
- Sanitized CLI failures contain neither raw SQL errors nor source bindings.
  The database connection closes on normal exit and initialization/use failures.

## Local database operations

Use an operator-selected database file on a local filesystem. New files use
mode 0600 where POSIX permissions are supported. Existing file permissions are
not silently rewritten. Store the database and its sidecars outside a public
checkout or in an ignored private directory; they contain source evidence.

Startup verifies application ownership and supported schema before changing
persistent journal settings. Migration metadata and initial schema are created
atomically. Unknown/newer schemas, foreign files, and unsupported SQLite
versions fail closed; there is no automatic reset or downgrade.

The connection reads back and requires WAL, FULL synchronous mode, foreign keys,
and a 5,000 ms busy timeout. This starter conservatively requires SQLite 3.51.3
or newer, rather than implementing every older backport exception to the
[SQLite WAL reset fix](https://sqlite.org/wal.html).
Check the returned actual SQLite version, especially on macOS, which may use
system SQLite. Only Linux is the current verification target.

Transactions execute entirely synchronously and obtain the write lock before
reading deduplication state. SQLite serializes local writers; lock contention can
still fail after the timeout. Synchronous busy waits block the Bun event loop.
Keep this small single-host workload bounded; no production load claim is made.

Do not copy only the main database file while WAL writers are active: committed
data may still be in the -wal sidecar. Use SQLite's supported backup API/tooling,
or fully stop and close all connections before an operator-controlled offline
backup. Backup automation, encryption, network/shared filesystems, multi-host
coordination, and storage-device durability guarantees are outside this starter.

## Missing production guarantees

- Allowlisting is not GitHub authorization. There are no installation tokens,
  webhook signatures, event freshness windows, or repository-rename handling.
- currentHeadSha is supplied by the caller, not fetched by the core. A future
  publisher must refetch the target and revalidate queued intents immediately
  before writing; a later head change remains an external race.
- Local atomic transactions do not make remote publication exactly-once. There
  is no publisher. A future adapter needs explicit write authority and remote
  reconciliation after uncertain API outcomes.
- IDs represent exact source observations, not semantic bugs. A new head, changed
  location, or changed excerpt can produce another proposal. Automatic public
  follow-ups require separate cross-commit reconciliation and verification.
- Pending intents retain their original evidence/head. They are not automatically
  refreshed, redacted, rendered safely, or approved for consumption.
- A structurally valid finding may still be wrong. Confidence is an author's
  unverified number; no quality evaluation or factual bug verification exists.
- JSON output and SQLite evidence may include secrets, mentions, links, or
  terminal escapes. Keep them out of public logs. Add redaction, safe rendering,
  notification controls, and retention rules before a publisher/model provider.
- The ledger's 10,000-delivery/finding cap is a fail-closed bound, not an archival
  policy. There is no automatic expiry, deletion, or cross-database deduplication.
- A future executor needs independent authority and resource-limited isolation
  without ambient secrets. A finding or repository instruction is not permission.

See [architecture](architecture.md) for transaction/lifecycle details and
[CI](ci.md) for verification and dependency-install boundaries.
