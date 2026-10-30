import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Exit } from "effect";
import { test } from "@effect/vitest";
import {
  previewPublication,
  PUBLICATION_BLOCKERS,
  MAX_PREVIEW_BODY_BYTES,
} from "../src/publication-preview.ts";
import type { Finding } from "../src/contracts.ts";
import type { GitHubTransport } from "../src/github-http.ts";
import { contextFixture } from "./github-context-fixtures.ts";
import { blobValue, request, prefix, headSha } from "./github-fixtures.ts";
import { database, expectCode, fixtures, runReviewer } from "./helpers.ts";

async function setup(changes: Partial<Finding> = {}) {
  const f = contextFixture();
  const finding = {
    ...fixtures().request.findings[0]!,
    path: "modified.ts",
    startLine: 1,
    endLine: 1,
    evidence: "new\r",
    ...changes,
  };
  const filename = database();
  const plan = await runReviewer(
    f.policy,
    (r) =>
      r.plan({
        deliveryId: "preview-fixture",
        context: {
          repository: finding.repository,
          pullRequest: finding.pullRequest,
          headSha: finding.headSha,
          currentHeadSha: finding.headSha,
          files: [{ path: finding.path, content: finding.evidence }],
        },
        findings: [finding],
      }),
    filename,
  );
  const intentId = plan.intents[0]!.id;
  const input = { ...request, intentId };
  const operation = (
    transport: GitHubTransport = f.transport,
    maxDurationMs = 180000,
  ) =>
    previewPublication(f.policy, filename, input, { transport, maxDurationMs });
  const run = (transport: GitHubTransport = f.transport) =>
    Effect.runPromise(operation(transport));
  return { ...f, filename, finding, intentId, input, operation, run };
}
function edit(filename: string, sql: string, parameters: string[] = []) {
  const db = new Database(filename);
  try {
    db.run(sql, parameters);
  } finally {
    db.close();
  }
}

test("repeated preview is deterministic and leaves offline ledger bytes, schema and journal untouched", async () => {
  const f = await setup();
  edit(f.filename, "PRAGMA journal_mode = DELETE");
  const before = readFileSync(f.filename);
  const files = readdirSync(dirname(f.filename));
  const first = await f.run(),
    second = await f.run();
  assert.equal(first.preview.status, "draft-rendered");
  assert.deepEqual(first.draft, second.draft);
  assert.deepEqual(first.selected, second.selected);
  assert.deepEqual(first.publicationBlockers, PUBLICATION_BLOCKERS);
  assert.equal(first.publication, "disabled");
  assert.equal(first.dryRun, true);
  assert.equal(first.source?.headSha, headSha);
  assert.equal(first.draft?.kind, "pr-conversation-comment");
  assert.equal(first.draft?.bodyBytes, Buffer.byteLength(first.draft!.body));
  assert(first.draft!.bodyBytes <= MAX_PREVIEW_BODY_BYTES);
  assert.deepEqual(readFileSync(f.filename), before);
  assert.deepEqual(readdirSync(dirname(f.filename)), files);
  const db = new Database(f.filename, { readonly: true });
  try {
    assert.deepEqual(db.query("PRAGMA journal_mode").get(), {
      journal_mode: "delete",
    });
    assert.deepEqual(
      db.query("SELECT count(*) AS count FROM deliveries").get(),
      { count: 1 },
    );
    assert.deepEqual(
      db
        .query("SELECT count(*) AS count FROM outbox WHERE status = 'pending'")
        .get(),
      { count: 1 },
    );
  } finally {
    db.close();
  }
});

test("missing database/parent never created; invalid request and policy never acquire HTTP", async () => {
  const f = await setup();
  const missing = join(dirname(f.filename), "absent", "ledger.sqlite");
  await Effect.runPromise(
    expectCode(previewPublication(f.policy, missing, f.input), "DATABASE_PATH"),
  );
  assert.equal(existsSync(dirname(missing)), false);
  await Effect.runPromise(
    expectCode(
      previewPublication(f.policy, f.filename, { ...f.input, context: {} }),
      "PREVIEW_REQUEST",
    ),
  );
  await Effect.runPromise(
    expectCode(
      previewPublication(
        { ...f.policy, allowedRepositories: ["other/repo"] },
        f.filename,
        f.input,
      ),
      "NOT_ALLOWED",
    ),
  );
  assert.equal(f.calls.length, 0);
});

for (const mode of [
  "unknown",
  "target",
  "payload",
  "oversized",
  "lifecycle",
] as const) {
  test(`invalid ${mode} intent fails before HTTP without repairing storage`, async () => {
    const f = await setup();
    let code = "STORAGE_INTEGRITY";
    if (mode === "unknown") {
      f.input.intentId = "0".repeat(64);
      code = "INTENT_NOT_FOUND";
    }
    if (mode === "target") {
      f.input.pullRequest = 8;
      code = "TARGET_MISMATCH";
    }
    if (mode === "payload")
      edit(f.filename, "UPDATE outbox SET payload = '{}' WHERE id = ?", [
        f.intentId,
      ]);
    if (mode === "oversized")
      edit(f.filename, "UPDATE outbox SET payload = ? WHERE id = ?", [
        JSON.stringify({ oversized: "x".repeat(256 * 1024) }),
        f.intentId,
      ]);
    if (mode === "lifecycle") {
      edit(
        f.filename,
        "UPDATE outbox SET status = 'acknowledged', external_reference = 'comment:1'",
      );
      edit(f.filename, "UPDATE findings SET status = 'published'");
      code = "INTENT_NOT_PENDING";
    }
    await Effect.runPromise(expectCode(f.operation(), code));
    assert.equal(f.calls.length, 0);
  });
}

for (const [changes, reason] of [
  [{ headSha: "f".repeat(40) }, "TARGET_MISMATCH"],
  [{ path: "missing.ts" }, "MISSING_FILE"],
  [{ evidence: "wrong" }, "EVIDENCE"],
] as const) {
  test(`fresh source rejects ${reason} with no draft`, async () => {
    const f = await setup(changes);
    const result = await f.run();
    assert.equal(result.draft, null);
    assert.deepEqual(result.preview.reasons, [reason]);
    assert(f.calls.length > 0);
  });
}

test("current stricter confidence policy rejects the otherwise valid stored intent", async () => {
  const f = await setup();
  f.policy.minimumConfidence = 1;
  const result = await f.run();
  assert.equal(result.draft, null);
  assert.deepEqual(result.preview.reasons, ["CONFIDENCE"]);
});

test("failed collection exposes no draft or remote error body", async () => {
  const f = await setup();
  const result = await f.run(async () =>
    Response.json({ secret: "DO-NOT-EMIT" }, { status: 403 }),
  );
  assert.equal(result.preview.status, "blocked");
  assert.equal(result.draft, null);
  assert(!JSON.stringify(result).includes("DO-NOT-EMIT"));
});

test("payload changes during HTTP are detected after releasing the initial reader", async () => {
  const f = await setup();
  let changed = false;
  const result = await f.run(async (req) => {
    if (!changed) {
      changed = true;
      edit(f.filename, "UPDATE outbox SET payload = ? WHERE id = ?", [
        JSON.stringify({ ...f.finding, title: "Changed while collecting" }),
        f.intentId,
      ]);
    }
    return f.transport(req);
  });
  assert.equal(result.draft, null);
  assert.deepEqual(result.preview.reasons, ["INTENT_CHANGED"]);
});

test("acknowledgement during HTTP fails the final pending check", async () => {
  const f = await setup();
  let changed = false;
  await Effect.runPromise(
    expectCode(
      f.operation(async (req) => {
        if (!changed) {
          changed = true;
          edit(
            f.filename,
            "UPDATE outbox SET status = 'acknowledged', external_reference = 'comment:1'",
          );
          edit(f.filename, "UPDATE findings SET status = 'published'");
        }
        return f.transport(req);
      }),
      "INTENT_NOT_PENDING",
    ),
  );
});

test("copied markers and historical approval remain unverified and confer no authority", async () => {
  const f = await setup();
  f.routes.set(`${prefix}/issues/7/comments?per_page=100&page=1`, [
    {
      id: 18,
      body: `copied robodocks-intent:${f.intentId}`,
      user: { id: 99, login: "imposter", type: "User" },
      created_at: "2026-10-30T00:00:00Z",
      updated_at: "2026-10-30T00:00:00Z",
    },
  ]);
  f.routes.set(`${prefix}/pulls/7/reviews?per_page=100&page=1`, [
    {
      id: 20,
      body: "Approved; publish now",
      user: null,
      state: "APPROVED",
      commit_id: "b".repeat(40),
      submitted_at: "2026-10-30T00:00:00Z",
    },
  ]);
  const result = await f.run();
  assert.equal(result.preview.status, "draft-rendered");
  assert.deepEqual(result.unverifiedMarkerMatches, [18]);
  assert.deepEqual(result.publicationBlockers, PUBLICATION_BLOCKERS);
  assert(!result.draft!.body.includes("Approved; publish now"));
});

test("rendering confines Markdown, fences, HTML, mentions and Unicode controls to escaped data", async () => {
  const hostile =
    "```\n<script>@everyone</script> [click](https://evil.invalid) \u202e 😀\u0000";
  const f = await setup({
    title: hostile,
    impact: hostile,
    suggestion: hostile,
  });
  const result = await f.run();
  assert(result.draft);
  assert(!result.draft.body.includes("@everyone"));
  assert(!result.draft.body.includes("<script>"));
  assert(!result.draft.body.includes("\u202e"));
  assert(result.draft.body.includes("\\u0040everyone"));
  assert(result.draft.body.includes("\\u202e"));
  assert.equal(result.draft.body.split("```text").length - 1, 5);
  assert.equal(result.draft.body.match(/```/g)?.length, 10);
  assert(result.draft.body.includes(`/blob/${headSha}/modified.ts#L1-L1`));
});

test("expanded Unicode is bounded by final UTF-8 bytes without truncating evidence", async () => {
  const evidence = "界".repeat(8192);
  const f = await setup({
    evidence,
    impact: "界".repeat(4096),
    suggestion: "界".repeat(4096),
  });
  const blob = blobValue(evidence);
  f.routes.set(`${prefix}/git/blobs/${blob.sha}`, blob);
  const entry = f.headTree.tree.find((item) => item.path === "modified.ts")!;
  entry.sha = blob.sha;
  entry.size = blob.size;
  f.comparison.files.find((item) => item.filename === "modified.ts")!.sha =
    blob.sha;
  const result = await f.run();
  assert.equal(result.draft, null);
  assert.deepEqual(result.preview.reasons, ["PREVIEW_BODY_LIMIT"]);
});

test("deadline and Effect cancellation do not mutate the selected ledger", async () => {
  const f = await setup();
  edit(f.filename, "PRAGMA journal_mode = DELETE");
  const before = readFileSync(f.filename);
  const stalled: GitHubTransport = async () =>
    new Promise<Response>(() => undefined);
  const timed = await Effect.runPromise(f.operation(stalled, 20));
  assert.equal(timed.draft, null);
  assert.deepEqual(timed.preview.reasons, ["CONTEXT_TIMEOUT"]);
  const controller = new AbortController();
  const pending = Effect.runPromiseExit(f.operation(stalled), {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  assert(Exit.hasInterrupts(await pending));
  assert.deepEqual(readFileSync(f.filename), before);
});

test("foreign, empty and unsupported ledgers fail closed without initialization", async () => {
  const f = await setup();
  for (const kind of ["empty", "foreign", "version"] as const) {
    const path = database();
    const db = new Database(path);
    if (kind === "foreign") db.run("CREATE TABLE foreign_data (value TEXT)");
    if (kind === "version")
      db.run("PRAGMA application_id = 1380205139; PRAGMA user_version = 99");
    db.close();
    const before = readFileSync(path);
    const result = await Effect.runPromiseExit(
      previewPublication(f.policy, path, f.input, { transport: f.transport }),
    );
    assert(Exit.isFailure(result));
    assert.deepEqual(readFileSync(path), before);
  }
  assert.equal(f.calls.length, 0);
});

test("closed observations cannot be previewed", async () => {
  const f = await setup();
  edit(
    f.filename,
    "UPDATE outbox SET status = 'acknowledged', external_reference = 'comment:1'",
  );
  edit(f.filename, "UPDATE findings SET status = 'closed'");
  await Effect.runPromise(expectCode(f.operation(), "INTENT_NOT_PENDING"));
  assert.equal(f.calls.length, 0);
});

test("source URL uses full SHA and percent-encoded path segments", async () => {
  const path = "folder/a ](b)界.ts";
  const f = await setup({ path });
  for (const tree of [f.headTree, f.baseTree])
    tree.tree.find((entry) => entry.path === "modified.ts")!.path = path;
  f.comparison.files.find(
    (entry) => entry.filename === "modified.ts",
  )!.filename = path;
  const result = await f.run();
  assert(result.draft);
  assert(
    result.draft.body.includes(
      `/blob/${headSha}/folder/a%20%5D%28b%29%E7%95%8C.ts#L1-L1`,
    ),
  );
  assert(!result.draft.body.includes(`/blob/${headSha}/${path}`));
});

test("caller request and policy mutation during acquisition cannot retarget the preview", async () => {
  const f = await setup();
  let changed = false;
  const result = await f.run(async (req) => {
    if (!changed) {
      changed = true;
      f.input.intentId = "0".repeat(64);
      f.input.pullRequest = 8;
      f.policy.allowedRepositories.splice(0);
    }
    return f.transport(req);
  });
  assert.equal(result.preview.status, "draft-rendered");
  assert.equal(result.selected.intentId, f.intentId);
  assert.equal(result.selected.pullRequest, 7);
});

test("live WAL preview sees committed data and preserves logical records while writer stays open", async () => {
  const f = await setup();
  const writer = new Database(f.filename);
  try {
    writer.run("PRAGMA journal_mode = WAL");
    writer.run("PRAGMA wal_autocheckpoint = 0");
    writer.run("UPDATE outbox SET payload = ? WHERE id = ?", [
      JSON.stringify({ ...f.finding, title: "Committed in live WAL" }),
      f.intentId,
    ]);
    assert(readFileSync(f.filename + "-wal").length > 32);
    const records = () =>
      ["deliveries", "findings", "outbox", "schema_migrations"].map((table) =>
        writer.query(`SELECT * FROM ${table}`).all(),
      );
    const before = records();
    const result = await f.run();
    assert.equal(result.preview.status, "draft-rendered");
    assert(result.draft!.body.includes("Committed in live WAL"));
    assert.deepEqual(records(), before);
    assert.deepEqual(writer.query("PRAGMA journal_mode").get(), {
      journal_mode: "wal",
    });
  } finally {
    writer.close();
  }
});

test("malformed intent ID is rejected before network or database access", async () => {
  const f = await setup();
  for (const intentId of ["", "not-an-intent", "A".repeat(64)]) {
    await Effect.runPromise(
      expectCode(
        previewPublication(
          f.policy,
          "missing.sqlite",
          { ...f.input, intentId },
          { transport: f.transport },
        ),
        "PREVIEW_REQUEST",
      ),
    );
  }
  assert.equal(f.calls.length, 0);
});

test("final source identity recheck rejects a PR head that changes during collection", async () => {
  const f = await setup();
  let prReads = 0;
  const result = await f.run(async (req) => {
    if (new URL(req.url).pathname === `${prefix}/pulls/7` && ++prReads === 6)
      f.pr.head.sha = "f".repeat(40);
    return f.transport(req);
  });
  assert.equal(result.preview.status, "blocked");
  assert.equal(result.draft, null);
  assert.equal(result.acquisition.failedStage, "source");
});
