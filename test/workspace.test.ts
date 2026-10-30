import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "@effect/vitest";
import { Effect } from "effect";
import {
  createTask,
  initializeWorkspace,
  inventoryWorkspace,
} from "../src/workspace.ts";
import { expectCode } from "./helpers.ts";

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "robodocks-workspace-test-"));
  onTestFinished(() => rmSync(parent, { recursive: true, force: true }));
  return { parent, root: join(parent, "robodocks-tasks") };
}
async function taskFixture(taskId = "task-one") {
  const f = fixture();
  await Effect.runPromise(initializeWorkspace(f.root));
  await Effect.runPromise(createTask(f.root, taskId));
  return { ...f, task: join(f.root, taskId), taskId };
}
function edit(path: string, changes: Record<string, unknown>) {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  writeFileSync(path, JSON.stringify({ ...value, ...changes }));
}
function snapshot(path: string): unknown {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return { link: readlinkSync(path) };
  if (info.isDirectory())
    return Object.fromEntries(
      readdirSync(path)
        .sort()
        .map((name) => [name, snapshot(join(path, name))]),
    );
  return {
    bytes: readFileSync(path).toString("base64"),
    mode: info.mode,
    mtime: info.mtimeMs,
  };
}
const unverified = [
  "activity-unverified",
  "artifacts-unverified",
  "git-state-unverified",
  "remote-checkpoint-unverified",
];

test("workspace creation is exclusive, private, explicit and never grants deletion", async () => {
  const { root } = fixture();
  const initialized = await Effect.runPromise(initializeWorkspace(root));
  assert.equal(initialized.dryRun, true);
  assert.equal(initialized.deletionAuthorized, false);
  assert.equal(lstatSync(root).mode & 0o777, 0o700);
  assert.equal(
    lstatSync(join(root, ".robodocks-root.json")).mode & 0o777,
    0o600,
  );
  const before = snapshot(root);
  await Effect.runPromise(expectCode(initializeWorkspace(root), "WORKSPACE"));
  assert.deepEqual(snapshot(root), before);
  const created = await Effect.runPromise(createTask(root, "first"));
  assert.equal(created.dryRun, true);
  assert.equal(created.deletionAuthorized, false);
  await Effect.runPromise(expectCode(createTask(root, "first"), "WORKSPACE"));
});

test("unsafe root paths and task IDs are rejected without creating content", async () => {
  const { parent, root } = fixture();
  for (const path of [
    "/",
    "/tmp",
    "robodocks-tasks",
    parent,
    root + "/",
    parent + "/../robodocks-tasks",
    join(parent, "missing", "robodocks-tasks"),
  ]) {
    await Effect.runPromise(expectCode(initializeWorkspace(path), "WORKSPACE"));
  }
  assert.deepEqual(readdirSync(parent), []);
  await Effect.runPromise(initializeWorkspace(root));
  for (const id of [
    "",
    ".",
    "..",
    "../escape",
    "/tmp/escape",
    "a/b",
    "a\\b",
    "a\n",
    "a".repeat(65),
    "UPPER",
    ".hidden",
  ]) {
    await Effect.runPromise(expectCode(createTask(root, id), "WORKSPACE"));
  }
  assert.deepEqual(readdirSync(root), [".robodocks-root.json"]);
});

test("symlink roots and ancestors cannot establish ownership", async () => {
  const { parent, root } = fixture();
  const actual = join(parent, "actual");
  mkdirSync(actual);
  symlinkSync(actual, root);
  await Effect.runPromise(expectCode(initializeWorkspace(root), "WORKSPACE"));
  await Effect.runPromise(expectCode(inventoryWorkspace(root), "WORKSPACE"));
  await Effect.runPromise(
    expectCode(initializeWorkspace(join(root, "robodocks-tasks")), "WORKSPACE"),
  );
  assert.deepEqual(readdirSync(actual), []);
});

test("active tasks and completed claims retain all verification blockers", async () => {
  const { root, task } = await taskFixture();
  const active = await Effect.runPromise(inventoryWorkspace(root));
  assert.equal(active.dryRun, true);
  assert.equal(active.deletionAuthorized, false);
  assert.equal(active.tasks[0]!.status, "blocked");
  assert.ok(active.tasks[0]!.blockers.includes("active-task"));
  for (const reason of unverified)
    assert.ok(active.tasks[0]!.blockers.includes(reason));
  edit(join(task, "task.json"), {
    state: "completed",
    gitState: "claimed-clean",
    artifactState: "claimed-preserved",
    checkpoint: {
      url: "https://github.com/example/project/pull/1",
      headSha: "a".repeat(40),
    },
  });
  const completed = await Effect.runPromise(inventoryWorkspace(root));
  assert.equal(completed.tasks[0]!.status, "needs-verification");
  assert.deepEqual(completed.tasks[0]!.blockers, unverified);
  assert.equal(
    JSON.stringify(completed).includes('"safeToDelete":true'),
    false,
  );
});

test("dirty, unpushed and sole-copy claims remain explicit blockers", async () => {
  const { root, task } = await taskFixture();
  for (const [gitState, reason] of [
    ["dirty", "dirty-worktree"],
    ["unpushed", "unpushed-commits"],
  ]) {
    edit(join(task, "task.json"), {
      state: "completed",
      gitState,
      artifactState: "sole-copy",
    });
    const result = (await Effect.runPromise(inventoryWorkspace(root)))
      .tasks[0]!;
    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.includes(reason!));
    assert.ok(result.blockers.includes("sole-artifact-copy"));
    assert.ok(result.blockers.includes("missing-checkpoint"));
  }
});

test("unknown root metadata fails closed without repairs", async () => {
  for (const contents of [
    "{",
    "{}",
    JSON.stringify({
      schemaVersion: 2,
      kind: "robodocks-task-root",
      rootId: "00000000-0000-4000-8000-000000000000",
    }),
    " ".repeat(8193),
  ]) {
    const { root } = fixture();
    await Effect.runPromise(initializeWorkspace(root));
    writeFileSync(join(root, ".robodocks-root.json"), contents);
    const before = snapshot(root);
    await Effect.runPromise(expectCode(inventoryWorkspace(root), "WORKSPACE"));
    await Effect.runPromise(
      expectCode(createTask(root, "new-task"), "WORKSPACE"),
    );
    assert.deepEqual(snapshot(root), before);
  }
});

test("missing, malformed, newer and foreign task manifests never become complete tasks", async () => {
  for (const changes of [
    { state: "unknown" },
    { schemaVersion: 2 },
    { extra: true },
    { taskId: "different" },
    { rootId: "00000000-0000-4000-8000-000000000000" },
    { checkpoint: { url: "https://evil.example/", headSha: "a".repeat(40) } },
  ]) {
    const { root, task } = await taskFixture();
    edit(join(task, "task.json"), changes);
    const before = snapshot(root);
    const result = (await Effect.runPromise(inventoryWorkspace(root)))
      .tasks[0]!;
    assert.equal(result.state, "unknown");
    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.includes("invalid-or-unowned-task"));
    assert.deepEqual(snapshot(root), before);
  }
  const { root } = await taskFixture();
  mkdirSync(join(root, "unregistered"));
  const result = (await Effect.runPromise(inventoryWorkspace(root))).tasks.find(
    (item) => item.taskId === "unregistered",
  )!;
  assert.equal(result.state, "unknown");
  assert.ok(result.blockers.includes("invalid-or-unowned-task"));
});

test("metadata symlinks, hardlinks and oversized files are not trusted", async () => {
  for (const kind of [
    "symlink",
    "hardlink",
    "oversized",
    "malformed",
  ] as const) {
    const { parent, root, task } = await taskFixture();
    const metadata = join(task, "task.json");
    const other = join(parent, "other.json");
    if (kind === "symlink") {
      writeFileSync(other, readFileSync(metadata));
      rmSync(metadata);
      symlinkSync(other, metadata);
    } else if (kind === "hardlink") linkSync(metadata, other);
    else
      writeFileSync(
        metadata,
        kind === "oversized" ? " ".repeat(8193) : "{broken",
      );
    const before = snapshot(parent);
    const result = (await Effect.runPromise(inventoryWorkspace(root)))
      .tasks[0]!;
    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.includes("invalid-or-unowned-task"));
    assert.deepEqual(snapshot(parent), before);
  }
});

test("protected payloads, external symlinks and hardlinks block planning without traversal", async () => {
  const { parent, root, task } = await taskFixture();
  for (const name of [
    "ledger.sqlite",
    "ledger.sqlite-wal",
    "ledger.sqlite-shm",
    ".env",
    "credentials.json",
    "archive-backup",
    "private.key",
  ])
    writeFileSync(join(task, name), "sentinel");
  const external = join(parent, "external");
  mkdirSync(external);
  writeFileSync(join(external, "sentinel"), "outside");
  symlinkSync(external, join(task, "external"));
  linkSync(join(external, "sentinel"), join(task, "hardlink"));
  const before = snapshot(parent);
  const result = (await Effect.runPromise(inventoryWorkspace(root))).tasks[0]!;
  for (const reason of [
    "protected-content",
    "symlink-present",
    "unsupported-file",
  ])
    assert.ok(result.blockers.includes(reason));
  assert.deepEqual(snapshot(parent), before);
});

test("inventory is deterministic and does not execute repository Git configuration", async () => {
  const { parent, root, task } = await taskFixture("z-task");
  await Effect.runPromise(createTask(root, "a-task"));
  mkdirSync(join(task, ".git"));
  const sentinel = join(parent, "executed");
  writeFileSync(
    join(task, ".git", "config"),
    `[core]\nfsmonitor = "touch ${sentinel}"\n[filter "malicious"]\nclean = touch ${sentinel}\n`,
  );
  const before = snapshot(parent);
  const first = await Effect.runPromise(inventoryWorkspace(root));
  assert.deepEqual(await Effect.runPromise(inventoryWorkspace(root)), first);
  assert.deepEqual(
    first.tasks.map((item) => item.taskId),
    ["a-task", "z-task"],
  );
  assert.equal(existsSync(sentinel), false);
  assert.deepEqual(snapshot(parent), before);
});

test("inventory bounds root breadth and task payload depth", async () => {
  const { root, task } = await taskFixture();
  let nested = task;
  for (let index = 0; index < 10; index++) {
    nested = join(nested, "nested");
    mkdirSync(nested);
  }
  assert.ok(
    (
      await Effect.runPromise(inventoryWorkspace(root))
    ).tasks[0]!.blockers.includes("scan-limit"),
  );
  for (let index = 0; index < 101; index++)
    mkdirSync(join(root, `entry-${index}`));
  await Effect.runPromise(expectCode(inventoryWorkspace(root), "WORKSPACE"));
});

test("inventory bounds task payload breadth rather than returning verification-only status", async () => {
  const { root, task } = await taskFixture();
  for (let index = 0; index < 1001; index++)
    writeFileSync(join(task, `entry-${index}`), "");
  const result = (await Effect.runPromise(inventoryWorkspace(root))).tasks[0]!;
  assert.equal(result.status, "blocked");
  assert.ok(
    result.blockers.includes("invalid-or-unowned-task") ||
      result.blockers.includes("scan-limit"),
  );
});

test("workspace roots cannot overlap protected ancestor directories", async () => {
  const { parent } = fixture();
  for (const name of [
    ".ssh",
    ".aws",
    ".gnupg",
    "credentials",
    "ledger",
    "backups",
  ]) {
    const protectedDirectory = join(parent, name);
    mkdirSync(protectedDirectory);
    await Effect.runPromise(
      expectCode(
        initializeWorkspace(join(protectedDirectory, "robodocks-tasks")),
        "WORKSPACE",
      ),
    );
    assert.deepEqual(readdirSync(protectedDirectory), []);
  }
});

test("nonblocking metadata reads reject FIFOs and invalid UTF-8", async () => {
  for (const kind of ["fifo", "utf8"]) {
    const { root, task } = await taskFixture();
    const manifest = join(task, "task.json");
    if (kind === "fifo") {
      rmSync(manifest);
      const created = spawnSync("mkfifo", [manifest], {
        encoding: "utf8",
        timeout: 1000,
      });
      assert.equal(created.status, 0, created.stderr);
    } else writeFileSync(manifest, Buffer.from([0xc3, 0x28]));
    const result = (await Effect.runPromise(inventoryWorkspace(root)))
      .tasks[0]!;
    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.includes("invalid-or-unowned-task"));
    assert.equal(lstatSync(manifest).isFIFO(), kind === "fifo");
  }
});
