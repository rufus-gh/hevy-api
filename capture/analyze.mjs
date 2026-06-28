#!/usr/bin/env node
/**
 * Summarize captured Hevy traffic.
 *   node capture/analyze.mjs [path-to-jsonl]
 * Defaults to capture/flows/hevy-capture.jsonl
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? join(here, "flows", "hevy-capture.jsonl");

let lines;
try {
  lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
} catch (e) {
  console.error(`Could not read ${file}: ${e.message}`);
  process.exit(1);
}

const records = lines.map((l) => JSON.parse(l));
const endpoints = new Map();

for (const r of records) {
  // Normalize path: strip query, replace UUIDs/ids with :id
  const path = r.path.split("?")[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\/\d+(?=\/|$)/g, "/:n");
  const key = `${r.method} ${r.host}${path}`;
  const entry = endpoints.get(key) ?? { count: 0, statuses: new Set(), sample: r };
  entry.count++;
  entry.statuses.add(r.status);
  endpoints.set(key, entry);
}

console.log(`\n${records.length} requests captured across ${endpoints.size} endpoints:\n`);
const sorted = [...endpoints.entries()].sort((a, b) => a[0].localeCompare(b[0]));
for (const [key, e] of sorted) {
  console.log(`  ${key}  (x${e.count}, status ${[...e.statuses].join("/")})`);
}

// Surface which headers look like auth so we know what to send.
const authHeaders = new Set();
for (const r of records) {
  for (const h of Object.keys(r.req_headers ?? {})) {
    if (/auth|token|key|session|bearer/i.test(h)) authHeaders.add(h.toLowerCase());
  }
}
console.log(`\nLikely auth-related request headers: ${[...authHeaders].join(", ") || "(none seen)"}`);
console.log(`\nFull detail is in ${file}`);
