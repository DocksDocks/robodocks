import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { onTestFinished, test } from "@effect/vitest";
import type { CollectionResult } from "../src/github-source.ts";
import { githubFixture, repository } from "./github-fixtures.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
function harness(fixture = githubFixture()) {
  const dir = mkdtempSync(join(tmpdir(), "robodocks-collect-cli-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const preload = join(dir, "synthetic-fetch.ts");
  // Test-only Bun preload. The application has no environment/CLI transport bypass.
  writeFileSync(
    preload,
    `const routes = new Map(${JSON.stringify([...fixture.routes])}); globalThis.fetch = async (request) => { const url = new URL(request.url); if (url.origin !== 'https://api.github.com' || request.method !== 'GET') throw new Error('Unexpected request'); const path = url.pathname + url.search; return routes.has(path) ? Response.json(routes.get(path)) : Response.json({ message: 'SENSITIVE-DETAIL' }, { status: 404 }); };`,
  );
  const run = (extra: string[] = []) =>
    spawnSync(
      process.execPath,
      [
        "--preload",
        preload,
        "src/cli.ts",
        "collect",
        "--policy",
        "examples/policy.json",
        "--repository",
        repository,
        "--pull-request",
        "7",
        ...extra,
      ],
      { cwd: root, encoding: "utf8", timeout: 10_000 },
    );
  return { dir, run };
}

test("manual collection CLI emits source only, no ledger, and separate attempt identity", () => {
  const { run, dir } = harness();
  const first = run(["--attempt", "operator-attempt"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, "");
  const result = JSON.parse(first.stdout) as CollectionResult;
  assert.equal(result.operation, "collect");
  assert.equal(result.acquisition.status, "complete");
  assert.equal(result.attempt.id, "operator-attempt");
  assert.equal(result.attempt.eventId, null);
  assert.equal(result.review.status, "not-run");
  assert.equal(result.snapshot?.files.length, 4);
  assert.equal("plan" in result, false);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  const retry = JSON.parse(second.stdout) as CollectionResult;
  assert.notEqual(retry.attempt.id, result.attempt.id);
  assert.equal(retry.snapshotId, result.snapshotId);
  assert.deepEqual(readdirSync(dir), ["synthetic-fetch.ts"]);
});

test("manual collection CLI returns nonzero with explicit unsupported/incomplete JSON", () => {
  for (const privateRepo of [false, true]) {
    const f = githubFixture();
    if (privateRepo) f.repo.private = true;
    else f.headTree.truncated = true;
    const result = harness(f).run();
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, "");
    const body = JSON.parse(result.stdout) as CollectionResult;
    assert.equal(
      body.acquisition.status,
      privateRepo ? "unsupported" : "incomplete",
    );
    assert.equal(body.snapshotId, null);
    assert.equal(body.review.status, "not-run");
    assert.ok(!result.stdout.includes("SENSITIVE-DETAIL"));
  }
});

test("collection flags cannot expand scope or mix ledger commands", () => {
  const { run } = harness();
  for (const args of [
    ["--database", "secret.sqlite"],
    ["--event-id", "transport-event"],
    ["--token", "SECRET-TOKEN"],
    ["--api-origin", "https://evil.example"],
    ["--attempt", "invalid attempt"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes("SECRET-TOKEN"));
    assert.ok(!result.stderr.includes("evil.example"));
  }
  const help = spawnSync(
    process.execPath,
    ["src/cli.ts", "collect", "--help"],
    { cwd: root, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes("--pull-request"));
});
