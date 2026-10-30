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
  const run = (
    args: string[],
    extraEnv: Record<string, string | undefined> = {},
  ) =>
    spawnSync(process.execPath, ["src/cli.ts", ...args], {
      cwd: checkout,
      // Bun otherwise creates $HOME/.bun/install/cache while loading imports,
      // before the CLI can reject HOME. Keep runtime writes out of this assertion.
      env: {
        ...process.env,
        ...extraEnv,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      },
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
    const result = run(args, { HOME: root, XDG_CACHE_HOME: undefined });
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /at .*\.ts:/);
    const error = JSON.parse(result.stderr) as {
      error: string;
      message: string;
    };
    assert.equal(
      error.error,
      args[0] === "workspace-init" && args.length === 3 ? "WORKSPACE" : "USAGE",
    );
    if (args[0] === "workspace-init" && args.length === 3 && args[2] === root) {
      assert.match(error.message, /Home roots and protected storage paths/);
    }
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

test("HOME guard rejects inventory of an otherwise valid owned root", () => {
  const { root, run } = fixture();
  const initialized = run(["workspace-init", "--root", root]);
  assert.equal(initialized.status, 0, initialized.stderr);
  const marker = join(root, ".robodocks-root.json");
  const before = readFileSync(marker);
  const rejected = run(["workspace-inventory", "--root", root], {
    HOME: root,
    XDG_CACHE_HOME: undefined,
  });
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, "");
  const error = JSON.parse(rejected.stderr) as {
    error: string;
    message: string;
  };
  assert.equal(error.error, "WORKSPACE");
  assert.match(error.message, /Home roots and protected storage paths/);
  assert.deepEqual(readdirSync(root), [".robodocks-root.json"]);
  assert.deepEqual(readFileSync(marker), before);
});
