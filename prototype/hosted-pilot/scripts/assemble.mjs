import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { createHash } from "node:crypto";
const adapter = readFileSync(
  new URL("../../d1/storage.ts", import.meta.url),
  "utf8",
);
const handler = readFileSync(
  new URL("../worker/handler.js", import.meta.url),
  "utf8",
);
const hash = createHash("sha256").update(adapter).update(handler).digest("hex");
writeFileSync(
  new URL("../worker/index.js", import.meta.url),
  `// Generated from the unchanged D1 adapter and bounded pilot handler.\nconst PILOT_BUILD = ${JSON.stringify(hash)};\n` +
    stripTypeScriptTypes(adapter, { mode: "transform" }) +
    "\n" +
    handler,
);
console.log(JSON.stringify({ workerSourceDigest: hash }));
