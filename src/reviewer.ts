import { createHash } from "node:crypto";
import type { Finding, FindingRecord, Policy, PublicationIntent, ReviewPlan, Snapshot } from "./contracts.ts";
import { requireCondition, validatePolicy, validateRequest } from "./validation.ts";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** One exact source observation; cross-commit semantic identity is out of scope. */
function findingId(finding: Finding): string {
  return hash([finding.repository, finding.pullRequest, finding.headSha, finding.ruleId, finding.path, finding.startLine, finding.endLine, finding.evidence]);
}

/** In-memory, single-process dry-run ledger. It never performs external writes. */
export class Reviewer {
  #policy: Policy;
  #deliveries = new Map<string, string>();
  #findings = new Map<string, FindingRecord>();
  #outbox = new Map<string, PublicationIntent>();

  constructor(operatorPolicy: unknown) {
    this.#policy = validatePolicy(operatorPolicy);
  }

  plan(untrustedRequest: unknown): ReviewPlan {
    // Validate the complete batch before reserving any delivery or finding.
    const request = validateRequest(untrustedRequest, this.#policy);
    const digest = hash(request);
    const previousDigest = this.#deliveries.get(request.deliveryId);
    if (previousDigest !== undefined) {
      requireCondition(previousDigest === digest, "DELIVERY_CONFLICT", "delivery ID was already used for a different request");
      return { dryRun: true, deliveryStatus: "duplicate", intents: [], suppressedFindingIds: [] };
    }
    requireCondition(this.#deliveries.size < 10_000 && this.#findings.size + request.findings.length <= 10_000, "LEDGER_FULL", "in-memory ledger capacity reached; use a durable adapter before production");

    const intents: PublicationIntent[] = [];
    const suppressedFindingIds: string[] = [];
    for (const finding of request.findings) {
      const id = findingId(finding);
      if (this.#findings.has(id)) {
        // Closed records are deliberately not reopened or followed up automatically.
        suppressedFindingIds.push(id);
        continue;
      }
      const intent: PublicationIntent = {
        id: hash(["review-comment-v1", id]),
        findingId: id,
        kind: "propose-review-comment",
        dryRun: true,
        status: "pending",
        finding,
      };
      this.#findings.set(id, { id, repository: finding.repository, pullRequest: finding.pullRequest, firstObservedHeadSha: finding.headSha, status: "proposed" });
      this.#outbox.set(intent.id, intent);
      intents.push(intent);
    }
    this.#deliveries.set(request.deliveryId, digest);
    return structuredClone({ dryRun: true, deliveryStatus: "accepted", intents, suppressedFindingIds });
  }

  /** Records an adapter's acknowledgement; does not call GitHub or publish. */
  recordPublication(intentId: string, externalReference: string): void {
    const intent = this.#outbox.get(intentId);
    requireCondition(intent, "UNKNOWN_INTENT", "publication acknowledgement requires a known intent");
    requireCondition(typeof externalReference === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(externalReference), "REFERENCE", "externalReference must be a bounded identifier, not arbitrary content");
    if (intent.status === "acknowledged") {
      requireCondition(intent.externalReference === externalReference, "ACK_CONFLICT", "intent was already acknowledged with a different reference");
      return;
    }
    intent.status = "acknowledged";
    intent.externalReference = externalReference;
    this.#findings.get(intent.findingId)!.status = "published";
  }

  /** Closure is an observation, not evidence of a fix or permission to create work. */
  recordFindingClosed(id: string): void {
    const record = this.#findings.get(id);
    requireCondition(record && record.status !== "proposed", "INVALID_TRANSITION", "only an acknowledged finding can be marked closed");
    record.status = "closed";
  }

  snapshot(): Snapshot {
    return structuredClone({
      schemaVersion: 1,
      deliveries: Array.from(this.#deliveries, ([id, digest]) => ({ id, digest })),
      findings: [...this.#findings.values()],
      outbox: [...this.#outbox.values()],
    });
  }
}
