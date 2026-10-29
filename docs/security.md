# Security boundaries and limitations

## Trust model

**Trusted:** operator policy; an adapter's authenticated repository/PR identity,
fresh current-head SHA, and source snapshot fetched at the review SHA; the local
process and ledger owner. The JSON CLI is a fixture harness, not an authenticated
source adapter. A caller that invents both source and evidence can pass validation.

**Untrusted:** repository files, PR text, comments, proposed findings, and any
future model output. They may contain adversarial instructions, secrets, false
claims, or misleading confidence scores. They never select policy or call tools.

There is no model or command interpreter in the core. Adversarial instruction
text stays data. This is a small attack surface, **not a general prompt-injection
defense** for a future model integration.

## Enforced in this starter

- Strict object fields and bounded strings, counts, files, and ledger size.
- Only explicit `owner/repository` values in the operator allowlist. No wildcard.
  Identifiers are case-sensitive for now; adapters must use canonical names.
- Only `read-only` / publication `disabled`; unknown policy fields are rejected.
- Full lowercase SHA and exact trusted target matching; no abbreviated SHAs.
- Normalized relative POSIX paths, no traversal, absolute paths, backslashes,
  control characters, or drive prefixes. Paths are never opened by the core.
- Evidence must exactly match the complete cited lines, including whitespace.
  Ranges are inclusive, one-based, and at most 100 lines. No CRLF normalization.
- A failed batch changes no state. Duplicate deliveries create no new intent;
  reuse of the same delivery ID with different validated content is rejected.
- Candidate text cannot directly select the intent ID, write mode, destination,
  or acknowledgement state. Returned plans/snapshots cannot mutate the ledger.
- Pending proposals are not treated as already published. Acknowledgement and
  closure methods only record a caller's observation; they perform no API call.
- Closed exact observations stay suppressed. Closing an issue alone never produces a
  follow-up, reopens work, or proves a fix. Actual persistence verification is
  not implemented.

## Deliberately missing production guarantees

- Allowlisting is not GitHub authorization. There are no installation tokens,
  permission checks, webhook signatures, replay windows, or repo-rename handling.
- `currentHeadSha` is a caller-provided observation. A head can change immediately
  afterward. A future publisher must refetch the target and revalidate every
  pending intent at the moment of publication; this planner cannot prevent that
  external time-of-check/time-of-use race.
- The ledger is in memory, bounded, single-process, and non-durable. Lost process
  state loses replay/finding suppression. There is no atomic remote write or
  exactly-once delivery guarantee. A durable adapter needs an atomic outbox and
  remote reconciliation after uncertain writes.
- Finding identity uses repository, PR, exact head SHA, rule, path, line range,
  and exact evidence. This prevents conflating identical text at distinct source
  locations. It is exact-observation deduplication, not semantic identity: a new
  commit, changed location, or changed excerpt can produce another proposal.
  No algorithm currently reconciles findings across commits or verifies whether
  a recurring finding is the same bug. A future publisher must reconcile this
  before creating public follow-ups; closure events themselves create no work.
- Pending intents are retained as their original observations, even when later
  reviews use a newer head. They are not publication-ready, cannot be consumed
  blindly, and are not automatically refreshed or reconciled.
- A valid finding may still be wrong. Confidence is an unverified number from
  its author. There is no model-quality evaluation or factual bug verification.
- There is no Markdown renderer or secret redactor. JSON intents may contain
  sensitive or adversarial source text, mentions, links, or terminal escape text.
  Do not post them directly or store them in public logs. Add safe rendering,
  notification controls, secret screening, and data retention rules before any
  publisher or remote model provider is introduced.
- Repository build/test scripts are never run. A future executor must require
  separate authority and isolated, resource-limited execution without ambient
  secrets. A finding or repository instruction is not that authority.

## Adapter acceptance gates

Before adding live integration, demonstrate: authenticated event-to-repository
binding, operator-owned policy, SHA-bound snapshots, no untrusted tool selection,
stale-head rejection at publish time, durable replay protection, explicit write
authority, safe output rendering, uncertain-write recovery, and a verified
closure/persistence policy. Keep the reviewer usable without an executor.
