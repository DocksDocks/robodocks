import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "@effect/vitest";
import { Effect } from "effect";
import { inspectLedger } from "../src/inspection.ts";
import { backupLedger, restoreLedger } from "../src/recovery.ts";
import { database, expectCode, fixtures, runReviewer } from "./helpers.ts";

const run = Effect.runPromise;
async function populated() {
  const { policy, request } = fixtures();
  const source = database();
  const plan = await runReviewer(
    policy,
    (reviewer) => reviewer.plan(request),
    source,
  );
  return {
    policy,
    request,
    source,
    plan,
    backup: join(dirname(source), "snapshot.sqlite"),
  };
}

test("WAL-backed snapshot restores replay, pending and acknowledged state into a fresh directory", async () => {
  const { policy, request, source, plan, backup } = await populated();
  // Keep a reader open and disable writer checkpoint to prove main-only copying
  // would lose a committed delivery which our supported snapshot includes.
  const writer = new Database(source);
  writer.run("PRAGMA wal_autocheckpoint=0; BEGIN");
  writer.query("SELECT * FROM deliveries").all();
  try {
    const second = structuredClone(request);
    second.deliveryId = "delivery-two";
    second.findings[0]!.ruleId = "second-rule";
    await runReviewer(
      policy,
      (reviewer) =>
        Effect.gen(function* () {
          yield* reviewer.plan(second);
          yield* reviewer.recordPublication(plan.intents[0]!.id, "comment:123");
        }),
      source,
    );
    assert.ok(statSync(source + "-wal").size > 0);
    const before = await runReviewer(
      policy,
      (reviewer) => reviewer.snapshot(),
      source,
    );
    const metadata = await run(backupLedger(policy, source, backup));
    assert.equal(metadata.deliveries, 2);
    assert.equal(metadata.intents, 2);
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    assert.equal(statSync(backup).nlink, 1);
    const snapshotBytes = readFileSync(backup);
    const directory = join(dirname(source), "fresh");
    mkdirSync(directory);
    const restored = join(directory, "ledger.sqlite");
    assert.equal(
      (await run(restoreLedger(policy, backup, restored))).cursorAction,
      "restart",
    );
    assert.deepEqual(
      await runReviewer(policy, (reviewer) => reviewer.snapshot(), restored),
      before,
    );
    assert.equal(
      (
        await runReviewer(
          policy,
          (reviewer) => reviewer.plan(request),
          restored,
        )
      ).deliveryStatus,
      "duplicate",
    );
    const conflicting = structuredClone(request);
    conflicting.findings[0]!.title = "different title";
    await assert.rejects(
      runReviewer(policy, (reviewer) => reviewer.plan(conflicting), restored),
      /different request/,
    );
    const third = structuredClone(request);
    third.deliveryId = "new-delivery";
    assert.equal(
      (await runReviewer(policy, (reviewer) => reviewer.plan(third), restored))
        .deliveryStatus,
      "accepted",
    );
    assert.deepEqual(readFileSync(backup), snapshotBytes);
    assert.deepEqual(
      await runReviewer(policy, (reviewer) => reviewer.snapshot(), source),
      before,
    );
  } finally {
    writer.run("ROLLBACK");
    writer.close(true);
  }
});

test("old backup deliberately excludes later deliveries rather than promising rollback-safe dedup", async () => {
  const { policy, request, source, backup } = await populated();
  await run(backupLedger(policy, source, backup));
  request.deliveryId = "post-backup";
  await runReviewer(policy, (reviewer) => reviewer.plan(request), source);
  const restored = database();
  await run(restoreLedger(policy, backup, restored));
  assert.equal(
    (await runReviewer(policy, (reviewer) => reviewer.plan(request), restored))
      .deliveryStatus,
    "accepted",
  );
});

for (const kind of [
  "existing",
  "source",
  "hardlink",
  "symlink",
  "dangling",
  "wal",
  "shm",
  "journal",
] as const) {
  test(`recovery never replaces ${kind} destination`, async () => {
    const { policy, source, backup } = await populated();
    let destination = backup;
    if (kind === "source") destination = source;
    if (kind === "existing") writeFileSync(destination, "");
    if (kind === "hardlink") linkSync(source, destination);
    if (kind === "symlink") symlinkSync(source, destination);
    if (kind === "dangling") symlinkSync(source + ".absent", destination);
    if (["wal", "shm", "journal"].includes(kind))
      writeFileSync(destination + "-" + kind, "sentinel");
    const original = readFileSync(source);
    await assert.rejects(run(backupLedger(policy, source, destination)));
    assert.deepEqual(readFileSync(source), original);
    assert.ok(
      !readdirSync(dirname(source)).some((name) =>
        name.startsWith(".robodocks-recovery-"),
      ),
    );
  });
}

test("recovery rejects source symlinks, symlink parents and absent destination parents", async () => {
  const { policy, source, backup } = await populated();
  const alias = source + ".alias";
  symlinkSync(source, alias);
  await run(expectCode(backupLedger(policy, alias, backup), "RECOVERY_SOURCE"));
  const directoryAlias = source + ".directory";
  symlinkSync(dirname(source), directoryAlias);
  await run(
    expectCode(
      backupLedger(policy, source, join(directoryAlias, "copy")),
      "DATABASE_PATH",
    ),
  );
  await run(
    expectCode(
      backupLedger(policy, source, join(dirname(source), "absent", "copy")),
      "DATABASE_PATH",
    ),
  );
});

const corruptions: Record<string, string> = {
  "payload identity":
    "UPDATE outbox SET payload=json_set(payload,'$.title','')",
  "orphan intent":
    "PRAGMA foreign_keys=OFF; UPDATE outbox SET finding_id='missing'",
  "missing delivery coverage": "DELETE FROM deliveries",
  "missing intent": "DELETE FROM outbox",
  "delivery id": "UPDATE deliveries SET id='bad id'",
  "oversized delivery": "UPDATE deliveries SET id=printf('%0300000d',1)",
  "oversized migration":
    "UPDATE schema_migrations SET applied_at=printf('%0300000d',1)",
  "delivery digest": "UPDATE deliveries SET digest='bad'",
  "unauthorized delivery": "UPDATE deliveries SET repository='other/repo'",
  "unauthorized finding": "UPDATE findings SET repository='other/repo'",
  "nonpositive rowid": "UPDATE findings SET rowid=-1",
  "migration history": "UPDATE schema_migrations SET name='forged'",
  "newer schema": "PRAGMA user_version=2",
  "foreign owner": "PRAGMA application_id=42",
  "extra trigger":
    "CREATE TRIGGER forged AFTER INSERT ON deliveries BEGIN DELETE FROM findings; END",
  "weakened schema": "ALTER TABLE deliveries ADD COLUMN injected TEXT",
  "inconsistent lifecycle": "UPDATE findings SET status='published'",
};
for (const [name, sql] of Object.entries(corruptions)) {
  test(`invalid ${name} fails without a promoted artifact`, async () => {
    const { policy, source, backup } = await populated();
    const db = new Database(source);
    try {
      db.run(sql);
    } finally {
      db.close(true);
    }
    const before = readFileSync(source);
    await assert.rejects(run(restoreLedger(policy, source, backup)));
    assert.equal(existsSync(backup), false);
    assert.deepEqual(readFileSync(source), before);
    assert.ok(
      !readdirSync(dirname(source)).some((entry) =>
        entry.startsWith(".robodocks-recovery-"),
      ),
    );
  });
}

test("truncated input fails and never initializes destination", async () => {
  const { policy, source, backup } = await populated();
  const broken = source + ".broken";
  copyFileSync(source, broken);
  writeFileSync(broken, readFileSync(broken).subarray(0, 100));
  await assert.rejects(run(restoreLedger(policy, broken, backup)));
  assert.equal(existsSync(backup), false);
});

test("forged migration view is rejected by schema without evaluating its body", async () => {
  const { policy, source, backup } = await populated();
  const db = new Database(source);
  try {
    db.run(
      "DROP TABLE schema_migrations; CREATE VIEW schema_migrations AS SELECT 1 AS version, json('malformed') AS name",
    );
  } finally {
    db.close(true);
  }
  await run(
    expectCode(restoreLedger(policy, source, backup), "STORAGE_INTEGRITY"),
  );
  assert.equal(existsSync(backup), false);
});

test("source and destination cannot overlap SQLite sidecar names", async () => {
  const { policy, source } = await populated();
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    await run(
      expectCode(
        backupLedger(policy, source, source + suffix),
        "RECOVERY_DESTINATION",
      ),
    );
  }
});

test("oversized payload is rejected before decoding", async () => {
  const { policy, source, backup } = await populated();
  const db = new Database(source);
  try {
    db.run("UPDATE outbox SET payload = ?", [
      JSON.stringify({ padding: "x".repeat(262144) }),
    ]);
  } finally {
    db.close(true);
  }
  await run(
    expectCode(restoreLedger(policy, source, backup), "STORAGE_INTEGRITY"),
  );
  assert.equal(existsSync(backup), false);
});

test("restored inspection starts a fresh cursor sequence for every logical record", async () => {
  const { policy, request, source, backup } = await populated();
  const second = structuredClone(request);
  second.deliveryId = "cursor-second";
  second.findings[0]!.ruleId = "cursor.second";
  await runReviewer(policy, (reviewer) => reviewer.plan(second), source);
  const db = new Database(source);
  try {
    db.run("UPDATE findings SET rowid=rowid*10");
  } finally {
    db.close(true);
  }
  const query = {
    repository: request.context.repository,
    status: "all" as const,
    limit: 1,
  };
  const original = await run(inspectLedger(policy, source, query));
  assert.ok(original.nextCursor);
  await run(backupLedger(policy, source, backup));
  const restored = database();
  assert.equal(
    (await run(restoreLedger(policy, backup, restored))).cursorAction,
    "restart",
  );
  // Old cursors are not guaranteed to fail: no cross-database identity exists.
  // Obey the explicit reset contract rather than asserting accidental rowids.
  const first = await run(inspectLedger(policy, restored, query));
  assert.ok(first.nextCursor);
  const next = await run(
    inspectLedger(policy, restored, { ...query, cursor: first.nextCursor }),
  );
  assert.equal(next.nextCursor, null);
  const expected = await run(
    inspectLedger(policy, source, { ...query, limit: 100 }),
  );
  assert.deepEqual([...first.items, ...next.items], expected.items);
});
