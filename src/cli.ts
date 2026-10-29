import { open } from "node:fs/promises";
import { Reviewer } from "./reviewer.ts";
import { ContractError } from "./validation.ts";

const usage = "Usage: node src/cli.ts --policy <operator-policy.json> --input <review-request.json>";

async function readJson(path: string): Promise<unknown> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new ContractError("INPUT_SIZE", "input must be a regular JSON file of at most two MiB");
    // A bounded read also protects against a file growing after the stat call.
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length === buffer.length) throw new ContractError("INPUT_SIZE", "input exceeds two MiB");
    try {
      return JSON.parse(buffer.subarray(0, length).toString("utf8"));
    } catch {
      throw new ContractError("JSON", "input must contain valid JSON");
    }
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (args.length !== 4 || args[0] !== "--policy" || args[2] !== "--input" || args[1]!.startsWith("--") || args[3]!.startsWith("--")) {
    throw new ContractError("USAGE", usage);
  }
  const reviewer = new Reviewer(await readJson(args[1]!));
  const plan = reviewer.plan(await readJson(args[3]!));
  process.stdout.write(`${JSON.stringify({ plan, snapshot: reviewer.snapshot() }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const report = error instanceof ContractError
    ? { error: error.code, message: error.message }
    : { error: "INPUT", message: "Could not read input files; check paths and permissions" };
  process.stderr.write(`${JSON.stringify(report)}\n`);
  process.exitCode = 1;
});
