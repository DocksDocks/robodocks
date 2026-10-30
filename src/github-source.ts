import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import {
  FindingSchema,
  HeadSha,
  RelativePath,
  Repository,
} from "./contracts.ts";
import { validatePolicy } from "./validation.ts";
import type { ContractError } from "./validation.ts";
import {
  defaultGitHubTransport,
  HTTP_LIMITS,
  SourceError,
  withGitHubHttp,
} from "./github-http.ts";
import type {
  GitHubHttp,
  GitHubTransport,
  HttpLimits,
  HttpStats,
} from "./github-http.ts";

const Id = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const AttemptId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
);
export const CollectionRequestSchema = Schema.Struct({
  repository: Repository,
  pullRequest: Id,
  attemptId: AttemptId,
});
export type CollectionRequest = typeof CollectionRequestSchema.Type;
const ProvenanceSchema = Schema.Struct({
  provider: Schema.Literal("github.com"),
  repository: Repository,
  repositoryId: Id,
  pullRequest: Id,
  pullRequestId: Id,
  headSha: HeadSha,
  baseTipSha: HeadSha,
  mergeBaseSha: HeadSha,
});
const BlobSchema = Schema.Struct({
  sha: HeadSha,
  mode: Schema.Literals(["100644", "100755"]),
  content: Schema.String.check(Schema.isMaxLength(128 * 1024)),
});
const FileSchema = Schema.Struct({
  path: RelativePath,
  previousPath: Schema.NullOr(RelativePath),
  status: Schema.Literals(["added", "modified", "removed", "renamed"]),
  before: Schema.NullOr(BlobSchema),
  after: Schema.NullOr(BlobSchema),
});
export const SourceSnapshotSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  provenance: ProvenanceSchema,
  files: Schema.Array(FileSchema).check(Schema.isMaxLength(299)),
});
export type SourceSnapshot = typeof SourceSnapshotSchema.Type;
export const CollectionResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  operation: Schema.Literal("collect"),
  attempt: Schema.Struct({ id: AttemptId, eventId: Schema.Null }),
  acquisition: Schema.Struct({
    status: Schema.Literals(["complete", "incomplete", "unsupported"]),
    omissions: Schema.Array(
      Schema.Struct({
        code: Schema.String,
        path: Schema.NullOr(RelativePath),
        side: Schema.NullOr(Schema.Literals(["before", "after"])),
      }),
    ),
    requests: Schema.Int,
    responseBytes: Schema.Int,
    decodedBytes: Schema.Int,
  }),
  snapshotId: Schema.NullOr(
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  ),
  snapshot: Schema.NullOr(SourceSnapshotSchema),
  review: Schema.Struct({ status: Schema.Literal("not-run") }),
});
export type CollectionResult = typeof CollectionResultSchema.Type;

// Future provider implementations receive source only and return findings only.
// No implementation or provider call is supplied by this slice.
export const ModelFindingsSchema = Schema.Struct({
  findings: Schema.Array(FindingSchema).check(Schema.isMaxLength(100)),
});
export type ModelFindings = typeof ModelFindingsSchema.Type;
export function validateModelFindings(
  input: unknown,
): Effect.Effect<ModelFindings, SourceError> {
  return Schema.decodeUnknownEffect(ModelFindingsSchema, {
    onExcessProperty: "error",
  })(input).pipe(
    Effect.mapError(
      () =>
        new SourceError(
          "MODEL_FINDINGS",
          "Model output must contain findings only",
        ),
    ),
  );
}
export interface ReviewModel {
  readonly review: (
    snapshot: SourceSnapshot,
  ) => Effect.Effect<ModelFindings, SourceError>;
}

function fail(code: string): never {
  throw new SourceError(code, "Source acquisition could not be completed");
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return fail("SOURCE_SHAPE");
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return fail("SOURCE_SHAPE");
  return value;
}
function positive(value: unknown): number {
  const n = integer(value);
  return n > 0 ? n : fail("SOURCE_SHAPE");
}
function sha(value: unknown): string {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value)
    ? value
    : fail("SOURCE_IDENTITY");
}
function path(value: unknown): string {
  if (!Schema.is(RelativePath)(value)) return fail("SOURCE_PATH");
  return value;
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : fail("SOURCE_SHAPE");
}
function same(actual: unknown, expected: unknown): void {
  if (actual !== expected) fail("SOURCE_IDENTITY");
}
function publicRepository(
  value: unknown,
  repository: string,
  repositoryId?: number,
): number {
  const repo = object(value);
  if (
    repo.private !== false ||
    (repo.visibility !== undefined && repo.visibility !== "public")
  )
    fail("UNSUPPORTED_PRIVATE");
  same(repo.full_name, repository);
  const id = positive(repo.id);
  if (repositoryId !== undefined) same(id, repositoryId);
  return id;
}
function pullIdentity(
  value: unknown,
  request: CollectionRequest,
  repositoryId: number,
) {
  const pr = object(value);
  same(pr.number, request.pullRequest);
  const head = object(pr.head);
  const base = object(pr.base);
  const headRepo = object(head.repo);
  const baseRepo = object(base.repo);
  if (headRepo.id !== repositoryId || baseRepo.id !== repositoryId)
    fail("UNSUPPORTED_FORK");
  publicRepository(head.repo, request.repository, repositoryId);
  publicRepository(base.repo, request.repository, repositoryId);
  return {
    pullRequestId: positive(pr.id),
    headSha: sha(head.sha),
    baseTipSha: sha(base.sha),
    changedFiles: integer(pr.changed_files),
  };
}
type TreeEntry = {
  sha: string;
  mode: string;
  type: string;
  size: number | null;
};
async function commitTree(
  http: GitHubHttp,
  prefix: string,
  commitSha: string,
): Promise<string> {
  const commit = object(await http.get(`${prefix}/git/commits/${commitSha}`));
  same(sha(commit.sha), commitSha);
  return sha(object(commit.tree).sha);
}
async function tree(
  http: GitHubHttp,
  prefix: string,
  treeSha: string,
): Promise<Map<string, TreeEntry>> {
  const result = object(
    await http.get(`${prefix}/git/trees/${treeSha}?recursive=1`),
  );
  same(sha(result.sha), treeSha);
  if (result.truncated !== false) fail("TRUNCATED_TREE");
  const entries = new Map<string, TreeEntry>();
  for (const item of array(result.tree)) {
    const entry = object(item);
    const name = path(entry.path);
    if (entries.has(name)) fail("DUPLICATE_PATH");
    if (typeof entry.mode !== "string" || typeof entry.type !== "string")
      fail("SOURCE_SHAPE");
    entries.set(name, {
      sha: sha(entry.sha),
      mode: entry.mode,
      type: entry.type,
      size: entry.size === undefined ? null : integer(entry.size),
    });
  }
  return entries;
}
function binaryText(content: string): boolean {
  return Array.from(content).some((character) => {
    const code = character.charCodeAt(0);
    return (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
    );
  });
}
function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}
function validateSnapshot(snapshot: SourceSnapshot): number {
  const paths = new Set<string>();
  const beforePaths = new Set<string>();
  const afterPaths = new Set<string>();
  let previous = "";
  let characters = 0;
  let decodedBytes = 0;
  for (const file of snapshot.files) {
    if (paths.has(file.path) || file.path <= previous) fail("SOURCE_RELATION");
    paths.add(file.path);
    previous = file.path;
    if (
      (file.status === "added") !== (file.before === null) ||
      (file.status === "removed") !== (file.after === null) ||
      (file.status === "renamed") !== (file.previousPath !== null) ||
      file.previousPath === file.path
    )
      fail("SOURCE_RELATION");
    if (
      file.status === "modified" &&
      file.before?.sha === file.after?.sha &&
      file.before?.mode === file.after?.mode
    )
      fail("SOURCE_RELATION");
    if (file.before !== null) {
      const name = file.previousPath ?? file.path;
      if (beforePaths.has(name)) fail("SOURCE_RELATION");
      beforePaths.add(name);
    }
    if (file.after !== null) {
      if (afterPaths.has(file.path)) fail("SOURCE_RELATION");
      afterPaths.add(file.path);
    }
    for (const blob of [file.before, file.after]) {
      if (blob === null) continue;
      const bytes = Buffer.from(blob.content, "utf8");
      if (
        bytes.toString("utf8") !== blob.content ||
        binaryText(blob.content) ||
        gitBlobSha(bytes) !== blob.sha
      )
        fail("SOURCE_RELATION");
      characters += blob.content.length;
      decodedBytes += bytes.length;
      if (
        blob.content.length > 128 * 1024 ||
        characters > 1024 * 1024 ||
        bytes.length > 512 * 1024 ||
        decodedBytes > 2 * 1024 * 1024
      )
        fail("SOURCE_RELATION");
    }
  }
  return decodedBytes;
}
function reconcileInventory(
  before: Map<string, TreeEntry>,
  after: Map<string, TreeEntry>,
  beforePaths: Set<string>,
  afterPaths: Set<string>,
): void {
  function leaf(entry: TreeEntry): boolean {
    return entry.type !== "tree" || entry.mode !== "040000";
  }
  function covered(
    entries: Map<string, TreeEntry>,
    other: Map<string, TreeEntry>,
    expected: Set<string>,
  ): boolean {
    const changed = new Set<string>();
    for (const [name, entry] of entries) {
      if (!leaf(entry)) continue;
      const counterpart = other.get(name);
      if (
        !counterpart ||
        counterpart.type !== entry.type ||
        counterpart.mode !== entry.mode ||
        counterpart.sha !== entry.sha
      )
        changed.add(name);
    }
    return (
      changed.size === expected.size &&
      [...changed].every((name) => expected.has(name))
    );
  }
  if (
    !covered(before, after, beforePaths) ||
    !covered(after, before, afterPaths)
  )
    fail("INCOMPLETE_INVENTORY");
}
function snapshotId(snapshot: SourceSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

// This boundary does not run a model. It refuses partial results and returns an
// owned input copy; callers cannot substitute context inside model output.
export function sourceForModel(
  input: unknown,
): Effect.Effect<SourceSnapshot, SourceError> {
  return Schema.decodeUnknownEffect(CollectionResultSchema, {
    onExcessProperty: "error",
  })(input).pipe(
    Effect.mapError(
      () => new SourceError("SOURCE_SHAPE", "Invalid source envelope"),
    ),
    Effect.flatMap((result) =>
      Effect.try({
        try: () => {
          if (
            result.acquisition.status !== "complete" ||
            result.acquisition.omissions.length !== 0 ||
            result.snapshot === null ||
            result.snapshotId !== snapshotId(result.snapshot)
          )
            fail("INCOMPLETE_SOURCE");
          if (
            validateSnapshot(result.snapshot) !==
              result.acquisition.decodedBytes ||
            result.acquisition.requests < 1 ||
            result.acquisition.responseBytes < 1 ||
            result.acquisition.requests > HTTP_LIMITS.maxRequests ||
            result.acquisition.responseBytes > HTTP_LIMITS.maxTotalResponseBytes
          )
            fail("SOURCE_RELATION");
          return structuredClone(result.snapshot);
        },
        catch: (error) =>
          error instanceof SourceError
            ? error
            : new SourceError("SOURCE_SHAPE", "Invalid source envelope"),
      }),
    ),
  );
}

export function collectGitHubSource(
  policyInput: unknown,
  requestInput: unknown,
  options: {
    readonly transport?: GitHubTransport;
    readonly httpLimits?: Partial<HttpLimits>;
    /** @internal Diagnostics for trusted sequential orchestration. */
    readonly onStats?: (stats: HttpStats) => void;
  } = {},
): Effect.Effect<CollectionResult, ContractError | SourceError> {
  return Effect.gen(function* () {
    const policy = yield* validatePolicy(policyInput);
    const request = yield* Schema.decodeUnknownEffect(CollectionRequestSchema, {
      onExcessProperty: "error",
    })(requestInput).pipe(
      Effect.mapError(
        () => new SourceError("SOURCE_REQUEST", "Invalid collection request"),
      ),
    );
    if (!policy.allowedRepositories.includes(request.repository))
      return yield* Effect.fail(
        new SourceError(
          "NOT_ALLOWED",
          "Repository is not explicitly allowed by the operator policy",
        ),
      );
    return yield* Effect.tryPromise({
      try: (signal) =>
        collect(
          request,
          options.transport ?? defaultGitHubTransport,
          signal,
          options.httpLimits,
          options.onStats,
        ),
      catch: (error) =>
        error instanceof SourceError
          ? error
          : new SourceError("SOURCE_FAILURE", "Source acquisition failed"),
    });
  });
}

async function collect(
  request: CollectionRequest,
  transport: GitHubTransport,
  signal: AbortSignal,
  limits?: Partial<HttpLimits>,
  onStats?: (stats: HttpStats) => void,
): Promise<CollectionResult> {
  let snapshot: SourceSnapshot | null = null;
  const files: Array<typeof FileSchema.Type> = [];
  let decodedBytes = 0;
  let totalCharacters = 0;
  let currentPath: string | null = null;
  let currentSide: "before" | "after" | null = null;
  return withGitHubHttp(
    transport,
    signal,
    async (http) => {
      let failure: SourceError | undefined;
      try {
        const prefix = `/repos/${request.repository}`;
        const repositoryId = publicRepository(
          await http.get(prefix),
          request.repository,
        );
        const initial = pullIdentity(
          await http.get(`${prefix}/pulls/${request.pullRequest}`),
          request,
          repositoryId,
        );
        const comparison = object(
          await http.get(
            `${prefix}/compare/${initial.baseTipSha}...${initial.headSha}?per_page=1`,
          ),
        );
        same(sha(object(comparison.base_commit).sha), initial.baseTipSha);
        const mergeBaseSha = sha(object(comparison.merge_base_commit).sha);
        const inventory = array(comparison.files);
        if (inventory.length >= 300 || initial.changedFiles >= 300)
          fail("COMPARE_FILE_CAP");
        same(inventory.length, initial.changedFiles);
        snapshot = {
          schemaVersion: 1,
          provenance: {
            provider: "github.com",
            repository: request.repository,
            repositoryId,
            pullRequest: request.pullRequest,
            pullRequestId: initial.pullRequestId,
            headSha: initial.headSha,
            baseTipSha: initial.baseTipSha,
            mergeBaseSha,
          },
          files,
        };
        // Independently bind all three commit identities; source before is never base-tip.
        const headTree = await commitTree(http, prefix, initial.headSha);
        const mergeTree = await commitTree(http, prefix, mergeBaseSha);
        await commitTree(http, prefix, initial.baseTipSha);
        const afterTree = await tree(http, prefix, headTree);
        const beforeTree = await tree(http, prefix, mergeTree);
        const headPaths = new Set<string>();
        const basePaths = new Set<string>();
        const allPaths = new Set<string>();
        const changed = inventory
          .map((item) => {
            const file = object(item);
            const name = path(file.filename);
            if (allPaths.has(name)) fail("DUPLICATE_PATH");
            allPaths.add(name);
            const status = file.status;
            if (
              status !== "added" &&
              status !== "modified" &&
              status !== "removed" &&
              status !== "renamed"
            )
              fail("UNSUPPORTED_CHANGE");
            const previousPath =
              status === "renamed" ? path(file.previous_filename) : null;
            if (status === "renamed" && previousPath === name)
              fail("SOURCE_PATH");
            if (status !== "removed") {
              if (headPaths.has(name)) fail("DUPLICATE_PATH");
              headPaths.add(name);
            }
            if (status !== "added") {
              const beforePath = previousPath ?? name;
              if (basePaths.has(beforePath)) fail("DUPLICATE_PATH");
              basePaths.add(beforePath);
            }
            return {
              path: name,
              previousPath,
              status,
              comparisonSha: sha(file.sha),
            } as const;
          })
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        async function blob(
          entries: Map<string, TreeEntry>,
          name: string,
          side: "before" | "after",
        ): Promise<typeof BlobSchema.Type> {
          currentPath = name;
          currentSide = side;
          const entry = entries.get(name);
          if (!entry) return fail("MISSING_BLOB");
          if (
            entry.type !== "blob" ||
            (entry.mode !== "100644" && entry.mode !== "100755")
          )
            return fail("UNSUPPORTED_MODE");
          if (entry.size === null) return fail("SOURCE_SHAPE");
          if (
            entry.size > 512 * 1024 ||
            decodedBytes + entry.size > 2 * 1024 * 1024
          )
            return fail("DECODED_BYTE_LIMIT");
          const result = object(
            await http.get(`${prefix}/git/blobs/${entry.sha}`),
          );
          same(sha(result.sha), entry.sha);
          same(integer(result.size), entry.size);
          if (
            result.encoding !== "base64" ||
            typeof result.content !== "string"
          )
            return fail("BLOB_ENCODING");
          // GitHub wraps Base64 with LF. No other whitespace or permissive decoding.
          const encoded = result.content.replaceAll("\n", "");
          if (
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
              encoded,
            )
          )
            return fail("BLOB_BASE64");
          if (encoded.length > Math.ceil(entry.size / 3) * 4)
            return fail("BLOB_SIZE");
          const bytes = Buffer.from(encoded, "base64");
          if (bytes.toString("base64") !== encoded) return fail("BLOB_BASE64");
          same(bytes.length, entry.size);
          decodedBytes += bytes.length;
          const actualSha = gitBlobSha(bytes);
          same(actualSha, entry.sha);
          let content: string;
          try {
            content = new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(bytes);
          } catch {
            return fail("BLOB_UTF8");
          }
          if (binaryText(content)) return fail("BINARY_BLOB");
          totalCharacters += content.length;
          if (content.length > 128 * 1024 || totalCharacters > 1024 * 1024)
            return fail("CHARACTER_LIMIT");
          return { sha: entry.sha, mode: entry.mode, content };
        }
        for (const file of changed) {
          currentPath = file.path;
          currentSide = null;
          if (file.status === "added" && beforeTree.has(file.path))
            fail("SOURCE_IDENTITY");
          if (file.status === "removed" && afterTree.has(file.path))
            fail("SOURCE_IDENTITY");
          const before =
            file.status === "added"
              ? null
              : await blob(
                  beforeTree,
                  file.previousPath ?? file.path,
                  "before",
                );
          const after =
            file.status === "removed"
              ? null
              : await blob(afterTree, file.path, "after");
          same((after ?? before)?.sha, file.comparisonSha);
          files.push({
            path: file.path,
            previousPath: file.previousPath,
            status: file.status,
            before,
            after,
          });
        }
        currentPath = null;
        currentSide = null;
        reconcileInventory(beforeTree, afterTree, basePaths, headPaths);
        validateSnapshot(snapshot);
        const final = pullIdentity(
          await http.get(`${prefix}/pulls/${request.pullRequest}`),
          request,
          repositoryId,
        );
        if (JSON.stringify(final) !== JSON.stringify(initial))
          fail("STALE_PULL_REQUEST");
        publicRepository(
          await http.get(prefix),
          request.repository,
          repositoryId,
        );
      } catch (error) {
        failure =
          error instanceof SourceError
            ? error
            : new SourceError("SOURCE_FAILURE", "Source acquisition failed");
      }
      return {
        schemaVersion: 1,
        operation: "collect",
        attempt: { id: request.attemptId, eventId: null },
        acquisition: {
          status: failure
            ? failure.code.startsWith("UNSUPPORTED_") && snapshot === null
              ? "unsupported"
              : "incomplete"
            : "complete",
          omissions: failure
            ? [{ code: failure.code, path: currentPath, side: currentSide }]
            : [],
          requests: http.stats.requests,
          responseBytes: http.stats.responseBytes,
          decodedBytes,
        },
        snapshotId: failure || snapshot === null ? null : snapshotId(snapshot),
        snapshot,
        review: { status: "not-run" },
      };
    },
    limits,
    onStats,
  );
}
