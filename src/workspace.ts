import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
} from "node:path";
import { Effect, Schema } from "effect";
import { HeadSha } from "./contracts.ts";
import { ContractError, requireCondition } from "./validation.ts";

const UUID = Schema.String.check(
  Schema.isPattern(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/,
  ),
);
const TaskId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}(?![\s\S])/),
);
const RootMarker = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("robodocks-task-root"),
  rootId: UUID,
});
const TaskMarker = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("robodocks-task"),
  rootId: UUID,
  taskId: TaskId,
});
export const TaskManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  rootId: UUID,
  taskId: TaskId,
  state: Schema.Literals(["active", "completed"]),
  gitState: Schema.Literals(["unknown", "dirty", "unpushed", "claimed-clean"]),
  artifactState: Schema.Literals(["unknown", "sole-copy", "claimed-preserved"]),
  checkpoint: Schema.NullOr(
    Schema.Struct({
      url: Schema.String.check(
        Schema.isBetweenLength(1, 300),
        Schema.isPattern(
          /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/(issues|pull)\/[1-9][0-9]{0,9}(?![\s\S])/,
        ),
      ),
      headSha: HeadSha.check(Schema.isBetweenLength(40, 40)),
    }),
  ),
});
const rootFile = ".robodocks-root.json";
const taskFile = ".robodocks-task.json";
const manifestFile = "task.json";
const limits = { tasks: 100, entries: 1000, depth: 8 };

function decode<A>(schema: Schema.ConstraintDecoder<A>, value: unknown): A {
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
}
function fail(message: string): never {
  throw new ContractError("WORKSPACE", message);
}
function scopedRoot(root: string): void {
  requireCondition(
    root.length <= 1024 &&
      !root.endsWith("/") &&
      isAbsolute(root) &&
      normalize(root) === root &&
      basename(root) === "robodocks-tasks" &&
      !Array.from(root).some(
        (character) =>
          character.charCodeAt(0) <= 31 ||
          character.charCodeAt(0) === 127 ||
          character === "\\",
      ) &&
      root.split("/").filter(Boolean).length >= 3,
    "WORKSPACE",
    "Use an absolute normalized dedicated robodocks-tasks path under an existing private parent",
  );
  const home = homedir();
  requireCondition(
    root !== home &&
      !home.startsWith(root + "/") &&
      !root
        .split("/")
        .some((part) =>
          /^(?:\.ssh|\.aws|\.gnupg|.*credentials.*|.*ledger.*|.*backup.*)$/i.test(
            part,
          ),
        ),
    "WORKSPACE",
    "Home roots and protected storage paths cannot be task roots",
  );
  let current = dirname(root);
  while (true) {
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      fail("Root ancestors must be real directories, not symlinks");
    if (current === parse(current).root) break;
    current = dirname(current);
  }
}
function directory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    fail("Expected an owned real directory");
}
function json(path: string): unknown {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 8192 || info.nlink !== 1)
      fail("Metadata must be a single-link regular file of at most 8192 bytes");
    const bytes = Buffer.alloc(8193);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > 8192) fail("Metadata exceeds 8192 bytes");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, length),
      ),
    ) as unknown;
  } finally {
    closeSync(fd);
  }
}
function save(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}
function ownedRoot(root: string) {
  scopedRoot(root);
  directory(root);
  return decode(RootMarker, json(join(root, rootFile)));
}
function boundedEntries(path: string, maximum: number): string[] {
  const dir = opendirSync(path);
  try {
    const names: string[] = [];
    for (let item = dir.readSync(); item !== null; item = dir.readSync()) {
      if (names.length === maximum)
        fail(
          "Workspace inventory limit exceeded; no complete inventory available",
        );
      names.push(item.name);
    }
    return names.sort();
  } finally {
    dir.closeSync();
  }
}
function inspectPayload(
  path: string,
  blockers: Set<string>,
  budget: { remaining: number },
  depth: number,
): void {
  if (depth > limits.depth) {
    blockers.add("scan-limit");
    return;
  }
  for (const name of boundedEntries(path, limits.entries)) {
    if (--budget.remaining < 0) {
      blockers.add("scan-limit");
      return;
    }
    if (
      /^(\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|.*credentials.*|.*\.(?:sqlite(?:-wal|-shm|-journal)?|db|pem|key)|.*(?:backup|ledger).*)$/i.test(
        name,
      )
    )
      blockers.add("protected-content");
    const child = join(path, name);
    const info = lstatSync(child);
    if (info.isSymbolicLink()) blockers.add("symlink-present");
    else if (info.isDirectory())
      inspectPayload(child, blockers, budget, depth + 1);
    else if (!info.isFile() || info.nlink !== 1)
      blockers.add("unsupported-file");
  }
}
function run<A>(action: () => A): Effect.Effect<A, ContractError> {
  return Effect.try({
    try: action,
    catch: (error) =>
      error instanceof ContractError
        ? error
        : new ContractError(
            "WORKSPACE",
            "Workspace operation rejected; check ownership, paths, metadata, permissions and limits. Creation may have left a partial directory; nothing was deleted",
          ),
  });
}
export function initializeWorkspace(root: string) {
  return run(() => {
    scopedRoot(root);
    mkdirSync(root, { mode: 0o700 }); // Exclusive: never adopt an existing directory.
    const marker = {
      schemaVersion: 1,
      kind: "robodocks-task-root",
      rootId: randomUUID(),
    };
    save(join(root, rootFile), marker);
    return {
      operation: "workspace-init",
      dryRun: true,
      deletionAuthorized: false,
      rootId: marker.rootId,
    };
  });
}
export function createTask(root: string, taskId: string) {
  return run(() => {
    decode(TaskId, taskId);
    const marker = ownedRoot(root);
    if (boundedEntries(root, limits.tasks + 1).length >= limits.tasks + 1)
      fail("Task limit reached");
    const path = join(root, taskId);
    mkdirSync(path, { mode: 0o700 });
    save(join(path, taskFile), {
      schemaVersion: 1,
      kind: "robodocks-task",
      rootId: marker.rootId,
      taskId,
    });
    save(join(path, manifestFile), {
      schemaVersion: 1,
      rootId: marker.rootId,
      taskId,
      state: "active",
      gitState: "unknown",
      artifactState: "unknown",
      checkpoint: null,
    });
    return {
      operation: "task-create",
      dryRun: true,
      deletionAuthorized: false,
      taskId,
    };
  });
}
export function inventoryWorkspace(root: string) {
  return run(() => {
    const marker = ownedRoot(root);
    const tasks = boundedEntries(root, limits.tasks + 1)
      .filter((name) => name !== rootFile)
      .map((taskId) => {
        const blockers = new Set<string>();
        let state: "active" | "completed" | "unknown" = "unknown";
        try {
          decode(TaskId, taskId);
          const path = join(root, taskId);
          directory(path);
          const ownership = decode(TaskMarker, json(join(path, taskFile)));
          const manifest = decode(TaskManifest, json(join(path, manifestFile)));
          if (
            ownership.rootId !== marker.rootId ||
            ownership.taskId !== taskId ||
            manifest.rootId !== marker.rootId ||
            manifest.taskId !== taskId
          )
            fail("Task ownership mismatch");
          state = manifest.state;
          if (state === "active") blockers.add("active-task");
          if (manifest.gitState === "dirty") blockers.add("dirty-worktree");
          if (manifest.gitState === "unpushed")
            blockers.add("unpushed-commits");
          if (manifest.artifactState === "sole-copy")
            blockers.add("sole-artifact-copy");
          if (manifest.checkpoint === null) blockers.add("missing-checkpoint");
          inspectPayload(path, blockers, { remaining: limits.entries }, 0);
        } catch {
          blockers.add("invalid-or-unowned-task");
        }
        const status = blockers.size === 0 ? "needs-verification" : "blocked";
        blockers.add("activity-unverified");
        blockers.add("git-state-unverified");
        blockers.add("artifacts-unverified");
        blockers.add("remote-checkpoint-unverified");
        return { taskId, state, status, blockers: [...blockers].sort() };
      });
    return {
      operation: "workspace-inventory",
      dryRun: true,
      deletionAuthorized: false,
      tasks,
    };
  });
}
