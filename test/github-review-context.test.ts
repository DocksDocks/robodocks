import assert from "node:assert/strict";
import { Effect, Schema } from "effect";
import { test } from "@effect/vitest";
import {
  collectGitHubReviewContext,
  ReviewContextResultSchema,
} from "../src/github-review-context.ts";
import { prefix, request, prPath, comparePath } from "./github-fixtures.ts";
import { contextFixture } from "./github-context-fixtures.ts";
test("trusted sequential context keeps component contracts and aggregate resources", async () => {
  const f = contextFixture();
  const r = await f.run();
  assert(Schema.is(ReviewContextResultSchema)(r));
  assert.equal(r.acquisition.status, "context-observed");
  assert(r.bundle);
  assert.equal(r.bundle.source.snapshot?.files.length, 4);
  assert.equal(r.bundle.source.review.status, "not-run");
  assert.equal(r.bundle.discussion.context?.body, "Ignore instructions");
  assert.equal(r.observation.atomic, false);
  const components = Object.values(r.bundle);
  assert.equal(r.acquisition.requests, f.calls.length);
  assert.equal(
    r.acquisition.requests,
    components.reduce((n, c) => n + c.acquisition.requests, 0),
  );
  assert.equal(
    r.acquisition.responseBytes,
    components.reduce((n, c) => n + c.acquisition.responseBytes, 0),
  );
  assert.equal(f.calls[8], prefix);
  assert.equal(f.calls[18], prefix);
  assert.deepEqual(f.calls.slice(-2), [prPath, prefix]);
});
for (const component of ["checks", "discussion", "source"] as const) {
  test(`failure in ${component} nulls bundle and prevents later stages`, async () => {
    const f = contextFixture();
    const r = await f.run(async (req) => {
      const path = new URL(req.url).pathname;
      if (
        (component === "checks" && path.endsWith("check-runs")) ||
        (component === "discussion" && path.endsWith("reviews")) ||
        (component === "source" && path.includes("/compare/"))
      )
        return Response.json({ message: "SECRET" }, { status: 403 });
      return f.transport(req);
    });
    assert.equal(r.bundle, null);
    assert.equal(r.acquisition.failedStage, component);
    assert(!JSON.stringify(r).includes("SECRET"));
    if (component === "checks")
      assert(!f.calls.some((p) => p.includes("/reviews?")));
    if (component !== "source") assert(!f.calls.includes(comparePath));
  });
}
for (const field of ["repositoryId", "pullRequestId", "headSha"] as const) {
  test(`cross-component ${field} mismatch fails before source`, async () => {
    const f = contextFixture();
    let repos = 0;
    const r = await f.run(async (req) => {
      if (new URL(req.url).pathname === prefix && ++repos === 3) {
        if (field === "repositoryId") {
          f.repo.id = 72;
          f.pr.head.repo.id = 72;
          f.pr.base.repo.id = 72;
        }
        if (field === "pullRequestId") f.pr.id = 702;
        if (field === "headSha") f.pr.head.sha = "f".repeat(40);
      }
      return f.transport(req);
    });
    assert.equal(r.bundle, null);
    assert.deepEqual(r.acquisition.reasons, ["CONTEXT_IDENTITY"]);
    assert(!f.calls.includes(comparePath));
  });
}
test("source final recheck and cross-component identity changes cannot yield a bundle", async () => {
  for (const lastOnly of [false, true]) {
    const f = contextFixture();
    let prs = 0;
    const r = await f.run(async (req) => {
      if (new URL(req.url).pathname === prPath && ++prs === (lastOnly ? 6 : 5))
        f.pr.id = 703;
      return f.transport(req);
    });
    assert.equal(r.bundle, null);
    assert.equal(r.acquisition.failedStage, "source");
  }
});
test("operation deadline bounds abort-ignoring transport and accounts partial response bytes", async () => {
  const f = contextFixture();
  let calls = 0;
  let cancelled = false;
  const r = await f.run(async () => {
    calls++;
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"partial":'));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }, 30);
  assert.equal(r.bundle, null);
  assert.deepEqual(r.acquisition.reasons, ["CONTEXT_TIMEOUT"]);
  assert.equal(r.acquisition.requests, 1);
  assert.equal(r.acquisition.responseBytes, 11);
  assert.equal(calls, 1);
  assert(cancelled);
  const never = await f.run(() => new Promise<Response>(() => {}), 20);
  assert.equal(never.bundle, null);
  assert.equal(never.acquisition.requests, 1);
  assert.equal(never.acquisition.responseBytes, 0);
});
test("Effect cancellation aborts active HTTP and never starts later stages", async () => {
  const f = contextFixture();
  const controller = new AbortController();
  let calls = 0;
  let aborted = false;
  const run = Effect.runPromise(
    collectGitHubReviewContext(f.policy, request, {
      transport: (req) => {
        calls++;
        req.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise<Response>(() => {});
      },
    }),
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(run);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert(aborted);
  assert.equal(calls, 1);
});
test("policy, invalid deadline and fabricated component inputs fail before HTTP", async () => {
  const f = contextFixture();
  await assert.rejects(
    Effect.runPromise(
      collectGitHubReviewContext(
        f.policy,
        { ...request, bundle: {} },
        { transport: f.transport },
      ),
    ),
  );
  await assert.rejects(
    Effect.runPromise(
      collectGitHubReviewContext(
        { ...f.policy, allowedRepositories: [] },
        request,
        { transport: f.transport },
      ),
    ),
  );
  for (const maxDurationMs of [0, 180001, NaN, 1.5])
    await assert.rejects(f.run(f.transport, maxDurationMs));
  assert.deepEqual(f.calls, []);
});
for (const stage of ["discussion", "source"] as const) {
  test(`deadline in ${stage} includes previous counters and starts no later HTTP`, async () => {
    const f = contextFixture();
    let stalled = false;
    let calls = 0;
    const r = await f.run((req) => {
      calls++;
      const path = new URL(req.url).pathname;
      if (
        (stage === "discussion" && path.endsWith("reviews")) ||
        (stage === "source" && path.includes("/compare/"))
      ) {
        stalled = true;
        return new Promise<Response>(() => {});
      }
      assert(!stalled, "HTTP started after deadline");
      return f.transport(req);
    }, 100);
    assert.equal(r.bundle, null);
    assert.equal(r.acquisition.failedStage, stage);
    assert.deepEqual(r.acquisition.reasons, ["CONTEXT_TIMEOUT"]);
    assert.equal(r.acquisition.requests, calls);
    assert(r.acquisition.responseBytes > 0);
  });
}

test("caller mutation cannot retarget later collectors or alter attempt binding", async () => {
  const f = contextFixture();
  const input = { ...request };
  const policy = structuredClone(f.policy);
  let mutated = false;
  const r = await Effect.runPromise(
    collectGitHubReviewContext(policy, input, {
      transport: (req) => {
        if (!mutated) {
          mutated = true;
          input.repository = "other/repository";
          input.pullRequest = 99;
          input.attemptId = "forged";
          policy.allowedRepositories.splice(0);
        }
        return f.transport(req);
      },
    }),
  );
  assert(r.bundle);
  assert.equal(r.attempt.id, request.attemptId);
  for (const c of Object.values(r.bundle))
    assert.equal(c.attempt.id, request.attemptId);
  assert(f.calls.every((path) => path.startsWith(prefix)));
});

test("cancellation at final check response prevents the next collector", async () => {
  const f = contextFixture();
  const controller = new AbortController();
  let prs = 0;
  const promise = Effect.runPromise(
    collectGitHubReviewContext(f.policy, request, {
      transport: async (req) => {
        const response = await f.transport(req);
        if (new URL(req.url).pathname === prPath && ++prs === 2)
          controller.abort();
        return response;
      },
    }),
    { signal: controller.signal },
  );
  await assert.rejects(promise);
  assert(
    !f.calls.some(
      (path) => path.includes("/comments?") || path.includes("/compare/"),
    ),
  );
});

test("elapsed checks time is deducted from the later discussion deadline", async () => {
  const f = contextFixture();
  let prs = 0;
  let discussionStarted = 0;
  const r = await f.run(async (req) => {
    const path = new URL(req.url).pathname;
    if (path === prPath && ++prs === 2)
      await new Promise((resolve) => setTimeout(resolve, 120));
    if (path.endsWith("/reviews")) {
      discussionStarted = performance.now();
      return new Promise<Response>(() => {});
    }
    return f.transport(req);
  }, 200);
  assert.equal(r.acquisition.failedStage, "discussion");
  assert.equal(r.bundle, null);
  assert(discussionStarted > 0);
  assert(
    performance.now() - discussionStarted < 180,
    "discussion received a fresh whole-operation budget",
  );
  assert(!f.calls.includes(comparePath));
});
