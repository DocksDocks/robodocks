import { Effect, Schema } from "effect";
import {
  collectGitHubCheckContext,
  CheckContextResultSchema,
} from "./github-check-context.ts";
import {
  collectGitHubDiscussionContext,
  DiscussionContextResultSchema,
} from "./github-discussion-context.ts";
import {
  collectGitHubSource,
  CollectionRequestSchema,
  CollectionResultSchema,
} from "./github-source.ts";
import { SourceError } from "./github-http.ts";
import type { GitHubTransport, HttpStats } from "./github-http.ts";
import { validatePolicy } from "./validation.ts";

const MAX_DURATION_MS = 180000;
const Stage = Schema.Literals(["checks", "discussion", "source"]);
export const ReviewContextResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  operation: Schema.Literal("collect-context"),
  attempt: CollectionResultSchema.fields.attempt,
  acquisition: Schema.Struct({
    status: Schema.Literals(["context-observed", "incomplete"]),
    failedStage: Schema.NullOr(Stage),
    reasons: Schema.Array(Schema.String),
    requests: Schema.Int,
    responseBytes: Schema.Int,
  }),
  observation: Schema.Struct({
    startedAt: Schema.String,
    finishedAt: Schema.String,
    durationMs: Schema.Number,
    maxDurationMs: Schema.Number,
    atomic: Schema.Literal(false),
    scope: Schema.Literal("public-pr-source-checks-discussion-v1"),
  }),
  bundle: Schema.NullOr(
    Schema.Struct({
      checks: CheckContextResultSchema,
      discussion: DiscussionContextResultSchema,
      source: CollectionResultSchema,
    }),
  ),
  review: Schema.Struct({ status: Schema.Literal("not-run") }),
});
export type ReviewContextResult = typeof ReviewContextResultSchema.Type;
type Identity = NonNullable<
  typeof CheckContextResultSchema.Type.context
>["provenance"];
function agrees(a: Identity, b: Identity): boolean {
  return (
    a.provider === b.provider &&
    a.repository === b.repository &&
    a.repositoryId === b.repositoryId &&
    a.pullRequest === b.pullRequest &&
    a.pullRequestId === b.pullRequestId &&
    a.headSha === b.headSha
  );
}

/** Collect trusted components; imported result JSON is deliberately not an input. */
export function collectGitHubReviewContext(
  policyInput: unknown,
  requestInput: unknown,
  options: {
    readonly transport?: GitHubTransport;
    readonly maxDurationMs?: number;
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
            "CONTEXT_REQUEST",
            "Invalid context collection request",
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
    const maxDurationMs = options.maxDurationMs ?? MAX_DURATION_MS;
    if (
      !Number.isSafeInteger(maxDurationMs) ||
      maxDurationMs < 1 ||
      maxDurationMs > MAX_DURATION_MS
    )
      return yield* Effect.fail(
        new SourceError(
          "CONTEXT_LIMIT",
          "Context deadline cannot exceed its hard bound",
        ),
      );
    const startedAt = new Date().toISOString(),
      start = performance.now();
    const stats: Record<typeof Stage.Type, HttpStats> = {
      checks: { requests: 0, responseBytes: 0 },
      discussion: { requests: 0, responseBytes: 0 },
      source: { requests: 0, responseBytes: 0 },
    };
    let stage: typeof Stage.Type = "checks";
    const remaining = () =>
      Math.floor(maxDurationMs - (performance.now() - start));
    const stageOptions = () => ({
      ...(options.transport ? { transport: options.transport } : {}),
      httpLimits: { totalTimeoutMs: Math.min(60000, Math.max(1, remaining())) },
      onStats: (value: HttpStats) => {
        stats[stage] = value;
      },
    });
    const deadline = () => remaining() <= 0;
    const timedOut = () =>
      new SourceError(
        "CONTEXT_TIMEOUT",
        "Context collection exceeded its observation window",
      );
    const acquired = yield* Effect.gen(function* () {
      if (deadline()) return yield* Effect.fail(timedOut());
      const checks = yield* collectGitHubCheckContext(
        policy,
        request,
        stageOptions(),
      );
      if (deadline()) return yield* Effect.fail(timedOut());
      if (checks.acquisition.status !== "endpoint-observed" || !checks.context)
        return yield* Effect.fail(
          new SourceError(
            checks.acquisition.reasons[0] ?? "CONTEXT_CHECKS",
            "Check observation failed",
          ),
        );
      if (
        checks.attempt.id !== request.attemptId ||
        checks.attempt.eventId !== null
      )
        return yield* Effect.fail(
          new SourceError("CONTEXT_IDENTITY", "Component identities disagree"),
        );
      stage = "discussion";
      const discussion = yield* collectGitHubDiscussionContext(
        policy,
        request,
        stageOptions(),
      );
      if (deadline()) return yield* Effect.fail(timedOut());
      if (
        discussion.acquisition.status !== "endpoint-observed" ||
        !discussion.context
      )
        return yield* Effect.fail(
          new SourceError(
            discussion.acquisition.reasons[0] ?? "CONTEXT_DISCUSSION",
            "Discussion observation failed",
          ),
        );
      if (
        !agrees(checks.context.provenance, discussion.context.provenance) ||
        discussion.attempt.id !== request.attemptId ||
        discussion.attempt.eventId !== null
      )
        return yield* Effect.fail(
          new SourceError("CONTEXT_IDENTITY", "Component identities disagree"),
        );
      stage = "source";
      const source = yield* collectGitHubSource(
        policy,
        request,
        stageOptions(),
      );
      if (deadline()) return yield* Effect.fail(timedOut());
      if (
        source.acquisition.status !== "complete" ||
        source.acquisition.omissions.length !== 0 ||
        !source.snapshot ||
        !source.snapshotId
      )
        return yield* Effect.fail(
          new SourceError(
            source.acquisition.omissions[0]?.code ?? "CONTEXT_SOURCE",
            "Source acquisition failed",
          ),
        );
      if (
        !agrees(checks.context.provenance, source.snapshot.provenance) ||
        source.attempt.id !== request.attemptId ||
        source.attempt.eventId !== null
      )
        return yield* Effect.fail(
          new SourceError("CONTEXT_IDENTITY", "Component identities disagree"),
        );
      return {
        bundle: { checks, discussion, source },
        reasons: [] as string[],
      };
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          bundle: null,
          reasons: [deadline() ? "CONTEXT_TIMEOUT" : error.code],
        }),
      ),
    );
    const result: ReviewContextResult = {
      schemaVersion: 1,
      operation: "collect-context",
      attempt: { id: request.attemptId, eventId: null },
      acquisition: {
        status: acquired.bundle ? "context-observed" : "incomplete",
        failedStage: acquired.bundle ? null : stage,
        reasons: acquired.reasons,
        requests: Object.values(stats).reduce(
          (sum, value) => sum + value.requests,
          0,
        ),
        responseBytes: Object.values(stats).reduce(
          (sum, value) => sum + value.responseBytes,
          0,
        ),
      },
      observation: {
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: performance.now() - start,
        maxDurationMs,
        atomic: false,
        scope: "public-pr-source-checks-discussion-v1",
      },
      bundle: acquired.bundle,
      review: { status: "not-run" },
    };
    return result;
  });
}
