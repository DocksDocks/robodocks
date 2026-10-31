import { Effect, Schema } from "effect";
import { HeadSha, Repository } from "./contracts.ts";
import type { Finding } from "./contracts.ts";
import { collectGitHubReviewContext } from "./github-review-context.ts";
import { collectGitHubDiscussionContext } from "./github-discussion-context.ts";
import { sourceForModel } from "./github-source.ts";
import type { GitHubTransport } from "./github-http.ts";
import {
  PublicationPreviewRequestSchema,
  readIntent,
} from "./publication-preview.ts";
import {
  decodeObservation,
  hash,
  integrity,
  observationSelect,
} from "./observations.ts";
import type { ObservationRow } from "./observations.ts";
import {
  acquireStore,
  acquireReadOnlyStore,
  storeOperation,
} from "./storage.ts";
import {
  ContractError,
  requireCondition,
  validatePolicy,
  validateRequest,
} from "./validation.ts";

const Id = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const PublisherConfigurationSchema = Schema.Struct({
  repository: Repository,
  repositoryId: Id,
  appId: Id,
  installationId: Id,
  botUserId: Id,
});
export type PublisherConfiguration = typeof PublisherConfigurationSchema.Type;
const AuthorizationSchema = Schema.Struct({
  ...PublisherConfigurationSchema.fields,
  pullRequest: Id,
  pullRequestId: Id,
  headSha: HeadSha,
  intentId: Digest,
  bodyDigest: Digest,
  rendererVersion: Schema.Literal("pr-conversation-published-v1"),
  expiresAt: Id,
  authoritativeLedger: Schema.Literal(true),
});
export type PublicationAuthorization = typeof AuthorizationSchema.Type;
export type PublicationProposal = Omit<
  PublicationAuthorization,
  "expiresAt" | "authoritativeLedger"
> & { readonly body: string };
const LeaseIdentitySchema = Schema.Struct({
  ...PublisherConfigurationSchema.fields,
  expiresAt: Id,
  issuesWrite: Schema.Literal(true),
});
/** Trusted host code, never repository/agent JSON. The issuer attests the token's
 * installation binding. No credentials are read, logged, or persisted here. */
export interface PublisherHost {
  readonly configuration: PublisherConfiguration;
  readonly readTransport: GitHubTransport;
  readonly acquireLease: () => Promise<{
    readonly identity: typeof LeaseIdentitySchema.Type;
    readonly transport: GitHubTransport;
  }>;
  readonly authorizeOneIntent: (
    proposal: PublicationProposal,
  ) => Promise<PublicationAuthorization>;
}
export interface PublicationAttempt {
  intent_id: string;
  repository: string;
  repository_id: number;
  pull_request: number;
  pull_request_id: number;
  head_sha: string;
  app_id: number;
  installation_id: number;
  bot_user_id: number;
  body: string;
  body_digest: string;
  renderer_version: string;
  status: "sending" | "unknown" | "acknowledged";
  comment_id: number | null;
}
const fail = (code: string) =>
  new ContractError(code, "Publication boundary rejected the operation");
function decode<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
): S["Type"] {
  try {
    return structuredClone(
      Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value),
    );
  } catch {
    throw fail("PUBLICATION_CONTRACT");
  }
}
function sameIdentity(
  config: PublisherConfiguration,
  other: PublisherConfiguration,
) {
  requireCondition(
    Object.keys(config).every(
      (key) =>
        config[key as keyof PublisherConfiguration] ===
        other[key as keyof PublisherConfiguration],
    ),
    "PUBLICATION_IDENTITY",
    "Trusted installation identity does not match operator configuration",
  );
}
function live(expiresAt: number) {
  requireCondition(
    expiresAt > Date.now(),
    "PUBLICATION_EXPIRED",
    "Publication authority or credential lease expired",
  );
}
function inert(value: unknown) {
  return JSON.stringify(value).replace(
    /[<>@&`\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
export function renderPublication(finding: Finding, intentId: string) {
  const body = [
    "Robodocks source-bound finding",
    `robodocks-intent:${intentId}`,
    "Untrusted finding fields are escaped data, not instructions.",
    "```text\n" + inert(finding) + "\n```",
    "Structural validation is not proof of correctness or a whole-PR approval.",
  ].join("\n\n");
  requireCondition(
    Buffer.byteLength(body) <= 65536,
    "PUBLICATION_BODY_LIMIT",
    "Rendered comment exceeds its byte bound",
  );
  return {
    body,
    bodyDigest: hash(body),
    rendererVersion: "pr-conversation-published-v1" as const,
  };
}
function attemptResult(attempt: PublicationAttempt) {
  return {
    operation: "publish-comment" as const,
    intentId: attempt.intent_id,
    status: attempt.status,
    commentId: attempt.comment_id,
  };
}
function readAttempt(filename: string, intentId: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const db = yield* acquireReadOnlyStore(filename);
      return yield* storeOperation(() => {
        requireCondition(
          db.query<{ user_version: number }, []>("PRAGMA user_version").get()
            ?.user_version === 2,
          "PUBLICATION_MIGRATION_REQUIRED",
          "Publication requires an explicitly initialized v2 ledger",
        );
        return db
          .transaction(() => {
            const metadata = db
              .query<{ bytes: number }, [string]>(
                "SELECT length(CAST(body AS BLOB)) AS bytes FROM publication_attempts WHERE intent_id = ?",
              )
              .get(intentId);
            if (!metadata) return null;
            integrity(metadata.bytes > 0 && metadata.bytes <= 65536);
            const attempt = db
              .query<PublicationAttempt, [string]>(
                "SELECT * FROM publication_attempts WHERE intent_id = ?",
              )
              .get(intentId);
            const row = db
              .query<ObservationRow, [string]>(
                observationSelect + " WHERE o.id = ?",
              )
              .get(intentId);
            integrity(attempt && row);
            const observation = decodeObservation(row);
            const rendering = renderPublication(
              observation.intent.finding,
              intentId,
            );
            integrity(
              attempt.repository === row.repository &&
                attempt.pull_request === row.pullRequest &&
                attempt.head_sha === row.headSha &&
                attempt.body === rendering.body &&
                attempt.body_digest === rendering.bodyDigest &&
                attempt.renderer_version === rendering.rendererVersion,
            );
            integrity(
              [
                attempt.repository_id,
                attempt.pull_request_id,
                attempt.app_id,
                attempt.installation_id,
                attempt.bot_user_id,
              ].every((id) => Number.isSafeInteger(id) && id > 0),
            );
            integrity(
              attempt.status === "acknowledged"
                ? Number.isSafeInteger(attempt.comment_id) &&
                    attempt.comment_id! > 0 &&
                    observation.intent.externalReference ===
                      `github-comment:${attempt.comment_id}`
                : (attempt.status === "sending" ||
                    attempt.status === "unknown") &&
                    attempt.comment_id === null &&
                    observation.intent.status === "pending",
            );
            return attempt;
          })
          .deferred();
      });
    }),
  );
}
function matchAttempt(
  config: PublisherConfiguration,
  request: typeof PublicationPreviewRequestSchema.Type,
  attempt: PublicationAttempt,
) {
  sameIdentity(config, {
    repository: attempt.repository,
    repositoryId: attempt.repository_id,
    appId: attempt.app_id,
    installationId: attempt.installation_id,
    botUserId: attempt.bot_user_id,
  });
  integrity(
    attempt.intent_id === request.intentId &&
      attempt.pull_request === request.pullRequest &&
      attempt.repository === request.repository &&
      hash(attempt.body) === attempt.body_digest &&
      attempt.renderer_version === "pr-conversation-published-v1",
  );
}
function acknowledge(
  filename: string,
  attempt: PublicationAttempt,
  commentId: number,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const { db } = yield* acquireStore(filename);
      return yield* storeOperation(() =>
        db
          .transaction(() => {
            const current = db
              .query<PublicationAttempt, [string]>(
                "SELECT * FROM publication_attempts WHERE intent_id = ?",
              )
              .get(attempt.intent_id);
            integrity(
              current &&
                (Object.keys(attempt) as (keyof PublicationAttempt)[]).every(
                  (key) =>
                    key === "status" ||
                    key === "comment_id" ||
                    current[key] === attempt[key],
                ),
            );
            const row = db
              .query<ObservationRow, [string]>(
                observationSelect + " WHERE o.id = ?",
              )
              .get(attempt.intent_id);
            integrity(row);
            const observation = decodeObservation(row);
            if (current.status === "acknowledged") {
              integrity(
                current.comment_id === commentId &&
                  observation.intent.externalReference ===
                    `github-comment:${commentId}`,
              );
              return attemptResult(current);
            }
            integrity(observation.intent.status === "pending");
            db.query(
              "UPDATE publication_attempts SET status = 'acknowledged', comment_id = ? WHERE intent_id = ?",
            ).run(commentId, attempt.intent_id);
            db.query(
              "UPDATE outbox SET status = 'acknowledged', external_reference = ? WHERE id = ?",
            ).run(`github-comment:${commentId}`, attempt.intent_id);
            db.query(
              "UPDATE findings SET status = 'published' WHERE id = ?",
            ).run(observation.record.id);
            return attemptResult({
              ...attempt,
              status: "acknowledged",
              comment_id: commentId,
            });
          })
          .immediate(),
      );
    }),
  );
}
async function responseComment(
  response: Response,
  attempt: PublicationAttempt,
  signal: AbortSignal,
): Promise<number> {
  if (
    response.status !== 201 ||
    response.redirected ||
    (response.url !== "" &&
      response.url !==
        `https://api.github.com/repos/${attempt.repository}/issues/${attempt.pull_request}/comments`)
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw fail("PUBLICATION_RESPONSE");
  }
  const reader = response.body?.getReader();
  if (!reader) throw fail("PUBLICATION_RESPONSE");
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw fail("PUBLICATION_INTERRUPTED");
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 131072) throw fail("PUBLICATION_RESPONSE_LIMIT");
      chunks.push(part.value);
    }
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (!value || typeof value !== "object") throw fail("PUBLICATION_RESPONSE");
    const c = value as {
      id?: unknown;
      body?: unknown;
      issue_url?: unknown;
      user?: { id?: unknown; type?: unknown };
    };
    if (
      !Number.isSafeInteger(c.id) ||
      (c.id as number) <= 0 ||
      c.body !== attempt.body ||
      c.issue_url !==
        `https://api.github.com/repos/${attempt.repository}/issues/${attempt.pull_request}` ||
      c.user?.id !== attempt.bot_user_id ||
      c.user.type !== "Bot"
    )
      throw fail("PUBLICATION_RESPONSE");
    return c.id as number;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

/** Library-only single intent send. Trusted callbacks are not a JSON plugin seam.
 * No default transport, retries, token loader, or CLI activation exists. */
export function publishGitHubComment(
  policyInput: unknown,
  filename: string,
  requestInput: unknown,
  host: PublisherHost,
) {
  return Effect.gen(function* () {
    yield* storeOperation(() =>
      requireCondition(
        host &&
          typeof host.readTransport === "function" &&
          typeof host.acquireLease === "function" &&
          typeof host.authorizeOneIntent === "function",
        "PUBLICATION_HOST",
        "Explicit trusted host callbacks are required",
      ),
    );
    const policy = yield* validatePolicy(policyInput);
    const { config, request } = yield* storeOperation(() => ({
      config: decode(PublisherConfigurationSchema, host.configuration),
      request: decode(PublicationPreviewRequestSchema, requestInput),
    }));
    yield* storeOperation(() =>
      requireCondition(
        policy.allowedRepositories.includes(request.repository) &&
          config.repository === request.repository,
        "NOT_ALLOWED",
        "Publisher target is not explicitly allowed",
      ),
    );
    const existing = yield* readAttempt(filename, request.intentId);
    if (existing) {
      yield* storeOperation(() => matchAttempt(config, request, existing));
      return attemptResult(existing);
    }
    const initial = yield* readIntent(filename, request);
    const rendered = yield* storeOperation(() =>
      renderPublication(initial.observation.intent.finding, request.intentId),
    );
    const context = yield* collectGitHubReviewContext(
      policy,
      {
        repository: request.repository,
        pullRequest: request.pullRequest,
        attemptId: request.attemptId,
      },
      { transport: host.readTransport },
    );
    if (!context.bundle)
      return yield* Effect.fail(fail("PUBLICATION_EVIDENCE"));
    const snapshot = yield* sourceForModel(context.bundle.source);
    const provenance = snapshot.provenance;
    yield* storeOperation(() =>
      requireCondition(
        provenance.repositoryId === config.repositoryId,
        "PUBLICATION_IDENTITY",
        "Fresh repository identity differs",
      ),
    );
    yield* validateRequest(
      {
        deliveryId: "publication-only",
        context: {
          repository: request.repository,
          pullRequest: request.pullRequest,
          headSha: provenance.headSha,
          currentHeadSha: provenance.headSha,
          files: snapshot.files.flatMap((f) =>
            f.after ? [{ path: f.path, content: f.after.content }] : [],
          ),
        },
        findings: [initial.observation.intent.finding],
      },
      policy,
    );
    const proposal: PublicationProposal = {
      ...config,
      pullRequest: request.pullRequest,
      pullRequestId: provenance.pullRequestId,
      headSha: provenance.headSha,
      intentId: request.intentId,
      ...rendered,
    };
    const authorization = yield* Effect.tryPromise({
      try: async () =>
        decode(
          AuthorizationSchema,
          await host.authorizeOneIntent(structuredClone(proposal)),
        ),
      catch: () => fail("PUBLICATION_AUTHORIZATION"),
    });
    const lease = yield* Effect.tryPromise({
      try: async () => {
        const acquired = await host.acquireLease();
        requireCondition(
          typeof acquired.transport === "function",
          "PUBLICATION_HOST",
          "Explicit credential-scoped transport is required",
        );
        return {
          identity: decode(LeaseIdentitySchema, acquired.identity),
          transport: acquired.transport,
        };
      },
      catch: () => fail("PUBLICATION_LEASE"),
    });
    yield* storeOperation(() => {
      sameIdentity(config, lease.identity);
      live(lease.identity.expiresAt);
      live(authorization.expiresAt);
      const { body: _body, ...bound } = proposal;
      integrity(
        (Object.keys(bound) as (keyof typeof bound)[]).every(
          (key) => authorization[key] === bound[key],
        ),
      );
    });
    // Authorization callbacks may take arbitrary time. Reacquire evidence AFTER
    // approval/lease acquisition and bind the complete context again.
    const fresh = yield* collectGitHubReviewContext(
      policy,
      {
        repository: request.repository,
        pullRequest: request.pullRequest,
        attemptId: request.attemptId,
      },
      { transport: host.readTransport },
    );
    if (
      !fresh.bundle ||
      fresh.bundle.source.snapshotId !== context.bundle.source.snapshotId
    )
      return yield* Effect.fail(fail("PUBLICATION_STALE"));
    const attempt: PublicationAttempt = {
      intent_id: request.intentId,
      repository: request.repository,
      repository_id: config.repositoryId,
      pull_request: request.pullRequest,
      pull_request_id: provenance.pullRequestId,
      head_sha: provenance.headSha,
      app_id: config.appId,
      installation_id: config.installationId,
      bot_user_id: config.botUserId,
      body: rendered.body,
      body_digest: rendered.bodyDigest,
      renderer_version: rendered.rendererVersion,
      status: "sending",
      comment_id: null,
    };
    const reserved = yield* Effect.scoped(
      Effect.gen(function* () {
        const { db } = yield* acquireStore(filename);
        return yield* storeOperation(() =>
          db
            .transaction(() => {
              live(authorization.expiresAt);
              live(lease.identity.expiresAt);
              requireCondition(
                db
                  .query<{ restored: number }, []>(
                    "SELECT restored FROM publication_control WHERE id = 1",
                  )
                  .get()?.restored === 0,
                "PUBLICATION_QUARANTINED",
                "Recovered or migrated history cannot authorize new sends",
              );
              const prior = db
                .query<PublicationAttempt, [string]>(
                  "SELECT * FROM publication_attempts WHERE intent_id = ?",
                )
                .get(request.intentId);
              if (prior) {
                matchAttempt(config, request, prior);
                return prior;
              }
              const row = db
                .query<ObservationRow, [string]>(
                  observationSelect + " WHERE o.id = ?",
                )
                .get(request.intentId);
              integrity(row && hash(row) === initial.fingerprint);
              integrity(decodeObservation(row).intent.status === "pending");
              db.query(
                "INSERT INTO publication_attempts (intent_id,repository,repository_id,pull_request,pull_request_id,head_sha,app_id,installation_id,bot_user_id,body,body_digest,renderer_version,status,comment_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              ).run(
                attempt.intent_id,
                attempt.repository,
                attempt.repository_id,
                attempt.pull_request,
                attempt.pull_request_id,
                attempt.head_sha,
                attempt.app_id,
                attempt.installation_id,
                attempt.bot_user_id,
                attempt.body,
                attempt.body_digest,
                attempt.renderer_version,
                attempt.status,
                null,
              );
              return null;
            })
            .immediate(),
        );
      }),
    );
    if (reserved) return attemptResult(reserved);
    // From here every failure is uncertain. No later invocation can POST again.
    const outcome = yield* Effect.tryPromise({
      try: async (signal) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, 10000);
        try {
          live(authorization.expiresAt);
          live(lease.identity.expiresAt);
          if (signal.aborted) throw fail("PUBLICATION_INTERRUPTED");
          const url = `https://api.github.com/repos/${attempt.repository}/issues/${attempt.pull_request}/comments`;
          const operation = async () =>
            responseComment(
              await lease.transport(
                new Request(url, {
                  method: "POST",
                  redirect: "error",
                  credentials: "omit",
                  headers: {
                    "content-type": "application/json",
                    accept: "application/vnd.github+json",
                    "x-github-api-version": "2022-11-28",
                  },
                  body: JSON.stringify({ body: attempt.body }),
                  signal: controller.signal,
                }),
              ),
              attempt,
              controller.signal,
            );
          return await Promise.race([
            operation(),
            new Promise<never>((_, reject) =>
              controller.signal.addEventListener(
                "abort",
                () => reject(fail("PUBLICATION_INTERRUPTED")),
                { once: true },
              ),
            ),
          ]);
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        }
      },
      catch: () => fail("PUBLICATION_UNKNOWN"),
    }).pipe(Effect.result);
    if (outcome._tag === "Success")
      return yield* acknowledge(filename, attempt, outcome.success);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { db } = yield* acquireStore(filename);
        yield* storeOperation(() =>
          db
            .query(
              "UPDATE publication_attempts SET status = 'unknown' WHERE intent_id = ? AND status = 'sending'",
            )
            .run(request.intentId),
        );
      }),
    );
    return attemptResult({ ...attempt, status: "unknown" });
  });
}

/** Read-only external reconciliation; zero/ambiguous matches NEVER authorize resend. */
export function reconcileGitHubComment(
  policyInput: unknown,
  filename: string,
  requestInput: unknown,
  host: Pick<PublisherHost, "configuration" | "readTransport">,
) {
  return Effect.gen(function* () {
    yield* storeOperation(() =>
      requireCondition(
        host && typeof host.readTransport === "function",
        "PUBLICATION_HOST",
        "Explicit trusted read transport is required",
      ),
    );
    const policy = yield* validatePolicy(policyInput);
    const { config, request } = yield* storeOperation(() => ({
      config: decode(PublisherConfigurationSchema, host.configuration),
      request: decode(PublicationPreviewRequestSchema, requestInput),
    }));
    yield* storeOperation(() =>
      requireCondition(
        policy.allowedRepositories.includes(request.repository) &&
          config.repository === request.repository,
        "NOT_ALLOWED",
        "Reconciliation target is not allowed",
      ),
    );
    const attempt = yield* readAttempt(filename, request.intentId);
    if (!attempt) return yield* Effect.fail(fail("PUBLICATION_ATTEMPT_ABSENT"));
    yield* storeOperation(() => matchAttempt(config, request, attempt));
    const discussion = yield* collectGitHubDiscussionContext(
      policy,
      {
        repository: request.repository,
        pullRequest: request.pullRequest,
        attemptId: request.attemptId,
      },
      { transport: host.readTransport },
    );
    if (
      !discussion.context ||
      discussion.acquisition.status !== "endpoint-observed"
    )
      return attemptResult(attempt);
    const p = discussion.context.provenance;
    if (
      p.repositoryId !== attempt.repository_id ||
      p.pullRequestId !== attempt.pull_request_id
    )
      return yield* Effect.fail(fail("PUBLICATION_IDENTITY"));
    const matches = discussion.context.issueComments.filter(
      (c) =>
        c.author?.id === attempt.bot_user_id &&
        c.author.type === "Bot" &&
        c.body === attempt.body,
    );
    if (matches.length !== 1) return attemptResult(attempt);
    return yield* acknowledge(filename, attempt, matches[0]!.id);
  });
}
