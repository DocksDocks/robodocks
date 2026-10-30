import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { Effect } from "effect";
import type { Policy } from "./contracts.ts";
import {
  decodeObservation,
  integrity,
  isReference,
  observationSelect,
} from "./observations.ts";
import type { ObservationRow } from "./observations.ts";
import {
  verifySQLiteVersion,
  INITIAL_SCHEMA_SQL,
  StoreError,
  storeOperation,
} from "./storage.ts";
import { requireCondition, validatePolicy } from "./validation.ts";

const MAX_BYTES = 512 * 1024 * 1024;
const SIDECARS = ["", "-wal", "-shm", "-journal"];

function check(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new StoreError({ code, message });
}

// Recovery assumes operator-controlled local directories, not an adversarial
// process concurrently replacing ancestors. Reject aliases at the boundary.
function localPath(input: string): string {
  requireCondition(
    input.length > 0 &&
      !input.includes("\0") &&
      input !== ":memory:" &&
      !input.startsWith("file:"),
    "DATABASE_PATH",
    "Choose an explicit local file path",
  );
  const path = resolve(input);
  let ancestor = dirname(path);
  while (true) {
    const info = lstatSync(ancestor, { throwIfNoEntry: false });
    check(
      info?.isDirectory() && !info.isSymbolicLink(),
      "DATABASE_PATH",
      "Recovery requires existing regular parent directories without symlinks",
    );
    if (ancestor === parse(ancestor).root) break;
    ancestor = dirname(ancestor);
  }
  return path;
}

function sourcePath(input: string): string {
  const path = localPath(input);
  const info = lstatSync(path, { throwIfNoEntry: false });
  check(
    info?.isFile() &&
      info.nlink === 1 &&
      info.size > 0 &&
      info.size <= MAX_BYTES,
    "RECOVERY_SOURCE",
    "Recovery requires a regular non-aliased ledger no larger than 512 MiB",
  );
  for (const suffix of SIDECARS.slice(1)) {
    const sidecar = lstatSync(path + suffix, { throwIfNoEntry: false });
    check(
      !sidecar ||
        (sidecar.isFile() && sidecar.nlink === 1 && sidecar.size <= MAX_BYTES),
      "RECOVERY_SOURCE",
      "Recovery source sidecars must be regular non-aliased bounded files",
    );
  }
  return path;
}

function freshDestination(path: string): void {
  check(
    SIDECARS.every(
      (suffix) => !lstatSync(path + suffix, { throwIfNoEntry: false }),
    ),
    "RECOVERY_DESTINATION",
    "Recovery destination and sidecars must not exist",
  );
}

function schema(db: Database) {
  const bounds = db
    .query<{ count: number; maximum: number | null }, []>(
      "SELECT count(*) AS count, max(length(CAST(sql AS BLOB))) AS maximum FROM sqlite_schema",
    )
    .get()!;
  integrity(bounds.count <= 32 && (bounds.maximum ?? 0) <= 16_384);
  return db
    .query<
      { type: string; name: string; tbl_name: string; sql: string | null },
      []
    >("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name")
    .all();
}

function validateLedger(db: Database, policy: Policy) {
  verifySQLiteVersion(db);
  integrity(
    db.query<{ application_id: number }, []>("PRAGMA application_id").get()
      ?.application_id === 0x52444253,
  );
  integrity(
    db.query<{ user_version: number }, []>("PRAGMA user_version").get()
      ?.user_version === 1,
  );
  // Comparing complete SQL also rejects weakened CHECKs, substituted views,
  // extra triggers and unexpected indexes. Reference SQL is our own constant.
  const reference = new Database(":memory:");
  try {
    reference.run(INITIAL_SCHEMA_SQL);
    integrity(JSON.stringify(schema(db)) === JSON.stringify(schema(reference)));
  } finally {
    reference.close(true);
  }
  // Bound every persisted text column before materializing application rows.
  // SQLite STRICT types alone do not impose text-size limits.
  integrity(
    db
      .query(
        "SELECT 1 FROM schema_migrations WHERE length(CAST(name AS BLOB)) > 64 OR length(CAST(applied_at AS BLOB)) > 64 LIMIT 1",
      )
      .get() === null,
  );
  integrity(
    db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM schema_migrations",
      )
      .get()?.count === 1,
  );
  integrity(
    db
      .query(
        "SELECT 1 FROM deliveries WHERE length(CAST(id AS BLOB)) > 128 OR length(CAST(digest AS BLOB)) != 64 OR length(CAST(repository AS BLOB)) > 180 LIMIT 1",
      )
      .get() === null,
  );
  integrity(
    db
      .query(
        "SELECT 1 FROM findings WHERE length(CAST(id AS BLOB)) != 64 OR length(CAST(repository AS BLOB)) > 180 OR length(CAST(head_sha AS BLOB)) != 40 OR length(CAST(status AS BLOB)) > 16 LIMIT 1",
      )
      .get() === null,
  );
  integrity(
    db
      .query(
        "SELECT 1 FROM outbox WHERE length(CAST(id AS BLOB)) != 64 OR length(CAST(finding_id AS BLOB)) != 64 OR length(CAST(status AS BLOB)) > 16 OR length(CAST(external_reference AS BLOB)) > 128 LIMIT 1",
      )
      .get() === null,
  );
  const migrations = db
    .query<{ version: number; name: string; applied_at: string }, []>(
      "SELECT version, name, applied_at FROM schema_migrations",
    )
    .all();
  integrity(
    migrations.length === 1 &&
      migrations[0]?.version === 1 &&
      migrations[0]?.name === "initial-ledger" &&
      typeof migrations[0]?.applied_at === "string" &&
      migrations[0].applied_at.length > 0,
  );
  const pageCount = db
    .query<{ page_count: number }, []>("PRAGMA page_count")
    .get()!.page_count;
  const pageSize = db
    .query<{ page_size: number }, []>("PRAGMA page_size")
    .get()!.page_size;
  check(
    pageCount * pageSize <= MAX_BYTES,
    "RECOVERY_LIMIT",
    "Ledger exceeds the 512 MiB recovery bound",
  );
  const counts = {
    deliveries: db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM deliveries")
      .get()!.count,
    findings: db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM findings")
      .get()!.count,
    intents: db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM outbox")
      .get()!.count,
  };
  integrity(
    counts.deliveries <= 10_000 &&
      counts.findings <= 10_000 &&
      counts.intents === counts.findings,
  );
  integrity(
    db.query<{ integrity_check: string }, []>("PRAGMA integrity_check(1)").get()
      ?.integrity_check === "ok",
  );
  integrity(db.query("PRAGMA foreign_key_check").get() === null);
  // Admission creates a delivery together with its observations; v1 has no
  // retention path. It does not retain enough input to reconstruct each digest.
  integrity(
    db
      .query(
        "SELECT 1 FROM findings f WHERE NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.repository = f.repository) LIMIT 1",
      )
      .get() === null,
  );
  for (const row of db
    .query<{ id: string; digest: string; repository: string }, []>(
      "SELECT id, digest, repository FROM deliveries",
    )
    .iterate()) {
    integrity(isReference(row.id) && /^[a-f0-9]{64}$/.test(row.digest));
    check(
      policy.allowedRepositories.includes(row.repository),
      "NOT_ALLOWED",
      "Recovery requires policy authorization for every ledger repository",
    );
  }
  // JSON may escape each bounded finding character six-fold. 256 KiB is a
  // conservative bound above the maximum canonical serialized Finding.
  integrity(
    db
      .query(
        "SELECT 1 FROM outbox WHERE length(CAST(payload AS BLOB)) > 262144 LIMIT 1",
      )
      .get() === null,
  );
  for (const row of db.query<ObservationRow, []>(observationSelect).iterate()) {
    integrity(Number.isSafeInteger(row.sequence) && row.sequence > 0);
    check(
      policy.allowedRepositories.includes(row.repository),
      "NOT_ALLOWED",
      "Recovery requires policy authorization for every ledger repository",
    );
    decodeObservation(row);
  }
  return counts;
}

export interface RecoveryResult {
  readonly schemaVersion: 1;
  readonly operation: "backup" | "restore";
  readonly deliveries: number;
  readonly findings: number;
  readonly intents: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly cursorAction: "restart";
}

function recover(
  operation: "backup" | "restore",
  policyInput: unknown,
  source: string,
  destination: string,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const policy = yield* validatePolicy(policyInput);
      const paths = yield* storeOperation(() => {
        const input = sourcePath(source);
        const output = localPath(destination);
        check(
          !SIDECARS.some(
            (suffix) => output === input + suffix || input === output + suffix,
          ),
          "RECOVERY_DESTINATION",
          "Recovery source and destination must not overlap SQLite files",
        );
        freshDestination(output);
        return { input, output };
      });
      // Do not call the normal inspection opener: its migration-history query
      // precedes the exact schema gate and could execute a forged view.
      const db = yield* Effect.acquireRelease(
        storeOperation(
          () =>
            new Database(paths.input, {
              readonly: true,
              create: false,
              strict: true,
            }),
        ),
        (connection) => Effect.sync(() => connection.close(true)),
      );
      return yield* storeOperation((): RecoveryResult => {
        db.run("PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000");
        db.transaction(() => validateLedger(db, policy)).deferred();
        // A private sibling directory keeps partial SQLite output inaccessible and
        // on the same filesystem as the final exclusive hard-link promotion.
        const temporary = mkdtempSync(
          join(dirname(paths.output), ".robodocks-recovery-"),
        );
        const stage = join(temporary, "ledger.sqlite");
        let promoted = false;
        try {
          closeSync(openSync(stage, "wx", 0o600));
          // SQLite takes a consistent source snapshot, including committed WAL.
          // VACUUM INTO is supported on a read-only source connection.
          db.run("VACUUM INTO ?", [stage]);
          const candidate = new Database(stage, {
            readonly: true,
            create: false,
            strict: true,
          });
          let counts;
          try {
            candidate.run("PRAGMA trusted_schema = OFF");
            counts = candidate
              .transaction(() => validateLedger(candidate, policy))
              .deferred();
          } finally {
            candidate.close(true);
          }
          const file = openSync(stage, "r");
          const hash = createHash("sha256");
          let bytes = 0;
          try {
            const buffer = Buffer.alloc(64 * 1024);
            let length;
            while (
              (length = readSync(file, buffer, 0, buffer.length, null)) > 0
            ) {
              bytes += length;
              check(
                bytes <= MAX_BYTES,
                "RECOVERY_LIMIT",
                "Snapshot exceeds the 512 MiB recovery bound",
              );
              hash.update(buffer.subarray(0, length));
            }
            fsyncSync(file);
          } finally {
            closeSync(file);
          }
          const result: RecoveryResult = {
            schemaVersion: 1,
            operation,
            ...counts,
            bytes,
            sha256: hash.digest("hex"),
            cursorAction: "restart",
          };
          freshDestination(paths.output);
          linkSync(stage, paths.output); // Atomic no-replace: never rename over a file.
          promoted = true;
          const directory = openSync(dirname(paths.output), "r");
          try {
            fsyncSync(directory);
          } finally {
            closeSync(directory);
          }
          return result;
        } catch (error) {
          if (promoted)
            throw new StoreError({
              code: "RECOVERY_COMPLETION_UNKNOWN",
              message:
                "Recovery destination was created but completion could not be confirmed; inspect it before retrying with a new path",
            });
          throw error;
        } finally {
          // Never remove source/destination, even after promotion or output failure.
          // Only known paths inside the directory exclusively created by this call.
          for (const suffix of SIDECARS) {
            try {
              unlinkSync(stage + suffix);
            } catch {
              /* crash leftovers are operator-owned */
            }
          }
          try {
            rmdirSync(temporary);
          } catch {
            /* do not broaden cleanup */
          }
        }
      });
    }),
  );
}

export const backupLedger = (
  policy: unknown,
  source: string,
  destination: string,
) => recover("backup", policy, source, destination);
export const restoreLedger = (
  policy: unknown,
  source: string,
  destination: string,
) => recover("restore", policy, source, destination);
