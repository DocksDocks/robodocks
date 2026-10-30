#!/usr/bin/env bun
import { version } from "../package.json";

if (process.argv.length === 3 && process.argv[2] === "--version") {
  process.stdout.write(version + "\n");
} else {
  await import("../src/cli.ts");
}
