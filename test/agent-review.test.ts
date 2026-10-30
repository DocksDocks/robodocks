import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { Effect } from "effect";
import { test } from "@effect/vitest";
import { AGENT_REVIEW_SCOPE, reviewGitHubSource } from "../src/agent-review.ts";
import type { AgentReview } from "../src/agent-review.ts";
import { collectGitHubSource } from "../src/github-source.ts";
import {
  database,
  emptySnapshot,
  expectCode,
  fixtures,
  runReviewer,
} from "./helpers.ts";
import type { Mutable } from "./helpers.ts";
import { githubFixture, prPath, request } from "./github-fixtures.ts";

async function setup() {
  const fixture = githubFixture();
  const collection = await Effect.runPromise(
    collectGitHubSource(fixture.policy, request, {
      transport: fixture.transport,
    }),
  );
  assert.equal(collection.acquisition.status, "complete");
  assert.ok(collection.snapshotId);
  const response: Mutable<AgentReview> = {
    schemaVersion: 1,
    attemptId: request.attemptId,
    snapshotId: collection.snapshotId,
    scope: AGENT_REVIEW_SCOPE,
    status: "complete",
    findings: [
      {
        side: "after",
        finding: {
          ...fixtures().request.findings[0]!,
          path: "modified.ts",
          startLine: 1,
          endLine: 1,
          evidence: "new\r",
        },
      },
    ],
  };
  const filename = database();
  const review = (input: unknown = response) =>
    reviewGitHubSource(fixture.policy, request, input, filename, {
      transport: fixture.transport,
    });
  return { fixture, collection, response, filename, review };
}

async function assertEmpty(f: Awaited<ReturnType<typeof setup>>) {
  assert.deepEqual(
    await runReviewer(
      f.fixture.policy,
      (reviewer) => reviewer.snapshot(),
      f.filename,
    ),
    emptySnapshot(),
  );
}

test("fresh GitHub source admits after-side findings and identical replay is durable", async () => {
  const f = await setup();
  const calls = f.fixture.calls.length;
  const result = await Effect.runPromise(f.review());
  assert.equal(result.review.status, "findings-proposed");
  assert.equal(result.plan?.deliveryStatus, "accepted");
  assert.equal(result.plan?.intents.length, 1);
  assert.ok(f.fixture.calls.length > calls, "submission must reacquire source");
  const replay = await Effect.runPromise(f.review());
  assert.equal(replay.plan?.deliveryStatus, "duplicate");
  assert.equal(replay.plan?.intents.length, 0);
  const ledger = await runReviewer(
    f.fixture.policy,
    (reviewer) => reviewer.snapshot(),
    f.filename,
  );
  assert.equal(ledger.deliveries.length, 1);
  assert.equal(ledger.findings.length, 1);
  assert.equal(ledger.outbox[0]?.finding.evidence, "new\r");
});

test("changing findings under the same attempt and snapshot conflicts instead of overwriting", async () => {
  const f = await setup();
  await Effect.runPromise(f.review());
  f.response.findings[0]!.finding.title = "Different diagnosis";
  await Effect.runPromise(expectCode(f.review(), "DELIVERY_CONFLICT"));
  const ledger = await runReviewer(
    f.fixture.policy,
    (reviewer) => reviewer.snapshot(),
    f.filename,
  );
  assert.equal(ledger.deliveries.length, 1);
  assert.notEqual(ledger.outbox[0]?.finding.title, "Different diagnosis");
});

test("a fabricated self-rehashed source snapshot cannot supply authoritative context", async () => {
  const f = await setup();
  const fabricated = structuredClone(f.collection.snapshot)!;
  const forged = {
    ...fabricated,
    files: fabricated.files.map((file) =>
      file.path === "modified.ts"
        ? { ...file, after: { ...file.after!, content: "fabricated\n" } }
        : file,
    ),
  };
  f.response.snapshotId = createHash("sha256")
    .update(JSON.stringify(forged))
    .digest("hex");
  f.response.findings[0]!.finding.evidence = "fabricated";
  await Effect.runPromise(expectCode(f.review(), "SNAPSHOT_MISMATCH"));
  assert.equal(existsSync(f.filename), false);
});

test("agent context, current head and source fields are rejected recursively", async () => {
  const f = await setup();
  for (const extra of [
    { context: fixtures().request.context },
    { currentHeadSha: "a".repeat(40) },
    { files: [] },
    { deliveryId: "agent-controlled" },
  ]) {
    await Effect.runPromise(
      expectCode(f.review({ ...f.response, ...extra }), "AGENT_RESPONSE"),
    );
  }
  await Effect.runPromise(
    expectCode(
      f.review({
        ...f.response,
        findings: [{ ...f.response.findings[0]!, context: {} }],
      }),
      "AGENT_RESPONSE",
    ),
  );
  assert.equal(existsSync(f.filename), false);
});

test("attempt and scope binding reject cross-attempt and unsupported review claims", async () => {
  const f = await setup();
  await Effect.runPromise(
    expectCode(
      f.review({ ...f.response, attemptId: "another-attempt" }),
      "ATTEMPT_MISMATCH",
    ),
  );
  await Effect.runPromise(
    expectCode(
      f.review({ ...f.response, scope: "whole-repository" }),
      "AGENT_RESPONSE",
    ),
  );
  await Effect.runPromise(
    expectCode(
      f.review({ ...f.response, status: "not-run" }),
      "AGENT_RESPONSE",
    ),
  );
  assert.equal(existsSync(f.filename), false);
});

test("fresh PR identity is checked even if source and head are unchanged", async () => {
  const f = await setup();
  f.fixture.pr.id += 1;
  await Effect.runPromise(expectCode(f.review(), "SNAPSHOT_MISMATCH"));
  assert.equal(existsSync(f.filename), false);
});

for (const side of ["head", "base"] as const) {
  test(`a ${side} move during acquisition is incomplete and never creates a delivery`, async () => {
    const f = await setup();
    let reads = 0;
    const result = await Effect.runPromise(
      reviewGitHubSource(f.fixture.policy, request, f.response, f.filename, {
        transport: async (req) => {
          if (new URL(req.url).pathname === prPath && ++reads === 2)
            f.fixture.pr[side].sha = "9".repeat(40);
          return f.fixture.transport(req);
        },
      }),
    );
    assert.equal(result.acquisition.status, "incomplete");
    assert.equal(result.review.status, "not-run");
    assert.equal(result.plan, null);
    assert.equal(result.acquisition.omissions[0]?.code, "STALE_PULL_REQUEST");
    assert.equal(existsSync(f.filename), false);
  });
}

test("incomplete collection and incomplete agent response cannot be reported as clean", async () => {
  const f = await setup();
  f.fixture.headTree.truncated = true;
  const missing = await Effect.runPromise(f.review());
  assert.equal(missing.review.status, "not-run");
  assert.equal(missing.plan, null);
  assert.equal(existsSync(f.filename), false);
  f.fixture.headTree.truncated = false;
  f.response.status = "incomplete";
  f.response.findings = [];
  const partial = await Effect.runPromise(f.review());
  assert.equal(partial.review.status, "incomplete");
  assert.equal(partial.plan, null);
  assert.equal(existsSync(f.filename), false);
});

test("explicit completed zero-findings review records a delivery without findings", async () => {
  const f = await setup();
  f.response.findings = [];
  const result = await Effect.runPromise(f.review());
  assert.equal(result.review.status, "no-confirmed-findings");
  assert.equal(result.scope, AGENT_REVIEW_SCOPE);
  assert.equal(result.plan?.deliveryStatus, "accepted");
  const ledger = await runReviewer(
    f.fixture.policy,
    (reviewer) => reviewer.snapshot(),
    f.filename,
  );
  assert.equal(ledger.deliveries.length, 1);
  assert.equal(ledger.findings.length, 0);
  assert.equal(ledger.outbox.length, 0);
});

test("before and missing sides are rejected rather than silently treated as head anchors", async () => {
  const f = await setup();
  const finding = f.response.findings[0]!.finding;
  await Effect.runPromise(
    expectCode(
      f.review({ ...f.response, findings: [{ side: "before", finding }] }),
      "AGENT_RESPONSE",
    ),
  );
  await Effect.runPromise(
    expectCode(
      f.review({ ...f.response, findings: [{ finding }] }),
      "AGENT_RESPONSE",
    ),
  );
  assert.equal(existsSync(f.filename), false);
});

for (const [path, evidence] of [
  ["removed.ts", "removed text"],
  ["old-name.ts", "old name"],
]) {
  test(`historical path ${path} is absent from the after-only planner context`, async () => {
    const f = await setup();
    Object.assign(f.response.findings[0]!.finding, { path, evidence });
    await Effect.runPromise(expectCode(f.review(), "MISSING_FILE"));
    await assertEmpty(f);
  });
}

test("renamed head path is accepted only with its exact head-side evidence", async () => {
  const f = await setup();
  Object.assign(f.response.findings[0]!.finding, {
    path: "renamed.ts",
    evidence: "old name",
  });
  await Effect.runPromise(expectCode(f.review(), "EVIDENCE"));
  await assertEmpty(f);
  f.response.findings[0]!.finding.evidence = "new name";
  const result = await Effect.runPromise(f.review());
  assert.equal(result.plan?.intents.length, 1);
});

test("finding identity and range still bind to the freshly acquired source", async () => {
  const f = await setup();
  const original = structuredClone(f.response.findings[0]!.finding);
  for (const delta of [
    { headSha: "8".repeat(40) },
    { repository: "other/repository" },
    { pullRequest: 8 },
  ]) {
    f.response.findings[0]!.finding = { ...original, ...delta };
    await Effect.runPromise(expectCode(f.review(), "TARGET_MISMATCH"));
  }
  f.response.findings[0]!.finding = {
    ...original,
    startLine: 100,
    endLine: 100,
  };
  await Effect.runPromise(expectCode(f.review(), "LINES"));
  await assertEmpty(f);
});

test("response mutations during asynchronous acquisition cannot change the admitted finding", async () => {
  const f = await setup();
  const original = f.response.findings[0]!.finding.title;
  const result = await Effect.runPromise(
    reviewGitHubSource(f.fixture.policy, request, f.response, f.filename, {
      transport: async (req) => {
        if (f.response.findings[0]) {
          f.response.findings[0].finding.title = "Injected after decoding";
          f.response.findings[0].finding.evidence = "fabricated";
          f.response.findings = [];
        }
        return f.fixture.transport(req);
      },
    }),
  );
  assert.equal(result.review.status, "findings-proposed");
  const ledger = await runReviewer(
    f.fixture.policy,
    (reviewer) => reviewer.snapshot(),
    f.filename,
  );
  assert.equal(ledger.outbox[0]?.finding.title, original);
  assert.equal(ledger.outbox[0]?.finding.evidence, "new\r");
});

test("operator policy is owned before asynchronous acquisition", async () => {
  const f = await setup();
  f.fixture.policy.minimumConfidence = 0.99;
  f.response.findings[0]!.finding.confidence = 0.5;
  await Effect.runPromise(
    expectCode(
      reviewGitHubSource(f.fixture.policy, request, f.response, f.filename, {
        transport: async (req) => {
          f.fixture.policy.minimumConfidence = 0;
          return f.fixture.transport(req);
        },
      }),
      "CONFIDENCE",
    ),
  );
  await assertEmpty(f);
});
