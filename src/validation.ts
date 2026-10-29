import { Data, Effect, Schema } from "effect";
import { PolicySchema, RequestSchema } from "./contracts.ts";
import type {
  Finding,
  Policy,
  ReviewContext,
  ReviewRequest,
} from "./contracts.ts";

export class ContractError extends Data.TaggedError("ContractError")<{
  readonly code: string;
  readonly message: string;
}> {
  constructor(code: string, message: string) {
    super({ code, message });
  }
}

export function requireCondition(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new ContractError(code, message);
}

function contract<A>(evaluate: () => A): Effect.Effect<A, ContractError> {
  return Effect.try({
    try: evaluate,
    catch: (error) =>
      error instanceof ContractError
        ? error
        : new ContractError(
            "SHAPE",
            "input does not satisfy the review contract",
          ),
  });
}

export function validatePolicy(
  input: unknown,
): Effect.Effect<Policy, ContractError> {
  return Schema.decodeUnknownEffect(PolicySchema, {
    onExcessProperty: "error",
  })(input).pipe(
    Effect.mapError(
      () =>
        new ContractError(
          "SHAPE",
          "policy has missing, unsupported, or invalid fields",
        ),
    ),
    Effect.flatMap((policy) =>
      contract(() => {
        requireCondition(
          new Set(policy.allowedRepositories.map((item) => item.toLowerCase()))
            .size === policy.allowedRepositories.length,
          "POLICY",
          "allowed repositories must be unique",
        );
        return structuredClone(policy);
      }),
    ),
  );
}

function validateContext(context: ReviewContext, policy: Policy): void {
  requireCondition(
    policy.allowedRepositories.includes(context.repository),
    "NOT_ALLOWED",
    "repository is not explicitly allowed by the operator policy",
  );
  requireCondition(
    context.headSha === context.currentHeadSha,
    "STALE_HEAD",
    "review snapshot no longer matches the current pull request head",
  );
  requireCondition(
    context.files.reduce((length, file) => length + file.content.length, 0) <=
      1024 * 1024,
    "LIMIT",
    "snapshot content cannot exceed one Mi character",
  );
  requireCondition(
    new Set(context.files.map((file) => file.path)).size ===
      context.files.length,
    "PATH",
    "snapshot paths must be unique",
  );
}

function validateFinding(
  finding: Finding,
  target: ReviewContext,
  policy: Policy,
): void {
  requireCondition(
    finding.repository === target.repository &&
      finding.pullRequest === target.pullRequest &&
      finding.headSha === target.headSha,
    "TARGET_MISMATCH",
    "finding repository, pull request and head must exactly match the trusted context",
  );
  requireCondition(
    finding.confidence >= policy.minimumConfidence,
    "CONFIDENCE",
    "finding does not meet the operator confidence threshold",
  );
  const file = target.files.find((item) => item.path === finding.path);
  requireCondition(
    file,
    "MISSING_FILE",
    "finding path is absent from the trusted snapshot",
  );
  const lines = file.content.split("\n");
  requireCondition(
    finding.endLine <= lines.length,
    "LINES",
    "finding line range is absent from the trusted snapshot",
  );
  requireCondition(
    lines.slice(finding.startLine - 1, finding.endLine).join("\n") ===
      finding.evidence,
    "EVIDENCE",
    "finding evidence must exactly match the cited lines in the trusted snapshot",
  );
}

export function validateRequest(
  input: unknown,
  policy: Policy,
): Effect.Effect<ReviewRequest, ContractError> {
  return Schema.decodeUnknownEffect(RequestSchema, {
    onExcessProperty: "error",
  })(input).pipe(
    Effect.mapError(
      () =>
        new ContractError(
          "SHAPE",
          "request has missing, unsupported, or invalid fields",
        ),
    ),
    Effect.flatMap((request) =>
      contract(() => {
        validateContext(request.context, policy);
        requireCondition(
          request.findings.length <= policy.maxFindings,
          "LIMIT",
          "findings exceed the operator limit",
        );
        request.findings.forEach((finding) =>
          validateFinding(finding, request.context, policy),
        );
        return structuredClone(request);
      }),
    ),
  );
}
