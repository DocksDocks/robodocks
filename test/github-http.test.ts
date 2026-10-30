import assert from "node:assert/strict";
import { test } from "@effect/vitest";
import { vi } from "vitest";
import {
  defaultGitHubTransport,
  HTTP_LIMITS,
  SourceError,
  withGitHubHttp,
} from "../src/github-http.ts";
import type {
  GitHubHttp,
  GitHubTransport,
  HttpLimits,
} from "../src/github-http.ts";

const root = "/repos/example-owner/example-project";
const sha = "a".repeat(40);
const json = () => Response.json({ ok: true });
function run(
  transport: GitHubTransport,
  use: (http: GitHubHttp) => Promise<unknown> = (http) => http.get(root),
  limits: Partial<HttpLimits> = {},
  signal = new AbortController().signal,
) {
  return withGitHubHttp(transport, signal, use, limits);
}
async function fails(operation: Promise<unknown>, code: string) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof SourceError);
    assert.equal(error.code, code);
    assert.ok(!error.message.includes("private-secret"));
    return true;
  });
}
function responseStream(
  chunks: Uint8Array[],
  cancelled: () => void = () => undefined,
) {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
      cancel: cancelled,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

test("HTTP constructs only fixed-origin GET requests with safe fixed headers and no body", async () => {
  const seen: string[] = [];
  const transport: GitHubTransport = async (request) => {
    assert.equal(new URL(request.url).origin, "https://api.github.com");
    assert.equal(request.method, "GET");
    assert.equal(request.redirect, "error");
    assert.equal(request.body, null);
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(request.headers.get("cookie"), null);
    assert.equal(request.headers.get("accept"), "application/vnd.github+json");
    assert.equal(request.headers.get("x-github-api-version"), "2022-11-28");
    assert.equal(request.headers.get("user-agent"), "robodocks/0.0.1");
    seen.push(request.url);
    return Response.json({
      ok: true,
      url: "https://private-secret.invalid/raw",
    });
  };
  const paths = [
    root,
    `${root}/pulls/12`,
    `${root}/compare/${sha}...${sha}?per_page=1`,
    `${root}/git/commits/${sha}`,
    `${root}/git/trees/${sha}?recursive=1`,
    `${root}/git/blobs/${sha}`,
  ];
  await run(transport, async (http) => {
    for (const path of paths)
      assert.equal(((await http.get(path)) as { ok: boolean }).ok, true);
    assert.equal(http.stats.requests, paths.length);
    assert.ok(http.stats.responseBytes > 0);
  });
  assert.deepEqual(
    seen,
    paths.map((path) => "https://api.github.com" + path),
  );
});

test("default transport reapplies safe fetch options despite Bun Request.credentials getter bug", async () => {
  const request = new Request("https://api.github.com" + root);
  const mocked = vi.spyOn(globalThis, "fetch").mockResolvedValue(json());
  try {
    await defaultGitHubTransport(request);
    assert.equal(mocked.mock.calls.length, 1);
    assert.equal(mocked.mock.calls[0]?.[0], request);
    assert.deepEqual(mocked.mock.calls[0]?.[1], {
      method: "GET",
      redirect: "error",
      credentials: "omit",
    });
  } finally {
    mocked.mockRestore();
  }
});

test("HTTP rejects arbitrary origins, mutable refs, queries, credentials and encoded/traversal paths before transport", async () => {
  let calls = 0;
  for (const path of [
    "https://private-secret.invalid/repos/o/r",
    "//api.github.com/repos/o/r",
    "/repos/o/..",
    "/repos/o/.",
    "/repos/o/r/../r",
    "/repos/o/r%2Fother",
    "/repos/o/r\n",
    "/repos/o/r\r\n",
    "/repos/o/r#fragment",
    "/repos/o/r?token=private-secret",
    `${root}/contents/file`,
    `${root}/git/blobs/main`,
    `${root}/git/commits/${sha.toUpperCase()}`,
    `${root}/git/trees/${sha}`,
    `${root}/git/trees/${sha}?recursive=1&other=1`,
    `${root}/compare/main...${sha}?per_page=1`,
    `${root}/compare/${sha}...${sha}?per_page=100`,
    `${root}/pulls/0`,
    `${root}/pulls/1/comments`,
  ])
    await fails(
      run(
        async () => {
          calls += 1;
          return json();
        },
        (http) => http.get(path),
      ),
      "HTTP_ENDPOINT",
    );
  assert.equal(calls, 0);
});

test("HTTP rejects redirect responses and unexpected final response URLs without reading or following them", async () => {
  for (const status of [301, 302, 307, 308]) {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status, headers: { location: "https://private-secret.invalid" } },
    );
    await fails(
      run(async () => response),
      "HTTP_REDIRECT",
    );
    assert.equal(cancelled, true);
  }
  const redirected = json();
  Object.defineProperty(redirected, "redirected", { value: true });
  await fails(
    run(async () => redirected),
    "HTTP_REDIRECT",
  );
  for (const url of [
    "https://private-secret.invalid",
    "https://api.github.com" + root + "/pulls/1",
  ]) {
    const response = json();
    Object.defineProperty(response, "url", { value: url });
    await fails(
      run(async () => response),
      "HTTP_ORIGIN",
    );
  }
});

test("HTTP sanitizes permission, rate-limit, missing-resource, server and unexpected statuses without retrying", async () => {
  for (const [status, headers, code] of [
    [401, {}, "HTTP_PERMISSION"],
    [403, {}, "HTTP_PERMISSION"],
    [403, { "x-ratelimit-remaining": "0" }, "HTTP_RATE_LIMIT"],
    [403, { "retry-after": "private-secret" }, "HTTP_RATE_LIMIT"],
    [429, {}, "HTTP_RATE_LIMIT"],
    [404, {}, "HTTP_NOT_FOUND"],
    [500, {}, "HTTP_SERVER"],
    [503, {}, "HTTP_SERVER"],
    [201, {}, "HTTP_STATUS"],
  ] as const) {
    let calls = 0;
    await fails(
      run(async () => {
        calls += 1;
        return new Response("private-secret", { status, headers });
      }),
      code,
    );
    assert.equal(calls, 1);
  }
  await fails(
    run(async () => {
      throw new Error("private-secret network error");
    }),
    "HTTP_NETWORK",
  );
});

test("HTTP accepts UTF-8 JSON, preserves text, and rejects bad JSON, UTF-8 or media type", async () => {
  assert.deepEqual(
    await run(
      async () =>
        new Response('{"text":"é\\r\\n \\t"}', {
          headers: { "content-type": "Application/JSON; charset=utf-8" },
        }),
    ),
    { text: "é\r\n \t" },
  );
  for (const response of [
    new Response("private-secret"),
    new Response("private-secret", {
      headers: { "content-type": "application/json" },
    }),
    new Response(new Uint8Array([123, 255, 125]), {
      headers: { "content-type": "application/json" },
    }),
    new Response(null, { headers: { "content-type": "application/json" } }),
  ]) {
    await fails(
      run(async () => response),
      "HTTP_JSON",
    );
  }
});

test("HTTP enforces streamed and declared response byte caps and cancels rejected bodies", async () => {
  let cancelled = 0;
  await fails(
    run(
      async () =>
        responseStream(
          [new Uint8Array(5), new Uint8Array(5), new Uint8Array(5)],
          () => {
            cancelled += 1;
          },
        ),
      undefined,
      { maxResponseBytes: 8 },
    ),
    "HTTP_BYTES",
  );
  assert.equal(cancelled, 1);
  for (const length of ["100", "private-secret", "-1", "1.5"]) {
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled += 1;
        },
      }),
      {
        headers: {
          "content-type": "application/json",
          "content-length": length,
        },
      },
    );
    await fails(
      run(async () => response, undefined, { maxResponseBytes: 8 }),
      "HTTP_BYTES",
    );
  }
  assert.equal(cancelled, 5);
  const response = Response.json({ ok: true });
  response.headers.set("content-length", "1");
  await fails(
    run(async () => response, undefined, { maxResponseBytes: 8 }),
    "HTTP_BYTES",
  );
});

test("HTTP counts actual UTF-8 bytes, bounds aggregate bytes and cannot have counters reset by callers", async () => {
  let calls = 0;
  await fails(
    run(
      async () => {
        calls += 1;
        return Response.json("é");
      },
      async (http) => {
        await http.get(root);
        assert.deepEqual(http.stats, { requests: 1, responseBytes: 4 });
        Object.assign(http.stats, { requests: 0, responseBytes: 0 });
        await http.get(root);
      },
      { maxTotalResponseBytes: 7 },
    ),
    "HTTP_BYTES",
  );
  assert.equal(calls, 2);
  await fails(
    run(
      async () => json(),
      async (http) => {
        await http.get(root);
        await http.get(root);
      },
      { maxRequests: 1 },
    ),
    "HTTP_REQUESTS",
  );
});

test("HTTP limit overrides can only reduce positive integer hard limits", async () => {
  for (const key of Object.keys(HTTP_LIMITS) as (keyof HttpLimits)[]) {
    for (const value of [0, -1, NaN, Infinity, 1.5, HTTP_LIMITS[key] + 1]) {
      let called = false;
      await fails(
        run(
          async () => {
            called = true;
            return json();
          },
          undefined,
          { [key]: value },
        ),
        "HTTP_LIMIT",
      );
      assert.equal(called, false);
    }
  }
});

test("HTTP pre-cancellation avoids transport and post-scope access is rejected", async () => {
  const controller = new AbortController();
  controller.abort("private-secret reason");
  let called = false;
  await fails(
    run(
      async () => {
        called = true;
        return json();
      },
      undefined,
      {},
      controller.signal,
    ),
    "CANCELLED",
  );
  assert.equal(called, false);
  let retained: GitHubHttp | undefined;
  await run(
    async () => json(),
    async (http) => {
      retained = http;
    },
  );
  assert.ok(retained);
  await fails(retained.get(root), "HTTP_SCOPE");
});

test("HTTP cancellation aborts the request even when an injected transport never resolves", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const pending = run(
    (request) => {
      requestSignal = request.signal;
      controller.abort("private-secret reason");
      return new Promise<Response>(() => undefined);
    },
    undefined,
    {},
    controller.signal,
  );
  await fails(pending, "CANCELLED");
  assert.equal(requestSignal?.aborted, true);
});

test("HTTP request timeout bounds a non-cooperative transport and disposes a late response", async () => {
  let resolve: ((response: Response) => void) | undefined;
  let requestSignal: AbortSignal | undefined;
  await fails(
    run(
      (request) => {
        requestSignal = request.signal;
        return new Promise<Response>((done) => {
          resolve = done;
        });
      },
      undefined,
      { requestTimeoutMs: 10 },
    ),
    "HTTP_TIMEOUT",
  );
  assert.equal(requestSignal?.aborted, true);
  let cancelled = false;
  assert.ok(resolve);
  resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await Promise.resolve();
  assert.equal(cancelled, true);
});

test("HTTP total deadline bounds hung user work separately from individual requests", async () => {
  await fails(
    run(
      async () => json(),
      async (http) => {
        await http.get(root);
        return new Promise(() => undefined);
      },
      { totalTimeoutMs: 10 },
    ),
    "HTTP_TIMEOUT",
  );
});

test("HTTP request deadline and cancellation interrupt streaming and release its reader", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          if (cancel) controller.abort();
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    await fails(
      run(
        async () => response,
        undefined,
        { requestTimeoutMs: 10 },
        controller.signal,
      ),
      cancel ? "CANCELLED" : "HTTP_TIMEOUT",
    );
    await Promise.resolve();
    assert.equal(cancelled, true);
    assert.equal(response.body?.locked, false);
  }
});

test("HTTP total and request timers are cleaned up after successful scope completion", async () => {
  let signal: AbortSignal | undefined;
  await run(
    async (request) => {
      signal = request.signal;
      return json();
    },
    undefined,
    { totalTimeoutMs: 10, requestTimeoutMs: 10 },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(signal?.aborted, false);
});

test("check context allowlist accepts only exact SHA fixed queries and bounded page numbers", async () => {
  const paths = [
    `${root}/commits/${sha}/check-runs?filter=all&per_page=100&page=1`,
    `${root}/commits/${sha}/status?per_page=100&page=2`,
  ];
  await run(
    async () => json(),
    async (http) => {
      for (const path of paths) await http.get(path);
    },
  );
  for (const path of [
    paths[0]!.replace(sha, "main"),
    paths[0]!.replace("filter=all", "filter=latest"),
    paths[0]!.replace("&page=1", "&page=3"),
    paths[1]! + "&token=secret",
    `${root}/actions/runs/1/logs`,
    `${root}/check-runs/1`,
    `${root}/commits/${sha}/statuses?per_page=100&page=1`,
  ])
    await fails(
      run(
        async () => {
          throw new Error("Must not fetch");
        },
        (http) => http.get(path),
      ),
      "HTTP_ENDPOINT",
    );
});

test("internal stats observer is immutable and cannot mask successful HTTP cleanup", async () => {
  let observed: unknown;
  const result = await withGitHubHttp(
    async () => Response.json({ ok: true }),
    new AbortController().signal,
    (http) => http.get("/repos/example-owner/example-project"),
    {},
    (stats) => {
      observed = stats;
      assert(Object.isFrozen(stats));
      throw new Error("observer failure");
    },
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(observed, { requests: 1, responseBytes: 11 });
});
