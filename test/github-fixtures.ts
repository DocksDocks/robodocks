import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { GitHubTransport } from "../src/github-http.ts";
import { fixtures } from "./helpers.ts";

export const repository = "example-owner/example-project";
export const prefix = `/repos/${repository}`;
export const headSha = "a".repeat(40);
export const baseTipSha = "b".repeat(40);
export const mergeBaseSha = "c".repeat(40);
export const headTreeSha = "d".repeat(40);
export const mergeTreeSha = "e".repeat(40);
export const comparePath = `${prefix}/compare/${baseTipSha}...${headSha}?per_page=1`;
export const prPath = `${prefix}/pulls/7`;
export const treePath = `${prefix}/git/trees/${headTreeSha}?recursive=1`;
export const baseTreePath = `${prefix}/git/trees/${mergeTreeSha}?recursive=1`;
export const request = { repository, pullRequest: 7, attemptId: "manual-1" };
export function blobValue(bytes: Uint8Array | string) {
  const buffer =
    typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  const sha = createHash("sha1")
    .update(`blob ${buffer.length}\0`)
    .update(buffer)
    .digest("hex");
  return {
    sha,
    size: buffer.length,
    encoding: "base64",
    content: buffer.toString("base64") + "\n",
  };
}
export function githubFixture() {
  const repo = {
    id: 71,
    full_name: repository,
    private: false,
    visibility: "public",
  };
  const pr = {
    id: 701,
    number: 7,
    changed_files: 4,
    head: { sha: headSha, repo: { ...repo } },
    base: { sha: baseTipSha, repo: { ...repo } },
  };
  const routes = new Map<string, unknown>([
    [prefix, repo],
    [prPath, pr],
  ]);
  const before: {
    path: string;
    mode: string;
    type: string;
    sha: string;
    size: number;
  }[] = [];
  const after: typeof before = [];
  function addBlob(
    path: string,
    content: Uint8Array | string,
    side: "before" | "after",
  ) {
    const blob = blobValue(content);
    routes.set(`${prefix}/git/blobs/${blob.sha}`, blob);
    (side === "before" ? before : after).push({
      path,
      mode: "100644",
      type: "blob",
      sha: blob.sha,
      size: blob.size,
    });
    return blob;
  }
  const added = addBlob(
    "added.ts",
    "\uFEFF// Added\r\n  export const x = 1;\r\n",
    "after",
  );
  addBlob("modified.ts", "old\r\n", "before");
  const modified = addBlob("modified.ts", "new\r\n", "after");
  const removed = addBlob("removed.ts", "removed text\n", "before");
  addBlob("old-name.ts", "old name\n", "before");
  const renamed = addBlob("renamed.ts", "new name\n", "after");
  const files = [
    { filename: "added.ts", status: "added", sha: added.sha },
    {
      filename: "modified.ts",
      status: "modified",
      sha: modified.sha,
      patch: "untrusted/non-authoritative",
      raw_url: "https://evil.example/ignored",
    },
    { filename: "removed.ts", status: "removed", sha: removed.sha },
    {
      filename: "renamed.ts",
      previous_filename: "old-name.ts",
      status: "renamed",
      sha: renamed.sha,
    },
  ];
  const comparison = {
    base_commit: { sha: baseTipSha },
    merge_base_commit: { sha: mergeBaseSha },
    files,
  };
  routes.set(comparePath, comparison);
  routes.set(`${prefix}/git/commits/${headSha}`, {
    sha: headSha,
    tree: { sha: headTreeSha },
  });
  routes.set(`${prefix}/git/commits/${mergeBaseSha}`, {
    sha: mergeBaseSha,
    tree: { sha: mergeTreeSha },
  });
  routes.set(`${prefix}/git/commits/${baseTipSha}`, {
    sha: baseTipSha,
    tree: { sha: "f".repeat(40) },
  });
  const headTree = { sha: headTreeSha, truncated: false, tree: after };
  const baseTree = { sha: mergeTreeSha, truncated: false, tree: before };
  routes.set(treePath, headTree);
  routes.set(baseTreePath, baseTree);
  const calls: string[] = [];
  const transport: GitHubTransport = async (req) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.has("cookie"), false);
    assert.equal(req.redirect, "error");
    assert.equal(req.headers.has("authorization"), false);
    const url = new URL(req.url);
    assert.equal(url.origin, "https://api.github.com");
    const path = url.pathname + url.search;
    calls.push(path);
    return routes.has(path)
      ? Response.json(routes.get(path))
      : Response.json({ message: "PRIVATE SERVER DETAILS" }, { status: 404 });
  };
  return {
    policy: fixtures().policy,
    repo,
    pr,
    routes,
    comparison,
    headTree,
    baseTree,
    calls,
    transport,
    addBlob,
  };
}
