import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { test } from "@effect/vitest";
import {
  publishGitHubComment,
  reconcileGitHubComment,
  renderPublication,
} from "../src/github-app-publisher.ts";
import type {
  PublisherHost,
  PublicationAttempt,
  PublicationAuthorization,
} from "../src/github-app-publisher.ts";
import type { GitHubTransport } from "../src/github-http.ts";
import { initializePublicationLedger } from "../src/storage.ts";
import { database, fixtures, runReviewer } from "./helpers.ts";
import { contextFixture } from "./github-context-fixtures.ts";
import { request, prefix, headSha } from "./github-fixtures.ts";

const run = Effect.runPromise;
const commentsPath = `${prefix}/issues/7/comments?per_page=100&page=1`;
const configuration = {
  repository: request.repository,
  repositoryId: 71,
  appId: 81,
  installationId: 91,
  botUserId: 101,
};
const expires = () => Date.now() + 600000;
function inspect(filename: string) {
  const db = new Database(filename, { readonly: true });
  try {
    return {
      attempt: db
        .query<PublicationAttempt, []>("SELECT * FROM publication_attempts")
        .get(),
      outbox: db
        .query<{ status: string; external_reference: string | null }, []>(
          "SELECT status,external_reference FROM outbox",
        )
        .get()!,
    };
  } finally {
    db.close(true);
  }
}
function edit(filename: string, sql: string) {
  const db = new Database(filename);
  try {
    db.run(sql);
  } finally {
    db.close(true);
  }
}
async function setup() {
  const f = contextFixture();
  const filename = database();
  await run(initializePublicationLedger(filename));
  const finding = {
    ...fixtures().request.findings[0]!,
    path: "modified.ts",
    startLine: 1,
    endLine: 1,
    evidence: "new\r",
  };
  const plan = await runReviewer(
    f.policy,
    (r) =>
      r.plan({
        deliveryId: "publisher-fixture",
        context: {
          repository: finding.repository,
          pullRequest: finding.pullRequest,
          headSha: finding.headSha,
          currentHeadSha: finding.headSha,
          files: [{ path: finding.path, content: finding.evidence }],
        },
        findings: [finding],
      }),
    filename,
  );
  const intentId = plan.intents[0]!.id;
  const input = { ...request, intentId };
  const sent: Request[] = [];
  const body = renderPublication(finding, intentId).body;
  const comment = (id = 201) => ({
    id,
    body,
    user: { id: configuration.botUserId, type: "Bot", login: "fixture[bot]" },
    issue_url: `https://api.github.com${prefix}/issues/7`,
    created_at: "2026-10-30T00:00:00Z",
    updated_at: "2026-10-30T00:00:00Z",
  });
  let transport: GitHubTransport = async () =>
    Response.json(comment(), { status: 201 });
  let authorize: PublisherHost["authorizeOneIntent"] = async (proposal) => {
    const { body: _body, ...binding } = proposal;
    return { ...binding, expiresAt: expires(), authoritativeLedger: true };
  };
  let leaseIdentity = {
    ...configuration,
    expiresAt: expires(),
    issuesWrite: true as const,
  };
  const host: PublisherHost = {
    configuration,
    readTransport: f.transport,
    authorizeOneIntent: (p) => authorize(p),
    acquireLease: async () => ({
      identity: leaseIdentity,
      transport: async (req) => {
        sent.push(req);
        return transport(req);
      },
    }),
  };
  const publish = () =>
    run(publishGitHubComment(f.policy, filename, input, host));
  const reconcile = () =>
    run(reconcileGitHubComment(f.policy, filename, input, host));
  return {
    ...f,
    filename,
    input,
    intentId,
    body,
    host,
    sent,
    comment,
    publish,
    reconcile,
    setTransport: (t: GitHubTransport) => {
      transport = t;
    },
    setAuthorize: (a: PublisherHost["authorizeOneIntent"]) => {
      authorize = a;
    },
    setLease: (identity: typeof leaseIdentity) => {
      leaseIdentity = identity;
    },
  };
}

test("actual one-intent POST persists sending first and acknowledges atomically; replay never sends", async () => {
  const f = await setup();
  f.setTransport(async (req) => {
    assert.equal(inspect(f.filename).attempt?.status, "sending");
    assert.equal(req.method, "POST");
    assert.equal(req.url, `https://api.github.com${prefix}/issues/7/comments`);
    assert.equal(req.redirect, "error");
    assert.equal(req.headers.has("authorization"), false);
    assert.deepEqual(await req.json(), { body: f.body });
    return Response.json(f.comment(), { status: 201 });
  });
  assert.equal((await f.publish()).status, "acknowledged");
  assert.equal(f.sent.length, 1);
  assert.equal(
    inspect(f.filename).outbox.external_reference,
    "github-comment:201",
  );
  assert.equal((await f.publish()).status, "acknowledged");
  assert.equal(f.sent.length, 1);
  assert(!f.body.includes("publication disabled"));
});

test("concurrent callers share one reservation and only one POST", async () => {
  const f = await setup();
  const results = await Promise.all([f.publish(), f.publish(), f.publish()]);
  assert(
    results.every((r) => r.status === "sending" || r.status === "acknowledged"),
  );
  assert.equal(f.sent.length, 1);
  assert.equal(inspect(f.filename).attempt?.status, "acknowledged");
});

test("successful remote write with lost response remains unknown across reopen; exact positive reconciles", async () => {
  const f = await setup();
  f.setTransport(async () => {
    f.routes.set(commentsPath, [f.comment()]);
    throw new Error("lost response secret");
  });
  assert.equal((await f.publish()).status, "unknown");
  assert.equal((await f.publish()).status, "unknown");
  assert.equal(f.sent.length, 1);
  assert.equal(inspect(f.filename).outbox.status, "pending");
  assert.equal((await f.reconcile()).status, "acknowledged");
  assert.equal((await f.reconcile()).commentId, 201);
  assert.equal(f.sent.length, 1);
});

for (const variation of [
  "zero",
  "wrong-author",
  "wrong-body",
  "duplicate",
  "wrong-type",
  "marker-only",
] as const)
  test(`uncertain reconciliation rejects ${variation} evidence without resending`, async () => {
    const f = await setup();
    f.setTransport(async () => {
      throw new Error("unknown");
    });
    await f.publish();
    const c = f.comment();
    const comments =
      variation === "zero"
        ? []
        : variation === "duplicate"
          ? [c, f.comment(202)]
          : [
              {
                ...c,
                ...(variation === "wrong-author"
                  ? { user: { ...c.user, id: 999 } }
                  : variation === "wrong-type"
                    ? { user: { ...c.user, type: "User" } }
                    : variation === "marker-only"
                      ? { body: `robodocks-intent:${f.intentId}` }
                      : { body: c.body + " edited" }),
              },
            ];
    f.routes.set(commentsPath, comments);
    assert.equal((await f.reconcile()).status, "unknown");
    assert.equal((await f.publish()).status, "unknown");
    assert.equal(f.sent.length, 1);
    assert.equal(inspect(f.filename).outbox.status, "pending");
  });

for (const variation of [
  "expired-lease",
  "wrong-app",
  "wrong-repository",
  "expired-authorization",
  "wrong-body",
  "wrong-head",
  "wrong-intent",
  "unattested-ledger",
] as const)
  test(`rejects ${variation} before reservation or POST`, async () => {
    const f = await setup();
    if (variation === "expired-lease")
      f.setLease({ ...configuration, expiresAt: 1, issuesWrite: true });
    else if (variation === "wrong-app")
      f.setLease({
        ...configuration,
        appId: 999,
        expiresAt: expires(),
        issuesWrite: true,
      });
    else if (variation === "wrong-repository")
      f.setLease({
        ...configuration,
        repositoryId: 999,
        expiresAt: expires(),
        issuesWrite: true,
      });
    else
      f.setAuthorize(async (proposal) => {
        const { body: _body, ...binding } = proposal;
        return {
          ...binding,
          expiresAt: variation === "expired-authorization" ? 1 : expires(),
          authoritativeLedger: variation !== "unattested-ledger",
          ...(variation === "wrong-body"
            ? { bodyDigest: "f".repeat(64) }
            : variation === "wrong-head"
              ? { headSha: "f".repeat(40) }
              : variation === "wrong-intent"
                ? { intentId: "f".repeat(64) }
                : {}),
        } as PublicationAuthorization;
      });
    await assert.rejects(f.publish());
    assert.equal(f.sent.length, 0);
    assert.equal(inspect(f.filename).attempt, null);
  });

test("fresh source acquisition after authorization rejects moved head", async () => {
  const f = await setup();
  f.setAuthorize(async (proposal) => {
    f.pr.head.sha = "f".repeat(40);
    const { body: _body, ...binding } = proposal;
    return { ...binding, expiresAt: expires(), authoritativeLedger: true };
  });
  await assert.rejects(f.publish());
  assert.equal(f.sent.length, 0);
  assert.equal(inspect(f.filename).attempt, null);
});

test("current policy and exact source evidence gate publication", async () => {
  const f = await setup();
  f.policy.minimumConfidence = 1;
  await assert.rejects(f.publish());
  assert.equal(f.sent.length, 0);
  assert.equal(inspect(f.filename).attempt, null);
});

for (const variation of [
  "status",
  "wrong-author",
  "wrong-body",
  "wrong-target",
  "oversize",
  "malformed",
] as const)
  test(`POST ${variation} response remains unknown and cannot retry`, async () => {
    const f = await setup();
    f.setTransport(async () =>
      variation === "oversize"
        ? new Response("x".repeat(131073), { status: 201 })
        : variation === "malformed"
          ? new Response("{", { status: 201 })
          : Response.json(
              {
                ...f.comment(),
                ...(variation === "wrong-author"
                  ? { user: { id: 999, type: "Bot" } }
                  : variation === "wrong-body"
                    ? { body: "copied" }
                    : variation === "wrong-target"
                      ? {
                          issue_url: `https://api.github.com${prefix}/issues/8`,
                        }
                      : {}),
              },
              { status: variation === "status" ? 500 : 201 },
            ),
    );
    assert.equal((await f.publish()).status, "unknown");
    assert.equal((await f.publish()).status, "unknown");
    assert.equal(f.sent.length, 1);
    assert.equal(inspect(f.filename).outbox.status, "pending");
  });

test("acknowledgement failure leaves committed sending; positive reconciliation safely finishes", async () => {
  const f = await setup();
  f.setTransport(async () => {
    edit(
      f.filename,
      "CREATE TRIGGER fail_ack BEFORE UPDATE ON outbox BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
    return Response.json(f.comment(), { status: 201 });
  });
  await assert.rejects(f.publish());
  assert.equal(inspect(f.filename).attempt?.status, "sending");
  assert.equal(inspect(f.filename).outbox.status, "pending");
  assert.equal((await f.publish()).status, "sending");
  assert.equal(f.sent.length, 1);
  edit(f.filename, "DROP TRIGGER fail_ack");
  f.routes.set(commentsPath, [f.comment()]);
  assert.equal((await f.reconcile()).status, "acknowledged");
});

test("interruption after reservation preserves uncertain sending and never retries", async () => {
  const f = await setup();
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.setTransport(async () => {
    started();
    return new Promise<Response>(() => {});
  });
  const operation = run(
    publishGitHubComment(f.policy, f.filename, f.input, f.host),
    { signal: controller.signal },
  );
  await ready;
  controller.abort();
  await assert.rejects(operation);
  assert.equal(inspect(f.filename).attempt?.status, "sending");
  assert.equal((await f.publish()).status, "sending");
  assert.equal(f.sent.length, 1);
});

test("quarantined recovered history blocks new sends", async () => {
  const f = await setup();
  edit(f.filename, "UPDATE publication_control SET restored = 1");
  await assert.rejects(f.publish());
  assert.equal(f.sent.length, 0);
  assert.equal(inspect(f.filename).attempt, null);
});

test("published body cannot activate mentions, HTML or code fences from finding fields", () => {
  const finding = {
    ...fixtures().request.findings[0]!,
    title: "@everyone ``` <script> & \u202e",
  };
  const body = renderPublication(finding, "a".repeat(64)).body;
  assert(!body.includes("@everyone"));
  assert(!body.includes("<script>"));
  assert(!body.includes("\u202e"));
  assert.equal(body.match(/```/g)?.length, 2);
  assert(body.includes(headSha));
});

test("missing read transport is rejected instead of defaulting to live HTTP", async () => {
  const f = await setup();
  const malformed = {
    ...f.host,
    readTransport: undefined,
  } as unknown as PublisherHost;
  await assert.rejects(
    run(publishGitHubComment(f.policy, f.filename, f.input, malformed)),
  );
  assert.equal(f.sent.length, 0);
  assert.equal(inspect(f.filename).attempt, null);
  await assert.rejects(
    run(reconcileGitHubComment(f.policy, f.filename, f.input, malformed)),
  );
});

test("interruption cancels a hanging response stream and preserves durable uncertainty", async () => {
  const f = await setup();
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let canceled = false;
  f.setTransport(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            started();
            return new Promise<void>(() => {});
          },
          cancel() {
            canceled = true;
          },
        }),
        { status: 201 },
      ),
  );
  const operation = run(
    publishGitHubComment(f.policy, f.filename, f.input, f.host),
    { signal: controller.signal },
  );
  await ready;
  controller.abort();
  await assert.rejects(operation);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(canceled, true);
  assert.equal(inspect(f.filename).attempt?.status, "sending");
  assert.equal((await f.publish()).status, "sending");
  assert.equal(f.sent.length, 1);
});

test("manual acknowledgement cannot bypass an outstanding publisher attempt", async () => {
  const f = await setup();
  f.setTransport(async () => {
    throw new Error("unknown");
  });
  await f.publish();
  await assert.rejects(
    runReviewer(
      f.policy,
      (r) => r.recordPublication(f.intentId, "manual-claim"),
      f.filename,
    ),
  );
  assert.equal(inspect(f.filename).attempt?.status, "unknown");
  assert.equal(inspect(f.filename).outbox.status, "pending");
});

test("incomplete reconciliation read never authorizes resend", async () => {
  const f = await setup();
  f.setTransport(async () => {
    throw new Error("unknown");
  });
  await f.publish();
  const bounded = Array.from({ length: 100 }, (_, i) => f.comment(i + 1));
  f.routes.set(commentsPath, bounded);
  f.routes.set(`${prefix}/issues/7/comments?per_page=100&page=2`, [
    f.comment(999),
  ]);
  assert.equal((await f.reconcile()).status, "unknown");
  assert.equal((await f.publish()).status, "unknown");
  assert.equal(f.sent.length, 1);
});

test("acknowledged attempt rejects a different positive external comment identity", async () => {
  const f = await setup();
  await f.publish();
  f.routes.set(commentsPath, [f.comment(999)]);
  await assert.rejects(f.reconcile());
  assert.equal(inspect(f.filename).attempt?.comment_id, 201);
  assert.equal(f.sent.length, 1);
});

for (const received of [false, true])
  test(`process kill ${received ? "after" : "before"} simulated remote receipt preserves sending across restart`, async () => {
    const f = await setup();
    const receipt = join(dirname(f.filename), "remote-receipt.json");
    const script = join(dirname(f.filename), "crash.ts");
    const publisherPath = fileURLToPath(
      new URL("../src/github-app-publisher.ts", import.meta.url),
    );
    const fixturePath = fileURLToPath(
      new URL("./github-context-fixtures.ts", import.meta.url),
    );
    const effectPath = fileURLToPath(import.meta.resolve("effect"));
    writeFileSync(
      script,
      `
    import { Effect } from ${JSON.stringify(effectPath)};
    import { publishGitHubComment } from ${JSON.stringify(publisherPath)};
    import { contextFixture } from ${JSON.stringify(fixturePath)};
    import { writeFileSync } from "node:fs";
    const fixture=contextFixture();
    const configuration=${JSON.stringify(configuration)};
    const host={configuration,readTransport:fixture.transport,
      authorizeOneIntent:async ({body,...binding})=>({...binding,expiresAt:Date.now()+600000,authoritativeLedger:true}),
      acquireLease:async()=>({identity:{...configuration,expiresAt:Date.now()+600000,issuesWrite:true},transport:async request=>{
        ${received ? `writeFileSync(${JSON.stringify(receipt)}, await request.text());` : ""}
        process.kill(process.pid,"SIGKILL");
        return new Promise(()=>{});
      }})};
    await Effect.runPromise(publishGitHubComment(fixture.policy,${JSON.stringify(f.filename)},${JSON.stringify(f.input)},host));
  `,
    );
    const child = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, DO_NOT_TRACK: "1" },
    });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    assert.equal(existsSync(receipt), received);
    assert.equal(inspect(f.filename).attempt?.status, "sending");
    assert.equal((await f.publish()).status, "sending");
    assert.equal(f.sent.length, 0);
    if (received) {
      f.routes.set(commentsPath, [f.comment()]);
      assert.equal((await f.reconcile()).status, "acknowledged");
    } else assert.equal((await f.reconcile()).status, "sending");
  });

test("independent publisher processes cannot both POST the same intent", async () => {
  const f = await setup();
  const receipt = join(dirname(f.filename), "posts.log");
  const script = join(dirname(f.filename), "concurrent.ts");
  const publisherPath = fileURLToPath(
    new URL("../src/github-app-publisher.ts", import.meta.url),
  );
  const fixturePath = fileURLToPath(
    new URL("./github-context-fixtures.ts", import.meta.url),
  );
  const effectPath = fileURLToPath(import.meta.resolve("effect"));
  writeFileSync(
    script,
    `
    import { Effect } from ${JSON.stringify(effectPath)};
    import { publishGitHubComment } from ${JSON.stringify(publisherPath)};
    import { contextFixture } from ${JSON.stringify(fixturePath)};
    import { appendFileSync } from "node:fs";
    const fixture=contextFixture();
    const configuration=${JSON.stringify(configuration)};
    const host={configuration,readTransport:fixture.transport,
      authorizeOneIntent:async ({body,...binding})=>({...binding,expiresAt:Date.now()+600000,authoritativeLedger:true}),
      acquireLease:async()=>({identity:{...configuration,expiresAt:Date.now()+600000,issuesWrite:true},transport:async request=>{
        appendFileSync(${JSON.stringify(receipt)},"POST\\n");
        await new Promise(resolve=>setTimeout(resolve,100));
        return Response.json(${JSON.stringify(f.comment())},{status:201});
      }})};
    await Effect.runPromise(publishGitHubComment(fixture.policy,${JSON.stringify(f.filename)},${JSON.stringify(f.input)},host));
  `,
  );
  const child = () =>
    new Promise<void>((resolve, reject) => {
      const process = spawn(globalThis.process.execPath, [script], {
        env: { ...globalThis.process.env, DO_NOT_TRACK: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      process.stderr.on("data", (data) => {
        stderr += String(data);
      });
      process.on("error", reject);
      process.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr));
      });
    });
  await Promise.all([child(), child()]);
  assert.equal(readFileSync(receipt, "utf8"), "POST\n");
  assert.equal(inspect(f.filename).attempt?.status, "acknowledged");
});

test("independent: reconciliation cap preserves uncertain attempt even with exact match on first page", async () => {
  const f = await setup();
  f.setTransport(async () => {
    throw new Error("lost");
  });
  await f.publish();
  f.routes.set(
    commentsPath,
    Array.from({ length: 100 }, (_, i) =>
      i === 0 ? f.comment() : { ...f.comment(300 + i), body: "other" },
    ),
  );
  f.routes.set(`${prefix}/issues/7/comments?per_page=100&page=2`, [
    f.comment(999),
  ]);
  assert.equal((await f.reconcile()).status, "unknown");
  assert.equal((await f.publish()).status, "unknown");
  assert.equal(f.sent.length, 1);
});
test("independent: wrong issue relationship cannot acknowledge exact bot and body", async () => {
  const f = await setup();
  f.setTransport(async () => {
    throw new Error("lost");
  });
  await f.publish();
  f.routes.set(commentsPath, [
    { ...f.comment(), issue_url: `https://api.github.com${prefix}/issues/8` },
  ]);
  assert.equal((await f.reconcile()).status, "unknown");
  assert.equal(f.sent.length, 1);
});
test("independent: callback secret never escapes authorization rejection", async () => {
  const f = await setup();
  f.setAuthorize(async () => {
    throw new Error("SECRET_SENTINEL");
  });
  await assert.rejects(
    f.publish(),
    (e) => !String(e).includes("SECRET_SENTINEL"),
  );
  assert.equal(f.sent.length, 0);
});
test("independent: grant mutation during lease acquisition cannot broaden captured grant", async () => {
  const f = await setup();
  let grant: PublicationAuthorization;
  f.setAuthorize(async (p) => {
    const { body: _body, ...binding } = p;
    grant = { ...binding, expiresAt: expires(), authoritativeLedger: true };
    return grant;
  });
  const old = f.host.acquireLease;
  const host = {
    ...f.host,
    acquireLease: async () => {
      Object.assign(grant, { bodyDigest: "f".repeat(64) });
      return old();
    },
  };
  assert.equal(
    (await run(publishGitHubComment(f.policy, f.filename, f.input, host)))
      .status,
    "acknowledged",
  );
  assert.equal(f.sent.length, 1);
});
