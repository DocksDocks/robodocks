# CI boundaries

The [workflow](../.github/workflows/ci.yml) runs on pull requests and pushes to
main, on a GitHub-hosted Ubuntu runner. It reads the exact Bun version from
.bun-version and installs the committed bun.lock with:

    bun install --frozen-lockfile --ignore-scripts

No dependency lifecycle scripts run. The job then runs bun run check and the
synthetic durable demo. The aggregate command performs real strict TypeScript
checking, type-aware stable Oxlint, formatting verification, and Bun tests.
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

Local success is not hosted CI success. Inspect checks for the exact published
commit before treating the update as hosted-validated or ready to merge.
