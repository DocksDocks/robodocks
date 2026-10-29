import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { it, test } from "@effect/vitest";
import { Effect } from "effect";
import type { InspectionRequest } from "../src/contracts.ts";
import { inspectLedger } from "../src/inspection.ts";
import { database, expectCode, fixtures, runReviewer } from "./helpers.ts";

function query(repository: string): InspectionRequest {
  return { repository, status: "all", limit: 100 };
}

function fixtureBatch(count: number, prefix = "inspection") {
  const { policy, request } = fixtures();
  const finding = request.findings[0]!;
  request.deliveryId = prefix;
  request.findings = Array.from({ length: count }, (_, index) => ({
    ...finding,
    ruleId: prefix + "." + index,
  }));
  return { policy, request };
}

function editDatabase(filename: string, edit: (db: Database) => void) {
  const db = new Database(filename, { strict: true });
  try {
    edit(db);
  } finally {
    db.close(true);
  }
}

function diskState(filename: string) {
  return {
    bytes: readFileSync(filename),
    files: readdirSync(dirname(filename)).sort(),
  };
}

function cursorText(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

it.live(
  "inspection rejects missing and non-file paths without creating a ledger",
  () => {
    const { policy, request } = fixtures();
    const filename = database();
    const directory = dirname(filename);
    return Effect.gen(function* () {
      for (const path of [
        filename,
        join(directory, "absent", "ledger.sqlite"),
        directory,
      ]) {
        yield* expectCode(
          inspectLedger(policy, path, query(request.context.repository)),
          "DATABASE_PATH",
        );
        assert.deepEqual(readdirSync(directory), []);
        assert.equal(existsSync(filename), false);
      }
    });
  },
);

test("inspection leaves empty, foreign, and newer databases byte-for-byte unchanged", async () => {
  const { policy, request } = fixtures();
  for (const kind of ["empty", "foreign", "newer"] as const) {
    const filename = database();
    editDatabase(filename, (db) => {
      db.run("PRAGMA user_version = 0");
      if (kind !== "empty") {
        db.run(
          "CREATE TABLE foreign_data (value TEXT); INSERT INTO foreign_data VALUES ('untouched')",
        );
      }
      if (kind === "newer") {
        db.run("PRAGMA application_id = 1380205139; PRAGMA user_version = 2");
      }
      assert.deepEqual(db.query("PRAGMA journal_mode").get(), {
        journal_mode: "delete",
      });
    });
    const before = diskState(filename);
    await Effect.runPromise(
      expectCode(
        inspectLedger(policy, filename, query(request.context.repository)),
        kind === "foreign" ? "DATABASE_OWNER" : "DATABASE_VERSION",
      ),
    );
    assert.deepEqual(diskState(filename), before, kind);
  }
});

test("inspection returns only the requested allowed repository and lifecycle status", async () => {
  const { policy, request } = fixtureBatch(3);
  const repository = request.context.repository;
  const otherRepository = "another-owner/another-project";
  policy.allowedRepositories.push(otherRepository, "allowed/empty");
  const filename = database();
  const intents = await runReviewer(
    policy,
    (reviewer) =>
      Effect.gen(function* () {
        const { intents } = yield* reviewer.plan(request);
        yield* reviewer.recordPublication(
          intents[1]!.id,
          "synthetic:published",
        );
        yield* reviewer.recordPublication(intents[2]!.id, "synthetic:closed");
        yield* reviewer.recordFindingClosed(intents[2]!.findingId);
        const other = fixtureBatch(1, "other").request;
        other.context.repository = otherRepository;
        other.findings[0]!.repository = otherRepository;
        yield* reviewer.plan(other);
        return intents;
      }),
    filename,
  );

  for (const [index, status] of ["proposed", "published", "closed"].entries()) {
    const page = await Effect.runPromise(
      inspectLedger(policy, filename, {
        repository,
        status,
        limit: 1,
      }),
    );
    assert.equal(page.schemaVersion, 1);
    assert.equal(page.operation, "inspect");
    assert.equal(page.repository, repository);
    assert.equal(page.status, status);
    assert.equal(page.nextCursor, null);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]!.record.id, intents[index]!.findingId);
    assert.equal(page.items[0]!.record.repository, repository);
    assert.equal(page.items[0]!.record.status, status);
    assert.equal(page.items[0]!.intent.findingId, page.items[0]!.record.id);
    assert.equal(
      page.items[0]!.intent.status,
      status === "proposed" ? "pending" : "acknowledged",
    );
  }
  const all = await Effect.runPromise(
    inspectLedger(policy, filename, query(repository)),
  );
  assert.deepEqual(
    all.items.map(({ record }) => record.id),
    intents.map((intent) => intent.findingId),
  );
  const empty = await Effect.runPromise(
    inspectLedger(policy, filename, query("allowed/empty")),
  );
  assert.deepEqual(empty.items, []);
  assert.equal(empty.nextCursor, null);
});

it.live(
  "inspection strictly validates query fields and authorization before opening a database",
  () => {
    const { policy, request } = fixtures();
    const filename = database();
    const valid = query(request.context.repository);
    const invalid: unknown[] = [
      ...[0, 101, 1.5, "1", null, Number.NaN, Infinity].map((limit) => ({
        ...valid,
        limit,
      })),
      { repository: valid.repository, status: valid.status },
      { ...valid, status: "pending" },
      { ...valid, repository: [valid.repository] },
      { ...valid, deliveryId: "not-an-admission" },
      { ...valid, findings: [] },
      { ...valid, cursor: null },
      { ...valid, cursor: "" },
      { ...valid, cursor: "a=" },
      { ...valid, cursor: "a/b" },
    ];
    return Effect.gen(function* () {
      for (const input of invalid) {
        yield* expectCode(inspectLedger(policy, filename, input), "INSPECTION");
      }
      for (const repository of [
        "excluded/project",
        valid.repository.toUpperCase(),
      ]) {
        yield* expectCode(
          inspectLedger(policy, filename, { ...valid, repository }),
          "NOT_ALLOWED",
        );
      }
      assert.deepEqual(readdirSync(dirname(filename)), []);
    });
  },
);

it.live(
  "inspection rejects malformed, wrong-version, and excess-field cursor payloads",
  () => {
    const { policy, request } = fixtures();
    const filename = database();
    const input = query(request.context.repository);
    const cursor = {
      version: 1,
      repository: input.repository,
      status: input.status,
      after: 1,
      afterId: "a".repeat(64),
      through: 2,
    };
    let cursorJson = JSON.stringify(cursor);
    while (Buffer.byteLength(cursorJson) % 3 !== 1) cursorJson += " ";
    const canonical = Buffer.from(cursorJson).toString("base64url");
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const noncanonical =
      canonical.slice(0, -1) +
      alphabet[alphabet.indexOf(canonical.at(-1)!) + 1]!;
    assert.equal(
      Buffer.from(noncanonical, "base64url").toString("utf8"),
      cursorJson,
    );
    const invalid = [
      "a",
      noncanonical,
      Buffer.from("not json").toString("base64url"),
      Buffer.from([0xff]).toString("base64url"),
      cursorText(null),
      cursorText({ ...cursor, version: 2 }),
      cursorText({ ...cursor, extra: true }),
      cursorText({ ...cursor, after: "1" }),
      cursorText({ ...cursor, after: 0 }),
      cursorText({ ...cursor, after: 1.5 }),
      cursorText({ ...cursor, afterId: "not-a-finding-id" }),
      cursorText({ ...cursor, through: 1 }),
      cursorText({ ...cursor, through: Number.MAX_SAFE_INTEGER + 1 }),
    ];
    return Effect.gen(function* () {
      for (const value of invalid) {
        yield* expectCode(
          inspectLedger(policy, filename, { ...input, cursor: value }),
          "CURSOR",
        );
      }
      assert.equal(existsSync(filename), false);
    });
  },
);

test("bounded pages have no duplicates and exclude findings appended after the first page", async () => {
  const { policy, request } = fixtureBatch(5);
  const filename = database();
  const original = await runReviewer(
    policy,
    (reviewer) => reviewer.plan(request),
    filename,
  );
  const input = { ...query(request.context.repository), limit: 2 };
  const first = await Effect.runPromise(inspectLedger(policy, filename, input));
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const appended = await runReviewer(
    policy,
    (reviewer) => reviewer.plan(fixtureBatch(1, "appended").request),
    filename,
  );
  const second = await Effect.runPromise(
    inspectLedger(policy, filename, { ...input, cursor: first.nextCursor }),
  );
  assert.equal(second.items.length, 2);
  assert.ok(second.nextCursor);
  const third = await Effect.runPromise(
    inspectLedger(policy, filename, { ...input, cursor: second.nextCursor }),
  );
  assert.equal(third.items.length, 1);
  assert.equal(third.nextCursor, null);
  const ids = [first, second, third].flatMap((page) =>
    page.items.map(({ record }) => record.id),
  );
  assert.deepEqual(
    ids,
    original.intents.map((intent) => intent.findingId),
  );
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.includes(appended.intents[0]!.findingId), false);
  const restarted = await Effect.runPromise(
    inspectLedger(policy, filename, query(input.repository)),
  );
  assert.equal(restarted.items.length, 6);
  assert.equal(
    restarted.items.at(-1)!.record.id,
    appended.intents[0]!.findingId,
  );
});

test("cursor reuse rejects another status, repository, or ledger anchor", async () => {
  const { policy, request } = fixtureBatch(2);
  policy.allowedRepositories.push("another/project");
  const filename = database();
  await runReviewer(policy, (reviewer) => reviewer.plan(request), filename);
  const input = { ...query(request.context.repository), limit: 1 };
  const first = await Effect.runPromise(inspectLedger(policy, filename, input));
  assert.ok(first.nextCursor);
  for (const change of [
    { status: "proposed" },
    { repository: "another/project" },
  ]) {
    await Effect.runPromise(
      expectCode(
        inspectLedger(policy, filename, {
          ...input,
          ...change,
          cursor: first.nextCursor,
        }),
        "CURSOR",
      ),
    );
  }
  const differentLedger = database();
  await runReviewer(
    policy,
    (reviewer) => reviewer.plan(fixtureBatch(2, "different").request),
    differentLedger,
  );
  await Effect.runPromise(
    expectCode(
      inspectLedger(policy, differentLedger, {
        ...input,
        cursor: first.nextCursor,
      }),
      "CURSOR",
    ),
  );
});

test("independent pages observe current statuses without invalidating a changed anchor", async () => {
  const { policy, request } = fixtureBatch(3);
  const filename = database();
  const { intents } = await runReviewer(
    policy,
    (reviewer) => reviewer.plan(request),
    filename,
  );
  const input = {
    repository: request.context.repository,
    status: "proposed",
    limit: 1,
  };
  const first = await Effect.runPromise(inspectLedger(policy, filename, input));
  assert.ok(first.nextCursor);
  await runReviewer(
    policy,
    (reviewer) =>
      Effect.gen(function* () {
        yield* reviewer.recordPublication(intents[0]!.id, "synthetic:anchor");
        yield* reviewer.recordPublication(intents[1]!.id, "synthetic:changed");
      }),
    filename,
  );
  const second = await Effect.runPromise(
    inspectLedger(policy, filename, { ...input, cursor: first.nextCursor }),
  );
  assert.deepEqual(
    second.items.map(({ record }) => record.id),
    [intents[2]!.findingId],
  );
  assert.equal(second.nextCursor, null);
  const published = await Effect.runPromise(
    inspectLedger(policy, filename, {
      ...query(input.repository),
      status: "published",
    }),
  );
  assert.deepEqual(
    published.items.map(({ record }) => record.id),
    intents.slice(0, 2).map((intent) => intent.findingId),
  );
});

test("inspection remains read-only at delivery capacity under tightened admission policy", async () => {
  const { policy, request } = fixtureBatch(2);
  const filename = database();
  const { intents } = await runReviewer(
    policy,
    (reviewer) => reviewer.plan(request),
    filename,
  );
  editDatabase(filename, (db) => {
    db.query(
      `WITH RECURSIVE slots(n) AS (
      VALUES(1) UNION ALL SELECT n + 1 FROM slots WHERE n < 9999
    ) INSERT INTO deliveries (id, digest, repository)
      SELECT 'full-' || n, ?, ? FROM slots`,
    ).run("0".repeat(64), request.context.repository);
    assert.deepEqual(
      db.query("SELECT count(*) AS count FROM deliveries").get(),
      { count: 10000 },
    );
    assert.deepEqual(db.query("PRAGMA journal_mode = DELETE").get(), {
      journal_mode: "delete",
    });
  });
  policy.minimumConfidence = 1;
  policy.maxFindings = 1;
  const before = diskState(filename);
  const page = await Effect.runPromise(
    inspectLedger(policy, filename, query(request.context.repository)),
  );
  assert.deepEqual(
    page.items.map(({ intent }) => intent),
    intents,
  );
  assert.equal(page.nextCursor, null);
  assert.deepEqual(diskState(filename), before);
});

test("selected corrupt observations fail with sanitized integrity errors and are not repaired", async () => {
  for (const corruption of [
    "payload",
    "missing-outbox",
    "lifecycle",
  ] as const) {
    const { policy, request } = fixtureBatch(1);
    const filename = database();
    await runReviewer(policy, (reviewer) => reviewer.plan(request), filename);
    editDatabase(filename, (db) => {
      if (corruption === "payload") {
        db.query("UPDATE outbox SET payload = ?").run(
          JSON.stringify({
            ...request.findings[0]!,
            confidence: 2,
            title: "inspection-private-sentinel",
          }),
        );
      } else if (corruption === "missing-outbox") {
        db.run("DELETE FROM outbox");
      } else {
        db.run("UPDATE findings SET status = 'published'");
      }
      db.run("PRAGMA journal_mode = DELETE");
    });
    const before = diskState(filename);
    const error = await Effect.runPromise(
      Effect.flip(
        inspectLedger(policy, filename, query(request.context.repository)),
      ),
    );
    assert.equal(error.code, "STORAGE_INTEGRITY");
    assert.equal(
      JSON.stringify(error).includes("inspection-private-sentinel"),
      false,
    );
    assert.equal(error.message.includes(filename), false);
    assert.equal(error.message.includes(request.findings[0]!.evidence), false);
    assert.deepEqual(diskState(filename), before, corruption);
  }
});

test("corruption outside the requested repository, status, or returned page is ignored", async () => {
  const { policy, request } = fixtureBatch(4);
  const repository = request.context.repository;
  policy.allowedRepositories.push("excluded/project");
  const filename = database();
  const { intents, excludedId } = await runReviewer(
    policy,
    (reviewer) =>
      Effect.gen(function* () {
        const { intents } = yield* reviewer.plan(request);
        yield* reviewer.recordPublication(intents[2]!.id, "synthetic:closed");
        yield* reviewer.recordFindingClosed(intents[2]!.findingId);
        const excluded = fixtureBatch(1, "excluded").request;
        excluded.context.repository = "excluded/project";
        excluded.findings[0]!.repository = "excluded/project";
        const other = yield* reviewer.plan(excluded);
        return { intents, excludedId: other.intents[0]!.id };
      }),
    filename,
  );
  editDatabase(filename, (db) => {
    db.query("UPDATE outbox SET payload = '{}' WHERE id IN (?, ?, ?)").run(
      intents[2]!.id,
      intents[3]!.id,
      excludedId,
    );
  });
  policy.allowedRepositories = [repository];
  const input = { repository, status: "proposed", limit: 1 };
  const first = await Effect.runPromise(inspectLedger(policy, filename, input));
  assert.equal(first.items[0]!.record.id, intents[0]!.findingId);
  assert.ok(first.nextCursor);
  const second = await Effect.runPromise(
    inspectLedger(policy, filename, { ...input, cursor: first.nextCursor }),
  );
  assert.equal(second.items[0]!.record.id, intents[1]!.findingId);
  assert.ok(second.nextCursor);
  const noPublished = await Effect.runPromise(
    inspectLedger(policy, filename, {
      ...query(repository),
      status: "published",
    }),
  );
  assert.deepEqual(noPublished.items, []);
  assert.equal(noPublished.nextCursor, null);
  await Effect.runPromise(
    expectCode(
      inspectLedger(policy, filename, { ...input, cursor: second.nextCursor }),
      "STORAGE_INTEGRITY",
    ),
  );
  await Effect.runPromise(
    expectCode(
      inspectLedger(policy, filename, { ...input, status: "closed" }),
      "STORAGE_INTEGRITY",
    ),
  );
});
