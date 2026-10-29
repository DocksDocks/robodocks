import { Schema } from "effect";

// Reusable intrinsic constraints also protect payloads read back from SQLite.
const boundedText = (maximum: number) =>
  Schema.String.check(
    Schema.isBetweenLength(1, maximum),
    Schema.isPattern(/\S/),
  );
const PositiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Confidence = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: 0, maximum: 1 }),
);
const Repository = boundedText(180).check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+$/),
  Schema.makeFilter(
    (value) => ![".", ".."].includes(value.split("/")[1] ?? ""),
  ),
);
const HeadSha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
const RelativePath = boundedText(512).check(
  Schema.makeFilter(
    (value) =>
      !Array.from(value).some(
        (character) =>
          character.charCodeAt(0) <= 31 ||
          character.charCodeAt(0) === 127 ||
          character === "\\" ||
          character === ":",
      ) &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
  ),
);

// These are the only input schemas. Types are derived, not duplicated.
export const PolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  mode: Schema.Literal("read-only"),
  publication: Schema.Literal("disabled"),
  allowedRepositories: Schema.Array(Repository).check(
    Schema.isBetweenLength(1, 100),
  ),
  minimumConfidence: Confidence,
  maxFindings: PositiveInteger.check(Schema.isLessThanOrEqualTo(100)),
});
export type Policy = typeof PolicySchema.Type;

export const ContextSchema = Schema.Struct({
  repository: Repository,
  pullRequest: PositiveInteger,
  headSha: HeadSha,
  currentHeadSha: HeadSha,
  files: Schema.Array(
    Schema.Struct({
      path: RelativePath,
      content: Schema.String.check(Schema.isMaxLength(128 * 1024)),
    }),
  ).check(Schema.isMaxLength(1000)),
});
export type ReviewContext = typeof ContextSchema.Type;

export const FindingSchema = Schema.Struct({
  ruleId: boundedText(100).check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/)),
  repository: Repository,
  pullRequest: PositiveInteger,
  headSha: HeadSha,
  path: RelativePath,
  startLine: PositiveInteger,
  endLine: PositiveInteger,
  title: boundedText(200),
  severity: Schema.Literals(["low", "medium", "high"]),
  evidence: boundedText(8192),
  impact: boundedText(4096),
  suggestion: boundedText(4096),
  confidence: Confidence,
}).check(
  Schema.makeFilter(
    (value) =>
      value.startLine <= value.endLine && value.endLine - value.startLine < 100,
  ),
);
export type Finding = typeof FindingSchema.Type;

export const RequestSchema = Schema.Struct({
  deliveryId: boundedText(128).check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  ),
  context: ContextSchema,
  findings: Schema.Array(FindingSchema).check(Schema.isMaxLength(100)),
});
export type ReviewRequest = typeof RequestSchema.Type;

export interface PublicationIntent {
  id: string;
  findingId: string;
  kind: "propose-review-comment";
  dryRun: true;
  status: "pending" | "acknowledged";
  finding: Finding;
  externalReference?: string;
}

export interface FindingRecord {
  id: string;
  repository: string;
  pullRequest: number;
  firstObservedHeadSha: string;
  status: "proposed" | "published" | "closed";
}

export interface Snapshot {
  schemaVersion: 1;
  deliveries: { id: string; digest: string }[];
  findings: FindingRecord[];
  outbox: PublicationIntent[];
}

export interface ReviewPlan {
  dryRun: true;
  deliveryStatus: "accepted" | "duplicate";
  intents: PublicationIntent[];
  suppressedFindingIds: string[];
}
