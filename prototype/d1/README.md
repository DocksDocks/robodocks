# Local D1 publication-state prototype

This is isolated development tooling, not the Bun CLI, a deployable Site, or a
publisher. It is excluded from the CLI package. See the repository's native-host
design and security documentation for scope and operational gates.

```sh
npm ci --prefix prototype/d1 --ignore-scripts
(cd prototype/d1 && bun check --no-script)
npm test --prefix prototype/d1
```

Use the repository's Bun 1.4.4 and Node 24.22.1 (the locally verified runtime).
Node 22.13 or newer is required for the test harness's experimental
`stripTypeScriptTypes` API. Dependencies and integrity hashes are committed in the
isolated npm lockfile; no lifecycle scripts are required. Miniflare's upstream
stable release includes a pinned prerelease `youch` diagnostic dependency; the
prototype does not call its diagnostic UI. Runtime code has no npm dependencies.

The harness strips the actual adapter TypeScript and executes it inside a local
workerd isolate with Miniflare's real D1 binding. It disables external Worker
fetches and Miniflare's external `Request.cf` lookup. Fixtures use synthetic
identities, bodies and SQL only. The tests' HTTP dispatcher includes arbitrary
SQL and can clear quarantine **solely to arrange synthetic fixtures**. It has no
authentication and **must never be deployed or copied into a Site handler**.
There is no production unquarantine API in the adapter.

Tests cover concurrent reservations, exact bindings and evidence, ambiguous
commit responses, acknowledgement races, atomic three-row transitions, hard and
silent SQL failures, defensive input copies, default/missing quarantine controls,
and persistence across independent local workerd restarts. This does not test
hosted D1 replicas, production durability/failover, clock skew, a real GitHub
request, operational grants, or a full collector/publisher port. The official
Worker D1 type compatibility check does not substitute for runtime tests.
