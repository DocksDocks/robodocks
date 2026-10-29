import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Writable } from "node:stream";
import { Effect, Exit } from "effect";
import { withReviewer } from "./reviewer.ts";
import { inspectLedger } from "./inspection.ts";
import { ContractError, requireCondition } from "./validation.ts";

const usage =
  "Usage: bun src/cli.ts plan --policy <policy.json> --input <review.json> --database <ledger.sqlite>\n" +
  "       bun src/cli.ts inspect --policy <policy.json> --database <existing-ledger.sqlite> --repository <owner/repo> [--status proposed|published|closed|all] [--limit 1..100] [--cursor <cursor>]\n" +
  "The legacy flags-only form is an alias for plan. Inspection defaults to proposed and limit 20.";

let activeOperation: "plan" | "inspect" | undefined;

function parseArguments(args: string[]) {
  const operation = args[0] === "inspect" ? "inspect" : "plan";
  const flags =
    args[0] === "plan" || args[0] === "inspect" ? args.slice(1) : args;
  const allowed =
    operation === "plan"
      ? ["--policy", "--input", "--database"]
      : [
          "--policy",
          "--database",
          "--repository",
          "--status",
          "--limit",
          "--cursor",
        ];
  const values = new Map<string, string>();
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index];
    const value = flags[index + 1];
    requireCondition(
      key &&
        allowed.includes(key) &&
        !values.has(key) &&
        value &&
        !value.startsWith("--"),
      "USAGE",
      usage,
    );
    values.set(key, value);
  }
  const policyPath = values.get("--policy");
  const databasePath = values.get("--database");
  requireCondition(policyPath && databasePath, "USAGE", usage);
  if (operation === "plan") {
    const inputPath = values.get("--input");
    requireCondition(inputPath, "USAGE", usage);
    return { operation, policyPath, databasePath, inputPath } as const;
  }
  const repository = values.get("--repository");
  const limit = values.get("--limit") ?? "20";
  requireCondition(repository && /^[0-9]+$/.test(limit), "USAGE", usage);
  const cursor = values.get("--cursor");
  return {
    operation,
    policyPath,
    databasePath,
    query: {
      repository,
      status: values.get("--status") ?? "proposed",
      limit: Number(limit),
      ...(cursor === undefined ? {} : { cursor }),
    },
  } as const;
}

function writeText(
  stream: Writable,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const removeAbort = () => signal?.removeEventListener("abort", onAbort);
    const onError = (error: Error) => {
      removeAbort();
      reject(error);
    };
    const onAbort = () => {
      stream.destroy();
      removeAbort();
      reject(new Error("Output interrupted"));
    };
    // A failed write callback can precede its error event. Keep this once-listener
    // in that case so the later event cannot become an uncaught exception.
    stream.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      stream.write(text, (error?: Error | null) => {
        removeAbort();
        if (error) {
          reject(error);
          return;
        }
        stream.removeListener("error", onError);
        resolve();
      });
    } catch (error) {
      removeAbort();
      reject(error);
    }
  });
}

function output(text: string) {
  return Effect.tryPromise({
    try: (signal) => writeText(process.stdout, text, signal),
    catch: () =>
      new ContractError(
        "OUTPUT",
        activeOperation === "plan"
          ? "Could not write review output; the delivery may already be committed"
          : activeOperation === "inspect"
            ? "Could not write inspection output; no delivery was admitted"
            : "Could not write output; no delivery was admitted",
      ),
  });
}

async function reportFailure(error: string, message: string): Promise<void> {
  // If stderr is also unavailable, retain the exit status without a raw stack.
  await writeText(
    process.stderr,
    JSON.stringify({ error, message }) + "\n",
  ).catch(() => undefined);
}

function readJson(path: string): Effect.Effect<unknown, ContractError> {
  return Effect.tryPromise({
    try: async () => {
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 2 * 1024 * 1024)
          throw new ContractError(
            "INPUT_SIZE",
            "input must be a regular JSON file of at most two MiB",
          );
        const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(
            buffer,
            length,
            buffer.length - length,
            null,
          );
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length === buffer.length)
          throw new ContractError("INPUT_SIZE", "input exceeds two MiB");
        try {
          const value: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              buffer.subarray(0, length),
            ),
          );
          return value;
        } catch {
          throw new ContractError("JSON", "input must contain valid JSON");
        }
      } finally {
        await handle.close();
      }
    },
    catch: (error) =>
      error instanceof ContractError
        ? error
        : new ContractError(
            "INPUT",
            "Could not read input files; check paths and permissions",
          ),
  });
}

const main = Effect.gen(function* () {
  const args = process.argv.slice(2);
  if (
    (args.length === 1 && args[0] === "--help") ||
    (args.length === 2 &&
      ["plan", "inspect"].includes(args[0] ?? "") &&
      args[1] === "--help")
  ) {
    yield* output(usage + "\n");
    return;
  }
  const options = yield* Effect.try({
    try: () => parseArguments(args),
    catch: () => new ContractError("USAGE", usage),
  });
  activeOperation = options.operation;
  const policy = yield* readJson(options.policyPath);
  const result =
    options.operation === "inspect"
      ? yield* inspectLedger(policy, options.databasePath, options.query)
      : yield* Effect.gen(function* () {
          const input = yield* readJson(options.inputPath);
          return yield* withReviewer(policy, options.databasePath, (reviewer) =>
            Effect.gen(function* () {
              const plan = yield* reviewer.plan(input);
              return {
                schemaVersion: 1,
                operation: "plan",
                plan: {
                  ...plan,
                  intents: plan.intents.map(
                    ({ id, findingId, kind, dryRun, status }) => ({
                      id,
                      findingId,
                      kind,
                      dryRun,
                      status,
                    }),
                  ),
                },
                storage: reviewer.storage,
              };
            }),
          );
        });
  // Let signals queued during a synchronous native call reach AbortController.
  // An already committed transaction is not rolled back by late interruption.
  yield* Effect.sleep("1 millis");
  yield* output(JSON.stringify(result, null, 2) + "\n");
});

const controller = new AbortController();
let interruptionCode = 130;
const onInterrupt = () => {
  interruptionCode = 130;
  controller.abort();
};
const onTerminate = () => {
  interruptionCode = 143;
  controller.abort();
};
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onTerminate);
try {
  const exit = await Effect.runPromiseExit(
    main.pipe(
      Effect.matchEffect({
        onSuccess: () => Effect.void,
        onFailure: (error) =>
          Effect.gen(function* () {
            yield* Effect.sleep("1 millis");
            process.exitCode = 1;
            yield* Effect.promise(() =>
              reportFailure(error.code, error.message),
            );
          }),
      }),
    ),
    { signal: controller.signal },
  );
  if (Exit.hasInterrupts(exit)) {
    process.exitCode = interruptionCode;
    await reportFailure(
      "INTERRUPTED",
      activeOperation === "plan"
        ? "Reviewer interrupted; an in-flight delivery may already be committed"
        : "Operation interrupted; no delivery was admitted",
    );
  } else if (Exit.isFailure(exit)) {
    process.exitCode = 1;
    await reportFailure("INTERNAL", "Unexpected reviewer failure");
  }
} finally {
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onTerminate);
}
