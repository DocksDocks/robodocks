import { Effect, Schema } from "effect";
import { InspectionCursorSchema, InspectionSchema } from "./contracts.ts";
import type { InspectionRequest } from "./contracts.ts";
import {
  decodeObservation,
  integrity,
  observationSelect,
} from "./observations.ts";
import type { Observation, ObservationRow } from "./observations.ts";
import { acquireReadOnlyStore, storeOperation } from "./storage.ts";
import {
  ContractError,
  requireCondition,
  validatePolicy,
} from "./validation.ts";

export interface InspectionPage {
  schemaVersion: 1;
  operation: "inspect";
  repository: string;
  status: InspectionRequest["status"];
  items: Observation[];
  nextCursor: string | null;
}

function decodeCursor(query: InspectionRequest) {
  if (query.cursor === undefined) return undefined;
  try {
    const encoded = Buffer.from(query.cursor, "base64url");
    requireCondition(
      encoded.toString("base64url") === query.cursor,
      "CURSOR",
      "Cursor encoding must be canonical base64url",
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    const cursor = Schema.decodeUnknownSync(InspectionCursorSchema, {
      onExcessProperty: "error",
    })(JSON.parse(text));
    requireCondition(
      cursor.repository === query.repository && cursor.status === query.status,
      "CURSOR",
      "Cursor does not match this inspection query",
    );
    return cursor;
  } catch {
    throw new ContractError(
      "CURSOR",
      "Cursor is invalid or belongs to another inspection query",
    );
  }
}

/** Inspect existing ledger data without admitting a delivery or initializing storage. */
export function inspectLedger(
  operatorPolicy: unknown,
  filename: string,
  input: unknown,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const policy = yield* validatePolicy(operatorPolicy);
      const query = yield* Schema.decodeUnknownEffect(InspectionSchema, {
        onExcessProperty: "error",
      })(input).pipe(
        Effect.mapError(
          () =>
            new ContractError(
              "INSPECTION",
              "Inspection requires a repository, valid status, and limit from 1 to 100",
            ),
        ),
      );
      const cursor = yield* storeOperation(() => {
        requireCondition(
          policy.allowedRepositories.includes(query.repository),
          "NOT_ALLOWED",
          "repository is not explicitly allowed by the operator policy",
        );
        return decodeCursor(query);
      });
      const db = yield* acquireReadOnlyStore(filename);
      return yield* storeOperation((): InspectionPage => {
        const page = db
          .transaction(() => {
            if (cursor) {
              const anchor = db
                .query<{ id: string }, [number, string]>(
                  "SELECT id FROM findings WHERE rowid = ? AND repository = ?",
                )
                .get(cursor.after, query.repository);
              requireCondition(
                anchor?.id === cursor.afterId,
                "CURSOR",
                "Cursor does not match this ledger; restart inspection",
              );
            }
            const through =
              cursor?.through ??
              db
                .query<{ through: number }, [string]>(
                  "SELECT coalesce(max(rowid), 0) AS through FROM findings WHERE repository = ?",
                )
                .get(query.repository)?.through ??
              0;
            integrity(Number.isSafeInteger(through) && through >= 0);
            const rows = db
              .query<
                ObservationRow,
                [string, string, string, number, number, number]
              >(
                observationSelect +
                  " WHERE f.repository = ? AND (? = 'all' OR f.status = ?)" +
                  " AND f.rowid > ? AND f.rowid <= ? ORDER BY f.rowid LIMIT ?",
              )
              .all(
                query.repository,
                query.status,
                query.status,
                cursor?.after ?? 0,
                through,
                query.limit + 1,
              );
            return { rows, through };
          })
          .deferred();
        const selected = page.rows.slice(0, query.limit);
        const items = selected.map(decodeObservation);
        const last = selected.at(-1);
        let nextCursor: string | null = null;
        if (page.rows.length > query.limit && last) {
          integrity(
            Number.isSafeInteger(last.sequence) &&
              last.sequence > 0 &&
              last.sequence < page.through,
          );
          nextCursor = Buffer.from(
            JSON.stringify({
              version: 1,
              repository: query.repository,
              status: query.status,
              after: last.sequence,
              afterId: last.findingId,
              through: page.through,
            }),
          ).toString("base64url");
        }
        return {
          schemaVersion: 1,
          operation: "inspect",
          repository: query.repository,
          status: query.status,
          items,
          nextCursor,
        };
      });
    }),
  );
}
