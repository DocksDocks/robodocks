/** Experimental storage only: no HTTP handler, credentials, grant or sender.
 * Pass the direct D1 binding, not a read-replica session. Never infer permission
 * to POST from a stored attempt, from read(), or from retrying a lost result.
 */
export interface Statement {
  bind(...values: (string | number | null)[]): Statement;
}
export interface Result {
  success: boolean;
  meta: { changes: number };
  results: Record<string, unknown>[];
}
export interface PrimaryD1 {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<Result[]>;
}
export interface Proposal {
  intentId: string;
  repository: string;
  repositoryId: number;
  pullRequest: number;
  pullRequestId: number;
  headSha: string;
  appId: number;
  installationId: number;
  botUserId: number;
  body: string;
  bodyDigest: string;
  rendererVersion: string;
}
export interface PositiveComment {
  commentId: number;
  repositoryId: number;
  pullRequestId: number;
  issueUrl: string;
  botUserId: number;
  authorType: string;
  body: string;
}
export class NativeStorageError extends Error {
  constructor(readonly code: "INPUT" | "STORAGE_UNCERTAIN") {
    super(code);
  }
}
function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Canonical exact binding; this validates storage shape, not review authority. */
export async function proposalKey(input: Proposal): Promise<string> {
  // Copy before awaiting Web Crypto: callers cannot race a mutable input.
  const p = { ...input };
  if (
    typeof p.repository !== "string" ||
    p.repository.length > 201 ||
    !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(p.repository) ||
    typeof p.intentId !== "string" ||
    p.intentId.length === 0 ||
    p.intentId.length > 256 ||
    ![
      p.repositoryId,
      p.pullRequest,
      p.pullRequestId,
      p.appId,
      p.installationId,
      p.botUserId,
    ].every(positive) ||
    typeof p.headSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(p.headSha) ||
    typeof p.body !== "string" ||
    new TextEncoder().encode(p.body).length > 65536 ||
    typeof p.bodyDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(p.bodyDigest) ||
    p.rendererVersion !== "pr-conversation-published-v1"
  )
    throw new NativeStorageError("INPUT");
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(p.body),
  );
  const digest = Array.from(new Uint8Array(hash), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== p.bodyDigest) throw new NativeStorageError("INPUT");
  return JSON.stringify([
    p.intentId,
    p.repository,
    p.repositoryId,
    p.pullRequest,
    p.pullRequestId,
    p.headSha,
    p.appId,
    p.installationId,
    p.botUserId,
    p.body,
    p.bodyDigest,
    p.rendererVersion,
  ]);
}

export class NativePublicationStore {
  constructor(private readonly db: PrimaryD1) {}

  private async execute(statements: Statement[]): Promise<Result[]> {
    try {
      const result = await this.db.batch(statements);
      if (result.length !== statements.length || result.some((r) => !r.success))
        throw new Error("D1 result");
      return result;
    } catch {
      // A transport failure may follow a commit; do not classify it as rollback.
      throw new NativeStorageError("STORAGE_UNCERTAIN");
    }
  }

  /** true only for this call's confirmed insertion, never for an existing row.
   * This is NOT authorization to publish; no publisher is wired to this class.
   * Reservations never expire. No delete/retry/release/unquarantine operation.
   */
  async reserve(input: Proposal): Promise<boolean> {
    const p = { ...input };
    const key = await proposalKey(p);
    const result = await this.execute([
      this.db
        .prepare(
          `
      INSERT INTO native_attempts (intent_id, proposal, status, comment_id)
      SELECT o.id, o.proposal, 'sending', NULL FROM native_outbox o
      JOIN native_findings f ON f.id = o.finding_id
      WHERE o.id = ? AND o.proposal = ? AND o.status = 'pending'
        AND f.status = 'proposed'
        AND EXISTS (SELECT 1 FROM native_control WHERE id = 1 AND quarantined = 0)
      ON CONFLICT(intent_id) DO NOTHING
    `,
        )
        .bind(p.intentId, key),
    ]);
    return result[0]?.meta.changes === 1;
  }

  async markUnknown(input: Proposal): Promise<boolean> {
    const p = { ...input };
    const key = await proposalKey(p);
    const result = await this.execute([
      this.db
        .prepare(
          `
      UPDATE native_attempts SET status = 'unknown'
      WHERE intent_id = ? AND proposal = ? AND status = 'sending'
    `,
        )
        .bind(p.intentId, key),
    ]);
    return result[0]?.meta.changes === 1;
  }

  /** Caller must acquire authentic, unique positive evidence. This exact check
   * cannot authenticate arbitrary JSON or prove a paginated lookup is complete.
   * Idempotent repeats return false; differing acknowledgements cannot replace it.
   */
  async acknowledge(
    input: Proposal,
    evidence: PositiveComment,
  ): Promise<boolean> {
    const p = { ...input };
    const e = { ...evidence };
    const key = await proposalKey(p);
    if (
      !positive(e.commentId) ||
      e.repositoryId !== p.repositoryId ||
      e.pullRequestId !== p.pullRequestId ||
      e.botUserId !== p.botUserId ||
      e.authorType !== "Bot" ||
      e.body !== p.body ||
      e.issueUrl !==
        `https://api.github.com/repos/${p.repository}/issues/${p.pullRequest}`
    )
      throw new NativeStorageError("INPUT");
    const reference = `github-comment:${e.commentId}`;
    const result = await this.execute([
      this.db
        .prepare(
          `UPDATE native_attempts SET status = 'acknowledged', comment_id = ?
        WHERE intent_id = ? AND proposal = ? AND status IN ('sending', 'unknown')
        AND EXISTS (SELECT 1 FROM native_outbox o JOIN native_findings f ON f.id = o.finding_id
          WHERE o.id = native_attempts.intent_id AND o.proposal = native_attempts.proposal
          AND o.status = 'pending' AND f.status = 'proposed')`,
        )
        .bind(e.commentId, p.intentId, key),
      this.db
        .prepare(
          `UPDATE native_outbox SET status = 'acknowledged', external_reference = ?
        WHERE id = ? AND status = 'pending' AND changes() = 1`,
        )
        .bind(reference, p.intentId),
      this.db
        .prepare(
          `UPDATE native_findings SET status = 'published'
        WHERE id = (SELECT finding_id FROM native_outbox WHERE id = ?)
        AND status = 'proposed' AND changes() = 1`,
        )
        .bind(p.intentId),
      this.db
        .prepare(
          `INSERT INTO native_transition_guard (id)
        SELECT 0 WHERE EXISTS (SELECT 1 FROM native_attempts a
          WHERE a.intent_id = ? AND a.status = 'acknowledged'
          AND NOT EXISTS (SELECT 1 FROM native_outbox o JOIN native_findings f ON f.id = o.finding_id
            WHERE o.id = a.intent_id AND o.proposal = a.proposal
              AND o.status = 'acknowledged'
              AND o.external_reference = 'github-comment:' || a.comment_id
              AND f.status = 'published'))`,
        )
        .bind(p.intentId),
    ]);
    return result[0]?.meta.changes === 1;
  }

  /** Metadata only, never a send grant. Direct primary binding required. */
  async read(intentId: string): Promise<Record<string, unknown> | null> {
    if (typeof intentId !== "string" || !intentId || intentId.length > 256)
      throw new NativeStorageError("INPUT");
    const result = await this.execute([
      this.db
        .prepare(
          "SELECT intent_id, status, comment_id FROM native_attempts WHERE intent_id = ?",
        )
        .bind(intentId),
    ]);
    return result[0]?.results[0] ?? null;
  }
}
