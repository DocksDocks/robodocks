/** Operator-owned configuration. Never load this from a pull request. */
export interface Policy {
  schemaVersion: 1;
  mode: "read-only";
  publication: "disabled";
  allowedRepositories: string[];
  minimumConfidence: number;
  maxFindings: number;
}

/** An adapter must obtain this snapshot independently of candidate findings. */
export interface ReviewContext {
  repository: string;
  pullRequest: number;
  headSha: string;
  currentHeadSha: string;
  files: { path: string; content: string }[];
}

/** Untrusted, proposed findings require runtime validation. */
export interface Finding {
  ruleId: string;
  repository: string;
  pullRequest: number;
  headSha: string;
  path: string;
  startLine: number;
  endLine: number;
  title: string;
  severity: "low" | "medium" | "high";
  evidence: string;
  impact: string;
  suggestion: string;
  confidence: number;
}

export interface ReviewRequest {
  deliveryId: string;
  context: ReviewContext;
  findings: Finding[];
}

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
