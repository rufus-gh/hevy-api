#!/usr/bin/env node
/**
 * Pull the auth tokens out of a capture so you can use them with HevyClient.
 *   node capture/extract-token.mjs
 *
 * Prints the latest refresh token (and a still-valid access token if present).
 * The refresh token is what you pass to `new HevyClient({ refreshToken })`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? join(here, "flows", "hevy-capture.jsonl");
const recs = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Most recent refresh_token response wins (tokens rotate).
const refreshes = recs
  .filter((r) => r.path.includes("/auth/refresh_token") && r.res_body)
  .map((r) => JSON.parse(r.res_body))
  .sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));

const latest = refreshes.at(-1);

if (!latest) {
  // Fall back to a Bearer header if no refresh response was captured.
  const authed = recs.reverse().find((r) => r.req_headers?.authorization);
  if (authed) {
    console.log("No /auth/refresh_token response captured, but found a Bearer access token:");
    console.log("  access_token:", authed.req_headers.authorization.replace(/^Bearer /, ""));
    console.log("\n⚠️  Access tokens expire in minutes. Capture an app launch to record a");
    console.log("    refresh_token response, which the client can use long-term.");
  } else {
    console.log("No tokens found in", file);
  }
  process.exit(0);
}

const valid = Date.parse(latest.expires_at) > Date.now();
console.log("user_id:      ", latest.user_id);
console.log("refresh_token:", latest.refresh_token);
console.log("access_token: ", latest.access_token, valid ? "(still valid)" : "(expired)");
console.log("expires_at:   ", latest.expires_at);
console.log("\nUse it like:\n");
console.log(`  import { HevyClient } from "hevy-api";`);
console.log(`  const client = new HevyClient({ refreshToken: "${latest.refresh_token}" });`);
console.log(`  console.log(await client.getAccount());`);
console.log("\n⚠️  The refresh token rotates on each use. Persist the new one via");
console.log("    onTokensRefreshed, and note that using it here may log out the app session.");
