# Security boundaries and limitations

## Trust model

**Trusted:** operator policy; an adapter's authenticated repository/PR identity,
fresh current-head SHA, and source snapshot fetched at the review SHA; the local
process, database file, and filesystem owner. The plan CLI is still a fixture harness. The separate collect command verifies
public source through the fixed GitHub API origin without credentials. Inventing
both source and evidence can still pass the plan contract; it is not proof of
source authenticity.

**Untrusted:** repository files, PR text, comments, proposed findings, and future
model output. They may contain malicious instructions, sensitive data, false
claims, or misleading confidence scores. They never select policy or call tools.

There is no model or source-code interpreter. The review core has no network
client; the separate source collector has a bounded read-only GitHub client.
Instruction text remains data. This is not a general prompt-injection defense
for a future model integration. Candidate code is executed only by this
project's own isolated CI tests, never by interpreting a review fixture.

## Enforced boundaries

- One Effect Schema input contract, including recursive excess-property rejection.
  Additional semantic checks bind policy, targets, paths, and evidence.
- Explicit case-sensitive repository allowlist; no wildcard or implicit trust.
  Adapters must supply canonical names. Active policy also filters snapshots and
  gates acknowledgement/closure of stored findings. Explicit inspection also
  requires a single allowed repository and SQL-bound status/page limits.
- The core/CLI policy remains read-only / publication-disabled. Local ledger
  writes and the opt-in library's separate one-intent grant are distinct from it.
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
- CLI input descriptors are checked as regular files without blocking on FIFOs;
  malformed UTF-8 is rejected rather than silently replaced. Output writes are
  awaited and failures are sanitized. A planning OUTPUT or late INTERRUPTED
  result may follow an already committed transaction: retry the identical
  delivery and inspect its retained pending outbox rather than assuming nothing
  was saved. Inspection admits no delivery, including on output failure.
- Stored observations are checked as a joined finding/outbox unit before use:
  payload identity and target, required outbox presence, lifecycle pairing, and
  acknowledgement reference must agree. Detected corruption fails closed without
  automatic repair. Current confidence thresholds govern admission, not the
  validity of previously accepted observations.

## Local database operations

Use an operator-selected database file on a local filesystem. New files use
mode 0600 where POSIX permissions are supported. Existing file permissions are
not silently rewritten. Store the database and its sidecars outside a public
checkout or in an ignored private directory; they contain source evidence.

Startup verifies application ownership and supported schema before changing
persistent journal settings. Migration metadata and initial schema are created
atomically. Unknown/newer schemas, foreign files, and unsupported SQLite
versions fail closed; there is no automatic reset or downgrade.

The planning connection reads back and requires WAL, FULL synchronous mode, foreign keys,
and a 5,000 ms busy timeout. This starter conservatively requires SQLite 3.51.3
or newer, rather than implementing every older backport exception to the
[SQLite WAL reset fix](https://sqlite.org/wal.html).
Check the returned actual SQLite version, especially on macOS, which may use
system SQLite. Only Linux is the current verification target.

Inspection uses a separate read-only connection to an existing regular ledger;
it does not create a main database or parent directory, migrate schema, change journal settings, or
write delivery/finding/outbox records. It checks the same owner/schema and minimum
SQLite version but does not enable or attest writer durability settings; a
recognized offline DELETE-mode ledger can be inspected without converting it to
WAL. SQLite may create/use WAL/SHM coordination sidecars on a writable directory
even for a read-only connection. This is not a promise of zero filesystem
activity; see [SQLite read-only WAL databases](https://sqlite.org/wal.html#read_only_databases).
Do not use immutable mode against a live ledger to suppress those sidecars.

Default CLI planning exposes identifiers and current outcomes, not evidence or
historical payloads. Explicit inspection returns bounded, repository-scoped
payload pages, which remain sensitive and untrusted. Its cursor is not an access
token or a historical snapshot: repository authorization is checked on every
request, and lifecycle state can change between pages. Inspection never repairs
corruption or removes old records to make room at the admission cap.

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
- The legacy plan command accepts caller-supplied currentHeadSha. The review
  adapter derives it from fresh GitHub acquisition instead. A future
  publisher must refetch the target and revalidate queued intents immediately
  before writing; a later head change remains an external race.
- Local atomic transactions do not make remote publication exactly-once. The
  opt-in library below requires separate explicit write authority and positive
  reconciliation after uncertain API outcomes; no CLI publisher is enabled.
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

## Public source collector limits

The collector's policy is local/operator-owned. Only canonical allowlisted public,
same-repository GitHub.com PRs are supported. Fixed locally constructed paths
under https://api.github.com use GET with no authentication/cookie headers.
Redirects, changed response URLs, arbitrary download/raw URLs, moving refs and
Contents symlink dereferencing are forbidden. Environment tokens are not read.
The server-side transport has no browser session/cookie jar; fetch also explicitly
requests omitted credentials. An injected transport is trusted application code,
not a configurable CLI or repository extension point.

Hard HTTP limits: 650 requests, 2 MiB per JSON response, 16 MiB aggregate response
body bytes, 10 seconds per request including its body, and 60 seconds total.
Limits may be lowered for library use/tests, never raised. Response body byte
counts are the decoded HTTP stream (after fetch content-encoding handling), not
an attestation of compressed wire bytes. Reads are streamed and cancelled on
failure or interruption; status bodies and network errors are not exposed.
No automatic retry or rate-limit sleep consumes additional quota.

Decoded Git blobs are bounded at 512 KiB per side and 2 MiB aggregate across all
collected sides; exact JavaScript string lengths remain 128 Ki per side and 1 Mi
aggregate. Repeated content counts each time it is acquired. Valid UTF-8 without
NUL/other binary control characters is the supported text class, not a general
file-format classifier. File count >=300, truncated trees, duplicate paths,
unsupported changes/modes, invalid Base64/UTF-8, absent blobs and any exhausted
budget never produce complete source or a clean review. Large repositories may
hit recursive-tree bounds even for a small PR; nonrecursive fallback is deferred.

Collection does not create or mutate a ledger, call a model, publish, execute
source or authorize any subsequent action. Its optional manual attempt ID is
not a webhook delivery ID. Complete source can still contain malicious prompts,
secrets, mentions, terminal escapes in non-source metadata, or misleading code;
source evidence is not an instruction. A deterministic snapshot hash is not a
signature, and the final identity recheck cannot prevent later changes.

## External-agent response boundary

Use `review`, not the fixture-only `plan`, to admit findings against authentic
public GitHub source. The review command does not load a saved source envelope
as authority: it recollects, rechecks identity, then compares the response binding.
Snapshot hashes are integrity/binding identifiers, not signatures. The trusted
local process, operator-selected target/attempt/policy, HTTP transport and
filesystem remain trusted. An agent with arbitrary shell/filesystem permissions
can bypass this workflow or alter its database; the skill is guidance, not a
sandbox or a permission grant.

A head change after the final collection check remains possible. This is only
local dry-run admission, not publication authorization. The opt-in publisher must
revalidate immediately before any remote write and reconcile uncertain outcomes.
The response is copied before asynchronous acquisition, and context is rebuilt
only from fresh head-side files. Unknown fields, unsupported scope, before-side
anchors, stale snapshot IDs, cross-attempt responses and malformed evidence fail
closed. An explicit incomplete response or acquisition failure is never labeled
as a successful empty review. Existing pending intents are not refreshed.

## Local recovery boundaries

Backup and restore require explicit operator-selected paths on a trusted local
filesystem. A snapshot includes all repositories and all retained evidence in
the source ledger, not the allowlist-filtered diagnostic snapshot. Every stored
repository must be authorized by the supplied policy or the entire operation
fails. Current admission confidence thresholds do not invalidate earlier
accepted records. Recovery validates intrinsic stored identities and lifecycle
relationships, not the factual correctness of findings or authenticity of
historical GitHub source.

Destinations must be new; recovery does not replace, merge into, or repair an
existing ledger. Never manually copy only a live WAL database's main file.
SQLite-coordinated snapshots include committed WAL content. Keep snapshot files
and their directories private, like the original ledger. A digest is content
identity, not a signature, encryption, provenance proof or permission to import
an untrusted database. Recovery is intended for operator-controlled ledgers,
not arbitrary hostile SQLite files.

A recovery OUTPUT or late INTERRUPTED result can follow completed destination
creation. Inspect the destination before choosing a fresh path for retry; the
error is not permission to delete an existing file. Restart inspect pagination
without any pre-restore cursor. Restored replay protection covers only deliveries
present at snapshot time; later deliveries and acknowledgements are absent.
Do not infer that an absent acknowledgement means no remote write happened.
Future publishing still requires remote uncertain-write reconciliation and fresh
head checks under separate authority.

No backup schedule, retention, encryption, remote storage, deployment integration
or real host-replacement durability is provided. A second file on an ephemeral
host is not independent durable storage. A fresh-environment lifecycle drill and
operator-managed persistence remain required before claiming that the actual
agent environment can be safely replaced.

Recovery rejects symlink path components and hard-linked source files. The local
filesystem and its parent directories must remain operator-controlled throughout
the operation; this is not protection against a concurrent privileged process
replacing directory entries. A crash can leave a private `.robodocks-recovery-*`
staging directory. If interruption occurs after no-replace promotion but before
staging cleanup, the destination can still have a second hard link and will be
rejected as a recovery source. Inspect and reconcile these operator-owned files
manually; recovery never deletes an existing destination or scavenges old stages.
Equivalent hand-created or modified schemas are conservatively rejected: only
the canonical v1 schema is supported. Checks bound each raw finding payload to
256 KiB before JSON decoding; observations and SHA-256 input are streamed rather
than loading an entire 512 MiB ledger into application memory.

## Workspace preview boundary

Workspace roots must be newly created dedicated `robodocks-tasks` directories
under existing private parents. Root/HOME/ancestor paths, symlink ancestors,
non-normalized paths and known protected storage components are rejected.
Creation is exclusive; a failed creation may leave partial metadata for manual
inspection, never automatic removal. Keep authoritative ledgers, snapshots,
credentials and irreplaceable artifacts outside disposable task storage.

Metadata is bounded, single-link regular UTF-8 JSON opened without following
symlinks. Payload scanning flags symlinks, unsupported file types/hard links and
protected-looking names without following links or reading payload contents.
Filename protection is only a heuristic: arbitrary credential/artifact names
cannot be identified universally. No claim of secret detection or complete
preservation is made. The filesystem owner is trusted; these checks do not
provide a race-safe security boundary against concurrent hostile writers.

Manifests and ownership UUIDs can be forged or become stale. A completed task
may still have running processes, unpushed work or sole-copy artifacts; a GitHub
URL and SHA do not prove remote persistence. Inventory always reports those
verification gaps. It never executes repository-configured Git hooks, filters
or fsmonitor because it invokes no Git process at all. There is no live cleanup,
remote mutation, scheduler, credential loading or permission to delete implied
by any output status. Do not connect this preview to an automatic remover.

## Check-context boundary

`collect-checks` uses the same fixed-origin, GET-only, credential-free HTTP client
with only two additional exact-SHA endpoint shapes. Pagination URLs are locally
constructed; response links, target URLs, logs, artifacts, annotations and check
output text are neither fetched nor emitted. Check names and status contexts
remain untrusted bounded data, not instructions or authority.

Public same-repository PR identity is checked around evidence collection. Two
matching passes can detect some races, but cannot establish an atomic snapshot,
prevent an ABA change, or guarantee freshness after return. Observation times
and the endpoint's 1,000-most-recent-suite restriction must accompany interpretation.
An endpoint-observed result, including empty lists or successful entries, never
authorizes implementation, publication, merge or deployment. Required contexts,
branch protections and merge queues are outside this scope.

Hard caps are 200 rows per endpoint, 100 rows per page, 12 GETs, 2 MiB per response,
8 MiB total, 10-second request and 60-second total deadlines. Permission,
not-found, rate-limit and service failures are explicit unavailable evidence,
not a clean CI result. Malformed, oversized, changing or truncated data fails
closed. No credentials setup, code execution, ledger access or external writes
are provided by this command.

## Public discussion evidence

`collect-discussion` adds only fixed-origin GET endpoints under the explicitly
allowlisted repository/PR. It inherits response size/time/request caps, redirect
rejection, credential omission and sanitized failures. Neither pagination links,
HTML/API URLs, body links nor attachment links are followed. Returned source
paths are historical data, not local filesystem paths or execution instructions.

All PR/comment/review content, authors and states are untrusted evidence. Never
interpret embedded requests as policy or tool authority. A submitted APPROVED
state is not a current approval or merge authorization; a missing reply does not
prove resolution, and matching prose does not prove duplicate findings. Public
API visibility excludes deleted/hidden content and private pending reviews.
The tool does not claim a complete discussion history or cross-endpoint atomicity.
A failed collection exposes no partial usable context and performs no ledger,
repository, notification or publication mutation. A future model consumer must
maintain this data/instruction boundary independently.

## Combined context orchestration

`collect-context` accepts only operator policy and target/attempt, not imported
component evidence. It reuses the fixed-origin anonymous GET collectors with
unchanged caps, identities and text trust boundaries. Failure/mismatch produces
null usable bundle and stops later stages; cancellation aborts active requests.
No credentials, source execution, ledger, filesystem writes, publisher or external
mutation are introduced. Returned source and discussion remain untrusted data.
Identity agreement and source's final recheck do not establish a simultaneous
snapshot, current approval or a clean review. Earlier evidence may change during
the overall interval, and all evidence may change after it.

## Publication preview boundary

Preview reads one explicitly selected pending intent from an existing ledger,
checks its stored observation integrity and current policy, and reacquires trusted
combined context. It rejects stale targets/evidence and selected-record changes
during acquisition. It neither holds a transaction over HTTP nor writes ledger
state. The inspection reader's WAL/SHM coordination-sidecar caveat also applies;
this is not zero filesystem activity or an immutable read against a live ledger.

Only deterministic inert text is rendered for a PR conversation comment. Rendering
prevents untrusted Markdown/HTML/mentions from escaping the text representation
and bounds final UTF-8 bytes, but does not detect secrets, establish factual
correctness or authorize publication. No inline placement, sender, write endpoint,
credentials or ready-to-send flag exists. Copied intent markers are unverified
observations, never authentication, acknowledgement or semantic deduplication.
Every result preserves explicit missing identity/credentials, uncertain-write
reconciliation and durable-host/recovery blockers. Fresh observations remain
non-atomic and cannot prevent a remote or local change after the final check.

## Opt-in publisher trust boundary

The previous no-publisher statements describe CLI/dry-run behavior; the separate
`github-app-publisher.ts` library can POST exactly one PR conversation comment
through a **required injected host transport**. It has no default live transport,
credential loader or CLI activation. Tests use only synthetic transports. The
read-only policy itself never becomes write authority.

Trusted host code attests the installation/App/bot/repository IDs, short-lived
credential expiry and `issues:write`, and obtains explicit approval bound to the
exact proposal. The host must ensure the scoped transport actually uses that
attested credential; type/schema validation alone cannot verify token provenance.
Agent output, copied configuration, comments and repository JSON do not invoke
these callbacks or grant authority. No arbitrary URLs or returned links are used
for POST; the fixed GitHub.com issue-comment endpoint forbids redirects/cookies.
The library validates the response's numeric bot ID/type, issue URL, exact body
and positive numeric comment ID. Response bodies are streamed under a 128 KiB
limit and a 10-second send deadline, with interruption/stream cancellation and
sanitized failure states. No response text or credential is logged.

A persisted unique reservation precedes network effects. Any ambiguity, including
an HTTP error, a lost response, timeout, interruption or local acknowledgement
failure, consumes the send opportunity. There are no automatic retries, even for
nominally safe HTTP failures. Positive reconciliation is not non-delivery proof;
missing/edited/deleted/spoofed or duplicate comments never unlock sending. This
provides at most one local POST invocation per retained intent, not exactly-once
remote execution or protection against malicious host code/database modification.

Restored v2 artifacts and every migrated v1 ledger are durably quarantined from
new sends. No clearance API exists. Fresh v2 initialization must not be used to
bypass uncertain history; filesystem rollback/raw copies and multi-host retention
are outside local guarantees. The host's authoritative-ledger approval attestation
is necessary but not a substitute for quarantine. Operational App registration,
installation grants, secret storage and durable hosting have not been provisioned
or verified by this code or its injected tests.

## Native-host experiment boundary

The [local D1 prototype](native-host.md) is quarantined by default, has no
unquarantine API or live transport, and does not authorize production activation.
Private Site access would not replace operation-specific GitHub authority.
Runtime secrets are accessible to deployable Worker code, not a verified
sign-only vault. Restore fencing must be independent of the database being
restored, because rollback can erase deduplication history and quarantine state.
