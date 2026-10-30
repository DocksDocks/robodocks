import assert from "node:assert/strict";
import { Effect, Schema } from "effect";
import { test } from "@effect/vitest";
import {
  collectGitHubCheckContext,
  CheckContextResultSchema,
} from "../src/github-check-context.ts";
import {
  githubFixture,
  prefix,
  headSha,
  prPath,
  request,
} from "./github-fixtures.ts";
import type { GitHubTransport, HttpLimits } from "../src/github-http.ts";

const checksPath = `${prefix}/commits/${headSha}/check-runs?filter=all&per_page=100&page=1`;
const statusesPath = `${prefix}/commits/${headSha}/status?per_page=100&page=1`;
const time = "2026-10-30T12:00:00Z";
function runValue(id = 1) {
  return {
    id,
    app: { id: 5 },
    check_suite: { id: 9 },
    name: "test",
    head_sha: headSha,
    status: "completed",
    conclusion: "success",
    started_at: time,
    completed_at: time,
    details_url: "https://evil.invalid",
    output: { text: "SENSITIVE" },
  };
}
function statusValue(id = 1) {
  return {
    id,
    context: `ci${id}`,
    state: "success",
    created_at: time,
    updated_at: time,
    target_url: "https://evil.invalid",
  };
}
function fixture() {
  const f = githubFixture();
  const checks = { total_count: 1, check_runs: [runValue()] };
  const statuses = { sha: headSha, total_count: 1, statuses: [statusValue()] };
  f.routes.set(checksPath, checks);
  f.routes.set(statusesPath, statuses);
  const run = (
    transport: GitHubTransport = f.transport,
    httpLimits: Partial<HttpLimits> = {},
  ) =>
    Effect.runPromise(
      collectGitHubCheckContext(f.policy, request, { transport, httpLimits }),
    );
  return { ...f, checks, statuses, run };
}
test("exact-head evidence uses two bounded read-only observations without logs or aggregate approval", async () => {
  const f = fixture();
  const result = await f.run();
  assert.ok(Schema.is(CheckContextResultSchema)(result));
  assert.equal(result.acquisition.status, "endpoint-observed");
  assert.equal(result.acquisition.requests, 8);
  assert.equal(result.context?.provenance.repositoryId, 71);
  assert.equal(result.context?.provenance.pullRequestId, 701);
  assert.equal(result.observation.atomic, false);
  assert.equal(result.observation.checkSuiteLimit, 1000);
  assert.equal(result.context?.checkRuns.length, 1);
  assert.ok(!JSON.stringify(result).includes("SENSITIVE"));
  assert.ok(!JSON.stringify(result).includes("evil.invalid"));
  assert.deepEqual(f.calls, [
    prefix,
    prPath,
    checksPath,
    statusesPath,
    checksPath,
    statusesPath,
    prefix,
    prPath,
  ]);
});
test("empty observations are explicit empty evidence, not approval or pending aggregate", async () => {
  const f = fixture();
  f.checks.total_count = 0;
  f.checks.check_runs = [];
  f.statuses.total_count = 0;
  f.statuses.statuses = [];
  const result = await f.run();
  assert.equal(result.acquisition.status, "endpoint-observed");
  assert.deepEqual(result.context?.checkRuns, []);
  assert.deepEqual(result.context?.statuses, []);
});
test("two pages per endpoint preserve equal check names across apps and retries within12 requests", async () => {
  const f = fixture();
  f.checks.total_count = 200;
  f.checks.check_runs = Array.from({ length: 100 }, (_, i) => runValue(i + 1));
  f.statuses.total_count = 200;
  f.statuses.statuses = Array.from({ length: 100 }, (_, i) =>
    statusValue(i + 1),
  );
  f.routes.set(checksPath.replace(/&page=1$/, "&page=2"), {
    total_count: 200,
    check_runs: Array.from({ length: 100 }, (_, i) => runValue(i + 101)),
  });
  f.routes.set(statusesPath.replace(/&page=1$/, "&page=2"), {
    sha: headSha,
    total_count: 200,
    statuses: Array.from({ length: 100 }, (_, i) => statusValue(i + 101)),
  });
  const result = await f.run();
  assert.equal(result.acquisition.status, "endpoint-observed");
  assert.equal(result.acquisition.requests, 12);
  assert.equal(result.context?.checkRuns.length, 200);
});
test("identity and head changes during collection fail closed", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.pr.head.sha = "f".repeat(40);
    },
    (f: ReturnType<typeof fixture>) => {
      f.pr.id++;
    },
    (f: ReturnType<typeof fixture>) => {
      f.repo.id++;
      f.pr.head.repo.id++;
      f.pr.base.repo.id++;
    },
  ]) {
    const f = fixture();
    let calls = 0;
    const result = await f.run(async (req) => {
      if (++calls === 7) mutate(f);
      return f.transport(req);
    });
    assert.equal(result.acquisition.status, "stale");
    assert.equal(result.context, null);
  }
});
test("initial wrong repository, PR, fork and malformed identity do not fetch check evidence", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.repo.full_name = "other/repo";
    },
    (f: ReturnType<typeof fixture>) => {
      f.pr.number++;
    },
    (f: ReturnType<typeof fixture>) => {
      f.pr.head.repo.id++;
    },
    (f: ReturnType<typeof fixture>) => {
      f.pr.id = NaN;
    },
  ]) {
    const f = fixture();
    mutate(f);
    const result = await f.run();
    assert.equal(result.context, null);
    assert.notEqual(result.acquisition.status, "endpoint-observed");
    assert.ok(f.calls.length <= 2);
  }
});
test("malformed, oversized, duplicate and inconsistent evidence is incomplete", async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => {
      f.checks.total_count = 201;
    },
    (f: ReturnType<typeof fixture>) => {
      f.checks.total_count = 2;
    },
    (f: ReturnType<typeof fixture>) => {
      f.checks.check_runs[0]!.name = "x".repeat(257);
    },
    (f: ReturnType<typeof fixture>) => {
      f.checks.check_runs[0]!.head_sha = "b".repeat(40);
    },
    (f: ReturnType<typeof fixture>) => {
      f.statuses.sha = "b".repeat(40);
    },
    (f: ReturnType<typeof fixture>) => {
      f.checks.check_runs.push(runValue());
      f.checks.total_count++;
    },
    (f: ReturnType<typeof fixture>) => {
      f.statuses.statuses.push(statusValue());
      f.statuses.total_count++;
    },
    (f: ReturnType<typeof fixture>) => {
      f.statuses.statuses.push({ ...statusValue(2), context: "CI1" });
      f.statuses.total_count++;
    },
    (f: ReturnType<typeof fixture>) => {
      f.checks.check_runs[0]!.status = "unknown";
    },
    (f: ReturnType<typeof fixture>) => {
      f.checks.check_runs[0]!.started_at = "nonsense";
    },
    (f: ReturnType<typeof fixture>) => {
      f.checks.check_runs[0]!.status = "queued";
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    const result = await f.run();
    assert.equal(result.acquisition.status, "incomplete");
    assert.equal(result.context, null);
  }
});
test("non-atomic changes with unchanged counts are detected by second observation", async () => {
  const f = fixture();
  let seen = 0;
  const result = await f.run(async (req) => {
    if (
      req.url.endsWith("check-runs?filter=all&per_page=100&page=1") &&
      ++seen === 2
    )
      f.checks.check_runs[0]!.conclusion = "failure";
    return f.transport(req);
  });
  assert.deepEqual(result.acquisition.reasons, ["CHECK_CHANGED"]);
  assert.equal(result.context, null);
});
test("permission, unavailable and rate limit failures are sanitized without retries", async () => {
  for (const code of [401, 403, 404, 429, 500]) {
    const f = fixture();
    let failures = 0;
    const result = await f.run(async (req) => {
      if (req.url.endsWith("page=1")) {
        failures++;
        return Response.json({ message: "SENSITIVE" }, { status: code });
      }
      return f.transport(req);
    });
    assert.equal(result.acquisition.status, "unavailable");
    assert.equal(result.context, null);
    assert.equal(failures, 1);
    assert.ok(!JSON.stringify(result).includes("SENSITIVE"));
  }
});
test("byte budgets and timeouts remain incomplete and bounded", async () => {
  const f = fixture();
  const bytes = await f.run(f.transport, { maxResponseBytes: 20 });
  assert.equal(bytes.context, null);
  assert.deepEqual(bytes.acquisition.reasons, ["HTTP_BYTES"]);
  const delayed = await f.run(() => new Promise(() => {}), {
    requestTimeoutMs: 5,
    totalTimeoutMs: 30,
  });
  assert.equal(delayed.context, null);
  assert.deepEqual(delayed.acquisition.reasons, ["HTTP_TIMEOUT"]);
});
test("request, policy and limit validation happens before any network read", async () => {
  const f = fixture();
  for (const input of [
    { ...request, url: "https://evil.invalid" },
    { ...request, repository: "other/repo" },
    { ...request, pullRequest: 0 },
  ])
    await assert.rejects(
      Effect.runPromise(
        collectGitHubCheckContext(f.policy, input, { transport: f.transport }),
      ),
    );
  await assert.rejects(f.run(f.transport, { maxRequests: 13 }));
  assert.deepEqual(f.calls, []);
});

test("page count drift and cross-page duplicates never yield usable context", async () => {
  for (const duplicate of [false, true]) {
    const f = fixture();
    f.checks.total_count = 101;
    f.checks.check_runs = Array.from({ length: 100 }, (_, i) =>
      runValue(i + 1),
    );
    f.routes.set(checksPath.replace(/&page=1$/, "&page=2"), {
      total_count: duplicate ? 101 : 102,
      check_runs: [runValue(duplicate ? 1 : 101)],
    });
    const result = await f.run();
    assert.equal(result.acquisition.status, "incomplete");
    assert.equal(result.context, null);
    assert.deepEqual(result.acquisition.reasons, [
      duplicate ? "CHECK_DUPLICATE" : "CHECK_CHANGED",
    ]);
  }
});
test("total observation timeout returns bounded structured failure with request accounting", async () => {
  const f = fixture();
  const result = await f.run(() => new Promise(() => {}), {
    totalTimeoutMs: 5,
  });
  assert.equal(result.context, null);
  assert.deepEqual(result.acquisition.reasons, ["HTTP_TIMEOUT"]);
  assert.equal(result.acquisition.requests, 1);
});

test("deterministic output sorting does not collapse apps, retries or distinct outcomes", async () => {
  const f = fixture();
  f.checks.check_runs = [
    {
      ...runValue(3),
      app: { id: 8 },
      status: "queued",
      conclusion: null,
      started_at: null,
      completed_at: null,
    },
    { ...runValue(2), conclusion: "cancelled" },
    { ...runValue(1), conclusion: "failure" },
  ] as typeof f.checks.check_runs;
  f.checks.total_count = 3;
  f.statuses.statuses = [
    statusValue(2),
    { ...statusValue(1), state: "pending" },
  ];
  f.statuses.total_count = 2;
  const result = await f.run();
  assert.equal(result.acquisition.status, "endpoint-observed");
  assert.deepEqual(
    result.context?.checkRuns.map((r) => [
      r.id,
      r.appId,
      r.status,
      r.conclusion,
    ]),
    [
      [1, 5, "completed", "failure"],
      [2, 5, "completed", "cancelled"],
      [3, 8, "queued", null],
    ],
  );
  assert.deepEqual(
    result.context?.statuses.map((r) => r.id),
    [1, 2],
  );
  assert.ok(result.observation.omitted.includes("required-checks"));
});

test("impossible calendar dates and times cannot be normalized into valid evidence", async () => {
  for (const value of [
    "2026-02-30T12:00:00Z",
    "2026-02-29T12:00:00Z",
    "2026-10-30T24:00:00Z",
    "2026-10-30T12:00:00+24:00",
  ]) {
    const f = fixture();
    f.checks.check_runs[0]!.started_at = value;
    const result = await f.run();
    assert.equal(result.acquisition.status, "incomplete");
    assert.deepEqual(result.acquisition.reasons, ["CHECK_TIMESTAMP"]);
  }
  const f = fixture();
  f.checks.check_runs[0]!.started_at = "2024-02-29T12:00:00-03:00";
  assert.equal((await f.run()).acquisition.status, "endpoint-observed");
});
