import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Context, Effect, Layer, Schema } from "effect";
import { FindingSchema } from "./contracts.ts";
import type {
  Finding,
  FindingRecord,
  Policy,
  PublicationIntent,
  ReviewPlan,
  Snapshot,
} from "./contracts.ts";
import { acquireStore, storeOperation, StoreError } from "./storage.ts";
import type { StorageDiagnostics } from "./storage.ts";
import {
  requireCondition,
  validatePolicy,
  validateRequest,
} from "./validation.ts";
import type { ContractError } from "./validation.ts";

type ReviewError = ContractError | StoreError;
interface OutboxRow {
  id: string;
  findingId: string;
  payload: string;
  status: "pending" | "acknowledged";
  externalReference: string | null;
}

export interface Reviewer {
  plan(input: unknown): Effect.Effect<ReviewPlan, ReviewError>;
  recordPublication(
    intentId: string,
    externalReference: string,
  ): Effect.Effect<void, ReviewError>;
  recordFindingClosed(id: string): Effect.Effect<void, ReviewError>;
  snapshot(): Effect.Effect<Snapshot, ReviewError>;
  readonly storage: Readonly<StorageDiagnostics>;
}

export class ReviewerService extends Context.Service<
  ReviewerService,
  Reviewer
>()("robodocks/Reviewer") {}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function findingId(finding: Finding): string {
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

function makeReviewer(
  policy: Policy,
  db: Database,
  diagnostics: StorageDiagnostics,
): Reviewer {
  // Only placeholder syntax is constructed; repository values are always bound.
  const repositoryPlaceholders = policy.allowedRepositories
    .map(() => "?")
    .join(", ");
  function isAllowed(repository: string): boolean {
    return policy.allowedRepositories.includes(repository);
  }

  function intent(row: OutboxRow): PublicationIntent {
    const finding = Schema.decodeUnknownSync(FindingSchema, {
      onExcessProperty: "error",
    })(JSON.parse(row.payload));
    if (
      findingId(finding) !== row.findingId ||
      hash(["review-comment-v1", row.findingId]) !== row.id
    ) {
      throw new StoreError({
        code: "STORAGE_INTEGRITY",
        message: "Stored observation identity does not match its payload",
      });
    }
    return {
      id: row.id,
      findingId: row.findingId,
      kind: "propose-review-comment",
      dryRun: true,
      status: row.status,
      finding,
      ...(row.externalReference === null
        ? {}
        : { externalReference: row.externalReference }),
    };
  }

  return {
    storage: Object.freeze({ ...diagnostics }),
    plan(input) {
      return validateRequest(input, policy).pipe(
        Effect.flatMap((request) =>
          storeOperation(() =>
            db
              .transaction((): ReviewPlan => {
                const digest = hash(request);
                const previous = db
                  .query<{ digest: string }, [string]>(
                    "SELECT digest FROM deliveries WHERE id = ?",
                  )
                  .get(request.deliveryId);
                if (previous) {
                  requireCondition(
                    previous.digest === digest,
                    "DELIVERY_CONFLICT",
                    "delivery ID was already used for a different request",
                  );
                  return {
                    dryRun: true,
                    deliveryStatus: "duplicate",
                    intents: [],
                    suppressedFindingIds: [],
                  };
                }
                const deliveries =
                  db
                    .query<{ count: number }, []>(
                      "SELECT count(*) AS count FROM deliveries",
                    )
                    .get()?.count ?? 0;
                const findings =
                  db
                    .query<{ count: number }, []>(
                      "SELECT count(*) AS count FROM findings",
                    )
                    .get()?.count ?? 0;
                requireCondition(
                  deliveries < 10_000 &&
                    findings + request.findings.length <= 10_000,
                  "LEDGER_FULL",
                  "Ledger capacity reached; archive with an operator-reviewed retention policy",
                );
                const intents: PublicationIntent[] = [];
                const suppressedFindingIds: string[] = [];
                for (const finding of request.findings) {
                  const id = findingId(finding);
                  if (
                    db
                      .query<{ id: string }, [string]>(
                        "SELECT id FROM findings WHERE id = ?",
                      )
                      .get(id)
                  ) {
                    suppressedFindingIds.push(id);
                    continue;
                  }
                  const proposed: PublicationIntent = {
                    id: hash(["review-comment-v1", id]),
                    findingId: id,
                    kind: "propose-review-comment",
                    dryRun: true,
                    status: "pending",
                    finding,
                  };
                  db.query(
                    "INSERT INTO findings (id, repository, pull_request, head_sha, status) VALUES (?, ?, ?, ?, 'proposed')",
                  ).run(
                    id,
                    finding.repository,
                    finding.pullRequest,
                    finding.headSha,
                  );
                  db.query(
                    "INSERT INTO outbox (id, finding_id, payload, status) VALUES (?, ?, ?, 'pending')",
                  ).run(proposed.id, id, JSON.stringify(finding));
                  intents.push(proposed);
                }
                db.query(
                  "INSERT INTO deliveries (id, digest, repository) VALUES (?, ?, ?)",
                ).run(request.deliveryId, digest, request.context.repository);
                return {
                  dryRun: true,
                  deliveryStatus: "accepted",
                  intents,
                  suppressedFindingIds,
                };
              })
              .immediate(),
          ),
        ),
      );
    },
    recordPublication(intentId, externalReference) {
      return storeOperation(() =>
        db
          .transaction(() => {
            const row = db
              .query<
                {
                  findingId: string;
                  status: string;
                  externalReference: string | null;
                  repository: string;
                },
                [string]
              >(
                "SELECT o.finding_id AS findingId, o.status, o.external_reference AS externalReference, f.repository FROM outbox o JOIN findings f ON f.id = o.finding_id WHERE o.id = ?",
              )
              .get(intentId);
            requireCondition(
              row,
              "UNKNOWN_INTENT",
              "publication acknowledgement requires a known intent",
            );
            requireCondition(
              isAllowed(row.repository),
              "NOT_ALLOWED",
              "repository is not explicitly allowed by the operator policy",
            );
            requireCondition(
              typeof externalReference === "string" &&
                /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(externalReference),
              "REFERENCE",
              "externalReference must be a bounded identifier",
            );
            if (row.status === "acknowledged") {
              requireCondition(
                row.externalReference === externalReference,
                "ACK_CONFLICT",
                "intent was already acknowledged with a different reference",
              );
              return;
            }
            db.query(
              "UPDATE outbox SET status = 'acknowledged', external_reference = ? WHERE id = ?",
            ).run(externalReference, intentId);
            db.query(
              "UPDATE findings SET status = 'published' WHERE id = ?",
            ).run(row.findingId);
          })
          .immediate(),
      );
    },
    recordFindingClosed(id) {
      return storeOperation(() =>
        db
          .transaction(() => {
            const record = db
              .query<{ status: string; repository: string }, [string]>(
                "SELECT status, repository FROM findings WHERE id = ?",
              )
              .get(id);
            requireCondition(
              record && record.status !== "proposed",
              "INVALID_TRANSITION",
              "only an acknowledged finding can be marked closed",
            );
            requireCondition(
              isAllowed(record.repository),
              "NOT_ALLOWED",
              "repository is not explicitly allowed by the operator policy",
            );
            db.query("UPDATE findings SET status = 'closed' WHERE id = ?").run(
              id,
            );
          })
          .immediate(),
      );
    },
    snapshot() {
      return storeOperation(() =>
        db
          .transaction((): Snapshot => {
            const findings = db
              .query<FindingRecord, string[]>(
                "SELECT id, repository, pull_request AS pullRequest, head_sha AS firstObservedHeadSha, status FROM findings WHERE repository IN (" +
                  repositoryPlaceholders +
                  ") ORDER BY rowid",
              )
              .all(...policy.allowedRepositories);
            const outbox = db
              .query<OutboxRow, string[]>(
                "SELECT o.id, o.finding_id AS findingId, o.payload, o.status, o.external_reference AS externalReference FROM outbox o JOIN findings f ON f.id = o.finding_id WHERE f.repository IN (" +
                  repositoryPlaceholders +
                  ") ORDER BY o.rowid",
              )
              .all(...policy.allowedRepositories)
              .map(intent);
            const deliveries = db
              .query<{ id: string; digest: string }, string[]>(
                "SELECT id, digest FROM deliveries WHERE repository IN (" +
                  repositoryPlaceholders +
                  ") ORDER BY rowid",
              )
              .all(...policy.allowedRepositories);
            return { schemaVersion: 1, deliveries, findings, outbox };
          })
          .deferred(),
      );
    },
  };
}

/** Layer.effect owns the acquired connection scope; do not close it before use. */
export function reviewerLayer(operatorPolicy: unknown, filename: string) {
  return Layer.effect(
    ReviewerService,
    Effect.gen(function* () {
      const policy = yield* validatePolicy(operatorPolicy);
      const { db, diagnostics } = yield* acquireStore(filename);
      return makeReviewer(policy, db, diagnostics);
    }),
  );
}

export function withReviewer<A, E, R>(
  operatorPolicy: unknown,
  filename: string,
  use: (reviewer: Reviewer) => Effect.Effect<A, E, R>,
) {
  return Effect.provide(
    ReviewerService.use(use),
    reviewerLayer(operatorPolicy, filename),
  );
}
