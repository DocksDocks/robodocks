import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "bun:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "robodocks-cli-"));
  directories.push(directory);
  return directory;
}
function cli(args: string[]) {
  return spawnSync(process.execPath, ["src/cli.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
}
function standardArgs(database: string): string[] {
  return [
    "--policy",
    "examples/policy.json",
    "--input",
    "examples/review.json",
    "--database",
    database,
  ];
}
interface Output {
  plan: { dryRun: boolean; deliveryStatus: string; intents: unknown[] };
  snapshot: { outbox: { status: string }[] };
  storage: { journalMode: string };
}
function output(text: string): Output {
  return JSON.parse(text) as Output;
}

test("CLI emits JSON and preserves deduplication across separate process invocations", () => {
  const database = join(temporaryDirectory(), "ledger.sqlite");
  const first = cli(standardArgs(database));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, "");
  const result = output(first.stdout);
  assert.equal(result.plan.dryRun, true);
  assert.equal(result.plan.intents.length, 1);
  assert.equal(result.snapshot.outbox[0]?.status, "pending");
  assert.equal(result.storage.journalMode, "wal");
  const second = cli(standardArgs(database));
  assert.equal(second.status, 0, second.stderr);
  const replay = output(second.stdout);
  assert.equal(replay.plan.deliveryStatus, "duplicate");
  assert.equal(replay.plan.intents.length, 0);
  assert.equal(replay.snapshot.outbox.length, 1);
});

test("CLI has help and rejects unsupported arguments or an implicit database", () => {
  assert.equal(cli(["--help"]).status, 0);
  for (const args of [
    ["--publish"],
    ["--policy", "examples/policy.json", "--input", "examples/review.json"],
  ]) {
    const result = cli(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /"error":"USAGE"/);
  }
});

test("CLI reports unreadable input without leaking paths or content", () => {
  const args = standardArgs(join(temporaryDirectory(), "ledger.sqlite"));
  args[1] = "/definitely-not-a-real-secret-file";
  const result = cli(args);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"error":"INPUT"/);
  assert.ok(!result.stderr.includes("definitely-not"));
});

test("CLI rejects malformed and oversized JSON without exposing its contents", () => {
  const directory = temporaryDirectory();
  const input = join(directory, "input.json");
  const args = standardArgs(join(directory, "ledger.sqlite"));
  args[3] = input;
  writeFileSync(input, "{private-malformed-json");
  assert.match(cli(args).stderr, /"error":"JSON"/);
  assert.ok(!cli(args).stderr.includes("private-malformed"));
  writeFileSync(input, " ".repeat(2 * 1024 * 1024 + 1));
  assert.match(cli(args).stderr, /"error":"INPUT_SIZE"/);
});

test("CLI sanitizes database failures and never emits SQL or local paths", () => {
  const directory = temporaryDirectory();
  const database = join(directory, "private-ledger.sqlite");
  writeFileSync(database, "not sqlite and contains private data");
  const result = cli(standardArgs(database));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /"error":"STORAGE"/);
  assert.ok(!result.stderr.includes(directory));
  assert.ok(!result.stderr.includes("private"));
});
