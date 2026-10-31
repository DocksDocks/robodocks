# Native-host design and D1 storage prototype

Status: **local-only storage experiment, not an operational publisher**. The
intended host is a private assistant-native Site, not a Railway service. This
slice creates no Site, cloud database, deployment, credentials, webhook, schedule,
or live GitHub request. Existing Bun/SQLite code and its CLI behavior remain
unchanged. No runtime default selects the new adapter.

## Bounded acceptance

The slice tests publication-state storage using real local D1 execution rather
than a hand-written API mock. It must demonstrate conditional single-winner
reservation, immutable binding, no resend from `sending` or `unknown`, conditional
unknown-state updates, exact-positive acknowledgement, and atomic publication /
outbox / finding updates. It must exercise transaction rollback, competing
callers, acknowledgement races, quarantine, and reopen/replay behavior where
supported by the harness. These are requirements, not a claim that every check
has already passed; the accompanying verification manifest records actual
commands and results.

The implementation lives under `prototype/d1/`: `storage.ts` contains the
standalone adapter and `migrations/0001-publication.sql` its isolated schema.
A canonical JSON binding freezes target/identity/body data and the body digest;
Workers WebCrypto checks the SHA-256 body digest. Test fixtures pre-admit matching
outbox data; the adapter has no admission method. Its pinned emulator dependencies
are confined to the prototype subpackage, not the CLI runtime.

It deliberately does not port source collection, admission, the Effect service,
the Bun publisher, or credential issuance. It is not a generic drop-in replacement
for `bun:sqlite`. There is no HTTP/MCP production endpoint, grant issuer,
unquarantine API, or live transport. Synthetic fixtures may explicitly initialize
fresh test state; this is not an operational activation procedure.

## Proposed host boundary

```text
Owner-private Site / authenticated agent tool
                 |
       operation-specific authorization
                 |
 future source/admission/publisher service   [not implemented]
                 |
          D1 publication adapter            [local prototype]
                 |
       durable conditional SQL state
```

Sites' installed platform references, inspected on 2026-10-31, describe hosted
Workers, D1 bindings, private access, and a Site-hosted MCP endpoint. These are
hosting capabilities, not evidence that Robodocks has been deployed or that
GitHub operations are authorized. A later implementation should retain Sites'
authentication integration, authorize operations server-side, and expose only
explicitly scoped tools. A private Site's audience check is not a substitute for
repository, intent, target, identity, and grant checks.

Browser identity, private service access, connected-app consent, and GitHub App
installation authority are separate. A service-access bearer bypass does not
supply a visitor identity or app consent. Proposed owner-private MCP access would
still require exact operation authorization; source text and model output must
never manufacture authority. Native-host does not mean the model process itself
owns durable disk or is an independent credential security boundary.

No sign-only, non-exportable GitHub App key facility has been verified through the
available Sites tools. Hosted runtime secrets are not equivalent to such a
facility: Worker code can consume secret bindings. Therefore anyone able to
change and deploy that code must be treated as inside the key trust boundary.
Do not describe a runtime-secret upload as isolating keys from deployable code.
A separate signer would need an independently enforced narrow signing policy,
identity verification, auditability, revocation, and an explicit trust decision;
this slice neither chooses nor provisions one. See the official
[Workers secrets contract](https://developers.cloudflare.com/workers/configuration/secrets/).

## D1 state operations

Use one SQL statement per `prepare()` and bind every data value. Claims must be
conditional writes against current database state, not `SELECT`, then a JavaScript
check, then an unconditional write. A primary-key/unique constraint on intent ID
ensures that competing reservations cannot each create an attempt. Frozen target,
body and bot identity are retained with the attempt. A repeated reservation is
not permission to send again, even when the supplied binding is identical.

A fresh successful reservation result can represent a single volatile claim in a
future trusted publisher. If its response is lost, do not recover a send permit
by reading the row or repeating the call. The write may already have committed;
the safe outcome is uncertainty and no new POST. The prototype itself never
produces a GitHub request.

An unknown-state transition uses a status predicate: it must not overwrite an
acknowledgement that won a race. Acknowledgement requires a trusted positive
observation of exactly the frozen target, numeric bot identity, and exact body;
a copied marker, missing result, wrong target/author, or ambiguous duplicate is
not sufficient. The adapter can compare supplied evidence but cannot establish
that evidence was genuinely fetched from GitHub. That is a separate trusted
collector/publisher obligation, intentionally absent here.

Related acknowledgement changes must commit together. Use a D1 `batch()` with
conditional SQL and assertions/constraints that fail the transaction when required
rows or lifecycle relations are inconsistent. A zero-row conditional update is
not itself a SQL error; success must not be inferred from the absence of an
exception. The prototype returns a boolean meaning only whether this call
performed the transition. `false` does not distinguish a same-ID replay from a
blocked or mismatched transition, and is never proof that supplied evidence was
accepted. Future callers must inspect and reconcile exact state before reporting
an acknowledgement. A late injected constraint failure must leave every
preceding statement rolled back. Cloudflare documents ordered
batch execution and all-or-nothing rollback in the
[D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/).

No transaction spans an HTTP call. D1 commit and GitHub delivery cannot be made
atomic by wrapping JavaScript in an async transaction. A POST may succeed while
its response or subsequent local acknowledgement is lost. `sending` and `unknown`
therefore remain permanently ineligible for automatic reservation/takeover.
Positive reconciliation may acknowledge; negative or incomplete reads do not
prove non-delivery. This design favors avoiding duplicate sends over guaranteed
delivery and makes **no exactly-once claim**.

## Consistency, clocks, and expiry

The conservative prototype path uses the ordinary D1 database binding, not a
read-replica session. Cloudflare documents that queries without the Sessions API
continue to run on the primary. If replicated inspection is introduced later,
use Sessions/bookmarks to preserve read-your-writes, and never turn a replica
read into publication authority. Session sequential consistency is not a promise
that a new session observes every concurrent writer. Even a primary pre-read can
race: authoritative transition predicates still belong in SQL. See
[D1 replication and sessions](https://developers.cloudflare.com/d1/best-practices/read-replication/).

The storage reservation has no expiry that releases an intent for resend. Wall
clock advance, rollback, process restart, or an expired installation token must
not turn uncertainty back into `pending`. Future time-limited grants and identity
leases need a trusted host clock, bounded validity, fresh checks immediately
before a claim/send, and fail-closed behavior when time is uncertain. An operator
changing a deadline is not evidence that an earlier POST did not occur. This
prototype does not authenticate grants or attest clock quality.

## Migration, quarantine, and recovery

The prototype schema starts quarantined and has no supported unquarantine API.
Quarantine blocks new reservations; unknown-state recording and exact-positive
acknowledgement remain available for reconciliation without granting send
permission. Missing control state denies reservation; missing required tables fail
the operation rather than triggering repair. Schema creation
belongs to explicit migrations/test setup, never request handling. An operational
Bun-to-D1 import and comprehensive imported-ledger validation are not implemented.
A future import must preserve stable intent/finding IDs,
frozen bindings, all attempts, acknowledgements, and unknown outcomes, then remain
quarantined pending independent validation. Do not interpret imported `pending`
rows as permission to send.

Restoring older state can erase reservations while remote comments remain.
Quarantine stored only in that same database cannot protect against restoring a
snapshot whose control row says active. Before any future restore, traffic and
publication must be fenced independently of the restored database, including
in-flight workers and retained credentials; hold the fence through reconciliation
and explicitly authorized reactivation. D1
[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
restores database history, not GitHub history. This local slice neither executes
nor validates a production recovery procedure.

## Verification and formal applicability

Use official Miniflare/workerd local D1 support for SQL/binding compatibility,
not Bun SQLite hidden behind a D1-shaped interface. Local emulation is meaningful
implementation evidence but does not prove hosted replication, network-failure,
resource-limit, or durability behavior. Cloudflare describes the isolation of
[local D1 development](https://developers.cloudflare.com/d1/best-practices/local-development/).
No hosted resource is needed for this slice.

The existing bounded `Publication.tla` model remains relevant to unique claims,
reserved-before-send, frozen identity, trusted acknowledgement, and no retry from
uncertainty. Its abstract state machine is unchanged: the new adapter is an
implementation candidate for those transitions, not a new protocol. The existing
model does not verify D1 SQL, batch semantics, replica routing, credentials,
network APIs, schema migration, or restore fencing. Keep its gate and negative
controls, plus focused real-D1 regressions and independent code review. Passing
TLC is not a proof of the D1 implementation. Existing admission/runtime/package
gates remain required because the repository still ships its Bun implementation.

Before operational use, separately review and authorize the production host,
access policy, secret/signing trust boundary, repository scope, fresh authority
checks, migration/recovery plan, telemetry redaction, spending limits, and first
real action. None is approved or performed by this prototype.

### Reproduce the local experiment

From the repository root, with Bun 1.4.4 and Node 24.22.1 available:

```sh
npm ci --prefix prototype/d1 --ignore-scripts --no-audit --no-fund
(cd prototype/d1 && npm run typecheck)
npm test --prefix prototype/d1
```

Miniflare `4.20260730.0`, its locked workerd `1.20260730.1`, and official
`@cloudflare/workers-types` `5.20261031.1` are dev-only prototype dependencies.
The strict binding check establishes that the official `D1Database` type can
supply the adapter interface without disabling library checking. Tests transform
the actual adapter TypeScript into a Worker module and execute its SQL through
a real local D1 binding. The test-only Worker accepts arbitrary fixture SQL and
operation dispatch: **never deploy that harness**. It has outbound requests
disabled and uses synthetic records only. Prototype source/tooling is excluded
from the installed CLI tarball; the existing package smoke verifies that artifact.

The tests include local persistence across workerd restart. They do not establish
hosted power-loss recovery or replica behavior. Lost-response injection wraps an
actual committed D1 call, not a simulated SQL engine; it tests application
uncertainty handling, not a real network partition.
