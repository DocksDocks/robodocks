import { open } from "node:fs/promises";
import { Effect, Exit } from "effect";
import { withReviewer } from "./reviewer.ts";
import { ContractError } from "./validation.ts";

const usage =
  "Usage: bun src/cli.ts --policy <operator-policy.json> --input <review-request.json> --database <local-ledger.sqlite>";

function readJson(path: string): Effect.Effect<unknown, ContractError> {
  return Effect.tryPromise({
    try: async () => {
      const handle = await open(path, "r");
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
            buffer.subarray(0, length).toString("utf8"),
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
    process.stdout.write(usage + "\n");
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
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
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
      Effect.match({
        onSuccess: () => undefined,
        onFailure: (error) => {
          process.stderr.write(
            JSON.stringify({ error: error.code, message: error.message }) +
              "\n",
          );
          process.exitCode = 1;
        },
      }),
    ),
    { signal: controller.signal },
  );
  if (Exit.hasInterrupts(exit)) {
    process.stderr.write(
      JSON.stringify({
        error: "INTERRUPTED",
        message: "Reviewer interrupted",
      }) + "\n",
    );
    process.exitCode = interruptionCode;
  } else if (Exit.isFailure(exit)) {
    process.stderr.write(
      JSON.stringify({
        error: "INTERNAL",
        message: "Unexpected reviewer failure",
      }) + "\n",
    );
    process.exitCode = 1;
  }
} finally {
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onTerminate);
}
