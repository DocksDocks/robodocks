import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

if (!process.versions.bun) {
  throw new Error("Use bun run test: Vitest and its workers require Bun.");
}

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    maxWorkers: Math.min(3, availableParallelism()),
    isolate: true,
    sequence: { concurrent: false },
    testTimeout: 10_000,
  },
});
