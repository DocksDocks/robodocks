import type { Finding, Policy, ReviewContext, ReviewRequest } from "./contracts.ts";

export class ContractError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
}

export function requireCondition(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new ContractError(code, message);
}

function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), "SHAPE", `${label} must be an object`);
  const result = value as Record<string, unknown>;
  requireCondition(Object.keys(result).length === keys.length && keys.every(key => Object.hasOwn(result, key)), "SHAPE", `${label} has missing or unsupported fields`);
  return result;
}

function text(value: unknown, label: string, limit = 4096): string {
  requireCondition(typeof value === "string" && value.trim().length > 0 && value.length <= limit, "TEXT", `${label} must be nonempty bounded text`);
  return value;
}

function integer(value: unknown, label: string): number {
  requireCondition(Number.isSafeInteger(value) && (value as number) > 0, "NUMBER", `${label} must be a positive safe integer`);
  return value as number;
}

function ratio(value: unknown, label: string): number {
  requireCondition(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1, "NUMBER", `${label} must be between zero and one`);
  return value;
}

function repository(value: unknown): string {
  const result = text(value, "repository", 180);
  requireCondition(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+$/.test(result) && ![".", ".."].includes(result.split("/")[1]!), "REPOSITORY", "repository must be an exact owner/name identifier");
  return result;
}

function sha(value: unknown): string {
  const result = text(value, "headSha", 40);
  requireCondition(/^[a-f0-9]{40}$/.test(result), "SHA", "headSha must be a full lowercase 40-character commit SHA");
  return result;
}

function relativePath(value: unknown): string {
  const result = text(value, "path", 512);
  requireCondition(!/[\\\x00-\x1f\x7f:]/.test(result) && result.split("/").every(part => part !== "" && part !== "." && part !== ".."), "PATH", "path must be a normalized relative POSIX path");
  return result;
}

export function validatePolicy(value: unknown): Policy {
  const data = object(value, ["schemaVersion", "mode", "publication", "allowedRepositories", "minimumConfidence", "maxFindings"], "policy");
  requireCondition(data.schemaVersion === 1 && data.mode === "read-only" && data.publication === "disabled", "POLICY", "only schema version 1, read-only, publication-disabled policy is supported");
  requireCondition(Array.isArray(data.allowedRepositories) && data.allowedRepositories.length > 0 && data.allowedRepositories.length <= 100, "POLICY", "policy must explicitly allow between one and 100 repositories");
  const allowedRepositories = Array.from(data.allowedRepositories, repository);
  requireCondition(new Set(allowedRepositories.map(item => item.toLowerCase())).size === allowedRepositories.length, "POLICY", "allowed repositories must be unique");
  const maxFindings = integer(data.maxFindings, "maxFindings");
  requireCondition(maxFindings <= 100, "LIMIT", "maxFindings cannot exceed 100");
  return { schemaVersion: 1, mode: "read-only", publication: "disabled", allowedRepositories, minimumConfidence: ratio(data.minimumConfidence, "minimumConfidence"), maxFindings };
}

function context(value: unknown, policy: Policy): ReviewContext {
  const data = object(value, ["repository", "pullRequest", "headSha", "currentHeadSha", "files"], "context");
  const targetRepository = repository(data.repository);
  requireCondition(policy.allowedRepositories.includes(targetRepository), "NOT_ALLOWED", "repository is not explicitly allowed by the operator policy");
  const headSha = sha(data.headSha);
  const currentHeadSha = sha(data.currentHeadSha);
  requireCondition(headSha === currentHeadSha, "STALE_HEAD", "review snapshot no longer matches the current pull request head");
  requireCondition(Array.isArray(data.files) && data.files.length <= 1000, "LIMIT", "context files must be an array with at most 1000 entries");
  let contentLength = 0;
  const files = Array.from(data.files, value => {
    const file = object(value, ["path", "content"], "file");
    requireCondition(typeof file.content === "string" && file.content.length <= 128 * 1024, "LIMIT", "file content must be text of at most 128 Ki characters");
    contentLength += file.content.length;
    return { path: relativePath(file.path), content: file.content };
  });
  requireCondition(contentLength <= 1024 * 1024, "LIMIT", "snapshot content cannot exceed one Mi character");
  requireCondition(new Set(files.map(file => file.path)).size === files.length, "PATH", "snapshot paths must be unique");
  return { repository: targetRepository, pullRequest: integer(data.pullRequest, "pullRequest"), headSha, currentHeadSha, files };
}

function finding(value: unknown, target: ReviewContext, policy: Policy): Finding {
  const data = object(value, ["ruleId", "repository", "pullRequest", "headSha", "path", "startLine", "endLine", "title", "severity", "evidence", "impact", "suggestion", "confidence"], "finding");
  const result: Finding = {
    ruleId: text(data.ruleId, "ruleId", 100),
    repository: repository(data.repository),
    pullRequest: integer(data.pullRequest, "pullRequest"),
    headSha: sha(data.headSha),
    path: relativePath(data.path),
    startLine: integer(data.startLine, "startLine"),
    endLine: integer(data.endLine, "endLine"),
    title: text(data.title, "title", 200),
    severity: data.severity as Finding["severity"],
    evidence: text(data.evidence, "evidence", 8192),
    impact: text(data.impact, "impact"),
    suggestion: text(data.suggestion, "suggestion"),
    confidence: ratio(data.confidence, "confidence"),
  };
  requireCondition(/^[a-z0-9][a-z0-9._-]*$/.test(result.ruleId), "RULE", "ruleId must be a stable lowercase identifier");
  requireCondition(["low", "medium", "high"].includes(result.severity), "SEVERITY", "unsupported severity");
  requireCondition(result.repository === target.repository && result.pullRequest === target.pullRequest && result.headSha === target.headSha, "TARGET_MISMATCH", "finding repository, pull request and head must exactly match the trusted context");
  requireCondition(result.confidence >= policy.minimumConfidence, "CONFIDENCE", "finding does not meet the operator confidence threshold");
  const file = target.files.find(item => item.path === result.path);
  requireCondition(file, "MISSING_FILE", "finding path is absent from the trusted snapshot");
  const lines = file.content.split("\n");
  requireCondition(result.startLine <= result.endLine && result.endLine <= lines.length && result.endLine - result.startLine < 100, "LINES", "finding line range must exist and span at most 100 lines");
  requireCondition(lines.slice(result.startLine - 1, result.endLine).join("\n") === result.evidence, "EVIDENCE", "finding evidence must exactly match the cited lines in the trusted snapshot");
  return result;
}

export function validateRequest(value: unknown, policy: Policy): ReviewRequest {
  const data = object(value, ["deliveryId", "context", "findings"], "request");
  const deliveryId = text(data.deliveryId, "deliveryId", 128);
  requireCondition(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(deliveryId), "DELIVERY", "deliveryId must be a bounded identifier");
  const target = context(data.context, policy);
  requireCondition(Array.isArray(data.findings) && data.findings.length <= policy.maxFindings, "LIMIT", "findings must be an array within the operator limit");
  return { deliveryId, context: target, findings: Array.from(data.findings, value => finding(value, target, policy)) };
}
