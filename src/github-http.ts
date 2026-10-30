import { Data } from "effect";

export class SourceError extends Data.TaggedError("SourceError")<{
  readonly code: string;
  readonly message: string;
}> {
  constructor(code: string, message: string) {
    super({ code, message });
  }
}

export type GitHubTransport = (request: Request) => Promise<Response>;
export const defaultGitHubTransport: GitHubTransport = (request) =>
  // Repeat the options at the fetch boundary: Bun 1.4.4 misreports the
  // Request.credentials getter even when its constructor receives "omit".
  fetch(request, { method: "GET", redirect: "error", credentials: "omit" });

export interface HttpLimits {
  maxRequests: number;
  maxResponseBytes: number;
  maxTotalResponseBytes: number;
  requestTimeoutMs: number;
  totalTimeoutMs: number;
}

export const HTTP_LIMITS: Readonly<HttpLimits> = Object.freeze({
  maxRequests: 650,
  maxResponseBytes: 2 * 1024 * 1024,
  maxTotalResponseBytes: 16 * 1024 * 1024,
  requestTimeoutMs: 10_000,
  totalTimeoutMs: 60_000,
});

export interface GitHubHttp {
  get(path: string): Promise<unknown>;
  readonly stats: { readonly requests: number; readonly responseBytes: number };
}

// Only locally constructed endpoints are accepted. No refs, returned URLs,
// pagination links, query expansion, credentials, fragments or encoded paths.
function endpoint(path: string): string {
  const parts =
    /^\/repos\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]+)(.*)$/.exec(
      path,
    );
  if (
    !parts ||
    parts[0] !== path ||
    path.length > 400 ||
    parts[2] === "." ||
    parts[2] === ".."
  )
    throw new SourceError("HTTP_ENDPOINT", "Unsupported GitHub API endpoint");
  const suffix = parts[3];
  const sha = "[a-f0-9]{40}";
  if (
    suffix !== "" &&
    !new RegExp(
      `^/commits/${sha}/check-runs\\?filter=all&per_page=100&page=[1-2]$`,
    ).test(suffix ?? "") &&
    !new RegExp(`^/commits/${sha}/status\\?per_page=100&page=[1-2]$`).test(
      suffix ?? "",
    ) &&
    !/^\/pulls\/[1-9][0-9]*$/.test(suffix ?? "") &&
    !/^\/(?:issues\/[1-9][0-9]*\/comments|pulls\/[1-9][0-9]*\/(?:reviews|comments))\?per_page=100&page=[1-2]$/.test(
      suffix ?? "",
    ) &&
    !new RegExp(`^/compare/${sha}\\.\\.\\.${sha}\\?per_page=1$`).test(
      suffix ?? "",
    ) &&
    !new RegExp(`^/git/(commits|blobs)/${sha}$`).test(suffix ?? "") &&
    !new RegExp(`^/git/trees/${sha}\\?recursive=1$`).test(suffix ?? "")
  )
    throw new SourceError("HTTP_ENDPOINT", "Unsupported GitHub API endpoint");
  return "https://api.github.com" + path;
}

function boundedLimits(overrides: Partial<HttpLimits>): HttpLimits {
  const limits = { ...HTTP_LIMITS, ...overrides };
  for (const key of Object.keys(HTTP_LIMITS) as (keyof HttpLimits)[]) {
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > HTTP_LIMITS[key]
    )
      throw new SourceError(
        "HTTP_LIMIT",
        "HTTP limits must be positive and cannot exceed hard bounds",
      );
  }
  return limits;
}

function abortError(signal: AbortSignal): SourceError {
  return signal.reason instanceof SourceError
    ? signal.reason
    : new SourceError("CANCELLED", "Source acquisition was cancelled");
}

// A deadline bounds even an injected transport that ignores AbortSignal.
function interruptible<A>(
  promise: Promise<A>,
  signal: AbortSignal,
): Promise<A> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function responseFailure(response: Response): SourceError | undefined {
  if ((response.status >= 300 && response.status < 400) || response.redirected)
    return new SourceError("HTTP_REDIRECT", "GitHub redirects are not allowed");
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after")))
  )
    return new SourceError(
      "HTTP_RATE_LIMIT",
      "GitHub API rate limit reached; no automatic retry was attempted",
    );
  if (response.status === 401 || response.status === 403)
    return new SourceError(
      "HTTP_PERMISSION",
      "GitHub did not permit public source acquisition",
    );
  if (response.status === 404)
    return new SourceError(
      "HTTP_NOT_FOUND",
      "GitHub source resource was not found",
    );
  if (response.status >= 500)
    return new SourceError(
      "HTTP_SERVER",
      "GitHub API is temporarily unavailable",
    );
  if (response.status !== 200)
    return new SourceError(
      "HTTP_STATUS",
      "GitHub API returned an unsupported status",
    );
  return undefined;
}

async function readJson(
  response: Response,
  signal: AbortSignal,
  limits: HttpLimits,
  stats: { requests: number; responseBytes: number },
): Promise<unknown> {
  const mediaType = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    cancelBody(response);
    throw new SourceError("HTTP_JSON", "GitHub API must return JSON");
  }
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) ||
      Number(declared) > limits.maxResponseBytes ||
      Number(declared) > limits.maxTotalResponseBytes - stats.responseBytes)
  ) {
    cancelBody(response);
    throw new SourceError(
      "HTTP_BYTES",
      "GitHub API response exceeds the byte budget",
    );
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new SourceError("HTTP_JSON", "GitHub API response has no JSON body");
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  let finished = false;
  try {
    if (signal.aborted) throw abortError(signal);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await interruptible(reader.read(), signal);
      if (signal.aborted) throw abortError(signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      stats.responseBytes += chunk.value.byteLength;
      if (
        size > limits.maxResponseBytes ||
        stats.responseBytes > limits.maxTotalResponseBytes
      )
        throw new SourceError(
          "HTTP_BYTES",
          "GitHub API response exceeds the byte budget",
        );
      chunks.push(chunk.value);
    }
    finished = true;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown;
    } catch {
      throw new SourceError(
        "HTTP_JSON",
        "GitHub API returned invalid JSON or UTF-8",
      );
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!finished) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Owns all deadlines/listeners and cancels unfinished reads when its scope ends. */
export async function withGitHubHttp<A>(
  transport: GitHubTransport,
  signal: AbortSignal,
  use: (http: GitHubHttp) => Promise<A>,
  overrides: Partial<HttpLimits> = {},
): Promise<A> {
  const limits = boundedLimits(overrides);
  const scope = new AbortController();
  const onAbort = () =>
    scope.abort(
      new SourceError("CANCELLED", "Source acquisition was cancelled"),
    );
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const timer = setTimeout(
    () =>
      scope.abort(
        new SourceError(
          "HTTP_TIMEOUT",
          "Source acquisition exceeded its total time budget",
        ),
      ),
    limits.totalTimeoutMs,
  );
  let active = true;
  const stats = { requests: 0, responseBytes: 0 };
  const http: GitHubHttp = {
    get stats() {
      return { ...stats };
    },
    async get(path) {
      if (!active)
        throw new SourceError(
          "HTTP_SCOPE",
          "Source acquisition scope is closed",
        );
      if (scope.signal.aborted) throw abortError(scope.signal);
      const url = endpoint(path);
      if (stats.requests >= limits.maxRequests)
        throw new SourceError(
          "HTTP_REQUESTS",
          "Source acquisition exceeded its request budget",
        );
      stats.requests += 1;
      const controller = new AbortController();
      const onScopeAbort = () => controller.abort(abortError(scope.signal));
      scope.signal.addEventListener("abort", onScopeAbort, { once: true });
      const requestTimer = setTimeout(
        () =>
          controller.abort(
            new SourceError(
              "HTTP_TIMEOUT",
              "GitHub API request exceeded its time budget",
            ),
          ),
        limits.requestTimeoutMs,
      );
      try {
        const request = new Request(url, {
          method: "GET",
          redirect: "error",
          credentials: "omit",
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "robodocks/0.0.1",
          },
          signal: controller.signal,
        });
        const pending = transport(request);
        // Dispose of a late response even if the transport ignored cancellation.
        void pending.then(
          (response) => {
            if (controller.signal.aborted) cancelBody(response);
          },
          () => undefined,
        );
        const response = await interruptible(pending, controller.signal);
        const failure = responseFailure(response);
        if (failure) {
          cancelBody(response);
          throw failure;
        }
        if (response.url !== "" && response.url !== url) {
          cancelBody(response);
          throw new SourceError(
            "HTTP_ORIGIN",
            "GitHub API response URL does not match the request",
          );
        }
        return await readJson(response, controller.signal, limits, stats);
      } catch (error) {
        if (controller.signal.aborted) throw abortError(controller.signal);
        if (error instanceof SourceError) throw error;
        throw new SourceError(
          "HTTP_NETWORK",
          "Could not acquire public source from GitHub",
        );
      } finally {
        clearTimeout(requestTimer);
        scope.signal.removeEventListener("abort", onScopeAbort);
      }
    },
  };
  try {
    if (scope.signal.aborted) throw abortError(scope.signal);
    return await interruptible(use(http), scope.signal);
  } finally {
    active = false;
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    scope.abort(
      new SourceError("HTTP_SCOPE", "Source acquisition scope is closed"),
    );
  }
}
