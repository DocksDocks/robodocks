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
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 }));
const Text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);
const Timestamp = Schema.String.check(Schema.isMaxLength(64));
const Check = Schema.Struct({
  id: Id,
  appId: Id,
  suiteId: Id,
  name: Text,
  headSha: HeadSha,
  status: Schema.Literals([
    "queued",
    "in_progress",
    "completed",
    "waiting",
    "requested",
    "pending",
  ]),
  conclusion: Schema.NullOr(
    Schema.Literals([
      "action_required",
      "cancelled",
      "failure",
      "neutral",
      "success",
      "skipped",
      "stale",
      "timed_out",
      "startup_failure",
    ]),
  ),
  startedAt: Schema.NullOr(Timestamp),
  completedAt: Schema.NullOr(Timestamp),
});
const Status = Schema.Struct({
  id: Id,
  context: Text,
  state: Schema.Literals(["error", "failure", "pending", "success"]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
const Identity = Schema.Struct({
  provider: Schema.Literal("github.com"),
  repository: Repository,
  repositoryId: Id,
  pullRequest: Id,
  pullRequestId: Id,
  headSha: HeadSha,
});
export const CheckContextResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  operation: Schema.Literal("check-context"),
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
    scope: Schema.Literal("exact-head-endpoints-only"),
    checkSuiteLimit: Schema.Literal(1000),
    omitted: Schema.Array(
      Schema.Literals([
        "logs",
        "artifacts",
        "annotations",
        "check-output",
        "external-urls",
        "required-checks",
        "merge-eligibility",
        "historical-statuses",
        "older-check-suites",
      ]),
    ),
  }),
  context: Schema.NullOr(
    Schema.Struct({
      provenance: Identity,
      checkRuns: Schema.Array(Check).check(Schema.isMaxLength(200)),
      statuses: Schema.Array(Status).check(Schema.isMaxLength(200)),
      checkRunCount: Count,
      statusCount: Count,
    }),
  ),
});
export type CheckContextResult = typeof CheckContextResultSchema.Type;
type IdentityValue = typeof Identity.Type;
const LIMITS = {
  maxRequests: 12,
  maxResponseBytes: 2 * 1024 * 1024,
  maxTotalResponseBytes: 8 * 1024 * 1024,
  requestTimeoutMs: 10000,
  totalTimeoutMs: 60000,
};
function fail(code: string): never {
  throw new SourceError(code, "Check context could not be observed");
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail("CHECK_SHAPE");
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
    return fail("CHECK_SHAPE");
  }
}
function repository(value: unknown, request: CollectionRequest): number {
  const repo = object(value);
  if (
    repo.private !== false ||
    (repo.visibility !== undefined && repo.visibility !== "public")
  )
    fail("CHECK_PRIVATE");
  if (repo.full_name !== request.repository) fail("CHECK_IDENTITY");
  return decode(Id, repo.id);
}
async function identity(
  http: GitHubHttp,
  request: CollectionRequest,
): Promise<IdentityValue> {
  const prefix = `/repos/${request.repository}`;
  const repositoryId = repository(await http.get(prefix), request);
  const pr = object(await http.get(`${prefix}/pulls/${request.pullRequest}`));
  if (pr.number !== request.pullRequest) fail("CHECK_IDENTITY");
  const head = object(pr.head),
    base = object(pr.base);
  if (
    repository(head.repo, request) !== repositoryId ||
    repository(base.repo, request) !== repositoryId
  )
    fail("CHECK_IDENTITY");
  return decode(Identity, {
    provider: "github.com",
    repository: request.repository,
    repositoryId,
    pullRequest: request.pullRequest,
    pullRequestId: pr.id,
    headSha: head.sha,
  });
}
function timestamp(value: string | null): void {
  if (value === null) return;
  if (
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    fail("CHECK_TIMESTAMP");
  // Date.parse normalizes impossible dates (for example February 30).
  const calendar = value.slice(0, 10);
  const midnight = new Date(calendar + "T00:00:00Z");
  if (
    !Number.isFinite(midnight.getTime()) ||
    midnight.toISOString().slice(0, 10) !== calendar
  )
    fail("CHECK_TIMESTAMP");
}

function check(value: unknown, sha: string): typeof Check.Type {
  const row = object(value);
  const parsed = decode(Check, {
    id: row.id,
    appId: object(row.app).id,
    suiteId: object(row.check_suite).id,
    name: row.name,
    headSha: row.head_sha,
    status: row.status,
    conclusion: row.conclusion,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  });
  if (parsed.headSha !== sha) fail("CHECK_SHA");
  timestamp(parsed.startedAt);
  timestamp(parsed.completedAt);
  if (
    (parsed.status === "completed") !== (parsed.conclusion !== null) ||
    (parsed.status === "completed") !== (parsed.completedAt !== null)
  )
    fail("CHECK_STATE");
  if (
    parsed.startedAt !== null &&
    parsed.completedAt !== null &&
    Date.parse(parsed.startedAt) > Date.parse(parsed.completedAt)
  )
    fail("CHECK_TIMESTAMP");
  return parsed;
}
function status(value: unknown): typeof Status.Type {
  const row = object(value);
  const parsed = decode(Status, {
    id: row.id,
    context: row.context,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  timestamp(parsed.createdAt);
  timestamp(parsed.updatedAt);
  if (Date.parse(parsed.createdAt) > Date.parse(parsed.updatedAt))
    fail("CHECK_TIMESTAMP");
  return parsed;
}
async function pages<T extends { readonly id: number }>(
  http: GitHubHttp,
  prefix: string,
  sha: string,
  kind: "check-runs" | "status",
  parse: (value: unknown) => T,
): Promise<T[]> {
  const rows: T[] = [],
    ids = new Set<number>(),
    contexts = new Set<string>();
  let total: number | undefined;
  for (let page = 1; page <= 2; page++) {
    const body = object(
      await http.get(
        `${prefix}/commits/${sha}/${kind}?${kind === "check-runs" ? "filter=all&" : ""}per_page=100&page=${page}`,
      ),
    );
    const count = decode(Count, body.total_count);
    if (total !== undefined && total !== count) fail("CHECK_CHANGED");
    total = count;
    if (kind === "status" && body.sha !== sha) fail("CHECK_SHA");
    const items = body[kind === "status" ? "statuses" : "check_runs"];
    if (
      !Array.isArray(items) ||
      items.length !== Math.min(100, total - rows.length)
    )
      fail("CHECK_PAGINATION");
    for (const item of items) {
      const row = parse(item);
      if (ids.has(row.id)) fail("CHECK_DUPLICATE");
      ids.add(row.id);
      if (kind === "status") {
        const context = object(row).context;
        if (typeof context !== "string" || contexts.has(context.toLowerCase()))
          fail("CHECK_DUPLICATE");
        contexts.add(context.toLowerCase());
      }
      rows.push(row);
    }
    if (rows.length === total) return rows;
  }
  return fail("CHECK_CAP");
}
export function collectGitHubCheckContext(
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
        () => new SourceError("CHECK_REQUEST", "Invalid check context request"),
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
            "Check context limits cannot exceed hard bounds",
          ),
        );
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const startedAt = new Date().toISOString(),
          start = performance.now();
        let context: CheckContextResult["context"] = null;
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
                      checkRuns: (typeof Check.Type)[];
                      statuses: (typeof Status.Type)[];
                    }
                  | undefined;
                let evidenceFailure: SourceError | undefined;
                try {
                  for (let pass = 0; pass < 2; pass++) {
                    const observed = {
                      checkRuns: await pages(
                        http,
                        prefix,
                        initial.headSha,
                        "check-runs",
                        (row) => check(row, initial.headSha),
                      ),
                      statuses: await pages(
                        http,
                        prefix,
                        initial.headSha,
                        "status",
                        status,
                      ),
                    };
                    if (
                      first &&
                      JSON.stringify(first) !== JSON.stringify(observed)
                    )
                      fail("CHECK_CHANGED");
                    first = observed;
                  }
                } catch (error) {
                  evidenceFailure =
                    error instanceof SourceError
                      ? error
                      : new SourceError(
                          "CHECK_FAILURE",
                          "Check context could not be observed",
                        );
                }
                const final = await identity(http, request);
                if (JSON.stringify(initial) !== JSON.stringify(final))
                  fail("CHECK_STALE");
                if (evidenceFailure) throw evidenceFailure;
                if (!first) fail("CHECK_SHAPE");
                context = {
                  provenance: initial,
                  checkRuns: [...first.checkRuns].sort((a, b) => a.id - b.id),
                  statuses: [...first.statuses].sort((a, b) => a.id - b.id),
                  checkRunCount: first.checkRuns.length,
                  statusCount: first.statuses.length,
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
                  "CHECK_FAILURE",
                  "Check context could not be observed",
                );
          context = null;
        }
        if (observedHttp) stats = observedHttp.stats;
        const durationMs = performance.now() - start;
        if (durationMs > limits.totalTimeoutMs) {
          failure = new SourceError(
            "HTTP_TIMEOUT",
            "Check context exceeded its observation window",
          );
          context = null;
        }
        return decode(CheckContextResultSchema, {
          schemaVersion: 1,
          operation: "check-context",
          attempt: { id: request.attemptId, eventId: null },
          acquisition: {
            status: failure
              ? failure.code === "CHECK_STALE"
                ? "stale"
                : /^(HTTP_(PERMISSION|NOT_FOUND|SERVER|NETWORK|RATE_LIMIT)|CHECK_PRIVATE)$/.test(
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
            scope: "exact-head-endpoints-only",
            checkSuiteLimit: 1000,
            omitted: [
              "logs",
              "artifacts",
              "annotations",
              "check-output",
              "external-urls",
              "required-checks",
              "merge-eligibility",
              "historical-statuses",
              "older-check-suites",
            ],
          },
          context,
        });
      },
      catch: (error) =>
        error instanceof SourceError
          ? error
          : new SourceError(
              "CHECK_FAILURE",
              "Check context could not be observed",
            ),
    });
  });
}
