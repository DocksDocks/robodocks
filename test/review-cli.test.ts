import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished, test } from "@effect/vitest";
import type { AgentReview } from "../src/agent-review.ts";
import type { CollectionResult } from "../src/github-source.ts";
import type { InspectionPage } from "../src/inspection.ts";
import { fixtures } from "./helpers.ts";
import { githubFixture, repository } from "./github-fixtures.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
interface ReviewOutput {
  operation: string;
  scope: string;
  review: { status: string };
  acquisition: { status: string };
  plan: null | { deliveryStatus: string; intents: unknown[] };
}
function harness() {
  const dir = mkdtempSync(join(tmpdir(), "robodocks-review-cli-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = githubFixture();
  const preload = join(dir, "synthetic-fetch.ts");
  const routes = join(dir, "routes.json");
  const calls = join(dir, "calls.txt");
  const database = join(dir, "ledger.sqlite");
  const responseFile = join(dir, "response.json");
  const saveRoutes = () =>
    writeFileSync(routes, JSON.stringify([...fixture.routes]));
  saveRoutes();
  // Trusted test-only preload, never a transport switch exposed by the CLI.
  writeFileSync(
    preload,
    `import { readFileSync, appendFileSync } from 'node:fs';
const routes = new Map(JSON.parse(readFileSync(${JSON.stringify(routes)}, 'utf8')));
globalThis.fetch = async (request) => {
  appendFileSync(${JSON.stringify(calls)}, 'GET\\n');
  const url = new URL(request.url);
  if (url.origin !== 'https://api.github.com' || request.method !== 'GET') throw new Error('Unexpected request');
  const path = url.pathname + url.search;
  return routes.has(path) ? Response.json(routes.get(path)) : Response.json({}, {status:404});
};`,
  );
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--preload", preload, "src/cli.ts", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
  const targetArgs = [
    "--policy",
    "examples/policy.json",
    "--repository",
    repository,
    "--pull-request",
    "7",
    "--attempt",
    "cli-attempt",
  ];
  const collection = run(["collect", ...targetArgs]);
  assert.equal(collection.status, 0, collection.stderr);
  const collected = JSON.parse(collection.stdout) as CollectionResult;
  assert.ok(collected.snapshotId);
  const response: AgentReview = {
    schemaVersion: 1,
    attemptId: collected.attempt.id,
    snapshotId: collected.snapshotId,
    scope: "changed-files-head-v1",
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
  const saveResponse = (input: unknown = response) =>
    writeFileSync(responseFile, JSON.stringify(input));
  saveResponse();
  const reviewArgs = [
    "review",
    ...targetArgs,
    "--input",
    responseFile,
    "--database",
    database,
  ];
  const networkCalls = () =>
    existsSync(calls) ? readFileSync(calls, "utf8").split("\n").length - 1 : 0;
  return {
    run,
    fixture,
    database,
    response,
    saveResponse,
    saveRoutes,
    reviewArgs,
    networkCalls,
  };
}

test("CLI collect to agent response to review persists and replays inspectable dry-run findings", () => {
  const h = harness();
  const before = h.networkCalls();
  const result = h.run(h.reviewArgs);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout) as ReviewOutput;
  assert.equal(body.operation, "review");
  assert.equal(body.review.status, "findings-proposed");
  assert.equal(body.scope, "changed-files-head-v1");
  assert.equal(body.plan?.deliveryStatus, "accepted");
  assert.equal(body.plan?.intents.length, 1);
  assert.ok(h.networkCalls() > before);
  const replay = h.run(h.reviewArgs);
  assert.equal(replay.status, 0, replay.stderr);
  const replayBody = JSON.parse(replay.stdout) as ReviewOutput;
  assert.equal(replayBody.plan?.deliveryStatus, "duplicate");
  assert.equal(replayBody.plan?.intents.length, 0);
  const inspect = h.run([
    "inspect",
    "--policy",
    "examples/policy.json",
    "--database",
    h.database,
    "--repository",
    repository,
  ]);
  assert.equal(inspect.status, 0, inspect.stderr);
  const page = JSON.parse(inspect.stdout) as InspectionPage;
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.intent.status, "pending");
  assert.equal(page.items[0]?.intent.finding.path, "modified.ts");
  assert.equal(page.items[0]?.intent.finding.evidence, "new\r");
});

test("CLI incomplete agent response exits nonzero without admitting a ledger", () => {
  const h = harness();
  h.saveResponse({ ...h.response, status: "incomplete", findings: [] });
  const result = h.run(h.reviewArgs);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout) as ReviewOutput;
  assert.equal(body.acquisition.status, "complete");
  assert.equal(body.review.status, "incomplete");
  assert.equal(body.plan, null);
  assert.equal(existsSync(h.database), false);
});

test("CLI incomplete source exits nonzero and never reports a clean review", () => {
  const h = harness();
  h.fixture.headTree.truncated = true;
  h.saveRoutes();
  const result = h.run(h.reviewArgs);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout) as ReviewOutput;
  assert.equal(body.acquisition.status, "incomplete");
  assert.equal(body.review.status, "not-run");
  assert.equal(body.plan, null);
  assert.equal(existsSync(h.database), false);
});

test("CLI malformed review flags fail before network access or ledger creation", () => {
  const h = harness();
  const before = h.networkCalls();
  const without = (flag: string) => {
    const index = h.reviewArgs.indexOf(flag);
    return [...h.reviewArgs.slice(0, index), ...h.reviewArgs.slice(index + 2)];
  };
  for (const args of [
    without("--attempt"),
    without("--input"),
    without("--database"),
    [...h.reviewArgs, "--token", "SECRET"],
    [...h.reviewArgs, "--publish", "true"],
  ]) {
    const result = h.run(args);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(
      (JSON.parse(result.stderr) as { error: string }).error,
      "USAGE",
    );
    assert.ok(!result.stderr.includes("SECRET"));
  }
  assert.equal(h.networkCalls(), before);
  assert.equal(existsSync(h.database), false);
});
