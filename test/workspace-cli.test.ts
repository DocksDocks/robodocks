import assert from "node:assert/strict";
import {
  closeSync,
  openSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { onTestFinished, test } from "@effect/vitest";

const checkout = fileURLToPath(new URL("..", import.meta.url));
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "robodocks-workspace-cli-"));
  onTestFinished(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "robodocks-tasks");
  const run = (args: string[], extraEnv: Record<string, string> = {}) =>
    spawnSync(process.execPath, ["src/cli.ts", ...args], {
      cwd: checkout,
      env: { ...process.env, ...extraEnv },
      encoding: "utf8",
      timeout: 10_000,
    });
  return { parent, root, run };
}

test("workspace CLI initializes, creates and inventories without executing Git", () => {
  const { parent, root, run } = fixture();
  const bin = join(parent, "bin");
  mkdirSync(bin);
  const sentinel = join(parent, "git-executed");
  writeFileSync(join(bin, "git"), `#!/bin/sh\ntouch '${sentinel}'\nexit 1\n`, {
    mode: 0o700,
  });
  const env = { PATH: bin + ":" + (process.env.PATH ?? "") };
  for (const args of [
    ["workspace-init", "--root", root],
    ["task-create", "--root", root, "--task", "cli-task"],
  ]) {
    const result = run(args, env);
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout) as {
      dryRun: boolean;
      deletionAuthorized: boolean;
    };
    assert.equal(body.dryRun, true);
    assert.equal(body.deletionAuthorized, false);
  }
  const manifest = join(root, "cli-task", "task.json");
  const before = readFileSync(manifest);
  const first = run(["workspace-inventory", "--root", root], env);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /active-task/);
  assert.match(first.stdout, /remote-checkpoint-unverified/);
  assert.equal(
    run(["workspace-inventory", "--root", root], env).stdout,
    first.stdout,
  );
  assert.deepEqual(readFileSync(manifest), before);
  assert.equal(existsSync(sentinel), false);
});

test("workspace CLI rejects broad roots including an isolated HOME", () => {
  const { parent, root, run } = fixture();
  for (const args of [
    ["workspace-init"],
    ["workspace-init", "--root", "/"],
    ["workspace-init", "--root", root],
    ["task-create", "--root", root],
    ["workspace-inventory", "--root", root, "--delete"],
    ["workspace-init", "--root", root, "--database", "private.sqlite"],
  ]) {
    const result = run(args, { HOME: root });
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /at .*\.ts:/);
  }
  assert.deepEqual(readdirSync(parent), []);
});

test("workspace output failure reports possible metadata creation without deletion", () => {
  const { root } = fixture();
  const full = openSync("/dev/full", "w");
  try {
    const result = spawnSync(
      process.execPath,
      ["src/cli.ts", "workspace-init", "--root", root],
      {
        cwd: checkout,
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", full, "pipe"],
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    const error = JSON.parse(result.stderr) as {
      error: string;
      message: string;
    };
    assert.equal(error.error, "OUTPUT");
    assert.match(error.message, /may have written metadata/);
    assert.match(error.message, /nothing was deleted/);
    assert.equal(existsSync(join(root, ".robodocks-root.json")), true);
  } finally {
    closeSync(full);
  }
});
