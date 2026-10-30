import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "robodocks-package-"));
const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const env = { ...process.env, DO_NOT_TRACK: "1" };
delete env.NODE_PATH;
// The installed bin's shebang must resolve the same verified Bun as this test.
env.PATH = dirname(process.execPath) + ":" + (env.PATH ?? "");
function run(command, args, cwd = temporary, expected = 0) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `${command}: ${result.error?.message}`);
  assert.equal(
    result.status,
    expected,
    `${command} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`,
  );
  return result;
}
function files(relative) {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = relative + "/" + entry.name;
      assert(
        !entry.isSymbolicLink(),
        `Package source must not contain symlinks: ${path}`,
      );
      return entry.isDirectory() ? files(path) : [path];
    },
  );
}
let complete = false;
try {
  const archive = join(temporary, "candidate.tgz");
  run(
    process.execPath,
    ["pm", "pack", "--ignore-scripts", "--filename", archive],
    root,
  );
  const members = run("tar", ["-tzf", archive]).stdout.trim().split("\n");
  const expected = [
    "package.json",
    "README.md",
    "LICENSE",
    ...["bin", "src", "skills", "docs", "examples"].flatMap(files),
  ].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(
    members.sort((a, b) => a.localeCompare(b)),
    expected
      .map((path) => "package/" + path)
      .sort((a, b) => a.localeCompare(b)),
    "Unexpected or missing package members",
  );
  assert(
    !members.some((path) =>
      /(?:^|\/)(?:node_modules|test|local|\.git|\.env)(?:\/|$)|\.(?:sqlite|log|tgz)$/.test(
        path,
      ),
    ),
    "Private or development artifacts entered package",
  );
  writeFileSync(
    join(temporary, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { robodocks: "file:./candidate.tgz" },
    }),
  );
  run(process.execPath, ["install", "--production", "--ignore-scripts"]);
  const installed = join(temporary, "node_modules", "robodocks");
  assert(
    !realpathSync(installed).startsWith(root + "/"),
    "Installation leaked checkout source",
  );
  for (const path of expected) {
    assert.deepEqual(
      readFileSync(join(installed, path)),
      readFileSync(join(root, path)),
      `Installed bytes differ: ${path}`,
    );
  }
  for (const dependency of Object.keys(metadata.devDependencies)) {
    assert(
      !existsSync(join(temporary, "node_modules", dependency)),
      `Development dependency installed: ${dependency}`,
    );
  }
  assert(
    existsSync(join(temporary, "node_modules", "effect")),
    "Runtime dependency missing",
  );
  const bin = join(temporary, "node_modules", ".bin", "robodocks");
  assert.equal(run(bin, ["--version"]).stdout.trim(), metadata.version);
  assert.match(run(bin, ["--help"]).stdout, /Usage:/);
  // Linux artifact target: /dev/full deterministically rejects every write.
  // Exercise the installed executable, not a mocked output helper.
  const full = openSync("/dev/full", "w");
  try {
    for (const flag of ["--version", "--help"]) {
      const failedOutput = spawnSync(bin, [flag], {
        cwd: temporary,
        env,
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", full, "pipe"],
      });
      assert.equal(failedOutput.error, undefined);
      assert.equal(failedOutput.status, 1);
      assert.deepEqual(JSON.parse(failedOutput.stderr), {
        error: "OUTPUT",
        message: "Could not write output; no delivery was admitted",
      });
    }
  } finally {
    closeSync(full);
  }

  for (const command of [
    "plan",
    "inspect",
    "collect",
    "collect-checks",
    "review",
    "backup",
    "restore",
    "workspace-init",
    "task-create",
    "workspace-inventory",
  ]) {
    assert.match(run(bin, [command, "--help"]).stdout, /Usage:/);
  }
  const workspace = join(temporary, "robodocks-tasks");
  for (const args of [
    ["workspace-init", "--root", workspace],
    ["task-create", "--root", workspace, "--task", "installed-task"],
  ]) {
    const result = JSON.parse(run(bin, args).stdout);
    assert.equal(result.dryRun, true);
    assert.equal(result.deletionAuthorized, false);
  }
  const manifest = join(workspace, "installed-task", "task.json");
  const manifestBefore = readFileSync(manifest);
  const inventoryArgs = ["workspace-inventory", "--root", workspace];
  const inventoryOutput = run(bin, inventoryArgs).stdout;
  const inventory = JSON.parse(inventoryOutput);
  assert.equal(inventory.operation, "workspace-inventory");
  assert.equal(inventory.dryRun, true);
  assert.equal(inventory.deletionAuthorized, false);
  assert.equal(inventory.tasks[0].status, "blocked");
  for (const blocker of [
    "active-task",
    "git-state-unverified",
    "remote-checkpoint-unverified",
  ]) {
    assert(inventory.tasks[0].blockers.includes(blocker));
  }
  assert.equal(run(bin, inventoryArgs).stdout, inventoryOutput);
  assert.deepEqual(readFileSync(manifest), manifestBefore);
  const unsafeWorkspace = run(
    bin,
    ["workspace-init", "--root", "/"],
    temporary,
    1,
  );
  assert.equal(JSON.parse(unsafeWorkspace.stderr).error, "WORKSPACE");
  const noDeletion = run(bin, [...inventoryArgs, "--delete"], temporary, 1);
  assert.equal(JSON.parse(noDeletion.stderr).error, "USAGE");
  const policy = join(installed, "examples", "policy.json");
  const input = join(installed, "examples", "review.json");
  const rejectedChecks = run(
    bin,
    [
      "collect-checks",
      "--policy",
      policy,
      "--repository",
      "example-owner/example-project",
      "--pull-request",
      "7",
      "--database",
      join(temporary, "forbidden.sqlite"),
    ],
    temporary,
    1,
  );
  assert.equal(JSON.parse(rejectedChecks.stderr).error, "USAGE");
  assert(!existsSync(join(temporary, "forbidden.sqlite")));
  const database = join(temporary, "ledger.sqlite");
  const args = [
    "plan",
    "--policy",
    policy,
    "--input",
    input,
    "--database",
    database,
  ];
  const first = JSON.parse(run(bin, args).stdout);
  assert.equal(first.plan.deliveryStatus, "accepted");
  assert.equal(first.plan.intents.length, 1);
  assert.equal(first.plan.dryRun, true);
  assert.equal(
    JSON.parse(run(bin, args).stdout).plan.deliveryStatus,
    "duplicate",
  );
  const inspection = JSON.parse(
    run(bin, [
      "inspect",
      "--policy",
      policy,
      "--database",
      database,
      "--repository",
      "example-owner/example-project",
    ]).stdout,
  );
  assert.equal(inspection.operation, "inspect");
  assert.match(JSON.stringify(inspection), /average.empty-input/);
  const snapshot = join(temporary, "snapshot.sqlite");
  const restoredDatabase = join(temporary, "restored.sqlite");
  assert.equal(
    JSON.parse(
      run(bin, [
        "backup",
        "--policy",
        policy,
        "--database",
        database,
        "--output",
        snapshot,
      ]).stdout,
    ).operation,
    "backup",
  );
  assert.equal(
    JSON.parse(
      run(bin, [
        "restore",
        "--policy",
        policy,
        "--input",
        snapshot,
        "--database",
        restoredDatabase,
      ]).stdout,
    ).operation,
    "restore",
  );
  const restoredPlan = JSON.parse(
    run(bin, [
      "plan",
      "--policy",
      policy,
      "--input",
      input,
      "--database",
      restoredDatabase,
    ]).stdout,
  );
  assert.equal(restoredPlan.plan.deliveryStatus, "duplicate");
  const restoredInspection = JSON.parse(
    run(bin, [
      "inspect",
      "--policy",
      policy,
      "--database",
      restoredDatabase,
      "--repository",
      "example-owner/example-project",
    ]).stdout,
  );
  assert.deepEqual(restoredInspection.items, inspection.items);
  assert.equal(restoredInspection.nextCursor, null);
  const agentResponse = join(temporary, "agent-response.json");
  const rejectedDatabase = join(temporary, "rejected.sqlite");
  writeFileSync(agentResponse, JSON.stringify({ context: "not trusted" }));
  const rejectedReview = run(
    bin,
    [
      "review",
      "--policy",
      policy,
      "--input",
      agentResponse,
      "--database",
      rejectedDatabase,
      "--repository",
      "example-owner/example-project",
      "--pull-request",
      "7",
      "--attempt",
      "package-smoke",
    ],
    temporary,
    1,
  );
  assert.equal(rejectedReview.stdout, "");
  assert.equal(JSON.parse(rejectedReview.stderr).error, "AGENT_RESPONSE");
  assert(
    !existsSync(rejectedDatabase),
    "Rejected agent response created a ledger",
  );
  assert(
    run(bin, ["collect-discussion", "--help"]).stdout.includes(
      "collect-discussion",
    ),
  );
  const discussionPreload = join(temporary, "discussion-fetch.ts");
  writeFileSync(
    discussionPreload,
    `const repo = {id:71,full_name:"example-owner/example-project",private:false,visibility:"public"}; const pr = {id:701,number:7,title:"Installed discussion smoke",body:null,head:{sha:"${"a".repeat(40)}",repo},base:{repo}}; globalThis.fetch = async request => { const url = new URL(request.url); if(url.origin !== "https://api.github.com" || request.method !== "GET" || request.headers.has("authorization") || request.headers.has("cookie")) throw new Error("Unexpected request"); const suffix = url.pathname.slice("/repos/example-owner/example-project".length); if(suffix === "") return Response.json(repo); if(suffix === "/pulls/7") return Response.json(pr); if(["/issues/7/comments","/pulls/7/reviews","/pulls/7/comments"].includes(suffix) && url.search === "?per_page=100&page=1") return Response.json([]); return Response.json({}, {status:404}); };`,
  );
  const installedDiscussion = JSON.parse(
    run(process.execPath, [
      "--preload",
      discussionPreload,
      bin,
      "collect-discussion",
      "--policy",
      policy,
      "--repository",
      "example-owner/example-project",
      "--pull-request",
      "7",
      "--attempt",
      "installed-discussion",
    ]).stdout,
  );
  assert.equal(installedDiscussion.operation, "discussion-context");
  assert.equal(installedDiscussion.acquisition.status, "endpoint-observed");
  assert.equal(installedDiscussion.context.title, "Installed discussion smoke");
  assert.deepEqual(installedDiscussion.context.reviewComments, []);
  const rejectedDiscussion = run(
    bin,
    [
      "collect-discussion",
      "--policy",
      policy,
      "--repository",
      "example-owner/example-project",
      "--pull-request",
      "7",
      "--database",
      rejectedDatabase,
    ],
    temporary,
    1,
  );
  assert.equal(JSON.parse(rejectedDiscussion.stderr).error, "USAGE");
  assert(!existsSync(rejectedDatabase), "Discussion context created a ledger");
  assert(
    run(bin, ["collect-context", "--help"]).stdout.includes("collect-context"),
  );
  const contextPreload = join(temporary, "context-fetch.ts");
  writeFileSync(
    contextPreload,
    `
    const sha = "${"a".repeat(40)}", tree = "${"d".repeat(40)}";
    const repo = {id:71,full_name:"example-owner/example-project",private:false,visibility:"public"};
    const pr = {id:701,number:7,changed_files:0,title:"Installed context smoke",body:null,head:{sha,repo},base:{sha,repo}};
    globalThis.fetch = async request => {
      const url = new URL(request.url);
      if(url.origin !== "https://api.github.com" || request.method !== "GET" || request.headers.has("authorization") || request.headers.has("cookie")) throw new Error("Unexpected request");
      const suffix = url.pathname.slice("/repos/example-owner/example-project".length);
      if(suffix === "") return Response.json(repo);
      if(suffix === "/pulls/7") return Response.json(pr);
      if(["/issues/7/comments","/pulls/7/reviews","/pulls/7/comments"].includes(suffix)) return Response.json([]);
      if(suffix.endsWith("/check-runs")) return Response.json({total_count:0,check_runs:[]});
      if(suffix.endsWith("/status")) return Response.json({sha,total_count:0,statuses:[]});
      if(suffix.startsWith("/compare/")) return Response.json({base_commit:{sha},merge_base_commit:{sha},files:[]});
      if(suffix.startsWith("/git/commits/")) return Response.json({sha,tree:{sha:tree}});
      if(suffix.startsWith("/git/trees/")) return Response.json({sha:tree,truncated:false,tree:[]});
      return Response.json({}, {status:404});
    };
  `,
  );
  const installedContext = JSON.parse(
    run(process.execPath, [
      "--preload",
      contextPreload,
      bin,
      "collect-context",
      "--policy",
      policy,
      "--repository",
      "example-owner/example-project",
      "--pull-request",
      "7",
      "--attempt",
      "installed-context",
    ]).stdout,
  );
  assert.equal(installedContext.operation, "collect-context");
  assert.equal(installedContext.acquisition.status, "context-observed");
  assert.equal(installedContext.bundle.source.acquisition.status, "complete");
  assert.equal(
    installedContext.bundle.discussion.context.title,
    "Installed context smoke",
  );
  assert.equal(
    installedContext.bundle.checks.acquisition.status,
    "endpoint-observed",
  );
  assert.equal(installedContext.observation.atomic, false);
  const rejectedContext = run(
    bin,
    [
      "collect-context",
      "--policy",
      policy,
      "--repository",
      "example-owner/example-project",
      "--pull-request",
      "7",
      "--database",
      rejectedDatabase,
    ],
    temporary,
    1,
  );
  assert.equal(JSON.parse(rejectedContext.stderr).error, "USAGE");
  assert(!existsSync(rejectedDatabase), "Combined context created a ledger");
  const installedPackages = readdirSync(join(temporary, "node_modules"))
    .filter((name) => !name.startsWith("."))
    .sort((a, b) => a.localeCompare(b));
  assert.deepEqual(installedPackages, ["effect", "robodocks"]);
  const installedDependencyTree = installedPackages.map((name) => {
    const directory = join(temporary, "node_modules", name);
    assert(
      realpathSync(directory).startsWith(temporary + "/"),
      "Dependency escaped clean installation",
    );
    const pkg = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    );
    return `${pkg.name}@${pkg.version}`;
  });
  assert.deepEqual(installedDependencyTree, [
    `effect@${metadata.dependencies.effect}`,
    `robodocks@${metadata.version}`,
  ]);
  const invalid = join(temporary, "invalid.json");
  writeFileSync(invalid, "{ broken");
  const failure = run(
    bin,
    ["plan", "--policy", policy, "--input", invalid, "--database", database],
    temporary,
    1,
  );
  assert.equal(failure.stdout, "");
  assert.equal(JSON.parse(failure.stderr).error, "JSON");
  const unknown = run(bin, ["--definitely-unknown"], temporary, 1);
  assert.equal(JSON.parse(unknown.stderr).error, "USAGE");
  complete = true;
  console.log(
    JSON.stringify({
      package: metadata.name,
      version: metadata.version,
      members: members.length,
      runtime: process.versions.bun,
      result: "passed",
      installedDependencyTree,
    }),
  );
} finally {
  if (complete) rmSync(temporary, { recursive: true, force: true });
  else console.error(`Package smoke fixture retained: ${temporary}`);
}
