import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { onTestFinished, test } from "@effect/vitest";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import type { InspectionPage } from "../src/inspection.ts";
import { fixtures, runReviewer } from "./helpers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "robodocks-cli-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
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
  schemaVersion: 1;
  operation: "plan";
  plan: { dryRun: boolean; deliveryStatus: string; intents: unknown[] };
  storage: { journalMode: string };
}
function output(text: string): Output {
  return JSON.parse(text) as Output;
}

function inspect(database: string) {
  return cli([
    "inspect",
    "--policy",
    "examples/policy.json",
    "--database",
    database,
    "--repository",
    "example-owner/example-project",
  ]);
}

function inspection(text: string): InspectionPage {
  return JSON.parse(text) as InspectionPage;
}

test("CLI emits JSON and preserves deduplication across separate process invocations", () => {
  const database = join(temporaryDirectory(), "ledger.sqlite");
  const first = cli(["plan", ...standardArgs(database)]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, "");
  const result = output(first.stdout);
  assert.equal(result.plan.dryRun, true);
  assert.equal(result.plan.intents.length, 1);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.operation, "plan");
  assert.equal("snapshot" in result, false);
  assert.equal("finding" in (result.plan.intents[0] as object), false);
  assert.equal(
    inspection(inspect(database).stdout).items[0]?.intent.status,
    "pending",
  );
  assert.equal(result.storage.journalMode, "wal");
  const second = cli(standardArgs(database));
  assert.equal(second.status, 0, second.stderr);
  const replay = output(second.stdout);
  assert.equal(replay.plan.deliveryStatus, "duplicate");
  assert.equal(replay.plan.intents.length, 0);
  assert.equal(inspection(inspect(database).stdout).items.length, 1);
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

test.skipIf(process.platform !== "linux")(
  "CLI rejects a FIFO before reading or creating a database",
  () => {
    const directory = temporaryDirectory();
    const fifo = join(directory, "input.fifo");
    const database = join(directory, "ledger.sqlite");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    const args = standardArgs(database);
    args[3] = fifo;
    const result = spawnSync(process.execPath, ["src/cli.ts", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 3000,
      killSignal: "SIGKILL",
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /"error":"INPUT_SIZE"/);
    assert.equal(existsSync(database), false);
  },
);

test("CLI rejects malformed UTF-8 instead of silently changing JSON text", () => {
  const directory = temporaryDirectory();
  const input = join(directory, "invalid-utf8.json");
  const database = join(directory, "ledger.sqlite");
  const fixture = readFileSync(join(root, "examples/review.json"));
  const title = Buffer.from("Empty input produces NaN");
  const at = fixture.indexOf(title);
  assert.ok(at >= 0);
  writeFileSync(
    input,
    Buffer.concat([
      fixture.subarray(0, at),
      Buffer.from([0xff]),
      fixture.subarray(at + 1),
    ]),
  );
  const args = standardArgs(database);
  args[3] = input;
  const result = cli(args);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"error":"JSON"/);
  assert.equal(existsSync(database), false);
});

test.skipIf(process.platform !== "linux")(
  "CLI awaits stdout failures and a retry preserves the committed delivery",
  () => {
    const database = join(temporaryDirectory(), "ledger.sqlite");
    const output = openSync("/dev/full", "w");
    try {
      const result = spawnSync(
        process.execPath,
        ["src/cli.ts", ...standardArgs(database)],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", output, "pipe"],
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.deepEqual(JSON.parse(result.stderr), {
        error: "OUTPUT",
        message:
          "Could not write review output; the delivery may already be committed",
      });
    } finally {
      closeSync(output);
    }
    const replay = cli(standardArgs(database));
    assert.equal(replay.status, 0, replay.stderr);
    const result = JSON.parse(replay.stdout) as Output;
    assert.equal(result.plan.deliveryStatus, "duplicate");
    assert.equal(inspection(inspect(database).stdout).items.length, 1);
  },
);

test("planning ignores unrelated corrupt history and never emits finding prose", async () => {
  const directory = temporaryDirectory();
  const filename = join(directory, "ledger.sqlite");
  const { policy, request } = fixtures();
  await runReviewer(policy, (reviewer) => reviewer.plan(request), filename);
  const db = new Database(filename, { strict: true });
  db.run("UPDATE outbox SET payload = '{}' ");
  db.close(true);
  request.deliveryId = "new-valid-delivery";
  request.findings[0]!.ruleId = "new.rule";
  request.findings[0]!.title = "CURRENT-PRIVATE-PROSE";
  const input = join(directory, "new-review.json");
  writeFileSync(input, JSON.stringify(request));
  const args = standardArgs(filename);
  args[3] = input;
  const planned = cli(args);
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(output(planned.stdout).plan.intents.length, 1);
  assert.ok(!planned.stdout.includes("CURRENT-PRIVATE-PROSE"));
  assert.ok(!planned.stdout.includes(request.findings[0]!.evidence));
  assert.equal(output(cli(args).stdout).plan.deliveryStatus, "duplicate");
  const inspected = inspect(filename);
  assert.equal(inspected.status, 1);
  assert.match(inspected.stderr, /"error":"STORAGE_INTEGRITY"/);
  assert.equal(inspected.stdout, "");
  const raw = new Database(filename, { readonly: true });
  try {
    assert.deepEqual(
      raw.query("SELECT count(*) AS count FROM deliveries").get(),
      { count: 2 },
    );
  } finally {
    raw.close(true);
  }
});

test("inspection CLI needs no review input and cannot initialize a missing ledger", () => {
  const filename = join(temporaryDirectory(), "absent-parent", "ledger.sqlite");
  const result = inspect(filename);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"error":"DATABASE_PATH"/);
  assert.equal(existsSync(filename), false);
  assert.equal(existsSync(join(filename, "..")), false);
  for (const extra of [
    ["--input", "examples/review.json"],
    ["--limit", "0"],
    ["--status", "pending"],
  ]) {
    const invalid = cli([
      "inspect",
      "--policy",
      "examples/policy.json",
      "--database",
      filename,
      "--repository",
      "example-owner/example-project",
      ...extra,
    ]);
    assert.equal(invalid.status, 1);
    assert.ok(!invalid.stderr.includes(filename));
    assert.equal(existsSync(filename), false);
  }
});

test.skipIf(process.platform !== "linux")(
  "inspection output failure does not claim a committed delivery",
  async () => {
    const filename = join(temporaryDirectory(), "ledger.sqlite");
    const { policy } = fixtures();
    await runReviewer(policy, () => Effect.void, filename);
    const target = openSync("/dev/full", "w");
    try {
      const result = spawnSync(
        process.execPath,
        [
          "src/cli.ts",
          "inspect",
          "--policy",
          "examples/policy.json",
          "--database",
          filename,
          "--repository",
          "example-owner/example-project",
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", target, "pipe"],
        },
      );
      assert.equal(result.status, 1);
      assert.deepEqual(JSON.parse(result.stderr), {
        error: "OUTPUT",
        message: "Could not write inspection output; no delivery was admitted",
      });
    } finally {
      closeSync(target);
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "help output failure never implies a committed delivery",
  () => {
    const target = openSync("/dev/full", "w");
    try {
      for (const args of [
        ["--help"],
        ["inspect", "--help"],
        ["plan", "--help"],
      ]) {
        const result = spawnSync(process.execPath, ["src/cli.ts", ...args], {
          cwd: root,
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", target, "pipe"],
        });
        assert.equal(result.status, 1);
        assert.deepEqual(JSON.parse(result.stderr), {
          error: "OUTPUT",
          message: "Could not write output; no delivery was admitted",
        });
      }
    } finally {
      closeSync(target);
    }
  },
);
