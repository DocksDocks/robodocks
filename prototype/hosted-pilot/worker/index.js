// Generated from the unchanged D1 adapter and bounded pilot handler.
const PILOT_BUILD = "cfdef4919a466a8c4337883064276fdd6c5a7789110acd70d63a34136157965e";
export class NativeStorageError extends Error {
    code;
    constructor(code){
        super(code), this.code = code;
    }
}
function positive(value) {
    return Number.isSafeInteger(value) && value > 0;
}
export async function proposalKey(input) {
    const p = {
        ...input
    };
    if (typeof p.repository !== "string" || p.repository.length > 201 || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(p.repository) || typeof p.intentId !== "string" || p.intentId.length === 0 || p.intentId.length > 256 || ![
        p.repositoryId,
        p.pullRequest,
        p.pullRequestId,
        p.appId,
        p.installationId,
        p.botUserId
    ].every(positive) || typeof p.headSha !== "string" || !/^[a-f0-9]{40}$/.test(p.headSha) || typeof p.body !== "string" || new TextEncoder().encode(p.body).length > 65536 || typeof p.bodyDigest !== "string" || !/^[a-f0-9]{64}$/.test(p.bodyDigest) || p.rendererVersion !== "pr-conversation-published-v1") throw new NativeStorageError("INPUT");
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(p.body));
    const digest = Array.from(new Uint8Array(hash), (v)=>v.toString(16).padStart(2, "0")).join("");
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
        p.rendererVersion
    ]);
}
export class NativePublicationStore {
    db;
    constructor(db){
        this.db = db;
    }
    async execute(statements) {
        try {
            const result = await this.db.batch(statements);
            if (result.length !== statements.length || result.some((r)=>!r.success)) throw new Error("D1 result");
            return result;
        } catch  {
            throw new NativeStorageError("STORAGE_UNCERTAIN");
        }
    }
    async reserve(input) {
        const p = {
            ...input
        };
        const key = await proposalKey(p);
        const result = await this.execute([
            this.db.prepare(`
      INSERT INTO native_attempts (intent_id, proposal, status, comment_id)
      SELECT o.id, o.proposal, 'sending', NULL FROM native_outbox o
      JOIN native_findings f ON f.id = o.finding_id
      WHERE o.id = ? AND o.proposal = ? AND o.status = 'pending'
        AND f.status = 'proposed'
        AND EXISTS (SELECT 1 FROM native_control WHERE id = 1 AND quarantined = 0)
      ON CONFLICT(intent_id) DO NOTHING
    `).bind(p.intentId, key)
        ]);
        return result[0]?.meta.changes === 1;
    }
    async markUnknown(input) {
        const p = {
            ...input
        };
        const key = await proposalKey(p);
        const result = await this.execute([
            this.db.prepare(`
      UPDATE native_attempts SET status = 'unknown'
      WHERE intent_id = ? AND proposal = ? AND status = 'sending'
    `).bind(p.intentId, key)
        ]);
        return result[0]?.meta.changes === 1;
    }
    async acknowledge(input, evidence) {
        const p = {
            ...input
        };
        const e = {
            ...evidence
        };
        const key = await proposalKey(p);
        if (!positive(e.commentId) || e.repositoryId !== p.repositoryId || e.pullRequestId !== p.pullRequestId || e.botUserId !== p.botUserId || e.authorType !== "Bot" || e.body !== p.body || e.issueUrl !== `https://api.github.com/repos/${p.repository}/issues/${p.pullRequest}`) throw new NativeStorageError("INPUT");
        const reference = `github-comment:${e.commentId}`;
        const result = await this.execute([
            this.db.prepare(`UPDATE native_attempts SET status = 'acknowledged', comment_id = ?
        WHERE intent_id = ? AND proposal = ? AND status IN ('sending', 'unknown')
        AND EXISTS (SELECT 1 FROM native_outbox o JOIN native_findings f ON f.id = o.finding_id
          WHERE o.id = native_attempts.intent_id AND o.proposal = native_attempts.proposal
          AND o.status = 'pending' AND f.status = 'proposed')`).bind(e.commentId, p.intentId, key),
            this.db.prepare(`UPDATE native_outbox SET status = 'acknowledged', external_reference = ?
        WHERE id = ? AND status = 'pending' AND changes() = 1`).bind(reference, p.intentId),
            this.db.prepare(`UPDATE native_findings SET status = 'published'
        WHERE id = (SELECT finding_id FROM native_outbox WHERE id = ?)
        AND status = 'proposed' AND changes() = 1`).bind(p.intentId),
            this.db.prepare(`INSERT INTO native_transition_guard (id)
        SELECT 0 WHERE EXISTS (SELECT 1 FROM native_attempts a
          WHERE a.intent_id = ? AND a.status = 'acknowledged'
          AND NOT EXISTS (SELECT 1 FROM native_outbox o JOIN native_findings f ON f.id = o.finding_id
            WHERE o.id = a.intent_id AND o.proposal = a.proposal
              AND o.status = 'acknowledged'
              AND o.external_reference = 'github-comment:' || a.comment_id
              AND f.status = 'published'))`).bind(p.intentId)
        ]);
        return result[0]?.meta.changes === 1;
    }
    async read(intentId) {
        if (typeof intentId !== "string" || !intentId || intentId.length > 256) throw new NativeStorageError("INPUT");
        const result = await this.execute([
            this.db.prepare("SELECT intent_id, status, comment_id FROM native_attempts WHERE intent_id = ?").bind(intentId)
        ]);
        return result[0]?.results[0] ?? null;
    }
}

// Only deploy behind confirmed owner-only Sites dispatch. Service access is not
// visitor identity. No application secrets, network sender, or generic SQL API.
const FIXTURES = [
  "concurrent",
  "unknown",
  "failed-write",
  "rollback",
  "lost-response",
  "singleflight",
];
const BODY = "Synthetic hosted storage fixture. Never publish.";
const json = (value, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
async function fixture(name) {
  if (!FIXTURES.includes(name)) throw new Error("INVALID_FIXTURE");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(BODY),
  );
  return {
    intentId: "pilot-v1-" + name,
    repository: "synthetic/pilot",
    repositoryId: 1,
    pullRequest: 2,
    pullRequestId: 3,
    headSha: "a".repeat(40),
    appId: 4,
    installationId: 5,
    botUserId: 6,
    body: BODY,
    bodyDigest: Array.from(new Uint8Array(digest), (n) =>
      n.toString(16).padStart(2, "0"),
    ).join(""),
    rendererVersion: "pr-conversation-published-v1",
  };
}
async function seed(db) {
  const statements = [
    db.prepare(
      "INSERT INTO native_control (id, quarantined) VALUES (1, 0) ON CONFLICT(id) DO NOTHING",
    ),
  ];
  for (const name of FIXTURES) {
    const p = await fixture(name);
    statements.push(
      db
        .prepare(
          "INSERT INTO native_findings (id, status) VALUES (?, 'proposed') ON CONFLICT(id) DO NOTHING",
        )
        .bind(p.intentId),
    );
    statements.push(
      db
        .prepare(
          "INSERT INTO native_outbox (id, finding_id, proposal, status) VALUES (?, ?, ?, 'pending') ON CONFLICT(id) DO NOTHING",
        )
        .bind(p.intentId, p.intentId, await proposalKey(p)),
    );
  }
  await db.batch(statements);
}
async function snapshot(db) {
  const r = await db.batch([
    db.prepare("SELECT id, quarantined FROM native_control"),
    db.prepare(
      "SELECT intent_id, status, comment_id FROM native_attempts ORDER BY intent_id",
    ),
    db.prepare(
      "SELECT id, status, external_reference FROM native_outbox ORDER BY id",
    ),
    db.prepare("SELECT id, status FROM native_findings ORDER BY id"),
  ]);
  return {
    control: r[0].results,
    attempts: r[1].results,
    outbox: r[2].results,
    findings: r[3].results,
  };
}
async function record(db, name, evidence) {
  const committed = await db.batch([
    db
      .prepare(
        "UPDATE pilot_evidence SET evidence = ? WHERE name = ? AND evidence = ?",
      )
      .bind(
        JSON.stringify(evidence),
        name,
        JSON.stringify({ status: "running" }),
      ),
  ]);
  if (committed[0].meta.changes !== 1)
    throw new Error("EVIDENCE_NOT_COMMITTED");
  return evidence;
}
async function probe(db, name) {
  if (!FIXTURES.includes(name) || name === "concurrent")
    throw new Error("INVALID_PROBE");
  // Durable single-flight claim. Interrupted probes stay inconclusive; never
  // automatically clear their claim or pretend that a repeat is a fresh test.
  const claim = await db.batch([
    db
      .prepare(
        "INSERT INTO pilot_evidence (name, evidence) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
      )
      .bind(name, JSON.stringify({ status: "running" })),
  ]);
  if (claim[0].meta.changes !== 1) {
    const prior = await db.batch([
      db
        .prepare("SELECT evidence FROM pilot_evidence WHERE name = ?")
        .bind(name),
    ]);
    const evidence = JSON.parse(prior[0].results[0].evidence);
    if (evidence.status === "running")
      throw new NativeStorageError("STORAGE_UNCERTAIN");
    return { alreadyRecorded: true, evidence };
  }
  const p = await fixture(name),
    store = new NativePublicationStore(db);
  if (name === "unknown" || name === "singleflight") {
    const reserved = await store.reserve(p),
      marked = await store.markUnknown(p),
      retry = await store.reserve(p);
    return record(db, name, {
      reserved,
      marked,
      retry,
      state: await store.read(p.intentId),
    });
  }
  if (name === "failed-write") {
    const broken = new NativePublicationStore({
      prepare: (sql) => db.prepare(sql),
      batch: (stmts) =>
        db.batch([
          ...stmts,
          db.prepare("INSERT INTO native_transition_guard (id) VALUES (0)"),
        ]),
    });
    let failure;
    try {
      await broken.reserve(p);
    } catch (e) {
      failure = e.code;
    }
    const afterFailure = await store.read(p.intentId);
    return record(db, name, {
      failure,
      afterFailure,
      confirmedReservationAfterRollback: await store.reserve(p),
    });
  }
  if (name === "lost-response") {
    const lost = new NativePublicationStore({
      prepare: (sql) => db.prepare(sql),
      batch: async (stmts) => {
        await db.batch(stmts);
        throw new Error("Synthetic lost result");
      },
    });
    let failure;
    try {
      await lost.reserve(p);
    } catch (e) {
      failure = e.code;
    }
    return record(db, name, {
      injection: "committed-write-then-thrown-result-not-network-fault",
      failure,
      retry: await store.reserve(p),
      state: await store.read(p.intentId),
    });
  }
  if (name === "rollback") {
    const reserved = await store.reserve(p);
    const before = await snapshot(db);
    const broken = new NativePublicationStore({
      prepare: (sql) => db.prepare(sql),
      batch: (stmts) =>
        db.batch([
          ...stmts,
          db.prepare("INSERT INTO native_transition_guard (id) VALUES (0)"),
        ]),
    });
    let failure;
    try {
      await broken.acknowledge(p, {
        commentId: 7,
        repositoryId: 1,
        pullRequestId: 3,
        botUserId: 6,
        authorType: "Bot",
        body: BODY,
        issueUrl: "https://api.github.com/repos/synthetic/pilot/issues/2",
      });
    } catch (e) {
      failure = e.code;
    }
    const after = await snapshot(db);
    // Scope comparison to this fixture; unrelated concurrent callers may change others.
    const selected = (s) => ({
      a: s.attempts.filter((r) => r.intent_id === p.intentId),
      o: s.outbox.filter((r) => r.id === p.intentId),
      f: s.findings.filter((r) => r.id === p.intentId),
    });
    return record(db, name, {
      reserved,
      failure,
      before: selected(before),
      after: selected(after),
      unchanged:
        JSON.stringify(selected(before)) === JSON.stringify(selected(after)),
    });
  }
  throw new Error("INVALID_PROBE");
}
const HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Robodocks · Private storage pilot</title><style>*{box-sizing:border-box}body{margin:0;background:#101715;color:#e7eee9;font:16px/1.6 system-ui}main{max-width:920px;margin:0 auto;padding:56px 22px}small{color:#99b5a5;letter-spacing:.1em}h1{font-size:clamp(30px,6vw,48px);line-height:1.15;margin:18px 0}p{color:#b7c7be;max-width:65ch}.badge{display:inline-block;border:1px solid #42634f;border-radius:30px;padding:5px 12px;color:#b9e9c8;font-size:13px}section{border:1px solid #31433a;border-radius:14px;margin:26px 0;padding:22px;background:#17221c}h2{font-size:20px;margin:0 0 12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;color:#c5dacd}a{color:#b9e9c8}button{background:#c4e6ce;color:#132219;border:0;border-radius:6px;padding:10px 16px;font-weight:650;cursor:pointer}footer{color:#8ba395;font-size:13px}</style><main><small>ROBODOCKS / STORAGE LAB</small><h1>Private D1 pilot</h1><span class="badge">Synthetic data only · No publisher</span><p>A minimal view into the isolated storage experiment. No GitHub key, live comments, admission workflow, or operational activation is connected.</p><section><h2>Durable state</h2><p>This page only reads state. Verification probes are bounded, fixed-fixture operations. A successful storage transition is never permission to post.</p><button id="refresh">Refresh state</button><pre id="state" aria-live="polite">Loading…</pre></section><section><h2>What this does not prove</h2><p>Recorded injected failures are not real network partitions. A successful redeployment read does not establish disaster recovery or exactly-once delivery. Service access is not a verified owner-browser session.</p></section><footer>Owner-private access is enforced by Sites. Do not widen sharing while this pilot is active.</footer></main><script>async function load(){const el=document.querySelector('#state');try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw Error('Status unavailable');el.textContent=JSON.stringify(await r.json(),null,2)}catch(e){el.textContent='State unavailable. Sign in with the Site owner account and try again.'}}document.querySelector('#refresh').addEventListener('click',load);load();</script></html>`;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/")
      return new Response(HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self' https://chatgpt.com",
          "x-content-type-options": "nosniff",
        },
      });
    if (!env.DB) return json({ error: "STORAGE_UNAVAILABLE" }, 503);
    try {
      if (request.method === "GET" && url.pathname === "/api/status") {
        const rows = await env.DB.batch([
          env.DB.prepare(
            "SELECT name, evidence FROM pilot_evidence ORDER BY name",
          ),
        ]);
        return json({
          build: PILOT_BUILD,
          scope: "synthetic-no-post",
          identity: request.headers.has("oai-authenticated-user-id")
            ? "signed-in-visitor"
            : "no-visitor-identity",
          state: await snapshot(env.DB),
          evidence: rows[0].results.map((r) => ({
            name: r.name,
            evidence: JSON.parse(r.evidence),
          })),
        });
      }
      if (request.method !== "POST") return json({ error: "NOT_FOUND" }, 404);
      if (
        request.headers.get("x-robodocks-pilot") !== "synthetic-v1" ||
        request.headers.get("content-type") !== "application/json"
      )
        return json({ error: "REQUEST_REJECTED" }, 403);
      const origin = request.headers.get("origin"),
        site = request.headers.get("sec-fetch-site");
      if (
        (origin && origin !== url.origin) ||
        (site && !["same-origin", "none"].includes(site))
      )
        return json({ error: "CROSS_ORIGIN_REJECTED" }, 403);
      if (Number(request.headers.get("content-length") || 0) > 128)
        return json({ error: "BODY_TOO_LARGE" }, 413);
      // No caller payload is accepted; request bodies must be exactly the empty object.
      const reader = request.body?.getReader();
      let bytes = 0,
        chunks = [];
      if (reader)
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 128) {
            await reader.cancel();
            return json({ error: "BODY_TOO_LARGE" }, 413);
          }
          chunks.push(value);
        }
      const data = JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(chunks.flatMap((c) => [...c])),
        ),
      );
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        Object.keys(data).length
      )
        return json({ error: "PAYLOAD_REJECTED" }, 400);
      if (url.pathname === "/api/seed") {
        await seed(env.DB);
        return json({ seeded: true, fixtures: FIXTURES.length });
      }
      if (url.pathname === "/api/reserve/concurrent")
        return json({
          reserved: await new NativePublicationStore(env.DB).reserve(
            await fixture("concurrent"),
          ),
        });
      if (url.pathname.startsWith("/api/probe/"))
        return json(
          await probe(env.DB, url.pathname.slice("/api/probe/".length)),
        );
      return json({ error: "NOT_FOUND" }, 404);
    } catch (e) {
      return json(
        {
          error:
            e?.code === "STORAGE_UNCERTAIN"
              ? "STORAGE_UNCERTAIN"
              : "REQUEST_FAILED",
        },
        400,
      );
    }
  },
};
