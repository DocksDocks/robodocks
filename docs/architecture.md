# Architecture

```text
Operator policy + trusted source snapshot + untrusted proposed findings
                             |
                     Effect Schema decode
                             |
                  relational/evidence validation
                             |
              synchronous SQLite BEGIN IMMEDIATE transaction
                 deliveries + findings + pending outbox
                             |
                   compact current-plan JSON
```

## One schema and one execution boundary

`src/contracts.ts` defines the structural input contracts using Effect Schema;
TypeScript types are derived from those schemas. Unknown properties are rejected,
including nested fields. `src/validation.ts` adds policy-dependent and relational
checks such as exact repository/head binding and evidence equality. It does not
maintain a second schema library or duplicate interface definitions for inputs.

`ContractError` represents invalid input or a rejected transition. `StoreError`
represents storage/setup failures. Reviewer operations return typed Effects.
The CLI handles these failures as sanitized JSON, never raw SQL error stacks.

`ReviewerService` and `reviewerLayer` provide a small stable Effect service/layer;
`withReviewer(policy, filename, use)` is the convenience boundary. It validates
operator policy, acquires a local
SQLite connection, registers its close finalizer, initializes storage, and runs
the caller's Effect within that scope. Initialization failures and normal exits
both release the connection. Do not retain the reviewer outside this scope.

The CLI maps SIGINT/SIGTERM to stable Effect interruption through AbortController.
Native synchronous SQLite calls cannot be preempted while they block the event
loop; process-kill/crash recovery still relies on SQLite transactions.

## Small SQLite boundary

`src/storage.ts` uses the supported `bun:sqlite` driver directly. Effect owns
errors and lifetime, rather than depending on the explicitly unstable Effect SQL
APIs. No generic ORM, network database, or additional SQL adapter is required.

Every write transaction callback is **fully synchronous** and called with
`.immediate()`, inside `Effect.try`. Never put an async callback, `await`, or
`Effect.runPromise` inside a native SQLite transaction: the native transaction
would commit when the callback returns, before asynchronous work completes.

Startup requires a local file and verifies its application identity/schema before
changing persistent journal settings. New files are created with mode `0600`
where the filesystem supports POSIX permissions. SQLite's application ID,
`user_version`, and `schema_migrations` row record the current v1 schema. Empty
databases initialize atomically; known v1 ledgers reopen without losing records.
Foreign, unknown, or newer schemas fail closed. There is no automatic downgrade,
destructive reset, legacy-memory snapshot import, or unspecified upgrade path.

This is the first SQLite schema, not an upgrade of a previously released ledger.
Required tables, repository indexes, and the migration row are checked before
startup; incomplete incompatible prototype databases are rejected, not repaired.
Future released schema changes require a new explicit versioned migration.

The v1 transaction creates:

- `schema_migrations`: applied version and name.
- `deliveries`: delivery ID, canonical validated-input digest, repository.
- `findings`: exact-observation identity, target, lifecycle status.
- `outbox`: one pending/acknowledged proposal per finding, with a foreign key.

All candidate values are bound SQL parameters. Request validation produces a
private copy; its delivery digest is computed before the write transaction.
Database-dependent replay, deduplication, and capacity decisions remain inside
that transaction. Delivery insertion, finding insertion, and outbox reservation
commit together or all roll back.

Read snapshots materialize both the observation and delivery result sets in a
single read transaction, excluding repositories outside the active operator
policy. JSON parsing, schema/integrity validation, and result mapping then run on
those owned rows after the transaction closes, still inside the sanitized
storage-error boundary. This keeps pure computation outside transaction lifetimes
without splitting the database snapshot.

Snapshot repository predicates are bound in SQL before payloads are read, with
supporting repository indexes. Lifecycle operations first authorize a
metadata-only lookup, then decode the ID-bound joined observation in the same
transaction. Primary keys and the outbox finding-ID unique index cover identity
lookups. No candidate string is interpolated into SQL. Native busy
errors become a sanitized STORAGE_BUSY result; there are no automatic retries.

## Identity and state

A finding ID covers repository, PR, full head SHA, rule, path, inclusive line
range, and exact evidence. It does not claim cross-commit semantic identity.
Different occurrences of identical source text remain distinct observations.

Replaying a delivery with the same canonical validated content emits no new
intent, including after process restart. Reusing its ID for different content
fails. Separate deliveries proposing the same exact observation are suppressed.
Pending outbox rows remain inspectable even when a duplicate emits no new work.

Acknowledgement records an external observation supplied by a future adapter; it
does not perform a publication. Acknowledgement cannot change its reference on
replay. Only acknowledged observations may close. Closure is not a verified fix,
does not reopen observations, and does not automatically create follow-up work.

SQLite transactions provide local atomicity and durable deduplication, **not
exactly-once GitHub publication**. A future publisher still needs explicit write
authority, fresh-head checks, safe rendering, and uncertain-write reconciliation.

## Separate bounded inspection

The CLI plan command returns only the current operation's compact outcome; it
never calls the full library snapshot. A committed plan cannot be turned into an
inspection failure by an unrelated historical record. The explicit inspect
command uses `inspectLedger` in `src/inspection.ts`, not writable initialization.
Its scoped read-only connection checks an existing regular ledger's identity,
schema, and minimum SQLite version without creating or migrating it.

Inspection validates one allowlisted repository, finding lifecycle status, and a
1–100 item limit before payload access. Repository, status, keyset bounds, and
limit are SQL parameters. Rows are ordered by the finding's rowid; at most
`limit + 1` rows are materialized in one read transaction to detect continuation. Only
the requested page is decoded afterward using the same intrinsic observation
decoder as planning/lifecycle operations, now in `src/observations.ts`. Current
admission thresholds and delivery capacity do not gate read access.

The versioned cursor binds repository, status, the last rowid/finding ID, and a
first-page high-water rowid. The last-row metadata detects ordinary cursor
misrouting or changed anchors without a new ledger identity table. Cursors are
not signed or secret and never replace allowlist checks. Every page is its own
read snapshot: later appends are outside the original high-water bound, while
lifecycle changes can alter which older rows match subsequent pages. No stable
cross-page historical snapshot or retention mechanism is promised.

## Where to change behavior

| Change                                                 | Start here                               | Regression coverage                                |
| ------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------- |
| Input shape, policy, evidence validation               | `src/contracts.ts`, `src/validation.ts`  | `test/reviewer.test.ts`, `test/properties.test.ts` |
| Planning, replay, lifecycle, observation integrity     | `src/reviewer.ts`, `src/observations.ts` | `test/reviewer.test.ts`, `test/integrity.test.ts`  |
| Bounded read-only inspection and cursors               | `src/inspection.ts`, `src/contracts.ts`  | `test/inspection.test.ts`, `test/cli.test.ts`      |
| Database ownership, initialization, settings, lifetime | `src/storage.ts`                         | `test/storage.test.ts`                             |
| CLI arguments, input/output, sanitized failures        | `src/cli.ts`                             | `test/cli.test.ts`                                 |
| Runtime, checker, linter, test runner                  | Root configs and CI workflow             | `test/runtime.test.ts`, full aggregate             |

Reuse `test/helpers.ts` for synthetic fixtures and scoped test databases; the
[README](../README.md#setup-and-commands) defines test-runner and isolation rules.
