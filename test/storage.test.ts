import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { it, test } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { withReviewer } from "../src/reviewer.ts";
import type { Reviewer } from "../src/reviewer.ts";
import { ContractError } from "../src/validation.ts";
import {
  database,
  emptySnapshot,
  expectCode,
  fixtures,
  runReviewer,
  reviewerEffect,
} from "./helpers.ts";

test("a foreign sqlite-prefixed name is not confused with SQLite's reserved literal prefix", async () => {
  const { policy } = fixtures();
  const filename = database();
  const foreign = new Database(filename, { strict: true });
  foreign.run(
    "CREATE TABLE sqliteXforeign (secret TEXT); INSERT INTO sqliteXforeign VALUES ('untouched')",
  );
  foreign.close(true);
  await Effect.runPromise(
    expectCode(
      withReviewer(policy, filename, (reviewer) => reviewer.snapshot()),
      "DATABASE_OWNER",
    ),
  );
  const inspected = new Database(filename, { strict: true });
  try {
    assert.deepEqual(inspected.query("PRAGMA application_id").get(), {
      application_id: 0,
    });
    assert.deepEqual(inspected.query("PRAGMA user_version").get(), {
      user_version: 0,
    });
    assert.deepEqual(inspected.query("PRAGMA journal_mode").get(), {
      journal_mode: "delete",
    });
    assert.deepEqual(
      inspected.query("SELECT secret FROM sqliteXforeign").all(),
      [{ secret: "untouched" }],
    );
    assert.deepEqual(
      inspected
        .query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all(),
      [{ name: "sqliteXforeign" }],
    );
  } finally {
    inspected.close(true);
  }
});

test("exact deliveries and observations remain deduplicated after closing and reopening", async () => {
  const { policy, request } = fixtures();
  const filename = database();
  const first = await runReviewer(
    policy,
    (reviewer) => reviewer.plan(request),
    filename,
  );
  await runReviewer(
    policy,
    (reviewer) =>
      Effect.gen(function* () {
        const replay = yield* reviewer.plan(request);
        assert.equal(replay.deliveryStatus, "duplicate");
        assert.equal(replay.intents.length, 0);
        const snapshot = yield* reviewer.snapshot();
        assert.equal(snapshot.outbox.length, 1);
        assert.equal(snapshot.outbox[0]!.id, first.intents[0]!.id);
        assert.equal(snapshot.outbox[0]!.status, "pending");
        request.deliveryId = "another-delivery-after-restart";
        const redetection = yield* reviewer.plan(request);
        assert.equal(redetection.intents.length, 0);
        assert.deepEqual(redetection.suppressedFindingIds, [
          first.intents[0]!.findingId,
        ]);
        assert.equal((yield* reviewer.snapshot()).deliveries.length, 2);
      }),
    filename,
  );
});

it.live(
  "SQLite diagnostics report the enabled durability and integrity settings",
  () => {
    const { policy } = fixtures();
    return reviewerEffect(policy, (reviewer) =>
      Effect.sync(() => {
        assert.match(reviewer.storage.sqliteVersion, /^\d+\.\d+\.\d+$/);
        assert.equal(reviewer.storage.schemaVersion, 1);
        assert.equal(reviewer.storage.journalMode, "wal");
        assert.equal(reviewer.storage.synchronous, 2);
        assert.equal(reviewer.storage.foreignKeys, 1);
        assert.equal(reviewer.storage.busyTimeoutMs, 5000);
        assert.ok(Object.isFrozen(reviewer.storage));
      }),
    );
  },
);

test("acknowledgement and closure persist without creating a follow-up after restart", async () => {
  const { policy, request } = fixtures();
  const filename = database();
  const intent = await runReviewer(
    policy,
    (reviewer) =>
      Effect.gen(function* () {
        const intent = (yield* reviewer.plan(request)).intents[0]!;
        yield* reviewer.recordPublication(intent.id, "synthetic-comment:123");
        yield* reviewer.recordFindingClosed(intent.findingId);
        return intent;
      }),
    filename,
  );
  await runReviewer(
    policy,
    (reviewer) =>
      Effect.gen(function* () {
        const before = yield* reviewer.snapshot();
        assert.equal(before.findings[0]!.status, "closed");
        assert.equal(
          before.outbox[0]!.externalReference,
          "synthetic-comment:123",
        );
        yield* reviewer.recordPublication(intent.id, "synthetic-comment:123");
        yield* reviewer.recordFindingClosed(intent.findingId);
        assert.deepEqual(yield* reviewer.snapshot(), before);
        request.deliveryId = "after-restart-and-closure";
        assert.equal((yield* reviewer.plan(request)).intents.length, 0);
        assert.equal((yield* reviewer.snapshot()).outbox.length, 1);
      }),
    filename,
  );
});

test("a SQL failure after reservation rolls back findings, outbox and delivery together", async () => {
  const { policy, request } = fixtures();
  const filename = database();
  await runReviewer(policy, (reviewer) => reviewer.snapshot(), filename);
  const injector = new Database(filename, { strict: true });
  try {
    injector.run(
      "CREATE TRIGGER fail_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
    );
  } finally {
    injector.close(true);
  }
  await runReviewer(
    policy,
    (reviewer) =>
      Effect.gen(function* () {
        yield* expectCode(reviewer.plan(request), "STORAGE");
        assert.deepEqual(yield* reviewer.snapshot(), emptySnapshot());
      }),
    filename,
  );
  const repair = new Database(filename, { strict: true });
  try {
    repair.run("DROP TRIGGER fail_delivery");
  } finally {
    repair.close(true);
  }
  const plan = await runReviewer(
    policy,
    (reviewer) => reviewer.plan(request),
    filename,
  );
  assert.equal(plan.intents.length, 1);
});

for (const newer of [false, true]) {
  test(
    (newer ? "newer-schema" : "foreign") +
      " databases are rejected without changing journal mode or user data",
    async () => {
      const { policy } = fixtures();
      const filename = database();
      const original = new Database(filename, { strict: true });
      try {
        original.run(
          "CREATE TABLE unrelated_data (value TEXT NOT NULL); INSERT INTO unrelated_data VALUES ('leave unchanged')",
        );
        if (newer)
          original.run(
            "PRAGMA application_id = 1380205139; PRAGMA user_version = 2",
          );
        assert.deepEqual(original.query("PRAGMA journal_mode").get(), {
          journal_mode: "delete",
        });
      } finally {
        original.close(true);
      }
      await Effect.runPromise(
        expectCode(
          withReviewer(policy, filename, (reviewer) => reviewer.snapshot()),
          newer ? "DATABASE_VERSION" : "DATABASE_OWNER",
        ),
      );
      const inspected = new Database(filename, { strict: true });
      try {
        assert.deepEqual(inspected.query("PRAGMA journal_mode").get(), {
          journal_mode: "delete",
        });
        assert.deepEqual(
          inspected.query("SELECT value FROM unrelated_data").all(),
          [{ value: "leave unchanged" }],
        );
        assert.deepEqual(inspected.query("PRAGMA user_version").get(), {
          user_version: newer ? 2 : 0,
        });
      } finally {
        inspected.close(true);
      }
    },
  );
}

test("an existing empty version-zero database migrates once and reopens at version one", async () => {
  const { policy } = fixtures();
  const filename = database();
  const empty = new Database(filename, { strict: true });
  assert.deepEqual(empty.query("PRAGMA user_version").get(), {
    user_version: 0,
  });
  empty.close(true);
  await runReviewer(
    policy,
    (reviewer) =>
      Effect.gen(function* () {
        assert.equal(reviewer.storage.schemaVersion, 1);
        assert.deepEqual(yield* reviewer.snapshot(), emptySnapshot());
      }),
    filename,
  );
  await runReviewer(
    policy,
    (reviewer) =>
      Effect.gen(function* () {
        assert.equal(reviewer.storage.schemaVersion, 1);
        assert.deepEqual(yield* reviewer.snapshot(), emptySnapshot());
      }),
    filename,
  );
  const inspected = new Database(filename, { strict: true });
  try {
    assert.deepEqual(inspected.query("PRAGMA user_version").get(), {
      user_version: 1,
    });
    assert.deepEqual(inspected.query("PRAGMA application_id").get(), {
      application_id: 1380205139,
    });
    assert.deepEqual(
      inspected.query("SELECT version, name FROM schema_migrations").all(),
      [{ version: 1, name: "initial-ledger" }],
    );
  } finally {
    inspected.close(true);
  }
});

test("inconsistent migration metadata is rejected before persistent journal changes", async () => {
  const { policy, request } = fixtures();
  const filename = database();
  await runReviewer(policy, (reviewer) => reviewer.plan(request), filename);
  const changed = new Database(filename, { strict: true });
  try {
    changed.run(
      "UPDATE schema_migrations SET name = 'unrecognized-migration' WHERE version = 1",
    );
    assert.deepEqual(changed.query("PRAGMA journal_mode = DELETE").get(), {
      journal_mode: "delete",
    });
  } finally {
    changed.close(true);
  }
  await Effect.runPromise(
    expectCode(
      withReviewer(policy, filename, (reviewer) => reviewer.snapshot()),
      "DATABASE_VERSION",
    ),
  );
  const inspected = new Database(filename, { strict: true });
  try {
    assert.deepEqual(inspected.query("PRAGMA journal_mode").get(), {
      journal_mode: "delete",
    });
    assert.deepEqual(
      inspected.query("SELECT count(*) AS count FROM outbox").get(),
      { count: 1 },
    );
    assert.deepEqual(
      inspected.query("SELECT version, name FROM schema_migrations").all(),
      [{ version: 1, name: "unrecognized-migration" }],
    );
  } finally {
    inspected.close(true);
  }
});

it.live(
  "parallel effects sharing a reviewer reserve one exact observation",
  () => {
    const { policy, request } = fixtures();
    return reviewerEffect(policy, (reviewer) =>
      Effect.gen(function* () {
        const plans = yield* Effect.all(
          [reviewer.plan(request), reviewer.plan(request)],
          { concurrency: "unbounded" },
        );
        assert.equal(plans.flatMap((plan) => plan.intents).length, 1);
        assert.deepEqual(plans.map((plan) => plan.deliveryStatus).sort(), [
          "accepted",
          "duplicate",
        ]);
        const snapshot = yield* reviewer.snapshot();
        assert.equal(snapshot.deliveries.length, 1);
        assert.equal(snapshot.findings.length, 1);
        assert.equal(snapshot.outbox.length, 1);
      }),
    );
  },
);

test(
  "eight concurrent CLI processes initialize one fresh ledger and accept one delivery",
  { timeout: 15_000 },
  async () => {
    const filename = database();
    const cwd = fileURLToPath(new URL("../", import.meta.url));
    const children = Array.from({ length: 8 }, () =>
      Bun.spawn(
        [
          process.execPath,
          "src/cli.ts",
          "--policy",
          "examples/policy.json",
          "--input",
          "examples/review.json",
          "--database",
          filename,
        ],
        { cwd, stdout: "pipe", stderr: "pipe", timeout: 10_000 },
      ),
    );
    const results = await Promise.all(
      children.map(async (child) => {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
      }),
    );
    const plans = results.map((result) => {
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stderr, "");
      const output = JSON.parse(result.stdout) as {
        plan: { deliveryStatus: string; intents: unknown[] };
      };
      assert.ok(["accepted", "duplicate"].includes(output.plan.deliveryStatus));
      return output.plan;
    });
    assert.equal(
      plans.filter((plan) => plan.deliveryStatus === "accepted").length,
      1,
    );
    assert.equal(plans.flatMap((plan) => plan.intents).length, 1);
    const { policy } = fixtures();
    const snapshot = await runReviewer(
      policy,
      (reviewer) => reviewer.snapshot(),
      filename,
    );
    assert.equal(snapshot.deliveries.length, 1);
    assert.equal(snapshot.findings.length, 1);
    assert.equal(snapshot.outbox.length, 1);
  },
);

test("narrower policy cannot read or acknowledge another repository's persisted state", async () => {
  const { policy, request } = fixtures();
  const filename = database();
  const intent = await runReviewer(
    policy,
    (reviewer) =>
      Effect.gen(function* () {
        const intent = (yield* reviewer.plan(request)).intents[0]!;
        yield* reviewer.recordPublication(intent.id, "synthetic-comment:123");
        return intent;
      }),
    filename,
  );
  const restricted = {
    ...policy,
    allowedRepositories: ["different-owner/different-project"],
  };
  await runReviewer(
    restricted,
    (reviewer) =>
      Effect.gen(function* () {
        assert.deepEqual(yield* reviewer.snapshot(), emptySnapshot());
        yield* expectCode(
          reviewer.recordPublication(intent.id, "synthetic-comment:123"),
          "NOT_ALLOWED",
        );
        yield* expectCode(
          reviewer.recordFindingClosed(intent.findingId),
          "NOT_ALLOWED",
        );
        yield* expectCode(reviewer.plan(request), "NOT_ALLOWED");
      }),
    filename,
  );
  const snapshot = await runReviewer(
    policy,
    (reviewer) => reviewer.snapshot(),
    filename,
  );
  assert.equal(snapshot.findings[0]!.status, "published");
});

test("connection scope closes even when its consumer fails", async () => {
  const { policy } = fixtures();
  let captured: Reviewer | undefined;
  await Effect.runPromise(
    expectCode(
      withReviewer(policy, database(), (reviewer) => {
        captured = reviewer;
        return Effect.fail(
          new ContractError("SYNTHETIC_STOP", "Synthetic consumer failure"),
        );
      }),
      "SYNTHETIC_STOP",
    ),
  );
  assert.ok(captured);
  await Effect.runPromise(expectCode(captured.snapshot(), "STORAGE"));
});

test("JSON property order does not turn a persisted exact delivery replay into a conflict", async () => {
  const { policy, request } = fixtures();
  const filename = database();
  await runReviewer(policy, (reviewer) => reviewer.plan(request), filename);
  const reordered = Object.fromEntries(Object.entries(request).reverse());
  const replay = await runReviewer(
    policy,
    (reviewer) => reviewer.plan(reordered),
    filename,
  );
  assert.equal(replay.deliveryStatus, "duplicate");
  assert.equal(replay.intents.length, 0);
});

test("persisted payloads are decoded with the same intrinsic scalar constraints", async () => {
  const { policy, request } = fixtures();
  const filename = database();
  await runReviewer(policy, (reviewer) => reviewer.plan(request), filename);
  const invalidPayload = JSON.stringify({
    ...request.findings[0]!,
    confidence: 2,
  });
  const corrupted = new Database(filename, { strict: true });
  try {
    corrupted.query("UPDATE outbox SET payload = ?").run(invalidPayload);
  } finally {
    corrupted.close(true);
  }
  await runReviewer(
    policy,
    (reviewer) => expectCode(reviewer.snapshot(), "STORAGE_INTEGRITY"),
    filename,
  );
  const inspected = new Database(filename, { strict: true });
  try {
    assert.deepEqual(inspected.query("SELECT payload FROM outbox").get(), {
      payload: invalidPayload,
    });
  } finally {
    inspected.close(true);
  }
});

test("Effect interruption closes the scoped connection before returning", async () => {
  const { policy } = fixtures();
  const controller = new AbortController();
  let captured: Reviewer | undefined;
  const result = await Effect.runPromiseExit(
    withReviewer(policy, database(), (reviewer) => {
      captured = reviewer;
      queueMicrotask(() => controller.abort());
      return Effect.never;
    }),
    { signal: controller.signal },
  );
  assert.equal(Exit.hasInterrupts(result), true);
  assert.ok(captured);
  await Effect.runPromise(expectCode(captured.snapshot(), "STORAGE"));
});
