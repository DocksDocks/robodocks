import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { it, test } from "@effect/vitest";
import { Effect } from "effect";
import {
  database,
  expectCode,
  fixtures,
  runReviewer,
  reviewerEffect,
} from "./helpers.ts";

function rawState(filename: string) {
  const db = new Database(filename, { strict: true });
  try {
    return {
      findings: db
        .query(
          "SELECT id, repository, pull_request, head_sha, status FROM findings ORDER BY rowid",
        )
        .all(),
      outbox: db
        .query(
          "SELECT id, finding_id, payload, status, external_reference FROM outbox ORDER BY rowid",
        )
        .all(),
      deliveries: db
        .query("SELECT id, digest, repository FROM deliveries ORDER BY rowid")
        .all(),
    };
  } finally {
    db.close(true);
  }
}

const corruptions = [
  ["repository", "UPDATE findings SET repository = 'other/project'"],
  ["pull request", "UPDATE findings SET pull_request = 8"],
  [
    "head SHA",
    "UPDATE findings SET head_sha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'",
  ],
  [
    "unacknowledged published status",
    "UPDATE findings SET status = 'published'",
  ],
  [
    "invalid acknowledged reference",
    "UPDATE findings SET status = 'published'; UPDATE outbox SET status = 'acknowledged', external_reference = 'bad reference'",
  ],
  ["missing outbox", "DELETE FROM outbox"],
] as const;

for (const [label, sql] of corruptions) {
  test(
    "stored " +
      label +
      " corruption fails closed across observation operations",
    async () => {
      const { policy, request } = fixtures();
      policy.allowedRepositories.push("other/project");
      const filename = database();
      const intent = (
        await runReviewer(
          policy,
          (reviewer) => reviewer.plan(request),
          filename,
        )
      ).intents[0]!;
      const db = new Database(filename, { strict: true });
      try {
        db.run(sql);
      } finally {
        db.close(true);
      }
      const before = rawState(filename);
      await runReviewer(
        policy,
        (reviewer) =>
          Effect.gen(function* () {
            yield* expectCode(reviewer.snapshot(), "STORAGE_INTEGRITY");
            yield* expectCode(reviewer.plan(request), "STORAGE_INTEGRITY");
            request.deliveryId = "redetection-after-corruption";
            yield* expectCode(reviewer.plan(request), "STORAGE_INTEGRITY");
            yield* expectCode(
              reviewer.recordFindingClosed(intent.findingId),
              "STORAGE_INTEGRITY",
            );
            yield* expectCode(
              reviewer.recordPublication(intent.id, "valid:123"),
              label === "missing outbox"
                ? "UNKNOWN_INTENT"
                : "STORAGE_INTEGRITY",
            );
          }),
        filename,
      );
      assert.deepEqual(
        rawState(filename),
        before,
        "Do not repair or mutate corrupt records implicitly",
      );
    },
  );
}

test("corrupt stored repository metadata cannot expose a different repository's payload", async () => {
  const { policy, request } = fixtures();
  const filename = database();
  const intent = (
    await runReviewer(policy, (reviewer) => reviewer.plan(request), filename)
  ).intents[0]!;
  const db = new Database(filename, { strict: true });
  try {
    db.run("UPDATE findings SET repository = 'other/project'");
  } finally {
    db.close(true);
  }
  policy.allowedRepositories = ["other/project"];
  await runReviewer(
    policy,
    (reviewer) =>
      Effect.gen(function* () {
        yield* expectCode(reviewer.snapshot(), "STORAGE_INTEGRITY");
        yield* expectCode(
          reviewer.recordPublication(intent.id, "valid:123"),
          "STORAGE_INTEGRITY",
        );
        yield* expectCode(
          reviewer.recordFindingClosed(intent.findingId),
          "STORAGE_INTEGRITY",
        );
      }),
    filename,
  );
});

test("an exact delivery replay detects corrupted repository metadata", async () => {
  const { policy, request } = fixtures();
  const filename = database();
  await runReviewer(policy, (reviewer) => reviewer.plan(request), filename);
  const db = new Database(filename, { strict: true });
  try {
    db.run("UPDATE deliveries SET repository = 'other/project'");
  } finally {
    db.close(true);
  }
  const before = rawState(filename);
  await runReviewer(
    policy,
    (reviewer) => expectCode(reviewer.plan(request), "STORAGE_INTEGRITY"),
    filename,
  );
  assert.deepEqual(rawState(filename), before);
});

test("stricter admission thresholds do not invalidate previously accepted observations", async () => {
  const { policy, request } = fixtures();
  const filename = database();
  const intent = (
    await runReviewer(policy, (reviewer) => reviewer.plan(request), filename)
  ).intents[0]!;
  policy.minimumConfidence = 1;
  policy.maxFindings = 1;
  await runReviewer(
    policy,
    (reviewer) =>
      Effect.gen(function* () {
        assert.equal((yield* reviewer.snapshot()).outbox.length, 1);
        yield* reviewer.recordPublication(intent.id, "valid:123");
        yield* reviewer.recordFindingClosed(intent.findingId);
        assert.equal(
          (yield* reviewer.snapshot()).findings[0]!.status,
          "closed",
        );
        yield* expectCode(reviewer.plan(request), "CONFIDENCE");
      }),
    filename,
  );
});

test("lifecycle authorization precedes reading excluded repositories' payloads", async () => {
  const { policy, request } = fixtures();
  const filename = database();
  const intent = (
    await runReviewer(policy, (reviewer) => reviewer.plan(request), filename)
  ).intents[0]!;
  const db = new Database(filename, { strict: true });
  try {
    db.run("UPDATE outbox SET payload = '{}' ");
  } finally {
    db.close(true);
  }
  policy.allowedRepositories = ["other/project"];
  await runReviewer(
    policy,
    (reviewer) =>
      Effect.gen(function* () {
        assert.equal((yield* reviewer.snapshot()).outbox.length, 0);
        yield* expectCode(
          reviewer.recordPublication(intent.id, "valid:123"),
          "NOT_ALLOWED",
        );
        yield* expectCode(
          reviewer.recordFindingClosed(intent.findingId),
          "NOT_ALLOWED",
        );
      }),
    filename,
  );
});

it.live(
  "capacity counts new unique observations and rolls back genuine overflow",
  () => {
    const { policy, request } = fixtures();
    policy.maxFindings = 100;
    const prototype = request.findings[0]!;
    const candidate = (index: number) => ({
      ...prototype,
      ruleId: "capacity." + index,
    });
    return reviewerEffect(policy, (reviewer) =>
      Effect.gen(function* () {
        for (let offset = 0; offset < 9999; offset += 100) {
          request.deliveryId = "seed-" + offset;
          request.findings = Array.from(
            { length: Math.min(100, 9999 - offset) },
            (_, index) => candidate(offset + index),
          );
          yield* reviewer.plan(request);
        }
        request.deliveryId = "known-only";
        request.findings = [candidate(0), candidate(1)];
        assert.equal((yield* reviewer.plan(request)).intents.length, 0);

        request.deliveryId = "overflow-with-one-slot";
        request.findings = [candidate(9999), candidate(10000)];
        const before = yield* reviewer.snapshot();
        yield* expectCode(reviewer.plan(request), "LEDGER_FULL");
        assert.deepEqual(yield* reviewer.snapshot(), before);

        request.deliveryId = "known-and-last-new";
        request.findings = [candidate(0), candidate(9999), candidate(9999)];
        const final = yield* reviewer.plan(request);
        assert.equal(final.intents.length, 1);
        assert.equal(final.suppressedFindingIds.length, 2);
        assert.equal((yield* reviewer.snapshot()).findings.length, 10000);

        request.deliveryId = "known-when-full";
        request.findings = [candidate(9999), candidate(1)];
        assert.equal((yield* reviewer.plan(request)).intents.length, 0);
        request.deliveryId = "new-when-full";
        request.findings = [candidate(10000)];
        yield* expectCode(reviewer.plan(request), "LEDGER_FULL");
      }),
    );
  },
  15000,
);
