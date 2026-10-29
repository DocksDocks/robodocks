import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { validatePolicy, validateRequest } from "../src/validation.ts";
import { fixtures, reviewerEffect, scopedDatabase } from "./helpers.ts";

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverseKeys(item)]),
    );
  }
  return value;
}

const positive = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 100_000 }),
);

it.effect.prop(
  "validation canonicalizes object key order and preserves caller-owned input",
  [positive],
  ([pullRequest]) =>
    Effect.gen(function* () {
      const { policy, request } = fixtures();
      request.context.pullRequest = request.findings[0]!.pullRequest =
        pullRequest;
      const before = structuredClone(request);
      const trusted = yield* validatePolicy(policy);
      const validated = yield* validateRequest(request, trusted);
      const reordered = yield* validateRequest(reverseKeys(request), trusted);
      assert.equal(JSON.stringify(validated), JSON.stringify(reordered));
      assert.deepEqual(request, before);
      assert.notEqual(validated, request);
    }),
  { arbitrary: { runs: 25, seed: "robodocks-canonical-input" } },
);

it.live.prop(
  "duplicate batches and reworded observations stay deduplicated across restart",
  [Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })), positive],
  ([copies, variant]) =>
    Effect.scoped(
      Effect.gen(function* () {
        // Scoped inside the property callback, not shared across generated runs or shrinks.
        const filename = yield* scopedDatabase;
        const { policy, request } = fixtures();
        const original = request.findings[0]!;
        request.findings = Array.from({ length: copies }, () =>
          structuredClone(original),
        );
        const first = yield* reviewerEffect(
          policy,
          (reviewer) => reviewer.plan(request),
          filename,
        );
        assert.equal(first.intents.length, 1);
        assert.equal(first.suppressedFindingIds.length, copies - 1);
        request.deliveryId = "reworded-" + variant;
        for (const finding of request.findings)
          finding.title = "Reworded finding " + variant;
        yield* reviewerEffect(
          policy,
          (reviewer) =>
            Effect.gen(function* () {
              const redetected = yield* reviewer.plan(request);
              assert.equal(redetected.intents.length, 0);
              assert.deepEqual(
                redetected.suppressedFindingIds,
                Array.from(
                  { length: copies },
                  () => first.intents[0]!.findingId,
                ),
              );
              const before = yield* reviewer.snapshot();
              assert.equal(before.findings.length, 1);
              assert.equal(before.outbox.length, 1);
              assert.equal(before.deliveries.length, 2);
              assert.equal(
                (yield* reviewer.plan(request)).deliveryStatus,
                "duplicate",
              );
              assert.deepEqual(yield* reviewer.snapshot(), before);
            }),
          filename,
        );
      }),
    ),
  { arbitrary: { runs: 25, seed: "robodocks-durable-dedup" } },
);
