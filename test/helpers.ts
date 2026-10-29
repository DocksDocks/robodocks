import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { onTestFinished } from "@effect/vitest";
import type { Policy, ReviewRequest } from "../src/contracts.ts";
import { withReviewer } from "../src/reviewer.ts";
import type { Reviewer } from "../src/reviewer.ts";

export type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
export function database(): string {
  const directory = mkdtempSync(join(tmpdir(), "robodocks-ledger-test-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "ledger.sqlite");
}

// Each property evaluation (including shrinking) owns a separate scope and directory.
export const scopedDatabase = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "robodocks-property-test-"))),
  (directory) =>
    Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
).pipe(Effect.map((directory) => join(directory, "ledger.sqlite")));

export function fixtures(): {
  policy: Mutable<Policy>;
  request: Mutable<ReviewRequest>;
} {
  return {
    policy: JSON.parse(
      readFileSync(new URL("../examples/policy.json", import.meta.url), "utf8"),
    ),
    request: JSON.parse(
      readFileSync(new URL("../examples/review.json", import.meta.url), "utf8"),
    ),
  };
}

export function reviewerEffect<A, E>(
  policy: unknown,
  use: (reviewer: Reviewer) => Effect.Effect<A, E>,
  filename = database(),
) {
  return withReviewer(policy, filename, use);
}

export function runReviewer<A, E>(
  policy: unknown,
  use: (reviewer: Reviewer) => Effect.Effect<A, E>,
  filename = database(),
): Promise<A> {
  return Effect.runPromise(reviewerEffect(policy, use, filename));
}

export function expectCode<A, E extends { readonly code: string }>(
  operation: Effect.Effect<A, E>,
  code: string,
) {
  return Effect.gen(function* () {
    const error = yield* Effect.flip(operation).pipe(
      Effect.mapError(
        () =>
          new Error(
            "Expected " + code + " failure, but the operation succeeded",
          ),
      ),
    );
    assert.equal(error.code, code);
  });
}

export function emptySnapshot() {
  return { schemaVersion: 1, deliveries: [], findings: [], outbox: [] };
}
