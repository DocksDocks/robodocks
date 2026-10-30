import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { onTestFinished, test } from "@effect/vitest";
import type { DiscussionContextResult } from "../src/github-discussion-context.ts";
import {
  githubFixture,
  repository,
  prefix,
  headSha,
} from "./github-fixtures.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
function harness(unavailable = false) {
  const dir = mkdtempSync(join(tmpdir(), "robodocks-check-cli-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const preload = join(dir, "synthetic-fetch.ts");
  const fixture = githubFixture();
  Object.assign(fixture.pr, { title: "PR title", body: null });
  for (const suffix of [
    "issues/7/comments",
    "pulls/7/reviews",
    "pulls/7/comments",
  ])
    fixture.routes.set(`${prefix}/${suffix}?per_page=100&page=1`, []);
  writeFileSync(
    preload,
    `const routes = new Map(${JSON.stringify([...fixture.routes])}); globalThis.fetch = async (request) => { const url = new URL(request.url); if (url.origin !== 'https://api.github.com' || request.method !== 'GET' || request.headers.has('authorization') || request.headers.has('cookie')) throw new Error('Unexpected request'); const path = url.pathname + url.search; return ${unavailable} && path.includes('/comments?') ? Response.json({message:'SENSITIVE'}, {status:403}) : routes.has(path) ? Response.json(routes.get(path)) : Response.json({}, {status:404}); };`,
  );
  const run = (extra: string[] = []) =>
    spawnSync(
      process.execPath,
      [
        "--preload",
        preload,
        "src/cli.ts",
        "collect-discussion",
        "--policy",
        "examples/policy.json",
        "--repository",
        repository,
        "--pull-request",
        "7",
        ...extra,
      ],
      { cwd: root, encoding: "utf8", timeout: 10000 },
    );
  return { dir, run };
}

test("discussion-context CLI emits separate time-bound read-only endpoint evidence", () => {
  const { dir, run } = harness();
  const first = run(["--attempt", "discussion-1"]);
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout) as DiscussionContextResult;
  assert.equal(result.operation, "discussion-context");
  assert.equal(result.acquisition.status, "endpoint-observed");
  assert.equal(result.observation.atomic, false);
  assert.equal(result.context?.provenance.headSha, headSha);
  assert.deepEqual(result.context?.issueComments, []);
  assert.deepEqual(result.context?.reviews, []);
  assert.deepEqual(result.context?.reviewComments, []);
  assert.equal(result.context?.title, "PR title");
  assert.equal(result.context?.body, null);
  assert.equal(result.attempt.id, "discussion-1");
  assert.equal(result.attempt.eventId, null);
  assert.equal("plan" in result, false);
  assert.deepEqual(readdirSync(dir), ["synthetic-fetch.ts"]);
});

test("discussion-context unavailable evidence has nonzero exit and sanitized JSON", () => {
  const output = harness(true).run();
  assert.equal(output.status, 1, output.stderr);
  assert.equal(output.stderr, "");
  const result = JSON.parse(output.stdout) as DiscussionContextResult;
  assert.equal(result.acquisition.status, "unavailable");
  assert.equal(result.context, null);
  assert(!output.stdout.includes("SENSITIVE"));
});

test("discussion-context rejects ledger, credential, URL and write flags", () => {
  const { run } = harness();
  for (const extra of [
    ["--database", "forbidden.sqlite"],
    ["--token", "SECRET"],
    ["--api-origin", "https://evil.example"],
    ["--publish", "true"],
    ["--input", "review.json"],
  ]) {
    const output = run(extra);
    assert.equal(output.status, 1);
    assert.equal(output.stdout, "");
    assert.equal(
      (JSON.parse(output.stderr) as { error: string }).error,
      "USAGE",
    );
    assert(!output.stderr.includes("SECRET"));
  }
});
