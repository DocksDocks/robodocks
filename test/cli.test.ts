import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
function cli(args: string[]) {
  return spawnSync(process.execPath, ["src/cli.ts", ...args], { cwd: root, encoding: "utf8", timeout: 10_000 });
}

test("CLI runs synthetic demo and emits only JSON", () => {
  const result = cli(["--policy", "examples/policy.json", "--input", "examples/review.json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.plan.dryRun, true);
  assert.equal(output.plan.intents.length, 1);
  assert.equal(output.snapshot.outbox[0].status, "pending");
});

test("CLI has help and fails closed on unsupported arguments", () => {
  assert.equal(cli(["--help"]).status, 0);
  const result = cli(["--publish"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).error, "USAGE");
});

test("CLI reports unreadable input without leaking paths or content", () => {
  const result = cli(["--policy", "/definitely-not-a-real-secret-file", "--input", "examples/review.json"]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, "INPUT");
  assert.ok(!result.stderr.includes("definitely-not"));
});

test("CLI rejects malformed and oversized JSON", () => {
  const directory = mkdtempSync(join(tmpdir(), "robodocks-test-"));
  try {
    const input = join(directory, "input.json");
    writeFileSync(input, "{broken-json");
    const args = ["--policy", "examples/policy.json", "--input", input];
    assert.equal(JSON.parse(cli(args).stderr).error, "JSON");
    writeFileSync(input, " ".repeat(2 * 1024 * 1024 + 1));
    assert.equal(JSON.parse(cli(args).stderr).error, "INPUT_SIZE");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
