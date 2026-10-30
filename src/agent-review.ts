import { Effect, Schema } from "effect";
import { FindingSchema } from "./contracts.ts";
import {
  collectGitHubSource,
  CollectionRequestSchema,
  sourceForModel,
} from "./github-source.ts";
import type { GitHubTransport, HttpLimits } from "./github-http.ts";
import { withReviewer } from "./reviewer.ts";
import { hash } from "./observations.ts";
import { ContractError, validatePolicy } from "./validation.ts";

// This scope deliberately excludes before-side anchors, discussions, checks and
// unchanged dependency files. A completed response is not a whole-PR verdict.
export const AGENT_REVIEW_SCOPE = "changed-files-head-v1";
export const AgentReviewSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  attemptId: CollectionRequestSchema.fields.attemptId,
  snapshotId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  scope: Schema.Literal(AGENT_REVIEW_SCOPE),
  status: Schema.Literals(["complete", "incomplete"]),
  findings: Schema.Array(
    Schema.Struct({
      finding: FindingSchema,
      side: Schema.Literal("after"),
    }),
  ).check(Schema.isMaxLength(100)),
});
export type AgentReview = typeof AgentReviewSchema.Type;

/**
 * The only source authority here is fresh GitHub acquisition, not an input file
 * or its self-computed hash. Transport injection is trusted application/test code
 * and is intentionally not exposed as a CLI option.
 */
export function reviewGitHubSource(
  policyInput: unknown,
  requestInput: unknown,
  responseInput: unknown,
  databasePath: string,
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
        () => new ContractError("REVIEW_REQUEST", "Invalid review target"),
      ),
    );
    const response = yield* Schema.decodeUnknownEffect(AgentReviewSchema, {
      onExcessProperty: "error",
    })(responseInput).pipe(
      Effect.mapError(
        () =>
          new ContractError("AGENT_RESPONSE", "Invalid agent review response"),
      ),
      // Own the response across the asynchronous acquisition boundary.
      Effect.map((value) => structuredClone(value)),
    );
    if (response.attemptId !== request.attemptId)
      return yield* Effect.fail(
        new ContractError(
          "ATTEMPT_MISMATCH",
          "Agent response belongs to another attempt",
        ),
      );
    const acquisition = yield* collectGitHubSource(policy, request, options);
    if (acquisition.acquisition.status !== "complete")
      return {
        schemaVersion: 1 as const,
        operation: "review" as const,
        attemptId: request.attemptId,
        scope: AGENT_REVIEW_SCOPE,
        acquisition: acquisition.acquisition,
        review: { status: "not-run" as const },
        plan: null,
      };
    const snapshot = yield* sourceForModel(acquisition);
    if (response.snapshotId !== acquisition.snapshotId)
      return yield* Effect.fail(
        new ContractError(
          "SNAPSHOT_MISMATCH",
          "Agent response does not match freshly acquired source and PR identity",
        ),
      );
    if (response.status === "incomplete")
      return {
        schemaVersion: 1 as const,
        operation: "review" as const,
        attemptId: request.attemptId,
        scope: AGENT_REVIEW_SCOPE,
        acquisition: acquisition.acquisition,
        review: { status: "incomplete" as const },
        plan: null,
      };
    // Only after-side files exist in this planner context. Deleted paths and old
    // rename paths cannot be silently mapped onto their historical contents.
    const context = {
      repository: snapshot.provenance.repository,
      pullRequest: snapshot.provenance.pullRequest,
      headSha: snapshot.provenance.headSha,
      currentHeadSha: snapshot.provenance.headSha,
      files: snapshot.files.flatMap((file) =>
        file.after === null
          ? []
          : [{ path: file.path, content: file.after.content }],
      ),
    };
    const deliveryId = hash([
      "agent-review-v1",
      request.repository,
      request.pullRequest,
      request.attemptId,
      response.snapshotId,
      AGENT_REVIEW_SCOPE,
    ]);
    return yield* withReviewer(policy, databasePath, (reviewer) =>
      Effect.gen(function* () {
        const plan = yield* reviewer.plan({
          deliveryId,
          context,
          findings: response.findings.map((item) => item.finding),
        });
        return {
          schemaVersion: 1 as const,
          operation: "review" as const,
          attemptId: request.attemptId,
          snapshotId: response.snapshotId,
          scope: AGENT_REVIEW_SCOPE,
          acquisition: acquisition.acquisition,
          review: {
            status:
              response.findings.length === 0
                ? ("no-confirmed-findings" as const)
                : ("findings-proposed" as const),
          },
          plan: {
            ...plan,
            intents: plan.intents.map(
              ({ id, findingId, kind, dryRun, status }) => ({
                id,
                findingId,
                kind,
                dryRun,
                status,
              }),
            ),
          },
          storage: reviewer.storage,
        };
      }),
    );
  });
}
