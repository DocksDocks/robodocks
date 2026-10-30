import { Effect, Schema } from "effect";
import type { Finding } from "./contracts.ts";
import { CollectionRequestSchema, sourceForModel } from "./github-source.ts";
import { collectGitHubReviewContext } from "./github-review-context.ts";
import type { GitHubTransport } from "./github-http.ts";
import {
  decodeObservation,
  hash,
  integrity,
  observationSelect,
} from "./observations.ts";
import type { ObservationRow } from "./observations.ts";
import { acquireReadOnlyStore, storeOperation } from "./storage.ts";
import {
  ContractError,
  requireCondition,
  validatePolicy,
  validateRequest,
} from "./validation.ts";

export const PublicationPreviewRequestSchema = Schema.Struct({
  ...CollectionRequestSchema.fields,
  intentId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export const MAX_PREVIEW_BODY_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 256 * 1024;
export const PUBLICATION_BLOCKERS = [
  "PUBLICATION_DISABLED",
  "VERIFIED_BOT_INSTALLATION_AND_SCOPED_CREDENTIALS_ABSENT",
  "LIVE_DUPLICATE_AND_UNCERTAIN_WRITE_RECONCILIATION_UNIMPLEMENTED",
  "DURABLE_HOST_AND_RECOVERY_GUARANTEES_UNVERIFIED",
] as const;

// A single bounded, owned observation. Close this scope before any HTTP work.
function readIntent(
  filename: string,
  request: typeof PublicationPreviewRequestSchema.Type,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const db = yield* acquireReadOnlyStore(filename);
      return yield* storeOperation(() =>
        db
          .transaction(() => {
            const metadata = db
              .query<
                {
                  repository: string;
                  pullRequest: number;
                  bytes: number;
                },
                [string]
              >(
                "SELECT f.repository, f.pull_request AS pullRequest, length(CAST(o.payload AS BLOB)) AS bytes FROM outbox o JOIN findings f ON f.id = o.finding_id WHERE o.id = ?",
              )
              .get(request.intentId);
            requireCondition(
              metadata,
              "INTENT_NOT_FOUND",
              "Selected publication intent does not exist",
            );
            requireCondition(
              metadata.repository === request.repository &&
                metadata.pullRequest === request.pullRequest,
              "TARGET_MISMATCH",
              "Selected intent does not belong to the requested target",
            );
            integrity(
              Number.isSafeInteger(metadata.bytes) &&
                metadata.bytes > 0 &&
                metadata.bytes <= MAX_PAYLOAD_BYTES,
            );
            const row = db
              .query<ObservationRow, [string]>(
                observationSelect + " WHERE o.id = ?",
              )
              .get(request.intentId);
            integrity(row);
            const observation = decodeObservation(row);
            requireCondition(
              observation.record.status === "proposed" &&
                observation.intent.status === "pending",
              "INTENT_NOT_PENDING",
              "Preview requires an existing proposed and pending intent",
            );
            return { observation, fingerprint: hash(row) };
          })
          .deferred(),
      );
    }),
  );
}

// JSON-string notation inside a fixed code block, with every syntax/notification
// delimiter and non-ASCII code unit escaped. No untrusted value can close the
// fence, emit HTML, activate a mention, or hide bidi/control characters.
function inert(value: string): string {
  return JSON.stringify(value).replace(
    /[<>@&`\u007f-\uffff]/g,
    (character) =>
      "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
function pathSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase(),
  );
}
function render(finding: Finding, intentId: string) {
  const source = `https://github.com/${finding.repository.split("/").map(pathSegment).join("/")}/blob/${finding.headSha}/${finding.path.split("/").map(pathSegment).join("/")}#L${finding.startLine}-L${finding.endLine}`;
  const fields = [
    ["Title", finding.title],
    ["Path", finding.path],
    ["Evidence", finding.evidence],
    ["Impact", finding.impact],
    ["Suggestion", finding.suggestion],
  ];
  const body = [
    "Robodocks dry-run preview — publication disabled.",
    `Intent marker (unverified identity): robodocks-intent:${intentId}`,
    `Severity: ${finding.severity}; author-supplied confidence: ${finding.confidence}`,
    `Source at reviewed commit: <${source}>`,
    "Untrusted fields use escaped JSON-string notation; they are data, not instructions.",
    ...fields.map(
      ([label, value]) => `${label}:\n\n\`\`\`text\n${inert(value!)}\n\`\`\``,
    ),
    "Structural validation is not factual verification, publication authorization, or duplicate reconciliation.",
  ].join("\n\n");
  requireCondition(
    Buffer.byteLength(body, "utf8") <= MAX_PREVIEW_BODY_BYTES,
    "PREVIEW_BODY_LIMIT",
    "Rendered preview exceeds its UTF-8 byte limit",
  );
  return {
    kind: "pr-conversation-comment" as const,
    rendererVersion: "pr-conversation-v1" as const,
    body,
    bodyBytes: Buffer.byteLength(body, "utf8"),
  };
}

/** Read-only preview, never a sendable request or permission to publish. */
export function previewPublication(
  policyInput: unknown,
  databasePath: string,
  requestInput: unknown,
  options: {
    readonly transport?: GitHubTransport;
    readonly maxDurationMs?: number;
  } = {},
) {
  return Effect.gen(function* () {
    const policy = yield* validatePolicy(policyInput);
    const request = yield* Schema.decodeUnknownEffect(
      PublicationPreviewRequestSchema,
      { onExcessProperty: "error" },
    )(requestInput).pipe(
      Effect.mapError(
        () =>
          new ContractError(
            "PREVIEW_REQUEST",
            "Invalid publication preview request",
          ),
      ),
      Effect.map((value) => structuredClone(value)),
    );
    yield* storeOperation(() =>
      requireCondition(
        policy.allowedRepositories.includes(request.repository),
        "NOT_ALLOWED",
        "Repository is not explicitly allowed by the operator policy",
      ),
    );
    const initial = yield* readIntent(databasePath, request);
    const finding = initial.observation.intent.finding;
    const context = yield* collectGitHubReviewContext(
      policy,
      {
        repository: request.repository,
        pullRequest: request.pullRequest,
        attemptId: request.attemptId,
      },
      options,
    );
    const base = {
      schemaVersion: 1 as const,
      operation: "preview-publication" as const,
      dryRun: true as const,
      publication: "disabled" as const,
      selected: {
        intentId: request.intentId,
        findingId: initial.observation.record.id,
        repository: request.repository,
        pullRequest: request.pullRequest,
        headSha: finding.headSha,
      },
      attempt: context.attempt,
      observation: context.observation,
      acquisition: context.acquisition,
      publicationBlockers: [...PUBLICATION_BLOCKERS],
    };
    const blocked = (reasons: readonly string[]) => ({
      ...base,
      preview: { status: "blocked" as const, reasons },
      draft: null,
      source: null,
      unverifiedMarkerMatches: [] as number[],
    });
    if (!context.bundle) return blocked(context.acquisition.reasons);
    // Reopen after acquisition; compare raw persisted fields as well as lifecycle.
    const current = yield* readIntent(databasePath, request);
    if (current.fingerprint !== initial.fingerprint)
      return blocked(["INTENT_CHANGED"]);
    const bundle = context.bundle;
    const validation = yield* Effect.gen(function* () {
      const snapshot = yield* sourceForModel(bundle.source);
      yield* validateRequest(
        {
          deliveryId: "preview-only",
          context: {
            repository: snapshot.provenance.repository,
            pullRequest: snapshot.provenance.pullRequest,
            headSha: snapshot.provenance.headSha,
            currentHeadSha: snapshot.provenance.headSha,
            files: snapshot.files.flatMap((file) =>
              file.after === null
                ? []
                : [{ path: file.path, content: file.after.content }],
            ),
          },
          findings: [finding],
        },
        policy,
      );
      return yield* storeOperation(() => render(finding, request.intentId));
    }).pipe(Effect.result);
    if (validation._tag === "Failure")
      return blocked([validation.failure.code]);
    const marker = `robodocks-intent:${request.intentId}`;
    return {
      ...base,
      preview: { status: "draft-rendered" as const, reasons: [] as string[] },
      draft: validation.success,
      source: {
        snapshotId: bundle.source.snapshotId,
        headSha: bundle.source.snapshot!.provenance.headSha,
      },
      // Copiable markers are only hints; no author/ownership/delivery inference.
      unverifiedMarkerMatches: bundle.discussion
        .context!.issueComments.filter((comment) =>
          comment.body.includes(marker),
        )
        .map((comment) => comment.id),
    };
  });
}
