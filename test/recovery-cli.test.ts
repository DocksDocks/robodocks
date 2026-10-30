import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { onTestFinished, test } from "@effect/vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const policy = ["--policy", "examples/policy.json"];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "robodocks-recovery-cli-"));
  onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function cli(args: string[], stdout?: number) {
  return spawnSync(process.execPath, ["src/cli.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    ...(stdout === undefined
      ? {}
      : { stdio: ["ignore", stdout, "pipe"] as const }),
  });
}
function plan(database: string) {
  return cli([
    "plan",
    ...policy,
    "--input",
    "examples/review.json",
    "--database",
    database,
  ]);
}
function inspect(database: string) {
  return cli([
    "inspect",
    ...policy,
    "--database",
    database,
    "--repository",
    "example-owner/example-project",
  ]);
}

test("recovery CLI requires explicit disjoint source/destination flags", () => {
  for (const command of ["backup", "restore"]) {
    assert.equal(cli([command, "--help"]).status, 0);
  }
  for (const args of [
    ["backup", ...policy, "--database", "unused"],
    [
      "backup",
      ...policy,
      "--database",
      "unused",
      "--output",
      "new",
      "--input",
      "other",
    ],
    ["restore", ...policy, "--input", "unused"],
    [
      "restore",
      ...policy,
      "--database",
      "new",
      "--input",
      "unused",
      "--output",
      "other",
    ],
    [
      "backup",
      ...policy,
      "--database",
      "unused",
      "--output",
      "new",
      "--repository",
      "example-owner/example-project",
    ],
  ]) {
    const result = cli(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /"error":"USAGE"/);
  }
});

test("recovery CLI preserves replay and pending records in a fresh directory", () => {
  const path = directory();
  const source = join(path, "ledger.sqlite");
  const snapshot = join(path, "snapshot.sqlite");
  const fresh = join(path, "fresh");
  mkdirSync(fresh, { mode: 0o700 });
  const restored = join(fresh, "ledger.sqlite");
  assert.equal(plan(source).status, 0);
  const backup = cli([
    "backup",
    ...policy,
    "--database",
    source,
    "--output",
    snapshot,
  ]);
  assert.equal(backup.status, 0, backup.stderr);
  assert.match(backup.stdout, /"operation": "backup"/);
  assert.doesNotMatch(backup.stdout, /average.empty-input/);
  const restore = cli([
    "restore",
    ...policy,
    "--input",
    snapshot,
    "--database",
    restored,
  ]);
  assert.equal(restore.status, 0, restore.stderr);
  assert.match(restore.stdout, /"operation": "restore"/);
  assert.match(restore.stdout, /"cursorAction": "restart"/);
  const replay = plan(restored);
  assert.equal(replay.status, 0, replay.stderr);
  assert.match(replay.stdout, /"deliveryStatus": "duplicate"/);
  assert.equal(inspect(restored).stdout, inspect(source).stdout);
  const original = readFileSync(snapshot);
  const conflict = cli([
    "backup",
    ...policy,
    "--database",
    source,
    "--output",
    snapshot,
  ]);
  assert.equal(conflict.status, 1);
  assert.equal(conflict.stdout, "");
  assert.deepEqual(readFileSync(snapshot), original);
});

test("recovery CLI reports uncertain output without hiding a completed destination", () => {
  const path = directory();
  const source = join(path, "ledger.sqlite");
  const snapshot = join(path, "snapshot.sqlite");
  const restored = join(path, "restored.sqlite");
  assert.equal(plan(source).status, 0);
  const full = openSync("/dev/full", "w");
  try {
    for (const args of [
      ["backup", ...policy, "--database", source, "--output", snapshot],
      ["restore", ...policy, "--input", snapshot, "--database", restored],
    ]) {
      const result = cli(args, full);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /"error":"OUTPUT"/);
      assert.match(result.stderr, /destination may already be complete/);
      assert.doesNotMatch(result.stderr, /no delivery was admitted/);
    }
  } finally {
    closeSync(full);
  }
  assert(existsSync(snapshot));
  assert(existsSync(restored));
  assert.equal(inspect(restored).status, 0);
});
