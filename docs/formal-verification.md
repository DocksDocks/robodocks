# Bounded admission model

`formal/Admission.tla` is a small TLA+ specification of source-bound admission
and replay. It is not a translation or proof of the TypeScript implementation.
Run `bun run test:model` from a source checkout. The npm runtime package does not
include the model checker, model or test script; no runtime dependency is added.

## Tool and execution contract

The source-checkout gate needs Bash, curl, GNU timeout, SHA utilities and Java 11 or newer.
It downloads the official stable TLA+ tools v1.7.4 over HTTPS into an isolated
temporary directory, checks the pinned SHA-256 and upstream release SHA-1, then
runs TLC with one worker, a fixed seed/fingerprint polynomial and a 512 MiB heap.
It neither executes repository application inputs nor reads credentials. CI's
job timeout bounds the whole check; each local TLC process also has a
60-second timeout. Temporary checker/state files are removed
on exit; the logs and counterexamples are printed to CI output.

- Official release: https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4
- SHA-256: `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`
- SHA-256 cross-check: https://github.com/libersoft-org/libersystem/blob/main/toolchain.lock
- Upstream release SHA-1: `bee4a54f3ee3d4afc347c3240ec2d9e93b075104`
- Formal methods overview: https://lamport.org/tla/tla.html

The stable release is intentional: v1.8.0 is a rolling prerelease, not an
immutable artifact pin. A checksum mismatch or unavailable tool fails the gate.
Update version, URL and hashes together after checking the upstream release.

## Finite scope and invariants

The committed configuration explores two abstract delivery keys and two request
digests. Each request can independently have complete/incomplete source,
matching/mismatching source binding, and complete/incomplete agent status. A
process may reset before or after an atomic commit. The ledger survives resets.
All enabled choices are explored; this is not random test sampling.

The checker verifies:

1. `TypeOK`: state values remain in the declared finite domains.
2. `NoInvalidAdmission`: a durable admission requires complete source, matching
   binding and a complete agent response at validation time.
3. `NoConflictOverwrite`: a delivery's first admitted digest never changes.
4. `NoDuplicateAdmission`: replay never admits the same delivery more than once.

`safe`, `firstDigest` and `admissions` are ghost monitor variables used only
by the model checker, not additional production database columns. They record
the eligibility, first digest and number of admissions so invariants can detect
a later invalid transition. Eligibility flags abstract validation outcomes; TLC
does not establish that the HTTP collector computes those flags correctly.

Three separate negative controls deliberately bypass source gating, overwrite
conflicting content, or count replay as another admission. Each must produce
its specific invariant counterexample and TLC's safety-violation exit code.
A syntax or infrastructure error is not an acceptable negative-control result.

## Model-to-code correspondence

| Model element                                       | Implementation and implementation-level checks                                                                                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owned immutable request                             | `reviewGitHubSource` in `src/agent-review.ts` decodes the request and clones response/policy; mutation regressions in `test/agent-review.test.ts`.                                                                                          |
| `sourceComplete`, `bindingMatches`, `agentComplete` | Collector completeness/final identity checks, `sourceForModel`, snapshot/attempt/scope checks and agent status guard before `withReviewer`; tests cover stale identity, fabricated source, unsupported anchors and incomplete CLI outcomes. |
| Abstract delivery key                               | Hash of target, attempt, snapshot and scope in `src/agent-review.ts`. The model assumes distinct abstract keys; hash collisions and serialization are not modeled.                                                                          |
| Request digest                                      | The validated planner request digest in `src/reviewer.ts`; conflicting-delivery/replay tests exercise the actual stored digest.                                                                                                             |
| Atomic `Admit`/`Replay`/`Conflict`                  | `makeReviewer().plan` runs its delivery lookup, findings/outbox writes and delivery insert inside one immediate SQLite transaction; `test/storage.test.ts`, `test/reviewer.test.ts` and CLI tests cover real transaction/replay behavior.   |
| `Reset`                                             | Abstract process interruption/restart: volatile progress disappears and committed state remains. This is an assumption corresponding to the storage contract, not a power-loss durability proof.                                            |

## Explicit limits

The model serializes commits because the implementation uses SQLite's immediate
transaction. It does not prove SQLite isolation, filesystem persistence, the
absence of corruption, Effect cancellation, or actual multi-process execution.
It abstracts evidence/policy validation into the source gate; implementation
tests remain necessary for those checks. It does not model finding-level
cross-delivery deduplication, ledger capacity, cryptography, network responses,
resource bounds, schema migration, a second writer outside the application, or
privileged callers that can modify the ledger directly.

A source/head change **after** the final collection check remains possible and
is intentionally not forbidden by this model. The gate means valid at admission's
source-check point, not current forever. The admission model does not cover publication. The separate publication
model below addresses durable send reservation and uncertain outcomes, without
claiming exactly-once delivery or automatic retries.

A successful TLC run means no listed invariant violation was found in this
finite abstract state space. It is not an unbounded theorem, a verified compiler,
a proof that a reported code defect is real, or permission to approve/merge.

## Publication state-machine applicability

The library-only publisher adds the separate `formal/Publication.tla` bounded
model. `test:model` checks both models and their separate negative controls.
Publication changes durable and externally observable state, so the admission
model alone is insufficient. The new model checks one intent, two concurrent
workers, two immutable body/target/authority bindings and two comment identities.
The finite binding values abstract the entire frozen tuple, not only body text.

`Reserve` represents the unique, immediate transaction that persists `sending`
and the immutable binding before the winner receives a volatile send permit.
`Post` consumes that permit and may either deliver a comment or fail without
one. A response can be lost independently of delivery: the remote comment may
exist while the durable state stays `sending` or becomes `unknown`. `Crash`
discards a permit without erasing durable history, including a crash before the
POST. Recovery never recreates a permit. `Acknowledge` represents either a valid
response or later exact-positive reconciliation; it requires a matching actual
remote comment and trusted positive observation. Inconclusive observations and
same-ID acknowledgement replays are stuttering steps. No fairness or eventual
acknowledgement is promised.

The checked safety invariants are:

- `ReservedBeforePost`: every POST had a durable authorized reservation.
- `AtMostOnePost`: at most one POST per intent, including concurrent callers,
  crashes, response loss and uncertain outcomes.
- `TrustedAcknowledgement`: acknowledgement requires an exact positive match,
  not a copied marker, wrong author, missing result or ambiguous duplicate.
- `FrozenIdentity`: the reserved binding and acknowledged numeric identity do
  not change.
- `UniqueWinner`: only one worker holds the permission to send a given intent.
- `TypeOK`: all state remains in the finite declared domains.

Three negative controls independently allow sending without reservation,
reacquiring a send permit after uncertainty, or acknowledging spoofed evidence.
Each must produce its named invariant counterexample and safety-violation exit
code; tool or syntax failure does not count as detecting the injected defect.

### Publication correspondence and limits

The model's immediate reservation and atomic acknowledgement correspond to the
publisher's SQLite transitions; concurrency, rollback, reopen and interrupted
send tests must validate the concrete implementation. `eligible` abstracts
explicit one-intent authority, fresh source evidence, operator policy and a
trusted short-lived installation identity lease. `exactPositive` abstracts
bounded canonical-target reads with exactly one numeric-bot-ID and exact-body
match. The checker does not establish these predicates: implementation tests
and the trusted host's credential-issuance boundary remain necessary. It does
not verify GitHub, the network, credentials, permission provisioning, SQLite,
Effect cancellation, schema migration, backup implementation or process leases.

No state transition loads an older backup. A stale snapshot could omit a prior
reservation or successful remote send, invalidating `AtMostOnePost` across
histories. Restored ledgers therefore require a separate operational send block
and external-history reconciliation; this finite model is not proof that such
reconciliation is complete. No exactly-once delivery or safe retry is claimed.
A source change after the final check also remains possible. The intentional
trade-off is safety over liveness: even a reservation followed by a crash before
any POST remains uncertain rather than being automatically resent.

The uncertain-response result fix does not change any publication transition:
`sending → unknown` remains conditional and an acknowledged attempt stays
acknowledged. The implementation now reads its returned result in that same
transaction. The model does not model API result projection; a deterministic
lost-response/concurrent-reconciliation regression checks that correspondence.
