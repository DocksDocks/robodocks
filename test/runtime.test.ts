import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "@effect/vitest";

test("runtime is a stable Bun release meeting the reviewed baseline", () => {
  assert.ok(process.versions.bun, "Vitest workers must run in Bun, not Node");
  assert.equal(process.versions.bun, Bun.version);
  const pin = readFileSync(
    new URL("../.bun-version", import.meta.url),
    "utf8",
  ).trim();
  assert.match(
    pin,
    /^\d+\.\d+\.\d+$/,
    "Pin an exact reviewed stable Bun release",
  );
  assert.match(
    Bun.version,
    /^\d+\.\d+\.\d+$/,
    "Do not use a canary or prerelease runtime",
  );
  const [major, minor, patch] = pin.split(".").map(Number);
  const actual = Bun.version.split(".").map(Number);
  assert.equal(actual[0], major);
  assert.equal(actual[1], minor);
  assert.ok(
    actual[2] !== undefined && patch !== undefined && actual[2] >= patch,
  );
});
