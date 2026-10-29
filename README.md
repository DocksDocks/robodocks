# Robodocks

A generic, open-source foundation for repository automation: **reviewer first,
executor later**. The integration target is any explicitly authorized GitHub
repository, without project-specific business rules.

## Current status: a runnable dry-run foundation

This starter **does not discover bugs or perform AI code reviews yet**. It accepts
proposed findings, validates their structure and cited evidence, and reserves
structured publication intents in a local SQLite ledger. It cannot publish
comments, open issues, modify reviewed source, merge, or deploy.

- Operator-owned repository allowlist and publication-disabled policy.
- Exact repository, pull request, SHA, path, line, and evidence checks.
- Required impact, suggestion, severity, and confidence fields.
- Stale-head rejection before finding state changes.
- Durable delivery/finding deduplication and transactional pending intent state.
- Typed Effect errors, scoped resources, and a single Effect Schema contract.
- Explicit acknowledgement/closure observations; no automatic follow-up issues.
- Synthetic examples and tests, without credentials or private project context.

These checks establish **structural validity**, not factual correctness,
confidence calibration, or review completeness. "Read-only" applies to reviewed
repositories and external services; the selected local ledger is written.

## Setup and commands

Use **Bun 1.4.4**, pinned in .bun-version. Bun supplies the runtime, package
manager, formatter, test runner, and strict TypeScript checker. There is no Node
runtime or npm installation step.

Set DO_NOT_TRACK=1 in your environment to disable Bun crash-report uploads and
telemetry. CI sets it explicitly. No application credentials are needed.

    bun install --frozen-lockfile --ignore-scripts
    bun run check
    bun run demo

The demo explicitly uses local/demo.sqlite, creating its parent directory when
needed. Repeating it reopens the same ledger: no duplicate intent is created and
the original pending intent remains in the snapshot. For another experiment,
choose a different database file instead of deleting an existing working ledger.

To emit only JSON without a package-script banner:

    bun src/cli.ts --policy examples/policy.json --input examples/review.json --database local/demo.sqlite

The CLI reads the two explicitly supplied JSON inputs and writes only its
explicitly selected local SQLite ledger (including SQLite WAL/SHM sidecars).
Repository paths inside an input are identifiers, not local files to execute or
open. Policy is never loaded from pull-request content. Errors are JSON on stderr
with a nonzero exit code; output may contain source evidence, so keep it private.

Development commands:

| Command                     | Purpose                                              |
| --------------------------- | ---------------------------------------------------- |
| bun check --no-script       | Strict, no-emit TypeScript checking                  |
| bun fmt --no-script         | Format supported project files                       |
| bun fmt --no-script --check | Require formatting without rewriting files           |
| bun run lint                | Stable Oxlint with type-aware rules, zero warnings   |
| bun test                    | Contract, CLI, resource, and SQLite regression tests |
| bun run check               | Type checking, lint, formatting check, and tests     |

The --no-script switches select Bun's built-in commands rather than similarly
named package scripts. Bun 1.4.4 does **not** expose native bun lint; that command
is canary-only in this release, so stable Oxlint is used instead.

Strict checking includes tests, dependency declarations, unchecked indexed
access, exact optional properties, unused code, and no implicit overrides.
TypeScript 7.0.2 is pinned as a compatible editor baseline; Bun performs the
actual strict-check gate and may incorporate newer checker behavior.
There is no separate transpilation or build step.

## Library boundary

Use withReviewer from src/reviewer.ts. Its callback receives an Effect-based
reviewer; the database connection closes when the scoped program finishes.

    import { Effect } from "effect";
    import { withReviewer } from "./src/reviewer.ts";

    const program = withReviewer(operatorPolicy, "local/review.sqlite", reviewer =>
      Effect.gen(function* () {
        const first = yield* reviewer.plan(reviewRequest);
        const replay = yield* reviewer.plan(reviewRequest);
        return { first, replay, snapshot: yield* reviewer.snapshot() };
      })
    );
    const result = await Effect.runPromise(program);

Inputs are illustrated in examples/policy.json and examples/review.json. A future
source adapter must authenticate the repository and independently fetch the
current head and SHA-bound source snapshot. The demo uses synthetic observations.

## Version selection policy

Prefer the latest supported LTS release where an official LTS channel exists;
otherwise choose the latest compatible stable release. Do not use prereleases or
canaries by default. Verify upstream status and compatibility, pin the reviewed
version, update the lockfile, and run the full checks before treating an update as
validated. This does not authorize production deployment or automatic upgrades.

Current direct dependencies are pinned: Effect 4.1.0, Bun types 1.4.4, TypeScript
7.0.2, Oxlint 1.90.0, and its type-aware engine 7.0.2005. Bun has no official LTS
channel; this project uses its verified stable release. Effect's explicitly
unstable SQL APIs are intentionally avoided: storage uses built-in bun:sqlite
behind a small Effect resource boundary. See the
[Effect release](https://github.com/Effect-TS/effect/releases/tag/effect@4.1.0),
[Bun release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4), and
[Oxlint release](https://github.com/oxc-project/oxc/releases/tag/oxlint_v1.90.0).

## Architecture and operational limits

Read [architecture](docs/architecture.md), [security](docs/security.md), and
[CI](docs/ci.md). AGENTS.md points to these canonical documents rather than
maintaining another instruction tree.

The ledger is designed for a local filesystem and a small single-host workload.
It verifies WAL, FULL synchronous mode, foreign keys, a five-second busy timeout,
and SQLite 3.51.3 or newer. Diagnostics report the **actual** SQLite version.
Bun can use system SQLite on macOS, so a Bun version pin alone does not guarantee
the same SQLite engine across operating systems. Linux is the verification
target; macOS and Windows are not claimed tested. No network/shared filesystem,
multi-host coordination, backup automation, or external exactly-once guarantee
is provided. The ledger has a 10,000-delivery/finding capacity.

## Roadmap, not implemented

1. Read-only GitHub adapter: authenticated repository/installation binding and
   independently verified SHA-bound snapshots.
2. Pluggable AI reviewer and quality evaluations, treating repository text as
   untrusted data rather than instructions.
3. Separately authorized publisher: fresh-head checks, rendering/redaction,
   rate limits, human controls, and uncertain-write reconciliation.
4. Cross-commit finding reconciliation and verified persistence/fix follow-ups.
5. An isolated executor with separate, explicit authority.

There is no LLM provider, GitHub App, webhook server, publisher, sandbox executor,
application credential handling, or deployment job in this starter.

## License and provenance

MIT, copyright 2026 DocksDocks. See [LICENSE](LICENSE).

RoboOMP is a conceptual reference for reusable repository automation. This
starter is original code; no upstream source or private project configuration
has been imported. Preserve applicable notices if upstream code is added later.
