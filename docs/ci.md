# CI boundaries

The [workflow](../.github/workflows/ci.yml) runs on pull requests and pushes to
`main`, using a GitHub-hosted Ubuntu runner and Node.js **26.13.0 LTS**, read from
the exact `.nvmrc` pin. The supported engine range starts at that LTS release,
not at the earlier non-LTS 26.12.x releases. It runs
`npm run check` and the synthetic JSON demo. No dependency installation is needed.

The token has `contents: read` only, checkout does not persist credentials, package
caching is disabled, and no application secrets are supplied. There is no
publisher, deployment job, or repository-write step. A five-minute job timeout
and cancellation of superseded runs bound resource use.

Actions are pinned to immutable commits verified against their official releases:

- [actions/checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1):
  `3d3c42e5aac5ba805825da76410c181273ba90b1`.
- [actions/setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0):
  `949feb2413d6458794dcd2491c4babbbce0c15c1`.

The workflow uses `pull_request`, not privileged `pull_request_target`. CI executes
candidate code on its runner; that is separate from the Robodocks planner, which
never executes the source text in review fixtures. Do not add secrets or write
credentials to these tests. Review future action upgrades and workflow changes.
The project runtime pin is separate from an action's own internal JavaScript
runtime; the test commands run under the Node version installed by `setup-node`.

For updates, follow the README's LTS-first, stable-otherwise policy. Keep the
`.nvmrc` pin and minimum `package.json` engine version aligned, then verify the
full suite and demo on that actual runtime before treating the update as validated
or merging it.

Local execution of the same commands verifies the code, not GitHub runner startup,
repository Actions settings, or remote job success. Inspect the exact commit's
hosted checks after publication before reporting CI as passed.

Add pinned development dependencies, a lockfile, and a static type-check step
before claiming full TypeScript verification. This starter's `check` command is
syntax checking plus runtime tests, not a TypeScript compiler run.
