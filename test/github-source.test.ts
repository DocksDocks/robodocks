import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { test } from "@effect/vitest";
import {
  collectGitHubSource,
  CollectionResultSchema,
  ModelFindingsSchema,
  sourceForModel,
  validateModelFindings,
} from "../src/github-source.ts";
import { expectCode } from "./helpers.ts";
import type { Mutable } from "./helpers.ts";
import {
  baseTipSha,
  blobValue,
  comparePath,
  githubFixture,
  headSha,
  mergeBaseSha,
  prPath,
  prefix,
  request,
} from "./github-fixtures.ts";

async function collect(
  fixture = githubFixture(),
  attemptId = request.attemptId,
) {
  return Effect.runPromise(
    collectGitHubSource(
      fixture.policy,
      { ...request, attemptId },
      { transport: fixture.transport },
    ),
  );
}
async function incomplete(
  fixture: ReturnType<typeof githubFixture>,
  code: string,
) {
  const result = await collect(fixture);
  assert.notEqual(result.acquisition.status, "complete");
  assert.equal(result.snapshotId, null);
  assert.equal(result.review.status, "not-run");
  assert.equal(result.acquisition.omissions[0]?.code, code);
  assert.equal(Schema.is(CollectionResultSchema)(result), true);
  await Effect.runPromise(
    expectCode(sourceForModel(result), "INCOMPLETE_SOURCE"),
  );
  return result;
}

test("acquires exact immutable added/modified/removed/renamed text using merge-base, not base tip", async () => {
  const f = githubFixture();
  const result = await collect(f);
  assert.equal(result.acquisition.status, "complete");
  assert.deepEqual(result.acquisition.omissions, []);
  assert.equal(Schema.is(CollectionResultSchema)(result), true);
  assert.equal(result.review.status, "not-run");
  assert.equal(result.attempt.eventId, null);
  assert.deepEqual(result.snapshot?.provenance, {
    provider: "github.com",
    repository: request.repository,
    repositoryId: 71,
    pullRequest: 7,
    pullRequestId: 701,
    headSha,
    baseTipSha,
    mergeBaseSha,
  });
  const files = result.snapshot!.files;
  assert.deepEqual(
    files.map((f) => [f.path, f.previousPath, f.status]),
    [
      ["added.ts", null, "added"],
      ["modified.ts", null, "modified"],
      ["removed.ts", null, "removed"],
      ["renamed.ts", "old-name.ts", "renamed"],
    ],
  );
  assert.equal(files[0]?.before, null);
  assert.equal(
    files[0]?.after?.content,
    "\uFEFF// Added\r\n  export const x = 1;\r\n",
  );
  assert.equal(files[1]?.before?.content, "old\r\n");
  assert.equal(files[2]?.after, null);
  assert.equal(files[3]?.before?.content, "old name\n");
  assert.equal(files[3]?.after?.content, "new name\n");
  assert.equal(
    JSON.stringify(result).includes("untrusted/non-authoritative"),
    false,
  );
  assert.equal(f.calls.filter((p) => p === prPath).length, 2);
  assert.equal(f.calls.filter((p) => p === prefix).length, 2);
  assert.ok(
    !f.calls.some(
      (p) => p.includes("contents") || p.includes("raw") || p.includes("main"),
    ),
  );
});

test("snapshot identity excludes manual attempts, HTTP metadata and comparison order", async () => {
  const f = githubFixture();
  const first = await collect(f, "first");
  f.comparison.files.reverse();
  const second = await collect(f, "second");
  assert.equal(first.snapshotId, second.snapshotId);
  assert.notEqual(first.attempt.id, second.attempt.id);
  assert.equal(first.snapshotId?.length, 64);
  assert.deepEqual(first.snapshot, second.snapshot);
  const owned = await Effect.runPromise(sourceForModel(first));
  assert.notEqual(owned, first.snapshot);
  const altered = structuredClone(first) as Mutable<typeof first>;
  altered.snapshot!.files[0]!.after!.content += "tamper";
  await Effect.runPromise(
    expectCode(sourceForModel(altered), "INCOMPLETE_SOURCE"),
  );
});

test("future model output is findings only; trusted context cannot be replaced", async () => {
  const decode = Schema.decodeUnknownEffect(ModelFindingsSchema, {
    onExcessProperty: "error",
  });
  assert.deepEqual(await Effect.runPromise(decode({ findings: [] })), {
    findings: [],
  });
  assert.equal(
    (
      await Effect.runPromise(
        Effect.result(
          decode({ findings: [], context: { headSha: "replacement" } }),
        ),
      )
    )._tag,
    "Failure",
  );
});

test("model decoder recursively refuses output that replaces trusted source", async () => {
  await Effect.runPromise(
    expectCode(
      validateModelFindings({ findings: [], snapshot: {} }),
      "MODEL_FINDINGS",
    ),
  );
});

test("allowlist and request contract reject before network access", async () => {
  const f = githubFixture();
  await Effect.runPromise(
    expectCode(
      collectGitHubSource(
        f.policy,
        { ...request, repository: "another/repo" },
        { transport: f.transport },
      ),
      "NOT_ALLOWED",
    ),
  );
  await Effect.runPromise(
    expectCode(
      collectGitHubSource(
        f.policy,
        { ...request, eventId: "event" },
        { transport: f.transport },
      ),
      "SOURCE_REQUEST",
    ),
  );
  assert.equal(f.calls.length, 0);
});

test("private and fork targets return explicit unsupported results", async () => {
  const privateRepo = githubFixture();
  privateRepo.repo.private = true;
  assert.equal(
    (await incomplete(privateRepo, "UNSUPPORTED_PRIVATE")).acquisition.status,
    "unsupported",
  );
  const fork = githubFixture();
  fork.pr.head.repo.id = 72;
  assert.equal(
    (await incomplete(fork, "UNSUPPORTED_FORK")).acquisition.status,
    "unsupported",
  );
});

for (const change of [
  {
    name: "canonical repository",
    edit: (f: ReturnType<typeof githubFixture>) => {
      f.repo.full_name = "other/repo";
    },
    code: "SOURCE_IDENTITY",
  },
  {
    name: "PR number",
    edit: (f: ReturnType<typeof githubFixture>) => {
      f.pr.number = 8;
    },
    code: "SOURCE_IDENTITY",
  },
  {
    name: "head SHA",
    edit: (f: ReturnType<typeof githubFixture>) => {
      f.pr.head.sha = "BAD";
    },
    code: "SOURCE_IDENTITY",
  },
  {
    name: "comparison base",
    edit: (f: ReturnType<typeof githubFixture>) => {
      f.comparison.base_commit.sha = headSha;
    },
    code: "SOURCE_IDENTITY",
  },
  {
    name: "commit identity",
    edit: (f: ReturnType<typeof githubFixture>) => {
      f.routes.set(`${prefix}/git/commits/${headSha}`, {
        sha: baseTipSha,
        tree: { sha: headSha },
      });
    },
    code: "SOURCE_IDENTITY",
  },
  {
    name: "truncated tree",
    edit: (f: ReturnType<typeof githubFixture>) => {
      f.headTree.truncated = true;
    },
    code: "TRUNCATED_TREE",
  },
  {
    name: "tree identity",
    edit: (f: ReturnType<typeof githubFixture>) => {
      f.headTree.sha = headSha;
    },
    code: "SOURCE_IDENTITY",
  },
  {
    name: "duplicate tree path",
    edit: (f: ReturnType<typeof githubFixture>) => {
      f.headTree.tree.push({ ...f.headTree.tree[0]! });
    },
    code: "DUPLICATE_PATH",
  },
  {
    name: "duplicate comparison path",
    edit: (f: ReturnType<typeof githubFixture>) => {
      f.comparison.files[1]!.filename = "added.ts";
    },
    code: "DUPLICATE_PATH",
  },
  {
    name: "duplicate previous path",
    edit: (f: ReturnType<typeof githubFixture>) => {
      f.comparison.files[3]!.previous_filename = "modified.ts";
    },
    code: "DUPLICATE_PATH",
  },
  {
    name: "unsafe path",
    edit: (f: ReturnType<typeof githubFixture>) => {
      f.comparison.files[0]!.filename = "../secret";
    },
    code: "SOURCE_PATH",
  },
  {
    name: "symlink",
    edit: (f: ReturnType<typeof githubFixture>) => {
      f.headTree.tree[0]!.mode = "120000";
    },
    code: "UNSUPPORTED_MODE",
  },
  {
    name: "submodule",
    edit: (f: ReturnType<typeof githubFixture>) => {
      f.headTree.tree[0]!.mode = "160000";
      f.headTree.tree[0]!.type = "commit";
    },
    code: "UNSUPPORTED_MODE",
  },
  {
    name: "missing tree blob",
    edit: (f: ReturnType<typeof githubFixture>) => {
      f.headTree.tree.shift();
    },
    code: "MISSING_BLOB",
  },
  {
    name: "missing fetched blob",
    edit: (f: ReturnType<typeof githubFixture>) => {
      f.routes.delete(`${prefix}/git/blobs/${f.headTree.tree[0]!.sha}`);
    },
    code: "HTTP_NOT_FOUND",
  },
  {
    name: "decoded bytes",
    edit: (f: ReturnType<typeof githubFixture>) => {
      f.headTree.tree[0]!.size = 512 * 1024 + 1;
    },
    code: "DECODED_BYTE_LIMIT",
  },
  {
    name: "compare cap",
    edit: (f: ReturnType<typeof githubFixture>) => {
      f.comparison.files.push(
        ...Array.from({ length: 296 }, () => ({ ...f.comparison.files[0]! })),
      );
      f.pr.changed_files = 300;
    },
    code: "COMPARE_FILE_CAP",
  },
  {
    name: "inventory count",
    edit: (f: ReturnType<typeof githubFixture>) => {
      f.pr.changed_files = 5;
    },
    code: "SOURCE_IDENTITY",
  },
  {
    name: "unsupported change",
    edit: (f: ReturnType<typeof githubFixture>) => {
      f.comparison.files[0]!.status = "copied";
    },
    code: "UNSUPPORTED_CHANGE",
  },
])
  test(`never reports complete for ${change.name}`, async () => {
    const f = githubFixture();
    change.edit(f);
    await incomplete(f, change.code);
  });

for (const field of ["head", "base", "id", "repo"])
  test(`rechecks PR ${field} before completing`, async () => {
    const f = githubFixture();
    const original = f.transport;
    let reads = 0;
    f.transport = (req) => {
      if (new URL(req.url).pathname === prPath && ++reads === 2) {
        if (field === "head") f.pr.head.sha = "f".repeat(40);
        if (field === "base") f.pr.base.sha = "f".repeat(40);
        if (field === "id") f.pr.id++;
        if (field === "repo") f.pr.head.repo.id++;
      }
      return original(req);
    };
    await incomplete(
      f,
      field === "repo" ? "UNSUPPORTED_FORK" : "STALE_PULL_REQUEST",
    );
  });

for (const [name, bytes, code] of [
  ["binary", new Uint8Array([65, 0, 66]), "BINARY_BLOB"],
  ["invalid UTF8", new Uint8Array([0xff]), "BLOB_UTF8"],
  ["oversized characters", "x".repeat(128 * 1024 + 1), "CHARACTER_LIMIT"],
] as const)
  test(`rejects ${name} source`, async () => {
    const f = githubFixture();
    const blob = blobValue(bytes);
    Object.assign(f.headTree.tree[0]!, { sha: blob.sha, size: blob.size });
    f.comparison.files[0]!.sha = blob.sha;
    f.routes.set(`${prefix}/git/blobs/${blob.sha}`, blob);
    await incomplete(f, code);
  });

for (const content of ["!!==", "YQ=", "YR==", "YQ== ", "YQ==\r\n"])
  test(`strict base64 rejects ${JSON.stringify(content)}`, async () => {
    const f = githubFixture();
    const entry = f.headTree.tree[0]!;
    f.routes.set(`${prefix}/git/blobs/${entry.sha}`, {
      sha: entry.sha,
      size: entry.size,
      encoding: "base64",
      content,
    });
    await incomplete(f, "BLOB_BASE64");
  });

test("blob payload must match its Git SHA, size and compare identity", async () => {
  for (const what of ["hash", "size", "compare"] as const) {
    const f = githubFixture();
    const entry = f.headTree.tree[0]!;
    if (what === "compare") f.comparison.files[0]!.sha = headSha;
    else {
      const wrong = blobValue("x".repeat(entry.size));
      f.routes.set(`${prefix}/git/blobs/${entry.sha}`, {
        ...wrong,
        sha: entry.sha,
        size: what === "size" ? entry.size + 1 : entry.size,
      });
    }
    await incomplete(f, "SOURCE_IDENTITY");
  }
});

test("bounded request budget cannot produce a complete snapshot", async () => {
  const f = githubFixture();
  const result = await Effect.runPromise(
    collectGitHubSource(f.policy, request, {
      transport: f.transport,
      httpLimits: { maxRequests: 3 },
    }),
  );
  assert.equal(result.acquisition.status, "incomplete");
  assert.equal(result.acquisition.omissions[0]?.code, "HTTP_REQUESTS");
  assert.equal(f.calls.length, 3);
});

test("empty comparison is complete acquisition, never a clean review", async () => {
  const f = githubFixture();
  f.pr.changed_files = 0;
  f.headTree.tree.length = 0;
  f.baseTree.tree.length = 0;
  f.routes.set(comparePath, { ...f.comparison, files: [] });
  const result = await collect(f);
  assert.equal(result.acquisition.status, "complete");
  assert.deepEqual(result.snapshot?.files, []);
  assert.deepEqual(result.review, { status: "not-run" });
});

for (const kind of ["characters", "decoded bytes"] as const)
  test(`enforces aggregate ${kind} across all snapshot sides`, async () => {
    const f = githubFixture();
    f.comparison.files.length = 0;
    f.headTree.tree.length = 0;
    f.baseTree.tree.length = 0;
    const count = kind === "characters" ? 9 : 6;
    for (let i = 0; i < count; i++) {
      const filename = `file-${i}.ts`;
      const blob = f.addBlob(
        filename,
        (kind === "characters" ? "x" : "\u0800").repeat(128 * 1024),
        "after",
      );
      f.comparison.files.push({ filename, status: "added", sha: blob.sha });
    }
    f.pr.changed_files = count;
    await incomplete(
      f,
      kind === "characters" ? "CHARACTER_LIMIT" : "DECODED_BYTE_LIMIT",
    );
  });

test("tree deltas must independently confirm the entire comparison inventory", async () => {
  const omitted = githubFixture();
  omitted.comparison.files.pop();
  omitted.pr.changed_files = 3;
  await incomplete(omitted, "INCOMPLETE_INVENTORY");
  const empty = githubFixture();
  empty.comparison.files.length = 0;
  empty.pr.changed_files = 0;
  await incomplete(empty, "INCOMPLETE_INVENTORY");
});

for (const mutation of [
  "missing after",
  "previous path",
  "duplicate path",
  "blob hash",
  "binary text",
  "decoded bytes",
  "aggregate characters",
] as const)
  test(`model consumer rejects self-rehashed ${mutation}`, async () => {
    const result = await collect();
    const altered = structuredClone(result) as Mutable<typeof result>;
    const snapshot = altered.snapshot!;
    if (mutation === "missing after") snapshot.files[0]!.after = null;
    if (mutation === "previous path")
      snapshot.files[1]!.previousPath = "another.ts";
    if (mutation === "duplicate path")
      snapshot.files[1]!.path = snapshot.files[0]!.path;
    if (mutation === "blob hash") snapshot.files[0]!.after!.sha = headSha;
    if (mutation === "binary text") {
      const blob = blobValue("binary\0");
      Object.assign(snapshot.files[0]!.after!, {
        content: "binary\0",
        sha: blob.sha,
      });
    }
    if (mutation === "decoded bytes") altered.acquisition.decodedBytes++;
    if (mutation === "aggregate characters") {
      const text = "x".repeat(128 * 1024);
      const blob = blobValue(text);
      snapshot.files = Array.from({ length: 9 }, (_, i) => ({
        path: `file-${i}.ts`,
        previousPath: null,
        status: "added",
        before: null,
        after: { sha: blob.sha, mode: "100644", content: text },
      }));
    }
    altered.snapshotId = createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex");
    await Effect.runPromise(
      expectCode(sourceForModel(altered), "SOURCE_RELATION"),
    );
  });

test("directory hashes and unchanged files are not changes, while executable mode changes are", async () => {
  const f = githubFixture();
  const unchanged = blobValue("same");
  for (const tree of [f.baseTree, f.headTree])
    tree.tree.push({
      path: "unchanged.ts",
      mode: "100644",
      type: "blob",
      sha: unchanged.sha,
      size: unchanged.size,
    });
  f.baseTree.tree.push({
    path: "directory",
    mode: "040000",
    type: "tree",
    sha: "1".repeat(40),
    size: 0,
  });
  f.headTree.tree.push({
    path: "directory",
    mode: "040000",
    type: "tree",
    sha: "2".repeat(40),
    size: 0,
  });
  const before = f.baseTree.tree.find((entry) => entry.path === "modified.ts")!;
  const after = f.headTree.tree.find((entry) => entry.path === "modified.ts")!;
  Object.assign(after, { sha: before.sha, size: before.size, mode: "100755" });
  f.comparison.files.find((entry) => entry.filename === "modified.ts")!.sha =
    before.sha;
  const result = await collect(f);
  assert.equal(result.acquisition.status, "complete");
  const model = await Effect.runPromise(sourceForModel(result));
  assert.equal(
    model.files.find((file) => file.path === "modified.ts")?.after?.mode,
    "100755",
  );
});

test("rename chains preserve separate before/after identities without false duplicates", async () => {
  const f = githubFixture();
  f.baseTree.tree.length = 0;
  f.headTree.tree.length = 0;
  f.comparison.files.length = 0;
  f.addBlob("a.ts", "A", "before");
  f.addBlob("b.ts", "B", "before");
  const a = f.addBlob("b.ts", "A", "after");
  const b = f.addBlob("c.ts", "B", "after");
  f.comparison.files.push(
    {
      filename: "b.ts",
      previous_filename: "a.ts",
      status: "renamed",
      sha: a.sha,
    },
    {
      filename: "c.ts",
      previous_filename: "b.ts",
      status: "renamed",
      sha: b.sha,
    },
  );
  f.pr.changed_files = 2;
  const result = await collect(f);
  assert.equal(result.acquisition.status, "complete");
  assert.equal(
    (await Effect.runPromise(sourceForModel(result))).files.length,
    2,
  );
});
