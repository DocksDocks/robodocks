import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { test } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";
import { hash } from "../src/observations.ts";
import { backupLedger, restoreLedger } from "../src/recovery.ts";
import {
  PUBLICATION_SCHEMA_SQL,
  initializePublicationLedger,
  migratePublicationLedger,
} from "../src/storage.ts";
import { database, expectCode, fixtures, runReviewer } from "./helpers.ts";

const run = Effect.runPromise;
function inspect(filename: string) {
  const db = new Database(filename, { readonly: true });
  try {
    return {
      version: db
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get()!.user_version,
      control: db.query("SELECT * FROM publication_control").get(),
      attempts: db.query("SELECT * FROM publication_attempts").all(),
    };
  } finally {
    db.close(true);
  }
}

test("publication v2 initialization is exclusive; explicit legacy migration quarantines and is idempotent", async () => {
  const { policy, request } = fixtures();
  const fresh = database();
  await run(initializePublicationLedger(fresh));
  assert.deepEqual(inspect(fresh).control, { id: 1, restored: 0 });
  await run(expectCode(initializePublicationLedger(fresh), "STORAGE"));
  assert.deepEqual(inspect(fresh).control, { id: 1, restored: 0 });
  await runReviewer(policy, (reviewer) => reviewer.plan(request), fresh);
  const legacy = database();
  const plan = await runReviewer(
    policy,
    (reviewer) => reviewer.plan(request),
    legacy,
  );
  assert.deepEqual(await run(migratePublicationLedger(legacy)), {
    schemaVersion: 2,
    migrated: true,
  });
  assert.deepEqual(inspect(legacy).control, { id: 1, restored: 1 });
  assert.deepEqual(await run(migratePublicationLedger(legacy)), {
    schemaVersion: 2,
    migrated: false,
  });
  const snapshot = await runReviewer(
    policy,
    (reviewer) => reviewer.snapshot(),
    legacy,
  );
  assert.equal(snapshot.outbox[0]!.id, plan.intents[0]!.id);
});

for (const status of ["sending", "unknown", "acknowledged"] as const) {
  test(`recovery preserves ${status} publication history and quarantines every v2 copy`, async () => {
    const { policy, request } = fixtures();
    const source = database();
    await run(initializePublicationLedger(source));
    const plan = await runReviewer(
      policy,
      (reviewer) => reviewer.plan(request),
      source,
    );
    const intent = plan.intents[0]!;
    const db = new Database(source);
    const body = "Frozen body";
    try {
      db.run(
        "INSERT INTO publication_attempts (intent_id,repository,repository_id,pull_request_id,pull_request,head_sha,app_id,installation_id,bot_user_id,body,body_digest,renderer_version,status,comment_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          intent.id,
          request.context.repository,
          1,
          2,
          request.context.pullRequest,
          request.context.headSha,
          3,
          4,
          5,
          body,
          hash(body),
          "pr-conversation-published-v1",
          status,
          status === "acknowledged" ? 6 : null,
        ],
      );
      if (status === "acknowledged") {
        db.run(
          "UPDATE outbox SET status='acknowledged', external_reference='github-comment:6'",
        );
        db.run("UPDATE findings SET status='published'");
      }
    } finally {
      db.close(true);
    }
    const before = inspect(source);
    const backup = join(dirname(source), "backup.sqlite");
    const restored = join(dirname(source), "restored.sqlite");
    assert.equal(
      (await run(backupLedger(policy, source, backup))).schemaVersion,
      2,
    );
    assert.deepEqual(inspect(source), before);
    assert.deepEqual(inspect(backup).attempts, before.attempts);
    assert.deepEqual(inspect(backup).control, { id: 1, restored: 1 });
    await run(restoreLedger(policy, backup, restored));
    assert.deepEqual(inspect(restored), inspect(backup));
    await run(migratePublicationLedger(restored));
    assert.deepEqual(inspect(restored).control, { id: 1, restored: 1 });
    const corrupt = new Database(source);
    try {
      corrupt.run("UPDATE publication_attempts SET body='changed'");
    } finally {
      corrupt.close(true);
    }
    await run(
      expectCode(
        backupLedger(policy, source, join(dirname(source), "invalid.sqlite")),
        "STORAGE_INTEGRITY",
      ),
    );
  });
}

test("v1 backup and restore remain v1; subsequent explicit migration is quarantined", async () => {
  const { policy, request } = fixtures();
  const source = database();
  await runReviewer(policy, (reviewer) => reviewer.plan(request), source);
  const target = join(dirname(source), "restored.sqlite");
  assert.equal(
    (await run(restoreLedger(policy, source, target))).schemaVersion,
    1,
  );
  await run(migratePublicationLedger(target));
  assert.deepEqual(inspect(target).control, { id: 1, restored: 1 });
});

test("explicit migration rejects incompatible schema without adding publication tables", async () => {
  const { policy, request } = fixtures();
  const source = database();
  await runReviewer(policy, (reviewer) => reviewer.plan(request), source);
  const db = new Database(source);
  try {
    db.run("CREATE TABLE unrelated (id TEXT)");
  } finally {
    db.close(true);
  }
  await run(expectCode(migratePublicationLedger(source), "DATABASE_VERSION"));
  const check = new Database(source, { readonly: true });
  try {
    assert.deepEqual(check.query("PRAGMA user_version").get(), {
      user_version: 1,
    });
    assert.equal(
      check
        .query(
          "SELECT name FROM sqlite_schema WHERE name='publication_attempts'",
        )
        .get(),
      null,
    );
  } finally {
    check.close(true);
  }
});

test("migration SQL failure rolls back tables, version and history atomically", async () => {
  const { policy, request } = fixtures();
  const source = database();
  await runReviewer(policy, (reviewer) => reviewer.plan(request), source);
  const original = Object.getOwnPropertyDescriptor(Database.prototype, "run")!
    .value as Database["run"];
  const spy = vi.spyOn(Database.prototype, "run").mockImplementation(function (
    this: Database,
    sql,
    ...bindings
  ) {
    const result = original.call(this, sql, ...bindings);
    if (sql === PUBLICATION_SCHEMA_SQL)
      throw new Error("Injected post-DDL failure");
    return result;
  });
  try {
    await run(expectCode(migratePublicationLedger(source), "STORAGE"));
  } finally {
    spy.mockRestore();
  }
  const check = new Database(source, { readonly: true });
  try {
    assert.deepEqual(check.query("PRAGMA user_version").get(), {
      user_version: 1,
    });
    assert.equal(
      check
        .query(
          "SELECT name FROM sqlite_schema WHERE name='publication_attempts'",
        )
        .get(),
      null,
    );
    assert.deepEqual(
      check.query("SELECT version,name FROM schema_migrations").all(),
      [{ version: 1, name: "initial-ledger" }],
    );
  } finally {
    check.close(true);
  }
  await run(migratePublicationLedger(source));
  assert.deepEqual(inspect(source).control, { id: 1, restored: 1 });
});
