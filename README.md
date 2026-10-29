# Robodocks

A generic, open-source foundation for repository automation: **reviewer first,
executor later**. The intended integration target is any explicitly authorized
GitHub repository, without project-specific business rules.

## Current status: a runnable dry-run foundation

This starter **does not discover bugs or perform AI code reviews yet**. It accepts
proposed findings, checks their structure and cited source evidence, and produces
structured publication intents for inspection. It makes no network requests and
cannot publish comments, open issues, modify source, merge, or deploy.

- Operator-owned repository allowlist; read-only and publication-disabled policy.
- Exact repository, pull request, commit SHA, file path, line, and evidence checks.
- Required impact, suggestion, severity, and confidence fields.
- Stale-head rejection before any ledger mutation.
- In-memory delivery deduplication, finding suppression, and pending intent state.
- Explicit simulated acknowledgement/closure transitions; closure never creates
  another issue or implies that a problem was fixed.
- Synthetic examples and tests; no credentials or project-specific context.

These checks establish **structural validity**, not factual correctness of the
finding, calibration of its confidence, or completeness of a review.

## Run locally

Use Node.js **24.12 or newer within the 24.x line**. There are no dependencies to
install and no build step.

```sh
npm run check
npm run demo
# Or emit only JSON, without npm's command banner:
node src/cli.ts --policy examples/policy.json --input examples/review.json
```

The sample has a fictional repository and a hand-authored empty-input finding.
The CLI returns a plan and ledger snapshot on stdout; validation errors are JSON
on stderr with a nonzero exit code. It reads only the two explicitly supplied
JSON files. File paths inside the review request are identifiers, not local files
to open. It does not load policy, scripts, or instructions from a repository.

Each CLI invocation starts with an empty ledger. Deduplication works only within
one `Reviewer` instance; snapshots are inspection output, not a supported durable
database or restart format. The in-memory ledger is capped at 10,000 deliveries
and findings and is not a concurrent or production worker.

## Library example

```ts
import { Reviewer } from "./src/reviewer.ts";

const reviewer = new Reviewer(operatorPolicy);
const first = reviewer.plan(reviewRequest);
const replay = reviewer.plan(reviewRequest); // duplicate; no new intents
const snapshot = reviewer.snapshot();       // detached inspection copy
```

See `examples/policy.json` for configuration and `examples/review.json` for the
request contract. Policy must come from the operator, outside pull-request
content. A future source adapter must obtain the current head and source snapshot
independently; the demo merely supplies synthetic values for those inputs.

## Architecture

```text
Operator policy ───────────────┐
Trusted source snapshot ──────┼─> validation ─> in-memory ledger ─> dry-run intents
Untrusted proposed findings ──┘                                    (JSON only)
```

- `src/contracts.ts`: explicit data contracts.
- `src/validation.ts`: bounded inputs, allowlist, target/evidence validation.
- `src/reviewer.ts`: deterministic planning, replay protection, lifecycle state.
- `src/cli.ts`: bounded JSON-file input and inspectable JSON output.

TypeScript's erasable syntax runs directly in Node. `npm run check` performs
syntax checks and runtime tests; it **does not perform static type checking**.
Node's built-in [TypeScript support](https://nodejs.org/docs/latest-v24.x/api/typescript.html)
strips types without checking them. A pinned TypeScript compiler and Node type
definitions can be added with the first tooling iteration.

## Roadmap, not implemented

1. Read-only GitHub adapter with verified installation/repository authorization,
   source snapshots bound to full SHAs, and authenticated webhook deliveries.
2. Pluggable reviewer provider and evaluation fixtures for real finding quality,
   with repository text treated as untrusted data rather than instructions.
3. Durable transactional storage and a separately authorized publisher, including
   current-head revalidation, rate limits, escaped output, and human controls.
4. Follow-up verification that distinguishes a closed issue from a verified fix.
   No automatic issue recreation is supported in this starter.
5. An isolated, explicitly authorized executor. Never grant execution permission
   just because the reviewer produced a finding.

There is no LLM provider, GitHub App, webhook server, publisher, sandbox runner,
credential handling, or deployment configuration here. A minimal read-only
[CI workflow](.github/workflows/ci.yml) runs the tests and synthetic demo; see
[docs/ci.md](docs/ci.md) for its boundaries.

Read the [security boundaries](docs/security.md) before designing adapters.

## License and provenance

MIT, copyright 2026 DocksDocks. See [LICENSE](LICENSE).

Robodocks was motivated by the idea of reusable repository automation, with
RoboOMP as a conceptual reference. This starter is original code; no RoboOMP
source code or private project configuration has been imported. If upstream code
is incorporated later, review its license and preserve all required notices.
