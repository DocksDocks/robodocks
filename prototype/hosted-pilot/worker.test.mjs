import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { test as nodeTest } from "node:test";
const test = (name, fn) => nodeTest(name, { timeout: 15_000 }, fn);

// Reuses the separately pinned D1 prototype test dependencies; no production dependency.
const { Miniflare } = createRequire(
  new URL("../d1/package.json", import.meta.url),
)("miniflare");
const script = await readFile(
  new URL("./worker/index.js", import.meta.url),
  "utf8",
);
const migrationFiles = (await readdir(new URL("./drizzle/", import.meta.url)))
  .filter((n) => n.endsWith(".sql"))
  .sort();
assert.ok(
  migrationFiles.length > 0,
  "Generated deployment migrations must exist",
);
const schema = (
  await Promise.all(
    migrationFiles.map((n) =>
      readFile(new URL("./drizzle/" + n, import.meta.url), "utf8"),
    ),
  )
).join("\n");
const headers = {
  "content-type": "application/json",
  "x-robodocks-pilot": "synthetic-v1",
};

async function fixture(t, { seed = true } = {}) {
  const mf = new Miniflare({
    cf: false,
    modules: true,
    script,
    compatibilityDate: "2026-07-30",
    d1Databases: ["DB"],
    outboundService: () => {
      throw new Error("External network forbidden in hosted pilot tests");
    },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  await db.batch(
    schema
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
  const fetch = (path, init) =>
    mf.dispatchFetch("https://pilot.invalid" + path, init);
  const post = async (path, body = "{}", extra = {}) => {
    const r = await fetch(path, {
      method: "POST",
      headers: { ...headers, ...extra },
      body,
    });
    return { status: r.status, data: await r.json() };
  };
  const status = async () => {
    const r = await fetch("/api/status");
    assert.equal(r.status, 200);
    return r.json();
  };
  if (seed)
    assert.deepEqual(await post("/api/seed"), {
      status: 200,
      data: { seeded: true, fixtures: 6 },
    });
  return { mf, db, fetch, post, status };
}

test("GET UI/status are read-only; local identity marker is not platform access proof", async (t) => {
  const { fetch, status } = await fixture(t, { seed: false });
  const before = await status();
  assert.deepEqual(before.state, {
    control: [],
    attempts: [],
    outbox: [],
    findings: [],
  });
  assert.equal(before.scope, "synthetic-no-post");
  assert.equal(before.identity, "no-visitor-identity");
  assert.match(before.build, /^[a-f0-9]{64}$/);
  const r = await fetch("/");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(await r.text(), /No publisher/);
  assert.deepEqual(await status(), before);
  const identified = await fetch("/api/status", {
    headers: { "oai-authenticated-user-id": "synthetic-local-marker" },
  });
  assert.equal((await identified.json()).identity, "signed-in-visitor");
  // Miniflare bypasses Sites dispatch: this is NOT an owner/anonymous access test.
});

test("seed is finite/idempotent and cannot clear an existing quarantine", async (t) => {
  const { post, status, db } = await fixture(t);
  const before = await status();
  assert.equal(before.state.outbox.length, 6);
  assert.equal(before.state.findings.length, 6);
  await post("/api/seed");
  assert.deepEqual(await status(), before);
  await db
    .prepare("UPDATE native_control SET quarantined = 1 WHERE id = 1")
    .run();
  await post("/api/seed");
  assert.deepEqual((await status()).state.control, [{ id: 1, quarantined: 1 }]);
  assert.deepEqual(await post("/api/reserve/concurrent"), {
    status: 200,
    data: { reserved: false },
  });
});

test("independent concurrent requests have exactly one confirmed reservation and no replay", async (t) => {
  const { post, status } = await fixture(t);
  const responses = await Promise.all(
    Array.from({ length: 12 }, () => post("/api/reserve/concurrent")),
  );
  assert.equal(
    responses.filter((r) => r.status === 200 && r.data.reserved === true)
      .length,
    1,
  );
  assert.equal(
    responses.filter((r) => r.status === 200 && r.data.reserved === false)
      .length,
    11,
  );
  assert.deepEqual(await post("/api/reserve/concurrent"), {
    status: 200,
    data: { reserved: false },
  });
  assert.deepEqual((await status()).state.attempts, [
    { intent_id: "pilot-v1-concurrent", status: "sending", comment_id: null },
  ]);
});

test("unknown is durable and never produces a new reservation", async (t) => {
  const { post, status } = await fixture(t);
  const first = await post("/api/probe/unknown");
  assert.deepEqual(first, {
    status: 200,
    data: {
      reserved: true,
      marked: true,
      retry: false,
      state: {
        intent_id: "pilot-v1-unknown",
        status: "unknown",
        comment_id: null,
      },
    },
  });
  const after = await status();
  assert.deepEqual(await post("/api/probe/unknown"), {
    status: 200,
    data: { alreadyRecorded: true, evidence: first.data },
  });
  assert.deepEqual(await status(), after);
});

test("failed D1 batch rolls back attempted reservation before a subsequent confirmed insert", async (t) => {
  const { post, status } = await fixture(t);
  const first = await post("/api/probe/failed-write");
  assert.deepEqual(first, {
    status: 200,
    data: {
      failure: "STORAGE_UNCERTAIN",
      afterFailure: null,
      confirmedReservationAfterRollback: true,
    },
  });
  assert.deepEqual((await status()).state.attempts, [
    { intent_id: "pilot-v1-failed-write", status: "sending", comment_id: null },
  ]);
  assert.deepEqual(await post("/api/probe/failed-write"), {
    status: 200,
    data: { alreadyRecorded: true, evidence: first.data },
  });
});

test("late D1 constraint failure atomically rolls back all acknowledgement changes", async (t) => {
  const { post } = await fixture(t);
  const { status, data } = await post("/api/probe/rollback");
  assert.equal(status, 200);
  assert.equal(data.reserved, true);
  assert.equal(data.failure, "STORAGE_UNCERTAIN");
  assert.equal(data.unchanged, true);
  assert.deepEqual(data.after, data.before);
  assert.deepEqual(data.after, {
    a: [
      { intent_id: "pilot-v1-rollback", status: "sending", comment_id: null },
    ],
    o: [
      { id: "pilot-v1-rollback", status: "pending", external_reference: null },
    ],
    f: [{ id: "pilot-v1-rollback", status: "proposed" }],
  });
});

test("injected loss after an actual committed D1 write is uncertain and cannot retry", async (t) => {
  const { post } = await fixture(t);
  assert.deepEqual(await post("/api/probe/lost-response"), {
    status: 200,
    data: {
      injection: "committed-write-then-thrown-result-not-network-fault",
      failure: "STORAGE_UNCERTAIN",
      retry: false,
      state: {
        intent_id: "pilot-v1-lost-response",
        status: "sending",
        comment_id: null,
      },
    },
  });
});

test("no arbitrary payload, SQL, fixture, URL, or method dispatch is accepted", async (t) => {
  const { post, fetch, status } = await fixture(t);
  const before = await status();
  for (const payload of [
    "1",
    "true",
    "null",
    "[]",
    "{",
    '{"sql":"DELETE FROM native_attempts"}',
    '{"url":"https://api.github.com"}',
    '{"fixture":"other"}',
  ]) {
    assert.equal((await post("/api/seed", payload)).status, 400, payload);
  }
  assert.equal((await post("/api/probe/unrecognized")).status, 400);
  assert.equal((await post("/api/activate")).status, 404);
  assert.equal((await fetch("/api/seed")).status, 404);
  assert.equal(
    (await fetch("/api/reserve/concurrent", { method: "DELETE" })).status,
    404,
  );
  assert.deepEqual(await status(), before);
});

test("cross-site or missing mutation headers and oversized bodies fail before writes", async (t) => {
  const { post, fetch, status } = await fixture(t, { seed: false });
  const before = await status();
  assert.equal(
    (await fetch("/api/seed", { method: "POST", body: "{}" })).status,
    403,
  );
  assert.equal(
    (await post("/api/seed", "{}", { origin: "https://other.invalid" })).status,
    403,
  );
  assert.equal(
    (await post("/api/seed", "{}", { "sec-fetch-site": "cross-site" })).status,
    403,
  );
  assert.equal(
    (await post("/api/seed", "{}", { "content-type": "text/plain" })).status,
    403,
  );
  assert.equal((await post("/api/seed", " ".repeat(129))).status, 413);
  assert.deepEqual(await status(), before);
});

test("same-probe concurrent callers execute once and return persisted evidence or uncertainty", async (t) => {
  const { post, status } = await fixture(t);
  for (const name of [
    "unknown",
    "failed-write",
    "rollback",
    "lost-response",
    "singleflight",
  ]) {
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => post("/api/probe/" + name)),
    );
    const winners = responses.filter(
      (r) => r.status === 200 && !r.data.alreadyRecorded,
    );
    assert.equal(winners.length, 1, name + ": exactly one probe execution");
    const winner = winners[0].data;
    for (const r of responses) {
      if (r.status === 400)
        assert.deepEqual(r.data, { error: "STORAGE_UNCERTAIN" });
      else {
        assert.equal(r.status, 200);
        if (r.data.alreadyRecorded) assert.deepEqual(r.data.evidence, winner);
        else assert.deepEqual(r.data, winner);
      }
    }
    assert.deepEqual(await post("/api/probe/" + name), {
      status: 200,
      data: { alreadyRecorded: true, evidence: winner },
    });
    const evidence = (await status()).evidence.filter((r) => r.name === name);
    assert.deepEqual(evidence, [{ name, evidence: winner }]);
  }
  const final = await status();
  assert.equal(final.state.attempts.length, 5);
  assert.equal(final.evidence.length, 5);
  assert.equal(
    final.state.attempts.find((r) => r.intent_id === "pilot-v1-unknown").status,
    "unknown",
  );
  assert.equal(
    final.state.attempts.find((r) => r.intent_id === "pilot-v1-singleflight")
      .status,
    "unknown",
  );
});

test("interrupted durable probe claims remain inconclusive and never re-execute", async (t) => {
  const { post, status, db } = await fixture(t);
  // Model crash after claim commit, both before any transition and after a
  // reservation commit. This is fixture injection, not a real process crash.
  for (const name of [
    "unknown",
    "failed-write",
    "rollback",
    "lost-response",
    "singleflight",
  ]) {
    await db
      .prepare("INSERT INTO pilot_evidence (name, evidence) VALUES (?, ?)")
      .bind(name, JSON.stringify({ status: "running" }))
      .run();
  }
  await db
    .prepare(
      "INSERT INTO native_attempts (intent_id, proposal, status, comment_id) SELECT id, proposal, 'sending', NULL FROM native_outbox WHERE id = ?",
    )
    .bind("pilot-v1-unknown")
    .run();
  const before = await status();
  for (const name of [
    "unknown",
    "failed-write",
    "rollback",
    "lost-response",
    "singleflight",
  ]) {
    assert.deepEqual(await post("/api/probe/" + name), {
      status: 400,
      data: { error: "STORAGE_UNCERTAIN" },
    });
    assert.deepEqual(await post("/api/probe/" + name), {
      status: 400,
      data: { error: "STORAGE_UNCERTAIN" },
    });
  }
  assert.deepEqual(await status(), before);
  assert.deepEqual(before.state.attempts, [
    { intent_id: "pilot-v1-unknown", status: "sending", comment_id: null },
  ]);
  assert.equal(
    before.evidence.filter((r) => r.evidence.status === "running").length,
    5,
  );
});
