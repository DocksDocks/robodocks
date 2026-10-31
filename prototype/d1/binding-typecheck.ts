import type { D1Database } from "@cloudflare/workers-types";
import type { PrimaryD1 } from "./storage.ts";

// Compile-time compatibility with the official Cloudflare Worker D1 binding.
export function verifyBindingShape(database: D1Database): PrimaryD1 {
  return database;
}
