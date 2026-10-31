import { Database, SQLiteError } from "bun:sqlite";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Data, Effect } from "effect";
import { ContractError, requireCondition } from "./validation.ts";

const APPLICATION_ID = 0x52444253;
const SCHEMA_VERSION = 1;
const PUBLICATION_SCHEMA_VERSION = 2;

// Shared canonical v1 DDL: recovery compares against a trusted in-memory reference.
export const INITIAL_SCHEMA_SQL = `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        repository TEXT NOT NULL
      ) STRICT;
      CREATE TABLE findings (
        id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        pull_request INTEGER NOT NULL CHECK (pull_request > 0),
        head_sha TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed', 'published', 'closed'))
      ) STRICT;
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        finding_id TEXT NOT NULL UNIQUE REFERENCES findings(id),
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged')),
        external_reference TEXT,
        CHECK ((status = 'pending' AND external_reference IS NULL) OR
               (status = 'acknowledged' AND external_reference IS NOT NULL))
      ) STRICT;
      CREATE INDEX deliveries_repository ON deliveries(repository);
      CREATE INDEX findings_repository ON findings(repository);
      PRAGMA application_id = ${APPLICATION_ID};
      PRAGMA user_version = ${SCHEMA_VERSION};
      INSERT INTO schema_migrations (version, name) VALUES (1, 'initial-ledger');
    `;

// Explicit opt-in migration only; ordinary writer initialization remains v1.
export const PUBLICATION_SCHEMA_SQL = `
  CREATE TABLE publication_attempts (
    intent_id TEXT PRIMARY KEY REFERENCES outbox(id),
    repository TEXT NOT NULL,
    repository_id INTEGER NOT NULL CHECK (repository_id > 0),
    pull_request_id INTEGER NOT NULL CHECK (pull_request_id > 0),
    pull_request INTEGER NOT NULL CHECK (pull_request > 0),
    head_sha TEXT NOT NULL,
    app_id INTEGER NOT NULL CHECK (app_id > 0),
    installation_id INTEGER NOT NULL CHECK (installation_id > 0),
    bot_user_id INTEGER NOT NULL CHECK (bot_user_id > 0),
    body TEXT NOT NULL,
    body_digest TEXT NOT NULL,
    renderer_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('sending', 'unknown', 'acknowledged')),
    comment_id INTEGER CHECK (comment_id > 0),
    CHECK ((status = 'acknowledged' AND comment_id IS NOT NULL) OR
           (status IN ('sending', 'unknown') AND comment_id IS NULL))
  ) STRICT;
  CREATE TABLE publication_control (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    restored INTEGER NOT NULL CHECK (restored IN (0, 1))
  ) STRICT;
  INSERT INTO publication_control (id, restored) VALUES (1, 0);
  INSERT INTO schema_migrations (version, name) VALUES (2, 'publication-attempts');
  PRAGMA user_version = 2;
`;

export class StoreError extends Data.TaggedError("StoreError")<{
  readonly code: string;
  readonly message: string;
}> {}

export interface StorageDiagnostics {
  sqliteVersion: string;
  schemaVersion: number;
  journalMode: string;
  synchronous: number;
  foreignKeys: number;
  busyTimeoutMs: number;
}

export function storeOperation<A>(
  evaluate: () => A,
): Effect.Effect<A, StoreError | ContractError> {
  return Effect.try({
    try: evaluate,
    catch: (error) =>
      error instanceof StoreError || error instanceof ContractError
        ? error
        : error instanceof SQLiteError && (error.errno & 0xff) === 5
          ? new StoreError({
              code: "STORAGE_BUSY",
              message:
                "Reviewer storage is busy; retry the same operation after the writer finishes",
            })
          : new StoreError({
              code: "STORAGE",
              message: "Reviewer storage operation failed",
            }),
  });
}

function ensure(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new StoreError({ code, message });
}

function ownership(db: Database): number {
  const application = db
    .query<{ application_id: number }, []>("PRAGMA application_id")
    .get()?.application_id;
  const version = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()?.user_version;
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'",
    )
    .all();
  ensure(
    application === APPLICATION_ID ||
      (application === 0 && version === 0 && tables.length === 0),
    "DATABASE_OWNER",
    "Database is not an initialized Robodocks ledger or an empty database",
  );
  ensure(
    version === 0 ||
      version === SCHEMA_VERSION ||
      version === PUBLICATION_SCHEMA_VERSION,
    "DATABASE_VERSION",
    "Database schema version is unsupported; no migration was attempted",
  );
  ensure(
    version !== 0 || tables.length === 0,
    "DATABASE_VERSION",
    "Unrecognized pre-migration database contents",
  );
  if (version === SCHEMA_VERSION || version === PUBLICATION_SCHEMA_VERSION) {
    const requiredObjects = [
      "schema_migrations",
      "deliveries",
      "findings",
      "outbox",
      "deliveries_repository",
      "findings_repository",
    ];
    if (version === PUBLICATION_SCHEMA_VERSION)
      requiredObjects.push("publication_attempts", "publication_control");
    ensure(
      requiredObjects.every((name) =>
        tables.some((object) => object.name === name),
      ),
      "DATABASE_VERSION",
      "Ledger schema is incomplete or incompatible with schema version one",
    );
    const migrations = db
      .query<{ version: number; name: string }, []>(
        "SELECT version, name FROM schema_migrations ORDER BY version",
      )
      .all();
    ensure(
      migrations.length === version &&
        migrations[0]?.version === SCHEMA_VERSION &&
        migrations[0]?.name === "initial-ledger" &&
        (version === 1 ||
          (migrations[1]?.version === 2 &&
            migrations[1]?.name === "publication-attempts")),
      "DATABASE_VERSION",
      "Database migration history is unsupported or inconsistent",
    );
  }
  return version;
}

export function verifySQLiteVersion(db: Database): string {
  const sqliteVersion = db
    .query<{ version: string }, []>("SELECT sqlite_version() AS version")
    .get()?.version;
  ensure(
    sqliteVersion,
    "SQLITE_VERSION",
    "Could not determine the SQLite version",
  );
  const [major = 0, minor = 0, patch = 0] = sqliteVersion
    .split(".")
    .map(Number);
  ensure(
    major > 3 || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3))),
    "SQLITE_VERSION",
    "SQLite 3.51.3 or newer is required for this WAL-backed ledger",
  );
  return sqliteVersion;
}

function initialize(db: Database): StorageDiagnostics {
  // Reject foreign/newer databases BEFORE changing persistent journal settings.
  db.run("PRAGMA busy_timeout = 5000");
  db.transaction(() => ownership(db)).deferred();
  const sqliteVersion = verifySQLiteVersion(db);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = FULL");
  db.run("PRAGMA foreign_keys = ON");
  const journalMode = db
    .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
    .get()?.journal_mode;
  const synchronous = db
    .query<{ synchronous: number }, []>("PRAGMA synchronous")
    .get()?.synchronous;
  const foreignKeys = db
    .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
    .get()?.foreign_keys;
  const busyTimeoutMs = db
    .query<{ timeout: number }, []>("PRAGMA busy_timeout")
    .get()?.timeout;
  ensure(
    journalMode === "wal" &&
      synchronous === 2 &&
      foreignKeys === 1 &&
      busyTimeoutMs === 5000,
    "DATABASE_SETTINGS",
    "Required SQLite durability and integrity settings could not be enabled",
  );
  db.transaction(() => {
    if (ownership(db) !== 0) return;
    db.run(INITIAL_SCHEMA_SQL);
  }).immediate();
  return {
    sqliteVersion,
    schemaVersion: ownership(db),
    journalMode,
    synchronous,
    foreignKeys,
    busyTimeoutMs,
  };
}

function validateDatabasePath(filename: string): void {
  requireCondition(
    filename.length > 0 &&
      !filename.includes("\0") &&
      filename !== ":memory:" &&
      !filename.startsWith("file:"),
    "DATABASE_PATH",
    "Choose an explicit local database file, not a memory database or URI",
  );
}

export function acquireReadOnlyStore(filename: string) {
  return Effect.acquireRelease(
    storeOperation(() => {
      validateDatabasePath(filename);
      ensure(
        statSync(filename, { throwIfNoEntry: false })?.isFile(),
        "DATABASE_PATH",
        "Inspection requires an existing regular ledger file",
      );
      return new Database(filename, {
        readonly: true,
        create: false,
        strict: true,
      });
    }),
    (db) => Effect.sync(() => db.close(true)),
  ).pipe(
    Effect.tap((db) =>
      storeOperation(() => {
        // Connection-local only. Never run writable initialization or migration here.
        db.run("PRAGMA busy_timeout = 5000");
        db.transaction(() => {
          ensure(
            ownership(db) !== 0,
            "DATABASE_VERSION",
            "Inspection requires an initialized ledger",
          );
          verifySQLiteVersion(db);
        }).deferred();
      }),
    ),
  );
}

export function acquireStore(filename: string) {
  return Effect.acquireRelease(
    storeOperation(() => {
      validateDatabasePath(filename);
      mkdirSync(dirname(filename), { recursive: true });
      try {
        closeSync(openSync(filename, "ax", 0o600));
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
      }
      return new Database(filename, { strict: true });
    }),
    (db) => Effect.sync(() => db.close(true)),
  ).pipe(
    Effect.flatMap((db) =>
      storeOperation(() => ({ db, diagnostics: initialize(db) })),
    ),
  );
}

/** Explicit additive opt-in. Never called by inspection, preview or recovery. */
export function migratePublicationLedger(filename: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      // Check existence and ownership read-only before the writable opener.
      yield* Effect.scoped(acquireReadOnlyStore(filename));
      const { db } = yield* acquireStore(filename);
      return yield* storeOperation(() =>
        db
          .transaction(() => {
            const version = ownership(db);
            const reference = new Database(":memory:");
            try {
              reference.run(INITIAL_SCHEMA_SQL);
              if (version === 2) reference.run(PUBLICATION_SCHEMA_SQL);
              const sql =
                "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name";
              ensure(
                JSON.stringify(db.query(sql).all()) ===
                  JSON.stringify(reference.query(sql).all()),
                "DATABASE_VERSION",
                "Migration requires the exact supported ledger schema",
              );
            } finally {
              reference.close(true);
            }
            if (version === 1) {
              db.run(PUBLICATION_SCHEMA_SQL);
              db.run(
                "UPDATE publication_control SET restored = 1 WHERE id = 1",
              );
            }
            return { schemaVersion: 2 as const, migrated: version === 1 };
          })
          .immediate(),
      );
    }),
  );
}

/** New authoritative ledger only. Existing ledgers require quarantined migration. */
export function initializePublicationLedger(filename: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* storeOperation(() => {
        validateDatabasePath(filename);
        // Exclusive creation, not a check-then-open overwrite of an existing ledger.
        closeSync(openSync(filename, "ax", 0o600));
      });
      const { db } = yield* acquireStore(filename);
      return yield* storeOperation(() =>
        db
          .transaction(() => {
            ensure(
              ownership(db) === 1,
              "DATABASE_VERSION",
              "Expected a newly initialized ledger",
            );
            db.run(PUBLICATION_SCHEMA_SQL);
            return { schemaVersion: 2 as const };
          })
          .immediate(),
      );
    }),
  );
}
