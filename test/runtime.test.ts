import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("runtime is an LTS release within the pinned major and minimum", () => {
  const pin = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();
  assert.match(pin, /^\d+\.\d+\.\d+$/, ".nvmrc must pin an exact reviewed release");
  const minimum = pin.split(".").map(Number);
  const current = process.versions.node.split(".").map(Number);
  assert.equal(current[0], minimum[0], `Use Node ${pin} LTS or a later LTS release in the same major`);
  assert.ok(current[1]! > minimum[1]! || (current[1] === minimum[1] && current[2]! >= minimum[2]!), `Use Node ${pin} or newer`);
  assert.ok(process.release.lts, "Use an official LTS release, not Current or a prerelease");
});
