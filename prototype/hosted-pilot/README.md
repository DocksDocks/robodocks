# Owner-private synthetic hosted pilot

A reusable template, **not an operational publisher**. The separately instantiated
Site uses a fresh D1 binding; this directory contains no private Site ID, visitor
ID, URL, credentials or access allowlist. Do not point it at an existing ledger,
deploy it publicly, or widen its audience. See [native-host design](../../docs/native-host.md).

## Reproduce local checks

With Node 24.22.1, install the existing pinned emulator in `../d1`:

```sh
npm ci --prefix prototype/d1 --ignore-scripts --no-audit --no-fund
cd prototype/hosted-pilot
node scripts/assemble.mjs
npm test
cp .openai/hosting.example.json .openai/hosting.json
bash scripts/build.sh
node scripts/validate-artifact.mjs
```

`assemble.mjs` transforms the unchanged `../d1/storage.ts` plus `worker/handler.js`
into the committed self-contained `worker/index.js`. Its embedded build digest
covers both input files. Tests exercise that actual assembled Worker and all
checked-in Drizzle SQL using Miniflare/workerd; external Worker requests are
disabled. Tests do not emulate Sites authentication.

Schema source is `db/schema.ts`, generated with pinned dev-only drizzle-kit and
drizzle-orm (`npm ci --ignore-scripts`, `npm run db:generate`). The generated
schema is **not byte-identical to the original STRICT prototype migration**:
Drizzle's tables are non-STRICT, retain the checks/FKs/unique reservation keys,
and add `pilot_evidence`. It has no seeded records. No request runs DDL.

## Bounded interface

- `GET /`: minimal read-only status UI.
- `GET /api/status`: fixed synthetic state and first-run probe evidence.
- `POST /api/seed`: idempotently initialize exactly six fixed fixtures. It inserts
  a fresh control row with `quarantined=0` **only in this synthetic database**;
  it never updates/clears an existing quarantine. This differs from the original
  local prototype migration, which seeds `quarantined=1`.
- `POST /api/reserve/concurrent`: reserve the one fixed concurrency fixture.
- `POST /api/probe/{unknown,failed-write,rollback,lost-response,singleflight}`: fixed probes;
  no caller-selected SQL, proposal, target, URL, identity or body text.

POST requires JSON `{}`, maximum 128 bytes, `X-Robodocks-Pilot: synthetic-v1` and
same-origin browser metadata when supplied. This is CSRF/input hardening, **not
an authentication token**. Owner-private Sites dispatch is the authorization
boundary, including its supported service-access credential. Service access
supplies no visitor identity and does not prove owner-browser sign-in.

Each named probe claims its evidence row atomically before execution. Concurrent
or interrupted `running` claims fail uncertain without re-execution; completed
repeats return persisted evidence. No claim expiration, clear/reset endpoint or
automatic retry is available. Evidence presence/HTTP200 alone is not success:
assert the expected fields. A probe interrupted between state and evidence writes
is deliberately inconclusive. GET never runs or retries probes.

`failed-write` and `rollback` append an impossible SQL CHECK to a real D1 batch.
`lost-response` commits a real D1 batch then deliberately throws before returning
its result: application fault injection, **not a real network partition**.
Acknowledgement uses clearly synthetic fixed evidence, not GitHub observations.
No server-side outbound HTTP sender, GitHub key or live action is included.

## Private publication and evidence

Use the native Sites Worker ESM setup and source-workflow helper in a separate
private instance. Register once, persist its returned ID only there, set `d1` to
`DB`, copy exact assembled Worker and immutable generated migrations, then use
owner-private publication. The helper packages `drizzle/` for hosted migration.
Keep source commit, version, build digest and deployed Worker hash in the private
instance evidence; public evidence must omit private instance identity.

Hosted acceptance is separate from these local tests: confirm owner-only policy,
anonymous denial, service access vs authenticated owner access, independent
concurrent request results, explicit failure/no-retry predicates, and identical
stored state after a new deployment using the same Site and unchanged `DB`
binding. This is bounded redeployment persistence, not disaster recovery,
replication or multi-isolate overlap proof. No paid add-ons/domains, schedules,
GitHub credentials, publication activation or production restore are part of it.

The sixth `singleflight` fixture is a finite fresh post-upgrade probe. It does not
reset or delete the original five fixtures retained for redeployment comparison.
