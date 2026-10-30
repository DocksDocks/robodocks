import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { onTestFinished, test } from "@effect/vitest";
import { contextFixture } from "./github-context-fixtures.ts";
import { fixtures, runReviewer } from "./helpers.ts";
import { repository } from "./github-fixtures.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
async function harness(unavailable = false) {
  const dir = mkdtempSync(join(tmpdir(), "robodocks-preview-cli-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const preload = join(dir, "fetch.ts"),
    filename = join(dir, "ledger.sqlite");
  const f = contextFixture();
  const input = fixtures().request;
  input.context.files = [{ path: "modified.ts", content: "new\r\n" }];
  Object.assign(input.findings[0]!, {
    path: "modified.ts",
    startLine: 1,
    endLine: 1,
    evidence: "new\r",
  });
  const plan = await runReviewer(
    f.policy,
    (reviewer) => reviewer.plan(input),
    filename,
  );
  const intentId = plan.intents[0]!.id;
  writeFileSync(
    preload,
    `const routes = new Map(${JSON.stringify([...f.routes])}); globalThis.fetch = async request => {const u = new URL(request.url); if(u.origin !== 'https://api.github.com' || request.method !== 'GET' || request.headers.has('authorization') || request.headers.has('cookie')) throw new Error('Unexpected request'); const path=u.pathname+u.search; return ${unavailable} && path.includes('/comments?') ? Response.json({message:'PRIVATE'}, {status:403}) : routes.has(path) ? Response.json(routes.get(path)) : Response.json({}, {status:404});};`,
  );
  const args = [
    "preview-publication",
    "--policy",
    "examples/policy.json",
    "--database",
    filename,
    "--repository",
    repository,
    "--pull-request",
    "7",
    "--intent",
    intentId,
    "--attempt",
    "preview-cli",
  ];
  const run = (values = args) =>
    spawnSync(
      process.execPath,
      ["--preload", preload, "src/cli.ts", ...values],
      { cwd: root, encoding: "utf8", timeout: 10000 },
    );
  return { dir, filename, args, run };
}

test("preview CLI renders deterministic drafts without changing ledger bytes", async () => {
  const f = await harness();
  const before = readFileSync(f.filename);
  const first = f.run();
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.operation, "preview-publication");
  assert.equal(result.dryRun, true);
  assert.equal(result.publication, "disabled");
  assert.equal(result.preview.status, "draft-rendered");
  assert.equal(result.draft.kind, "pr-conversation-comment");
  assert.equal(result.draft.bodyBytes, Buffer.byteLength(result.draft.body));
  const second = f.run();
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout).draft, result.draft);
  assert.deepEqual(readFileSync(f.filename), before);
});

test("failed fresh collection emits no draft and nonzero status", async () => {
  const f = await harness(true);
  const before = readFileSync(f.filename);
  const result = f.run();
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.preview.status, "blocked");
  assert.equal(output.draft, null);
  assert(!result.stdout.includes("PRIVATE"));
  assert.deepEqual(readFileSync(f.filename), before);
});

test("preview rejects missing or unsupported arguments before opening storage", async () => {
  const f = await harness();
  for (const args of [
    f.args.slice(0, 9),
    [...f.args, "--input", "untrusted.json"],
    [...f.args, "--publish", "true"],
    [...f.args, "--token", "SECRET"],
    [...f.args, "--output", "draft.md"],
    [...f.args, "--api-origin", "https://evil.example"],
    [...f.args, "--intent", "duplicate"],
  ]) {
    const result = f.run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error, "USAGE");
    assert(!result.stderr.includes("SECRET"));
  }
  const missing = join(f.dir, "missing", "ledger.sqlite");
  const args = f.args.map((value) => (value === f.filename ? missing : value));
  assert.equal(f.run(args).status, 1);
  assert.equal(existsSync(join(f.dir, "missing")), false);
  const help = f.run(["preview-publication", "--help"]);
  assert.equal(help.status, 0);
  assert(help.stdout.includes("--intent"));
});
