import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";

const source = stripTypeScriptTypes(
  await readFile(new URL("storage.ts", import.meta.url), "utf8"),
  { mode: "transform" },
);
const migration = (
  await readFile(
    new URL("migrations/0001-publication.sql", import.meta.url),
    "utf8",
  )
)
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);
const script = `${source}
export default { async fetch(request, env) {
  const { op, p, evidence, statements } = await request.json();
  try {
    if (op === 'sql') return Response.json(await env.DB.batch(statements.map(([sql, ...values]) => env.DB.prepare(sql).bind(...values))));
    const db = op === 'lostReserve' ? {prepare: sql => env.DB.prepare(sql), batch: async statements => { await env.DB.batch(statements); throw new Error('lost result'); }} : env.DB;
    const store = new NativePublicationStore(db);
    if (op === 'mutateReserve') { const pending = store.reserve(p); p.intentId = 'mutated'; p.body = 'mutated'; return Response.json({result: await pending}); }
    if (op === 'mutateAck') { const pending = store.acknowledge(p,evidence); p.intentId = 'mutated'; evidence.body = 'mutated'; evidence.commentId = 900; return Response.json({result: await pending}); }
    const result = op === 'key' ? await proposalKey(p) : op === 'lostReserve' ? await store.reserve(p) : op === 'read' ? await store.read(p.intentId) : await store[op](p, evidence);
    return Response.json({ result });
  } catch (error) { return Response.json({ error: error.code ?? error.message }); }
}};`;
const body = "Josh here\nSynthetic publication fixture only.";
const proposal = (id = "intent-1") => ({
  intentId: id,
  repository: "example/project",
  repositoryId: 1,
  pullRequest: 2,
  pullRequestId: 3,
  headSha: "a".repeat(40),
  appId: 4,
  installationId: 5,
  botUserId: 6,
  body,
  bodyDigest: createHash("sha256").update(body).digest("hex"),
  rendererVersion: "pr-conversation-published-v1",
});
const comment = (p, commentId = 7) => ({
  commentId,
  repositoryId: p.repositoryId,
  pullRequestId: p.pullRequestId,
  issueUrl: `https://api.github.com/repos/${p.repository}/issues/${p.pullRequest}`,
  botUserId: p.botUserId,
  authorType: "Bot",
  body: p.body,
});
async function fixture(t, fresh = true) {
  const mf = new Miniflare({
    cf: false,
    modules: true,
    script,
    compatibilityDate: "2026-07-30",
    d1Databases: ["DB"],
    outboundService: () => {
      throw new Error("External network forbidden in prototype tests");
    },
  });
  t.after(() => mf.dispose());
  const call = async (op, p, evidence) =>
    (
      await mf.dispatchFetch("http://fixture.invalid", {
        method: "POST",
        body: JSON.stringify({ op, p, evidence }),
      })
    ).json();
  const sql = async (...statements) =>
    (
      await mf.dispatchFetch("http://fixture.invalid", {
        method: "POST",
        body: JSON.stringify({ op: "sql", statements }),
      })
    ).json();
  await sql(...migration.map((s) => [s]));
  const p = proposal();
  const key = (await call("key", p)).result;
  await sql(
    ["INSERT INTO native_findings VALUES (?, 'proposed')", "finding-1"],
    [
      "INSERT INTO native_outbox VALUES (?, ?, ?, 'pending', NULL)",
      p.intentId,
      "finding-1",
      key,
    ],
  );
  if (fresh)
    await sql(["UPDATE native_control SET quarantined = 0 WHERE id = 1"]);
  const states = async () => {
    const result = await sql([
      "SELECT a.status AS attempt, a.comment_id, o.status AS outbox, o.external_reference, f.status AS finding FROM native_attempts a JOIN native_outbox o ON o.id = a.intent_id JOIN native_findings f ON f.id = o.finding_id",
    ]);
    return result[0].results[0];
  };
  return { call, sql, p, states };
}

test("default quarantine and missing control both refuse claims", async (t) => {
  const { call, sql, p } = await fixture(t, false);
  assert.deepEqual(await call("reserve", p), { result: false });
  await sql(["DELETE FROM native_control"]);
  assert.deepEqual(await call("reserve", p), { result: false });
});
test("twenty simultaneous claims yield exactly one confirmed insertion", async (t) => {
  const { call, p } = await fixture(t);
  const results = await Promise.all(
    Array.from({ length: 20 }, () => call("reserve", p)),
  );
  assert.equal(results.filter((r) => r.result === true).length, 1);
  assert.equal(results.filter((r) => r.result === false).length, 19);
});
test("every stored proposal binding is exact", async (t) => {
  const { call, p } = await fixture(t);
  for (const delta of [
    { repositoryId: 9 },
    { repository: "other/project" },
    { pullRequest: 9 },
    { pullRequestId: 9 },
    { headSha: "b".repeat(40) },
    { appId: 9 },
    { installationId: 9 },
    { botUserId: 9 },
  ])
    assert.deepEqual(await call("reserve", { ...p, ...delta }), {
      result: false,
    });
  assert.deepEqual(
    await call("reserve", {
      ...p,
      body: "different",
      bodyDigest: createHash("sha256").update("different").digest("hex"),
    }),
    { result: false },
  );
  assert.deepEqual(await call("reserve", { ...p, body: "different" }), {
    error: "INPUT",
  });
  assert.deepEqual(await call("reserve", p), { result: true });
});
test("unknown never resends, but exact positive evidence acknowledges atomically", async (t) => {
  const { call, p, states } = await fixture(t);
  assert.deepEqual(await call("reserve", p), { result: true });
  assert.deepEqual(await call("markUnknown", p), { result: true });
  assert.deepEqual(await call("reserve", p), { result: false });
  assert.deepEqual(await call("acknowledge", p, comment(p)), { result: true });
  assert.deepEqual(await states(), {
    attempt: "acknowledged",
    comment_id: 7,
    outbox: "acknowledged",
    external_reference: "github-comment:7",
    finding: "published",
  });
  assert.deepEqual(await call("acknowledge", p, comment(p)), { result: false });
  assert.deepEqual(await call("reserve", p), { result: false });
  assert.deepEqual(await call("markUnknown", p), { result: false });
});
test("evidence mismatch cannot acknowledge", async (t) => {
  const { call, p, states } = await fixture(t);
  await call("reserve", p);
  for (const delta of [
    { commentId: 0 },
    { repositoryId: 9 },
    { pullRequestId: 9 },
    { issueUrl: "https://api.github.com/repos/other/project/issues/2" },
    { botUserId: 9 },
    { authorType: "User" },
    { body: p.body + "\n" },
  ])
    assert.deepEqual(
      await call("acknowledge", p, { ...comment(p), ...delta }),
      { error: "INPUT" },
    );
  assert.equal((await states()).attempt, "sending");
});
test("acknowledgement wins against simultaneous unknown without regression", async (t) => {
  const { call, p, states } = await fixture(t);
  await call("reserve", p);
  await Promise.all([
    call("markUnknown", p),
    call("acknowledge", p, comment(p)),
  ]);
  assert.equal((await states()).attempt, "acknowledged");
  assert.equal((await states()).finding, "published");
});
for (const conflicting of [false, true])
  test(`concurrent ${conflicting ? "conflicting" : "identical"} acknowledgements have one winner`, async (t) => {
    const { call, p, states } = await fixture(t);
    await call("reserve", p);
    const results = await Promise.all([
      call("acknowledge", p, comment(p, 7)),
      call("acknowledge", p, comment(p, conflicting ? 8 : 7)),
    ]);
    assert.equal(results.filter((r) => r.result === true).length, 1);
    assert.equal(results.filter((r) => r.result === false).length, 1);
    const state = await states();
    assert.equal(
      state.external_reference,
      `github-comment:${state.comment_id}`,
    );
  });
for (const action of ["ABORT, 'synthetic failure'", "IGNORE"])
  test(`outbox trigger RAISE(${action}) rolls back entire acknowledgement`, async (t) => {
    const { call, sql, p, states } = await fixture(t);
    await call("reserve", p);
    await sql([
      `CREATE TRIGGER reject_ack BEFORE UPDATE ON native_outbox BEGIN SELECT RAISE(${action}); END`,
    ]);
    assert.deepEqual(await call("acknowledge", p, comment(p)), {
      error: "STORAGE_UNCERTAIN",
    });
    assert.deepEqual(await states(), {
      attempt: "sending",
      comment_id: null,
      outbox: "pending",
      external_reference: null,
      finding: "proposed",
    });
  });
test("lost committed reservation result never authorizes retry", async (t) => {
  const { call, p } = await fixture(t);
  assert.deepEqual(await call("lostReserve", p), {
    error: "STORAGE_UNCERTAIN",
  });
  assert.deepEqual(await call("reserve", p), { result: false });
  assert.deepEqual(await call("read", p), {
    result: { intent_id: p.intentId, status: "sending", comment_id: null },
  });
});
test("restored/imported quarantine blocks new claims but permits positive reconciliation", async (t) => {
  const { call, sql, p, states } = await fixture(t);
  await call("reserve", p);
  await sql(["UPDATE native_control SET quarantined = 1"]);
  assert.deepEqual(await call("reserve", p), { result: false });
  assert.deepEqual(await call("acknowledge", p, comment(p)), { result: true });
  assert.equal((await states()).finding, "published");
});

test("absent intent and closed finding refuse claims", async (t) => {
  const { call, sql, p } = await fixture(t);
  assert.deepEqual(await call("reserve", { ...p, intentId: "absent" }), {
    result: false,
  });
  await sql(["UPDATE native_findings SET status = 'closed'"]);
  assert.deepEqual(await call("reserve", p), { result: false });
});
test("caller mutation during crypto cannot change reserve or acknowledgement", async (t) => {
  const { call, p, states } = await fixture(t);
  assert.deepEqual(await call("mutateReserve", p), { result: true });
  assert.deepEqual(await call("mutateAck", p, comment(p)), { result: true });
  assert.equal((await states()).comment_id, 7);
});
test("reservation persists across independent workerd restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "robodocks-d1-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    cf: false,
    modules: true,
    script,
    compatibilityDate: "2026-07-30",
    d1Databases: { DB: "restart-db" },
    d1Persist: directory,
    outboundService: () => {
      throw new Error("External network forbidden");
    },
  };
  let mf = new Miniflare(options);
  const dispatch = async (data) =>
    (
      await mf.dispatchFetch("http://fixture.invalid", {
        method: "POST",
        body: JSON.stringify(data),
      })
    ).json();
  const p = proposal();
  try {
    await dispatch({ op: "sql", statements: migration.map((s) => [s]) });
    const key = (await dispatch({ op: "key", p })).result;
    await dispatch({
      op: "sql",
      statements: [
        ["UPDATE native_control SET quarantined=0"],
        ["INSERT INTO native_findings VALUES ('finding-1','proposed')"],
        [
          "INSERT INTO native_outbox VALUES (?,'finding-1',?,'pending',NULL)",
          p.intentId,
          key,
        ],
      ],
    });
    assert.deepEqual(await dispatch({ op: "reserve", p }), { result: true });
  } finally {
    await mf.dispose();
  }
  mf = new Miniflare(options);
  try {
    assert.deepEqual(await dispatch({ op: "reserve", p }), { result: false });
    assert.deepEqual(await dispatch({ op: "read", p }), {
      result: { intent_id: p.intentId, status: "sending", comment_id: null },
    });
  } finally {
    await mf.dispose();
  }
});

test("proposal shape rejects coercible strings and oversized repository", async (t) => {
  const { call, p } = await fixture(t);
  for (const delta of [
    { repository: [p.repository] },
    { headSha: [p.headSha] },
    { bodyDigest: [p.bodyDigest] },
    { repository: "a".repeat(201) + "/b" },
  ])
    assert.deepEqual(await call("key", { ...p, ...delta }), { error: "INPUT" });
});
