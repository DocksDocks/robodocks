import { createHash } from "node:crypto";
import { Schema } from "effect";
import { FindingSchema } from "./contracts.ts";
import type { Finding, FindingRecord, PublicationIntent } from "./contracts.ts";
import { StoreError } from "./storage.ts";

export interface ObservationRow {
  sequence: number;
  findingId: string;
  repository: string;
  pullRequest: number;
  headSha: string;
  findingStatus: string;
  intentId: string | null;
  payload: string | null;
  intentStatus: string | null;
  externalReference: string | null;
}
export interface Observation {
  record: FindingRecord;
  intent: PublicationIntent;
}
export const observationSelect =
  "SELECT f.rowid AS sequence, f.id AS findingId, f.repository, f.pull_request AS pullRequest, f.head_sha AS headSha, f.status AS findingStatus, " +
  "o.id AS intentId, o.payload, o.status AS intentStatus, o.external_reference AS externalReference " +
  "FROM findings f LEFT JOIN outbox o ON o.finding_id = f.id";

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function findingId(finding: Finding): string {
  return hash([
    finding.repository,
    finding.pullRequest,
    finding.headSha,
    finding.ruleId,
    finding.path,
    finding.startLine,
    finding.endLine,
    finding.evidence,
  ]);
}

export function integrity(condition: unknown): asserts condition {
  if (!condition)
    throw new StoreError({
      code: "STORAGE_INTEGRITY",
      message: "Stored observation records are missing or inconsistent",
    });
}

export function isReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  );
}

export function decodeObservation(row: ObservationRow): Observation {
  integrity(row.intentId !== null && row.payload !== null);
  let finding: Finding;
  try {
    finding = Schema.decodeUnknownSync(FindingSchema, {
      onExcessProperty: "error",
    })(JSON.parse(row.payload));
  } catch {
    throw new StoreError({
      code: "STORAGE_INTEGRITY",
      message: "Stored observation payload does not satisfy its contract",
    });
  }
  integrity(
    findingId(finding) === row.findingId &&
      hash(["review-comment-v1", row.findingId]) === row.intentId &&
      finding.repository === row.repository &&
      finding.pullRequest === row.pullRequest &&
      finding.headSha === row.headSha,
  );
  const pending =
    row.findingStatus === "proposed" &&
    row.intentStatus === "pending" &&
    row.externalReference === null;
  const acknowledged =
    (row.findingStatus === "published" || row.findingStatus === "closed") &&
    row.intentStatus === "acknowledged" &&
    isReference(row.externalReference);
  integrity(pending || acknowledged);
  const status: FindingRecord["status"] = pending
    ? "proposed"
    : row.findingStatus === "closed"
      ? "closed"
      : "published";
  return {
    record: {
      id: row.findingId,
      repository: finding.repository,
      pullRequest: finding.pullRequest,
      firstObservedHeadSha: finding.headSha,
      status,
    },
    intent: {
      id: row.intentId,
      findingId: row.findingId,
      kind: "propose-review-comment",
      dryRun: true,
      status: pending ? "pending" : "acknowledged",
      finding,
      ...(row.externalReference === null
        ? {}
        : { externalReference: row.externalReference }),
    },
  };
}
