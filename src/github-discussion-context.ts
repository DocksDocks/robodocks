import { Effect, Schema } from "effect";
import { CollectionRequestSchema } from "./github-source.ts";
import type { CollectionRequest } from "./github-source.ts";
import { HeadSha, Repository } from "./contracts.ts";
import { validatePolicy } from "./validation.ts";
import {
  defaultGitHubTransport,
  SourceError,
  withGitHubHttp,
} from "./github-http.ts";
import type { GitHubHttp, GitHubTransport, HttpLimits } from "./github-http.ts";

const Id = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Text = Schema.String.check(Schema.isMaxLength(65536));
const Timestamp = Schema.String.check(Schema.isMaxLength(64));
const Author = Schema.NullOr(
  Schema.Struct({
    id: Id,
    login: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    type: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  }),
);
const IssueComment = Schema.Struct({
  id: Id,
  author: Author,
  body: Text,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
const Review = Schema.Struct({
  id: Id,
  author: Author,
  body: Text,
  state: Schema.Literals([
    "APPROVED",
    "CHANGES_REQUESTED",
    "COMMENTED",
    "DISMISSED",
  ]),
  submittedAt: Timestamp,
  commitId: Schema.NullOr(HeadSha),
});
const Position = Schema.NullOr(
  Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
);
const Line = Schema.NullOr(Id);
const Side = Schema.NullOr(Schema.Literals(["LEFT", "RIGHT"]));
const ReviewComment = Schema.Struct({
  ...IssueComment.fields,
  pullRequestReviewId: Schema.NullOr(Id),
  inReplyToId: Schema.NullOr(Id),
  path: Text,
  diffHunk: Text,
  commitId: HeadSha,
  originalCommitId: HeadSha,
  position: Position,
  originalPosition: Position,
  line: Line,
  originalLine: Line,
  startLine: Line,
  originalStartLine: Line,
  side: Side,
  startSide: Side,
  subjectType: Schema.NullOr(Schema.Literals(["line", "file"])),
});
const Identity = Schema.Struct({
  provider: Schema.Literal("github.com"),
  repository: Repository,
  repositoryId: Id,
  pullRequest: Id,
  pullRequestId: Id,
  headSha: HeadSha,
});
export const DiscussionContextResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  operation: Schema.Literal("discussion-context"),
  attempt: Schema.Struct({
    id: CollectionRequestSchema.fields.attemptId,
    eventId: Schema.Null,
  }),
  acquisition: Schema.Struct({
    status: Schema.Literals([
      "endpoint-observed",
      "incomplete",
      "unavailable",
      "stale",
    ]),
    reasons: Schema.Array(Schema.String),
    requests: Schema.Int,
    responseBytes: Schema.Int,
  }),
  observation: Schema.Struct({
    startedAt: Timestamp,
    finishedAt: Timestamp,
    durationMs: Schema.Number,
    atomic: Schema.Literal(false),
    maxDurationMs: Schema.Literal(60000),
    scope: Schema.Literal("public-pr-discussion-endpoints-only"),
    omitted: Schema.Array(
      Schema.Literals([
        "pending-reviews",
        "thread-resolution",
        "reactions",
        "timeline",
        "deleted-or-hidden-content",
        "edit-history",
        "external-urls",
        "approval-validity",
        "duplicate-finding-verdict",
      ]),
    ),
  }),
  context: Schema.NullOr(
    Schema.Struct({
      provenance: Identity,
      title: Text,
      body: Schema.NullOr(Text),
      issueComments: Schema.Array(IssueComment).check(Schema.isMaxLength(100)),
      reviews: Schema.Array(Review).check(Schema.isMaxLength(100)),
      reviewComments: Schema.Array(ReviewComment).check(
        Schema.isMaxLength(100),
      ),
    }),
  ),
});
export type DiscussionContextResult = typeof DiscussionContextResultSchema.Type;
type IdentityValue = typeof Identity.Type;
const LIMITS = {
  maxRequests: 16,
  maxResponseBytes: 2 * 1024 * 1024,
  maxTotalResponseBytes: 8 * 1024 * 1024,
  requestTimeoutMs: 10000,
  totalTimeoutMs: 60000,
};
function fail(code: string): never {
  throw new SourceError(code, "Discussion context could not be observed");
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail("DISCUSSION_SHAPE");
  return value as Record<string, unknown>;
}
function decode<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(
      value,
    );
  } catch {
    return fail("DISCUSSION_SHAPE");
  }
}
function repository(value: unknown, request: CollectionRequest): number {
  const repo = object(value);
  if (
    repo.private !== false ||
    (repo.visibility !== undefined && repo.visibility !== "public")
  )
    fail("DISCUSSION_PRIVATE");
  if (repo.full_name !== request.repository) fail("DISCUSSION_IDENTITY");
  return decode(Id, repo.id);
}
async function identity(
  http: GitHubHttp,
  request: CollectionRequest,
): Promise<{ provenance: IdentityValue; title: string; body: string | null }> {
  const prefix = `/repos/${request.repository}`;
  const repositoryId = repository(await http.get(prefix), request);
  const pr = object(await http.get(`${prefix}/pulls/${request.pullRequest}`));
  if (pr.number !== request.pullRequest) fail("DISCUSSION_IDENTITY");
  const head = object(pr.head),
    base = object(pr.base);
  if (
    repository(head.repo, request) !== repositoryId ||
    repository(base.repo, request) !== repositoryId
  )
    fail("DISCUSSION_IDENTITY");
  return {
    title: decode(Text, pr.title),
    body: decode(Schema.NullOr(Text), pr.body),
    provenance: decode(Identity, {
      provider: "github.com",
      repository: request.repository,
      repositoryId,
      pullRequest: request.pullRequest,
      pullRequestId: pr.id,
      headSha: head.sha,
    }),
  };
}
function timestamp(value: string | null): void {
  if (value === null) return;
  if (
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    fail("DISCUSSION_TIMESTAMP");
  // Date.parse normalizes impossible dates (for example February 30).
  const calendar = value.slice(0, 10);
  const midnight = new Date(calendar + "T00:00:00Z");
  if (
    !Number.isFinite(midnight.getTime()) ||
    midnight.toISOString().slice(0, 10) !== calendar
  )
    fail("DISCUSSION_TIMESTAMP");
}

function author(value: unknown): typeof Author.Type {
  if (value === null) return null;
  const row = object(value);
  return decode(Author, { id: row.id, login: row.login, type: row.type });
}
function issueComment(value: unknown): typeof IssueComment.Type {
  const row = object(value);
  const result = decode(IssueComment, {
    id: row.id,
    author: author(row.user),
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  timestamp(result.createdAt);
  timestamp(result.updatedAt);
  if (Date.parse(result.createdAt) > Date.parse(result.updatedAt))
    fail("DISCUSSION_TIMESTAMP");
  return result;
}
function review(value: unknown): typeof Review.Type {
  const row = object(value);
  const result = decode(Review, {
    id: row.id,
    author: author(row.user),
    body: row.body,
    state: row.state,
    submittedAt: row.submitted_at,
    commitId: row.commit_id,
  });
  timestamp(result.submittedAt);
  return result;
}
function reviewComment(value: unknown): typeof ReviewComment.Type {
  const row = object(value);
  if (row.in_reply_to_id === row.id) fail("DISCUSSION_IDENTITY");
  return decode(ReviewComment, {
    ...issueComment(row),
    pullRequestReviewId: row.pull_request_review_id,
    inReplyToId: row.in_reply_to_id ?? null,
    path: row.path,
    diffHunk: row.diff_hunk,
    commitId: row.commit_id,
    originalCommitId: row.original_commit_id,
    position: row.position ?? null,
    originalPosition: row.original_position ?? null,
    line: row.line ?? null,
    originalLine: row.original_line ?? null,
    startLine: row.start_line ?? null,
    originalStartLine: row.original_start_line ?? null,
    side: row.side ?? null,
    startSide: row.start_side ?? null,
    subjectType: row.subject_type ?? null,
  });
}
async function pages<T extends { readonly id: number }>(
  http: GitHubHttp,
  path: string,
  parse: (value: unknown) => T,
  relationship: { field: "issue_url" | "pull_request_url"; expected: string },
): Promise<T[]> {
  const rows: T[] = [],
    ids = new Set<number>();
  for (let page = 1; page <= 2; page++) {
    const items = await http.get(`${path}?per_page=100&page=${page}`);
    if (!Array.isArray(items) || items.length > 100) fail("DISCUSSION_SHAPE");
    if (rows.length + items.length > 100) fail("DISCUSSION_CAP");
    for (const item of items) {
      const raw = object(item);
      if (
        raw[relationship.field] !== undefined &&
        raw[relationship.field] !== relationship.expected
      )
        fail("DISCUSSION_IDENTITY");
      const row = parse(item);
      if (ids.has(row.id)) fail("DISCUSSION_DUPLICATE");
      ids.add(row.id);
      rows.push(row);
    }
    if (items.length < 100) return rows;
  }
  return fail("DISCUSSION_CAP");
}
function textBudget(
  value: { title: string; body: string | null },
  discussion: {
    issueComments: readonly (typeof IssueComment.Type)[];
    reviews: readonly (typeof Review.Type)[];
    reviewComments: readonly (typeof ReviewComment.Type)[];
  },
): void {
  const texts = [
    value.title,
    value.body,
    ...discussion.issueComments.map((row) => row.body),
    ...discussion.reviews.map((row) => row.body),
    ...discussion.reviewComments.flatMap((row) => [
      row.body,
      row.diffHunk,
      row.path,
    ]),
  ];
  let total = 0;
  for (const text of texts) {
    if (text === null) continue;
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > 65536) fail("DISCUSSION_TEXT_BYTES");
    total += bytes;
  }
  if (total > 512 * 1024) fail("DISCUSSION_TEXT_BYTES");
}
export function collectGitHubDiscussionContext(
  policyInput: unknown,
  requestInput: unknown,
  options: {
    readonly transport?: GitHubTransport;
    readonly httpLimits?: Partial<HttpLimits>;
  } = {},
) {
  return Effect.gen(function* () {
    const policy = yield* validatePolicy(policyInput);
    const request = yield* Schema.decodeUnknownEffect(CollectionRequestSchema, {
      onExcessProperty: "error",
    })(requestInput).pipe(
      Effect.mapError(
        () =>
          new SourceError(
            "DISCUSSION_REQUEST",
            "Invalid discussion context request",
          ),
      ),
    );
    if (!policy.allowedRepositories.includes(request.repository))
      return yield* Effect.fail(
        new SourceError(
          "NOT_ALLOWED",
          "Repository is not explicitly allowed by the operator policy",
        ),
      );
    const limits = { ...LIMITS, ...options.httpLimits };
    for (const key of Object.keys(LIMITS) as (keyof HttpLimits)[])
      if (
        !Number.isSafeInteger(limits[key]) ||
        limits[key] < 1 ||
        limits[key] > LIMITS[key]
      )
        return yield* Effect.fail(
          new SourceError(
            "HTTP_LIMIT",
            "Discussion context limits cannot exceed hard bounds",
          ),
        );
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const startedAt = new Date().toISOString(),
          start = performance.now();
        let context: DiscussionContextResult["context"] = null;
        let failure: SourceError | undefined;
        let stats = { requests: 0, responseBytes: 0 };
        let observedHttp: GitHubHttp | undefined;
        try {
          await withGitHubHttp(
            options.transport ?? defaultGitHubTransport,
            signal,
            async (http) => {
              observedHttp = http;
              try {
                const initial = await identity(http, request);
                const prefix = `/repos/${request.repository}`;
                let first:
                  | {
                      issueComments: (typeof IssueComment.Type)[];
                      reviews: (typeof Review.Type)[];
                      reviewComments: (typeof ReviewComment.Type)[];
                    }
                  | undefined;
                let evidenceFailure: SourceError | undefined;
                try {
                  for (let pass = 0; pass < 2; pass++) {
                    const observed = {
                      issueComments: await pages(
                        http,
                        `${prefix}/issues/${request.pullRequest}/comments`,
                        issueComment,
                        {
                          field: "issue_url",
                          expected: `https://api.github.com${prefix}/issues/${request.pullRequest}`,
                        },
                      ),
                      reviews: await pages(
                        http,
                        `${prefix}/pulls/${request.pullRequest}/reviews`,
                        review,
                        {
                          field: "pull_request_url",
                          expected: `https://api.github.com${prefix}/pulls/${request.pullRequest}`,
                        },
                      ),
                      reviewComments: await pages(
                        http,
                        `${prefix}/pulls/${request.pullRequest}/comments`,
                        reviewComment,
                        {
                          field: "pull_request_url",
                          expected: `https://api.github.com${prefix}/pulls/${request.pullRequest}`,
                        },
                      ),
                    };
                    textBudget(initial, observed);
                    if (
                      first &&
                      JSON.stringify(first) !== JSON.stringify(observed)
                    )
                      fail("DISCUSSION_CHANGED");
                    first = observed;
                  }
                } catch (error) {
                  evidenceFailure =
                    error instanceof SourceError
                      ? error
                      : new SourceError(
                          "DISCUSSION_FAILURE",
                          "Discussion context could not be observed",
                        );
                }
                const final = await identity(http, request);
                if (
                  JSON.stringify(initial.provenance) !==
                  JSON.stringify(final.provenance)
                )
                  fail("DISCUSSION_STALE");
                if (
                  initial.title !== final.title ||
                  initial.body !== final.body
                )
                  fail("DISCUSSION_CHANGED");
                if (evidenceFailure) throw evidenceFailure;
                if (!first) fail("DISCUSSION_SHAPE");
                context = {
                  provenance: initial.provenance,
                  title: initial.title,
                  body: initial.body,
                  issueComments: [...first.issueComments].sort(
                    (a, b) => a.id - b.id,
                  ),
                  reviews: [...first.reviews].sort((a, b) => a.id - b.id),
                  reviewComments: [...first.reviewComments].sort(
                    (a, b) => a.id - b.id,
                  ),
                };
              } finally {
                stats = http.stats;
              }
            },
            limits,
          );
        } catch (error) {
          failure =
            error instanceof SourceError
              ? error
              : new SourceError(
                  "DISCUSSION_FAILURE",
                  "Discussion context could not be observed",
                );
          context = null;
        }
        if (observedHttp) stats = observedHttp.stats;
        const durationMs = performance.now() - start;
        if (durationMs > limits.totalTimeoutMs) {
          failure = new SourceError(
            "HTTP_TIMEOUT",
            "Discussion context exceeded its observation window",
          );
          context = null;
        }
        return decode(DiscussionContextResultSchema, {
          schemaVersion: 1,
          operation: "discussion-context",
          attempt: { id: request.attemptId, eventId: null },
          acquisition: {
            status: failure
              ? failure.code === "DISCUSSION_STALE"
                ? "stale"
                : /^(HTTP_(PERMISSION|NOT_FOUND|SERVER|NETWORK|RATE_LIMIT)|DISCUSSION_PRIVATE)$/.test(
                      failure.code,
                    )
                  ? "unavailable"
                  : "incomplete"
              : "endpoint-observed",
            reasons: failure ? [failure.code] : [],
            ...stats,
          },
          observation: {
            startedAt,
            finishedAt: new Date().toISOString(),
            durationMs,
            atomic: false,
            maxDurationMs: 60000,
            scope: "public-pr-discussion-endpoints-only",
            omitted: [
              "pending-reviews",
              "thread-resolution",
              "reactions",
              "timeline",
              "deleted-or-hidden-content",
              "edit-history",
              "external-urls",
              "approval-validity",
              "duplicate-finding-verdict",
            ],
          },
          context,
        });
      },
      catch: (error) =>
        error instanceof SourceError
          ? error
          : new SourceError(
              "DISCUSSION_FAILURE",
              "Discussion context could not be observed",
            ),
    });
  });
}
