import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Writable } from "node:stream";
import { Effect, Exit } from "effect";
import { withReviewer } from "./reviewer.ts";
import { ContractError } from "./validation.ts";

const usage =
  "Usage: bun src/cli.ts --policy <operator-policy.json> --input <review-request.json> --database <local-ledger.sqlite>";

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
        "Could not write review output; the delivery may already be committed",
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
  if (args.length === 1 && args[0] === "--help") {
    yield* output(usage + "\n");
    return;
  }
  if (
    args.length !== 6 ||
    args[0] !== "--policy" ||
    args[2] !== "--input" ||
    args[4] !== "--database" ||
    args[1]?.startsWith("--") ||
    args[3]?.startsWith("--") ||
    args[5]?.startsWith("--")
  ) {
    return yield* Effect.fail(new ContractError("USAGE", usage));
  }
  const policyPath = args[1];
  const inputPath = args[3];
  const databasePath = args[5];
  if (!policyPath || !inputPath || !databasePath)
    return yield* Effect.fail(new ContractError("USAGE", usage));
  const policy = yield* readJson(policyPath);
  const input = yield* readJson(inputPath);
  const result = yield* withReviewer(policy, databasePath, (reviewer) =>
    Effect.gen(function* () {
      const plan = yield* reviewer.plan(input);
      const snapshot = yield* reviewer.snapshot();
      return { plan, snapshot, storage: reviewer.storage };
    }),
  );
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
      "Reviewer interrupted; an in-flight delivery may already be committed",
    );
  } else if (Exit.isFailure(exit)) {
    process.exitCode = 1;
    await reportFailure("INTERNAL", "Unexpected reviewer failure");
  }
} finally {
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onTerminate);
}
