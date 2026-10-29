import type { Database } from "bun:sqlite";
import { Context, Effect, Layer } from "effect";
import type {
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

import {
  hash,
  findingId,
  integrity,
  isReference,
  decodeObservation,
  observationSelect,
} from "./observations.ts";
import type { Observation, ObservationRow } from "./observations.ts";

type ReviewError = ContractError | StoreError;
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

function makeReviewer(
  policy: Policy,
  db: Database,
  diagnostics: StorageDiagnostics,
): Reviewer {
  // Only placeholder syntax is constructed; repository values are always bound.
  const repositoryPlaceholders = policy.allowedRepositories
    .map(() => "?")
    .join(", ");
  function allowed(repository: string): void {
    requireCondition(
      policy.allowedRepositories.includes(repository),
      "NOT_ALLOWED",
      "repository is not explicitly allowed by the operator policy",
    );
  }
  function byFinding(
    id: string,
    expectedRepository?: string,
  ): Observation | undefined {
    const metadata = db
      .query<{ repository: string }, [string]>(
        "SELECT repository FROM findings WHERE id = ?",
      )
      .get(id);
    if (!metadata) return undefined;
    if (expectedRepository !== undefined)
      integrity(metadata.repository === expectedRepository);
    allowed(metadata.repository);
    const row = db
      .query<ObservationRow, [string]>(observationSelect + " WHERE f.id = ?")
      .get(id);
    integrity(row);
    return decodeObservation(row);
  }

  return {
    storage: Object.freeze({ ...diagnostics }),
    plan(input) {
      return validateRequest(input, policy).pipe(
        Effect.flatMap((request) =>
          storeOperation(() => {
            // Validation owns this copy; hashing needs no database lock.
            const digest = hash(request);
            return db
              .transaction((): ReviewPlan => {
                const previous = db
                  .query<{ digest: string; repository: string }, [string]>(
                    "SELECT digest, repository FROM deliveries WHERE id = ?",
                  )
                  .get(request.deliveryId);
                if (previous) {
                  requireCondition(
                    previous.digest === digest,
                    "DELIVERY_CONFLICT",
                    "delivery ID was already used for a different request",
                  );
                  integrity(previous.repository === request.context.repository);
                  for (const finding of request.findings)
                    integrity(
                      byFinding(findingId(finding), finding.repository),
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
                let findings =
                  db
                    .query<{ count: number }, []>(
                      "SELECT count(*) AS count FROM findings",
                    )
                    .get()?.count ?? 0;
                requireCondition(
                  deliveries < 10_000,
                  "LEDGER_FULL",
                  "Ledger delivery capacity reached; archive with an operator-reviewed retention policy",
                );
                const intents: PublicationIntent[] = [];
                const suppressedFindingIds: string[] = [];
                for (const finding of request.findings) {
                  const id = findingId(finding);
                  if (byFinding(id, finding.repository)) {
                    suppressedFindingIds.push(id);
                    continue;
                  }
                  // Only newly inserted unique observations consume finding capacity.
                  // Any later overflow rolls back the entire batch, including prior inserts.
                  requireCondition(
                    findings < 10_000,
                    "LEDGER_FULL",
                    "Ledger finding capacity reached; archive with an operator-reviewed retention policy",
                  );
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
                  findings += 1;
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
              .immediate();
          }),
        ),
      );
    },
    recordPublication(intentId, externalReference) {
      return storeOperation(() =>
        db
          .transaction(() => {
            const metadata = db
              .query<{ repository: string }, [string]>(
                "SELECT f.repository FROM findings f JOIN outbox o ON o.finding_id = f.id WHERE o.id = ?",
              )
              .get(intentId);
            requireCondition(
              metadata,
              "UNKNOWN_INTENT",
              "publication acknowledgement requires a known intent",
            );
            allowed(metadata.repository);
            const row = db
              .query<ObservationRow, [string]>(
                observationSelect + " WHERE o.id = ?",
              )
              .get(intentId);
            integrity(row);
            const observation = decodeObservation(row);
            allowed(observation.record.repository);
            requireCondition(
              isReference(externalReference),
              "REFERENCE",
              "externalReference must be a bounded identifier",
            );
            if (observation.intent.status === "acknowledged") {
              requireCondition(
                observation.intent.externalReference === externalReference,
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
            ).run(observation.record.id);
          })
          .immediate(),
      );
    },
    recordFindingClosed(id) {
      return storeOperation(() =>
        db
          .transaction(() => {
            const observation = byFinding(id);
            requireCondition(
              observation,
              "INVALID_TRANSITION",
              "only an acknowledged finding can be marked closed",
            );
            allowed(observation.record.repository);
            requireCondition(
              observation.record.status !== "proposed",
              "INVALID_TRANSITION",
              "only an acknowledged finding can be marked closed",
            );
            db.query("UPDATE findings SET status = 'closed' WHERE id = ?").run(
              id,
            );
          })
          .immediate(),
      );
    },
    snapshot() {
      return storeOperation(() => {
        const rows = db
          .transaction(() => {
            const observations = db
              .query<ObservationRow, string[]>(
                observationSelect +
                  " WHERE f.repository IN (" +
                  repositoryPlaceholders +
                  ") ORDER BY f.rowid",
              )
              .all(...policy.allowedRepositories);
            const deliveries = db
              .query<{ id: string; digest: string }, string[]>(
                "SELECT id, digest FROM deliveries WHERE repository IN (" +
                  repositoryPlaceholders +
                  ") ORDER BY rowid",
              )
              .all(...policy.allowedRepositories);
            // Materialize both result sets under the same read snapshot.
            return { observations, deliveries };
          })
          .deferred();
        // Decode owned rows after releasing the read transaction, but keep
        // parsing, schema, and integrity failures within storeOperation.
        const observations = rows.observations.map(decodeObservation);
        return {
          schemaVersion: 1,
          deliveries: rows.deliveries,
          findings: observations.map((item) => item.record),
          outbox: observations.map((item) => item.intent),
        } satisfies Snapshot;
      });
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
