#!/usr/bin/env node
/**
 * Pull the freshest tokens from the capture and write them to
 * examples/.hevy-token.json (gitignored) so the web tester can use them.
 *
 *   node capture/use-latest-token.mjs
 *
 * Prefers a still-valid access token (lets you test reads without rotating —
 * and logging out — the app), and includes the latest refresh token as backup.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const capture = join(here, "flows", "hevy-capture.jsonl");
const out = join(here, "..", "examples", ".hevy-token.json");

const recs = readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Newest refresh_token response (full token set with expiry).
const refresh = recs
  .filter((r) => r.path.includes("/auth/refresh_token") && r.res_body)
  .map((r) => ({ ...JSON.parse(r.res_body), ts: r.ts }))
  .sort((a, b) => a.ts - b.ts)
  .at(-1);

// Newest Bearer access token seen on any authed request (does not rotate).
const bearer = recs
  .filter((r) => r.req_headers?.authorization?.startsWith("Bearer "))
  .sort((a, b) => a.ts - b.ts)
  .at(-1);

const token = {};
if (refresh) {
  token.refreshToken = refresh.refresh_token;
  token.accessToken = refresh.access_token;
  token.expiresAt = Date.parse(refresh.expires_at);
}
// A Bearer from a later request is fresher than the refresh response's access token.
if (bearer && (!token.expiresAt || bearer.ts * 1000 > token.expiresAt - 15 * 60_000)) {
  token.accessToken = bearer.req_headers.authorization.replace(/^Bearer /, "");
  // Access tokens last ~15 min; assume validity from the request time.
  token.expiresAt = Math.max(token.expiresAt ?? 0, bearer.ts * 1000 + 14 * 60_000);
}

if (!token.accessToken && !token.refreshToken) {
  console.error("No tokens found in capture. Open the Hevy app with the proxy running first.");
  process.exit(1);
}

writeFileSync(out, JSON.stringify(token, null, 2));
const valid = token.expiresAt && token.expiresAt > Date.now();
console.log("Wrote", out);
console.log("  refreshToken:", token.refreshToken ? "present" : "(none)");
console.log("  accessToken: ", token.accessToken ? "present" : "(none)", valid ? "(appears valid)" : "(may be expired)");
console.log("  expiresAt:   ", token.expiresAt ? new Date(token.expiresAt).toISOString() : "(unknown)");
