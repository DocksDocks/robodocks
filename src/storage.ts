import { Database, SQLiteError } from "bun:sqlite";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { Data, Effect } from "effect";
import { ContractError, requireCondition } from "./validation.ts";

const APPLICATION_ID = 0x52444253;
const SCHEMA_VERSION = 1;

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
                "Reviewer storage is busy; retry the same delivery after the writer finishes",
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
      "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
    )
    .all();
  ensure(
    application === APPLICATION_ID ||
      (application === 0 && version === 0 && tables.length === 0),
    "DATABASE_OWNER",
    "Database is not an initialized Robodocks ledger or an empty database",
  );
  ensure(
    version === 0 || version === SCHEMA_VERSION,
    "DATABASE_VERSION",
    "Database schema version is unsupported; no migration was attempted",
  );
  ensure(
    version !== 0 || tables.length === 0,
    "DATABASE_VERSION",
    "Unrecognized pre-migration database contents",
  );
  if (version === SCHEMA_VERSION) {
    const requiredObjects = [
      "schema_migrations",
      "deliveries",
      "findings",
      "outbox",
      "deliveries_repository",
      "findings_repository",
    ];
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
      migrations.length === 1 &&
        migrations[0]?.version === SCHEMA_VERSION &&
        migrations[0]?.name === "initial-ledger",
      "DATABASE_VERSION",
      "Database migration history is unsupported or inconsistent",
    );
  }
  return version;
}

function initialize(db: Database): StorageDiagnostics {
  // Reject foreign/newer databases BEFORE changing persistent journal settings.
  db.run("PRAGMA busy_timeout = 5000");
  db.transaction(() => ownership(db)).deferred();
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
    if (ownership(db) === SCHEMA_VERSION) return;
    db.run(`
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
    `);
  }).immediate();
  return {
    sqliteVersion,
    schemaVersion: SCHEMA_VERSION,
    journalMode,
    synchronous,
    foreignKeys,
    busyTimeoutMs,
  };
}

export function acquireStore(filename: string) {
  return Effect.acquireRelease(
    storeOperation(() => {
      requireCondition(
        filename.length > 0 &&
          !filename.includes("\0") &&
          filename !== ":memory:" &&
          !filename.startsWith("file:"),
        "DATABASE_PATH",
        "Choose an explicit local database file, not a memory database or URI",
      );
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
