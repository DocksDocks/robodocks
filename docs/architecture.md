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

## Portable local ledger recovery

`backupLedger(policy, source, destination)` and
`restoreLedger(policy, source, destination)` in `src/recovery.ts` return scoped
Effects. Both require an existing regular source and a new explicit destination
in an existing trusted local directory. Schema v1 is unchanged. Recovery uses
SQLite `VACUUM INTO` from a read-only source connection to a private staging
file, not a raw main-file copy; committed WAL state is included in the consistent
snapshot. VACUUM may renumber rowids, so restart inspection without old cursors.

The entire ledger must pass owner/version/exact-schema checks,
`integrity_check`, `foreign_key_check` and intrinsic application validation,
including delivery identities, finding/outbox identities and lifecycle pairing.
The shared observation decoder is reused. Unlike repository-filtered inspection,
recovery checks every row and rejects any repository outside the operator policy.
Source and candidate files are bounded at 512 MiB and records at the existing
10,000-row capacity. Historical admission thresholds are not reapplied.

A candidate is validated read-only before atomic no-clobber hardlink promotion.
Symlink path components, hardlinked sources, existing destinations and destination
sidecars are rejected. Cleanup is limited to owned staging paths. No writable
initialization happens during restore: a subsequent normal plan/review call
opens the validated restored ledger with the existing writer setup contract.
Post-promotion synchronization failure reports `RECOVERY_COMPLETION_UNKNOWN`;
output failure or late interruption can also follow a complete destination.
The operator must inspect rather than assume failure means no file exists.

Results contain schemaVersion 1, operation, deliveries/findings/intents counts,
bytes, sha256 and cursorAction: "restart". The hash identifies file bytes, not
source provenance. Logical records and replay state are preserved as of the
snapshot, not writes committed later. No external publication reconciliation,
remote durability, retention or environment-lifecycle integration is supplied.
See [security](security.md#local-recovery-boundaries) and the recovery-specific
[formal applicability limits](ci.md#formal-verification-applicability).

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

## Bounded GitHub source acquisition

`src/github-source.ts` is a separate Effect boundary. Operator policy and a
manual request are decoded before networking; the collector never reads policy
from source. API metadata must bind the exact allowlisted canonical repository
name and numeric repository/PR IDs. Both PR sides must identify that same public
repository. Initial head/base-tip values select a SHA-only comparison; its base
and merge-base are validated separately. All three commit identities are bound
with Git commit reads. Recursive head and merge-base trees must be untruncated,
identity-matched and path-unique. The base-tip tree is not source-before.

The comparison inventory must agree with the PR's changed-file count and stay
below 300. Independently computed merge-base/head leaf deltas (SHA, mode and
type) must exactly match its before/after path coverage; directory tree hashes
are not source files. A small or empty incomplete inventory cannot hide a
change visible in those full trees. Comparison pagination does not recover files past GitHub's cap. Each
changed side selects a regular blob by its tree entry, never a Contents or raw
URL. Returned blob SHA/size, canonical Base64 and the computed Git blob SHA-1
must agree before fatal UTF-8 decoding. UTF-8 BOM is retained. Unsupported modes,
control-byte binary content, bad identities and all bounds fail closed. Rename
old/new paths remain distinct; removed files have no after side. Missing patches
are normal and patches are deliberately not copied into authoritative source.

A second PR read and repository read must retain identity, visibility, head and
base before completion. A later change is still possible: this is acquisition,
not publication authorization. The process fails fast with explicit incomplete
or unsupported status, first omission and any already-completed file records.
No snapshot ID is assigned to partial data. Complete snapshot identity hashes
fixed-order versioned provenance plus lexicographically sorted file records,
including both sides' mode/blob SHA/exact text. Manual attempt ID, null event ID,
resource counters and not-run review status are outside the hash.

`sourceForModel` validates side/status/rename relationships, unique sorted paths,
reconstructed blob hashes/text class and aggregate budgets in addition to the
complete envelope hash. It is an integrity consumer gate, not a provenance
signature verifier. Only collector-owned results should cross that trust
boundary; a fabricated envelope and recomputed hash do not become authenticated
source. `ReviewModel` and `ModelFindingsSchema` describe a future source-in,
findings-only-out seam without providing a provider, executing a model, or
admitting a delivery. A model never supplies a replacement trusted snapshot.

`src/github-http.ts` owns request/scope cancellation and deadlines. The default
transport is server-side fetch; tests inject deterministic Responses, never
network hosts. Endpoint construction permits only fixed GitHub API GET paths,
not arbitrary URL/ref/query inputs. Returned links are ignored. No credential,
redirect, retry, publisher, webhook or generic provider framework is introduced.

## Trusted external-agent admission

`robodocks collect` remains a source-only operation: `review.status` is `not-run`.
An external agent can inspect that snapshot and return an `AgentReviewSchema`
response (defined in `src/agent-review.ts`). The operator then runs `robodocks
review` with an explicit repository, PR, attempt ID, policy and database.

The response contains a schema version, the collected snapshot ID and attempt ID,
fixed scope `changed-files-head-v1`, explicit `complete` or `incomplete` status,
and findings shaped as `{ "side": "after", "finding": <FindingSchema> }`.
It cannot supply files, policy, current head, database, delivery ID or tools.
The tool decodes and owns this response before asynchronous work.

The review adapter performs a new bounded GitHub collection. Its final PR and
repository identity checks happen after source acquisition, hence after the
external agent produced the response. The new complete snapshot must match the
response's snapshot hash, including repository/PR numeric IDs, head, base tip,
merge base and complete collected file contents. A rehashed fabricated local
snapshot cannot establish authenticity. Attempt IDs are operator-selected manual
identifiers, not cryptographic capabilities or GitHub event IDs; the response
must echo the operator's selected attempt.

Only fresh head-side contents are translated into the existing core context.
Before-side anchors are rejected at decoding; deleted paths and old rename paths
are absent from the context. Evidence and target validation still run in the core.
The database schema remains v1 and stored findings have head-side semantics.
Delivery identity binds target, attempt, snapshot and review scope; an identical
retry is deduplicated, while changed findings for that delivery conflict.

An incomplete acquisition returns `review.status: not-run`, an explicit incomplete
agent response returns `incomplete`, and neither opens the ledger. A complete
empty response is recorded as `no-confirmed-findings`; a complete response with
accepted findings is `findings-proposed`. Neither is a whole-PR approval or proof
of correctness. The scope excludes discussions, checks and unchanged dependency
context, even though collection includes before sides to describe changes.

The legacy `plan` command remains a manual fixture interface with caller-provided
context, not an alternative authenticated review path. No command publishes.

## Task workspace inventory

`src/workspace.ts` is independent of the review ledger. `workspace-init` creates
a new dedicated root and `.robodocks-root.json` with schema version 1, kind
`robodocks-task-root` and a random UUID `rootId`. `task-create` exclusively
creates a task child, `.robodocks-task.json` with kind `robodocks-task`, and
`task.json`. Task metadata binds the generated root ID and validated task ID;
markers are operational ownership labels, not authenticity proofs. The manifest
schema is strict, including nested checkpoint fields. Lifecycle and evidence
claims are edited explicitly by the operator; no background state transitions
or process leases are implemented.

Inventory reads root children deterministically and rejects unknown/invalid
ownership rather than adopting directories. It inspects filesystem metadata,
not payload contents, and never invokes Git or the network. Limits are 100 tasks,
1,000 entries per task, depth 8, and 8,192 bytes per metadata file. A limit breach
blocks a task or fails the inventory; partial scans never establish completeness.
All tasks retain four unverified evidence blockers even when no other blocker
is found. `needs-verification` is not deletion eligibility. The command has no
retention decision, deletion implementation or dependency on a backup feature.

## Separate exact-head check context

`src/github-check-context.ts` implements `collect-checks` and its independent
`CheckContextResultSchema` v1. Source snapshot and review contracts remain v1 and
unchanged; check context is not admitted to the findings ledger or model input.
Public repository identity and PR numeric ID/head are observed before and after
bounded evidence reads. The check-runs endpoint uses a full SHA and `filter=all`;
the combined-status endpoint supplies latest statuses per context and binds its
response SHA. Returned aggregate status is deliberately not used as approval.

Two full passes must have identical normalized results, page counts and order;
duplicate run IDs/status IDs or status contexts, malformed rows, changed counts,
truncation and evidence drift fail closed. Names do not collapse distinct runs. After order-sensitive verification, output
rows are sorted by numeric ID; the observation explicitly lists omitted scopes
(logs, artifacts, annotations, check output, external URLs, required checks,
merge eligibility, historical statuses and older check suites).
The 200-row cap per endpoint, two pages per pass, 12-request cap, response budgets
and deadlines bound work. Final output includes wall-clock endpoints, monotonic
duration, `atomic: false`, scope and GitHub's 1,000-suite endpoint limit. No
observation is globally complete CI history or guaranteed current after return.

`endpoint-observed` means only that this bounded endpoint observation succeeded.
`incomplete`, `unavailable` and `stale` carry sanitized reason codes and null
context rather than partial apparently usable evidence. Repository policy and
request validation remain mandatory before network activity. No mutation,
publication, approval, merge decision or ledger state transition is introduced.

The command name is `collect-checks`; its independent versioned result retains
`operation: "check-context"`. Endpoint semantics follow GitHub's official
[check-run reference](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)
and [combined status reference](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference).

## Independent discussion observation

`src/github-discussion-context.ts` exposes `collectGitHubDiscussionContext` and
`DiscussionContextResultSchema`; CLI `collect-discussion` emits operation
`discussion-context` v1 without changing existing contracts. Only caller-owned
policy/request select an allowlisted repository and PR. The shared HTTP guard
adds three fixed endpoint families: PR issue comments, PR reviews and PR review
comments, each `per_page=100&page=1..2`. Repository and PR detail GETs bracket
two complete normalized list passes in provider order. Initial/final title/body must also match.
IDs are unique within each category; order/page-boundary changes fail closed before output is sorted by ID.
Explicit issue/PR relationship URLs, when present, must match the selected
canonical repository/PR endpoint; they are never followed. Missing historical
reply parents are not treated as contradictions.
No author-login or text equality is used to collapse distinct records.

Repository numeric identity, PR numeric identity, public visibility and same-repo
head/base identity are checked at both boundaries. A head/identity change returns
stale where the final identity can be established; invalid identity/private or
unavailable endpoints fail closed. Collection failures still attempt the final
identity check within the same request/time budget. On any failure context is
null; successful empty lists mean only empty endpoint observations.

Inline comments retain path, diff hunk, current/original commit IDs, positions,
lines/start lines, sides, reply parent, review ID and subject type. Nullable or
optional anchor fields remain nullable; no synthetic head anchor, thread status,
approval validity or semantic deduplication is derived. Submitted reviews retain
raw supported state, commit ID, author, body and submission time. Issue/inline
comments retain creation/update times. Unexpected shapes/states, invalid dates,
duplicate IDs, changed observations and capacity overflows fail closed.

Bounds and omissions are documented in the README. Text is preserved without
trimming or newline normalization and measured in UTF-8 bytes. This is a bounded,
non-atomic public observation, not an authoritative history or snapshot. No
ledger is opened; the admission/replay state machine and its model are unchanged.

Endpoint semantics were checked against GitHub's official
[PR details](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request),
[issue comments](https://docs.github.com/en/rest/issues/comments#list-issue-comments),
[submitted/pending reviews](https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request),
and [inline review comments](https://docs.github.com/en/rest/pulls/comments#list-review-comments-on-a-pull-request)
documentation: public reads permit unauthenticated access, list pagination caps
at 100 per page, and pending reviews do not carry submitted-at metadata. Inline
responses distinguish original/current positions and commits; file comments
need not have a line. The collector continues to send its existing pinned
`2022-11-28` API version and treats unsupported response shapes as incomplete.

GitHub's [official OpenAPI response schemas](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json)
allow null review commit IDs for removed commits and omit deprecated inline
positions. Both are preserved as null; missing raw bodies fail closed rather
than being silently converted to empty strings. Current/original inline commit
IDs remain historical values, not equality requirements against the PR head.

## Sequential combined observation

`collectGitHubReviewContext` and `ReviewContextResultSchema` in
`src/github-review-context.ts` implement `collect-context` v1. Caller-owned policy
and `CollectionRequestSchema` are validated before HTTP. Existing collectors run
checks → discussion → source, with the same request and trusted transport. No
component envelopes can be imported. Endpoint-success statuses, complete source,
non-null evidence, empty source omissions, source snapshot ID, attempt and exact
provider/repository/numeric repository/PR/numeric PR/head identity are required.
Mismatch or failure yields an explicit failed stage/reason and null bundle;
subsequent stages are not started. Effect interruption remains interruption,
not an empty success envelope.

The 180-second monotonic deadline is apportioned as the smaller of remaining
operation time and each existing 60-second cap. It is checked between stages and
before output; HTTP deadlines also bound transports that ignore cancellation.
No component bounds are relaxed. A narrow internal HTTP finalization observer
reports frozen request/response counters, including a source timeout that exits
without a component result. Observer errors cannot mask results or cleanup.
The wrapper sums counters; it does not parse or count response bodies again.
Source decoded-byte diagnostics remain in the source component only.

The bundle preserves the full original component envelopes, without a new hash,
source identity extension, model admission or ledger transition. Source remains
last with its original final PR/repository recheck. The enclosing interval has
`atomic: false` and never claims a globally complete/current observation. Checks
and discussion are not revalidated after source; changes outside their own
interval remain possible. `context-observed` is successful bounded acquisition,
not a review verdict, approval validity or merge eligibility.

## Pending-intent publication preview

`previewPublication` in `src/publication-preview.ts` backs `preview-publication`.
It accepts operator policy, an existing ledger path and an explicit repository,
PR, intent ID and attempt. A bounded, read-only selected-observation lookup checks
integrity and proposed/pending lifecycle. No transaction spans HTTP acquisition.
It reuses `collect-context` rather than accepting imported evidence, verifies the
finding against fresh head-side source and current policy, and re-reads the
selected record before rendering to detect payload or lifecycle changes.

Output is a versioned dry-run PR conversation-comment draft, not an executable
HTTP request or inline review position. Rendering is deterministic for identical
validated input, final UTF-8 output is bounded, and source URLs pin the full SHA
with encoded path components. Untrusted prose is rendered inertly. Context is a
non-atomic observation which may change after return. Check failures are evidence,
not a publication decision. No sender, credentials, state transition or schema
change is added; all publication blockers remain even when a draft is rendered.

Renderer `pr-conversation-v1` represents untrusted fields as JSON strings in
fixed code blocks, with non-ASCII and hazardous characters displayed as explicit
escape sequences (for example `\uXXXX`). The raw stored payload is capped at
256 KiB before decoding; the final comment body is capped at 64 KiB UTF-8 and
is rejected rather than silently truncated. Marker matches are limited to issue
conversation-comment IDs and explicitly labeled unverified; no match suppresses
or acknowledges an intent.
