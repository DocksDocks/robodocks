# CI boundaries

The [workflow](../.github/workflows/ci.yml) runs on pull requests and pushes to
main, on a GitHub-hosted Ubuntu runner. It reads the exact Bun version from
.bun-version and installs the committed bun.lock with:

    bun install --frozen-lockfile --ignore-scripts

No dependency lifecycle scripts run. The job then runs bun run check and the
synthetic durable demo. The aggregate command performs real strict TypeScript
checking, type-aware stable Oxlint, formatting verification, and the unified
Bun-hosted Vitest suite with @effect/vitest. bun run test explicitly launches
Vitest through Bun; the runtime test checks process.versions.bun inside a worker.
Native SQLite/process tests keep real services, while pure contract properties
use Effect test services. Temporary fixtures are isolated per test or generated
property evaluation.
Native bun lint is not used because it is canary-only in stable Bun 1.4.4.

The token has contents: read only and checkout does not persist credentials.
No application secrets, write tokens, deployment jobs, publisher steps, or
repository data are supplied. DO_NOT_TRACK=1 disables Bun crash-report uploads
and telemetry. A five-minute timeout and cancellation of superseded runs bound
resource use. The workflow uses pull_request, not privileged pull_request_target.

Actions are pinned to verified official stable release commits:

- [actions/checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1):
  3d3c42e5aac5ba805825da76410c181273ba90b1.
- [oven-sh/setup-bun v2.2.0](https://github.com/oven-sh/setup-bun/releases/tag/v2.2.0):
  0c5077e51419868618aeaa5fe8019c62421857d6.

An action's internal Node runtime is separate from the Bun runtime that executes
project commands. Candidate code runs on an isolated runner, whereas the
Robodocks planner never executes source text from review fixtures.

The version-selection policy and canonical commands live in the README. Update
pins and lockfile together, verify install without scripts, and run the full
suite and demo on the actual selected runtime. Linux/Bun 1.4.4 reports SQLite
3.53.4 in local verification; macOS and Windows are not claimed tested. Diagnostics
must report the actual engine rather than infer it from the Bun version.

## Contributor acceptance criteria

Behavioral changes require focused regression coverage. For a bug fix, demonstrate
that the regression fails against the previous behavior where practical. Do not
weaken checks or skip regressions merely to obtain a green run. Before handoff,
run the [README's aggregate checks and synthetic demo](../README.md#setup-and-commands)
against the final tree; targeted tests do not replace them. Report what passed,
failed, or was not run, including the exact blocker for incomplete verification.

Local success is not hosted CI success. Inspect checks for the exact published
commit before treating the update as hosted-validated or ready to merge.

Verification limits: automated interruption checks cover Effect scope cleanup.
The queued-signal checkpoint after a blocking native SQLite call is code-reviewed,
not empirically reverified in a blocking-call signal scenario. Synchronous native
calls cannot be preempted, and an interrupted CLI may already have committed its
delivery. No power-loss/crash-recovery stress result is claimed by these checks.

Source-collector HTTP tests use injected synthetic transports. Collection CLI
tests preload a test-only fetch replacement in a separate Bun process; there is
no application environment variable or CLI flag to redirect the API. Normal CI
performs no source-collection network calls, loads no credentials and invokes no
model. Fixtures cover all supported change types, merge-base provenance,
identity rechecks, exact BOM/CRLF preservation, caps/omissions, blob integrity,
consumer completeness and independent attempt/content IDs. Live GitHub API
interoperability is not claimed by these synthetic tests.

## Installed artifact gate

The workflow also runs `bun run test:package`. See [packaging](packaging.md) for
the exact tarball contents, production-only clean installation, CLI smoke and
platform limits. The installed smoke also backs up a synthetic ledger, restores
it into a new path, verifies duplicate delivery replay and inspects retained
pending records. This is an artifact test, not a registry release or a real
cloud-environment replacement drill.

## Review gate for assistant-created pull requests

Open assistant-created changes as a draft PR, then review the full published
diff at its exact head commit before asking the user to approve it. Fix confirmed
errors within the authorized scope, review the resulting delta, and verify CI
for that updated exact head. Repeat this review-and-fix cycle until confirmed findings are fixed, or any
remaining finding is explicitly disclosed for the user’s decision, and the
required checks pass. If a change needs new
authorization or verification is blocked, report that boundary rather than
requesting approval as though the gate passed.

Only after this gate passes should the assistant request the user's approval.
A passing review is not a formal GitHub approval, merge permission, or deployment
authorization; those actions still require the applicable explicit user approval.
This is the project's contributor workflow, not a claim that GitHub branch
protection or a required approval rule has been configured.

## Formal-verification applicability

Every PR must identify the invariants its changes affect and state the evidence
used to check them, including "none changed" when appropriate. Ordinary changes
still require code review, focused regressions, relevant property tests and the
exact-head CI checks. For critical state transitions (admission, replay,
concurrency, recovery or future publishing), assess whether a formal model or
proof is warranted; update the applicable model when its contract changes, or
explain why it does not apply. Do not require a theorem prover for an unrelated
CLI text or stream-handling change.

The bounded [admission model](formal-verification.md) adds a TLC gate to CI.
A model-check result applies only to the stated finite model, assumptions and
invariants. A proof must name its specification, checker and implementation
connection. AI review, prose arguments and passing tests are not formal proofs;
model checking does not establish correctness of all TypeScript, Bun or SQLite.
Never relabel partial, failed or unexecuted verification as a passing gate.

Recovery changes preserve schema v1 and the admission/lifecycle transition
contract. The admission model assumes durable ledger state across reset; it
does not model filesystem snapshots, restore validation, atomic file promotion,
SQLite internals or loss of writes after an older snapshot. It is therefore not
a proof of backup/restore correctness. Recovery-specific regression tests and
the installed artifact flow provide implementation evidence; the existing TLC
and negative-control gate remains required for the admission model.

## Workspace preview verification

Workspace regressions use isolated temporary directories to exercise exclusive
root/task creation, strict identity metadata, conservative inventory statuses,
path and link guards, protected-content hints and bounded scans. The installed
artifact smoke exercises the public workspace CLI rather than only source
imports. Inventory must not mutate task contents or invoke Git/network services;
creation commands intentionally write metadata. Local checks do not establish
remote checkpoint durability, real process inactivity or safe deletion.

The existing admission/replay TLA model does not model workspace paths,
filesystem races or cleanup safety. No formal proof of workspace safety is
claimed; this first slice has no deletion transition. A future deletion feature
requires its own explicit invariants, evidence and authorization review.
