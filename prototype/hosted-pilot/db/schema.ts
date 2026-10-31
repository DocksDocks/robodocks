import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  check,
  unique,
} from "drizzle-orm/sqlite-core";
export const control = sqliteTable(
  "native_control",
  {
    id: integer("id").primaryKey(),
    quarantined: integer("quarantined").notNull(),
  },
  (t) => [
    check("control_singleton", sql`${t.id} = 1`),
    check("control_quarantined", sql`${t.quarantined} IN (0,1)`),
  ],
);
export const findings = sqliteTable(
  "native_findings",
  { id: text("id").primaryKey(), status: text("status").notNull() },
  (t) => [
    check(
      "finding_status",
      sql`${t.status} IN ('proposed','published','closed')`,
    ),
  ],
);
export const outbox = sqliteTable(
  "native_outbox",
  {
    id: text("id").primaryKey(),
    findingId: text("finding_id")
      .notNull()
      .references(() => findings.id),
    proposal: text("proposal").notNull(),
    status: text("status").notNull(),
    externalReference: text("external_reference"),
  },
  (t) => [
    unique("outbox_finding").on(t.findingId),
    check("outbox_json", sql`json_valid(${t.proposal})`),
    check("outbox_status", sql`${t.status} IN ('pending','acknowledged')`),
    check(
      "outbox_reference",
      sql`(${t.status} = 'pending' AND ${t.externalReference} IS NULL) OR (${t.status} = 'acknowledged' AND ${t.externalReference} IS NOT NULL)`,
    ),
  ],
);
export const attempts = sqliteTable(
  "native_attempts",
  {
    intentId: text("intent_id")
      .primaryKey()
      .references(() => outbox.id),
    proposal: text("proposal").notNull(),
    status: text("status").notNull(),
    commentId: integer("comment_id"),
  },
  (t) => [
    check("attempt_json", sql`json_valid(${t.proposal})`),
    check(
      "attempt_status",
      sql`${t.status} IN ('sending','unknown','acknowledged')`,
    ),
    check("positive_comment", sql`${t.commentId} > 0`),
    check(
      "attempt_reference",
      sql`(${t.status} = 'acknowledged' AND ${t.commentId} IS NOT NULL) OR (${t.status} IN ('sending','unknown') AND ${t.commentId} IS NULL)`,
    ),
  ],
);
export const guard = sqliteTable(
  "native_transition_guard",
  { id: integer("id") },
  (t) => [check("impossible_transition_guard", sql`${t.id} = 1`)],
);
export const evidence = sqliteTable(
  "pilot_evidence",
  { name: text("name").primaryKey(), evidence: text("evidence").notNull() },
  (t) => [check("evidence_json", sql`json_valid(${t.evidence})`)],
);
