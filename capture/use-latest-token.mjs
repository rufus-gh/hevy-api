#!/usr/bin/env node
/**
 * Pull the freshest tokens from the capture and write them to
 * examples/.hevy-token.json (gitignored) so the web tester can use them,
 * and automatically search/update any other files (like ~/.hevy-mcp/token.json
 * and any workspace .env or JSON files) containing Hevy tokens.
 *
 *   node capture/use-latest-token.mjs
 *
 * Prefers a still-valid access token (lets you test reads without rotating —
 * and logging out — the app), and includes the latest refresh token as backup.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(here, "..");
const capture = join(here, "flows", "hevy-capture.jsonl");

const recs = readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Stable saved-account credentials from any login_with_saved_account request.
// The secret never rotates so we only need one; grab the latest.
const savedAccountRec = recs
  .filter((r) => r.path?.includes("login_with_saved_account") && r.req_body)
  .sort((a, b) => a.ts - b.ts)
  .at(-1);
const savedAccount = savedAccountRec ? JSON.parse(savedAccountRec.req_body) : null;

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

const updatedFiles = new Set();

// Helper to update a JSON token file
function updateJsonTokenFile(filePath) {
  try {
    let existing = {};
    if (existsSync(filePath)) {
      try {
        existing = JSON.parse(readFileSync(filePath, "utf8"));
      } catch {
        // Overwrite if malformed
      }
    }
    const updated = {
      ...existing,
      // Persistent saved-account credentials (preferred — never expire).
      ...(savedAccount?.userId ? { userId: savedAccount.userId } : {}),
      ...(savedAccount?.secret ? { secret: savedAccount.secret } : {}),
      // Rotating tokens as fallback.
      refreshToken: token.refreshToken ?? existing.refreshToken,
      accessToken: token.accessToken ?? existing.accessToken,
      expiresAt: token.expiresAt ?? existing.expiresAt,
    };
    const updatedStr = JSON.stringify(updated, null, 2);
    const existingStr = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
    if (updatedStr !== existingStr) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, updatedStr);
      updatedFiles.add(filePath);
    }
  } catch (e) {
    console.error(`Failed to update JSON file ${filePath}:`, e.message);
  }
}

// Helper to update a .env file
function updateEnvFile(filePath) {
  try {
    if (!existsSync(filePath)) return;
    let content = readFileSync(filePath, "utf8");
    let changed = false;

    if (token.refreshToken && content.includes("HEVY_REFRESH_TOKEN")) {
      const newContent = content.replace(/(HEVY_REFRESH_TOKEN\s*=\s*['"]?)[^'"\r\n]*(['"]?)/g, `$1${token.refreshToken}$2`);
      if (newContent !== content) {
        content = newContent;
        changed = true;
      }
    }
    if (token.accessToken && content.includes("HEVY_ACCESS_TOKEN")) {
      const newContent = content.replace(/(HEVY_ACCESS_TOKEN\s*=\s*['"]?)[^'"\r\n]*(['"]?)/g, `$1${token.accessToken}$2`);
      if (newContent !== content) {
        content = newContent;
        changed = true;
      }
    }

    if (changed) {
      writeFileSync(filePath, content);
      updatedFiles.add(filePath);
    }
  } catch (e) {
    console.error(`Failed to update environment file ${filePath}:`, e.message);
  }
}

// Recursively find all candidate files in the workspace
function findFilesToUpdate(dir) {
  const ignoredDirs = ["node_modules", ".git", "dist", "capture/flows"];
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  for (const file of files) {
    const fullPath = join(dir, file);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (!ignoredDirs.includes(file)) {
        findFilesToUpdate(fullPath);
      }
    } else if (file.endsWith(".json")) {
      try {
        const content = readFileSync(fullPath, "utf8");
        if (content.includes("refreshToken") || content.includes("accessToken")) {
          const json = JSON.parse(content);
          if (json && typeof json === "object" && ("refreshToken" in json || "accessToken" in json)) {
            updateJsonTokenFile(fullPath);
          }
        }
      } catch {
        // Ignore
      }
    } else if (file === ".env" || file.startsWith(".env.")) {
      updateEnvFile(fullPath);
    }
  }
}

// 1. Update the known/default files
const defaultJsonFiles = [
  join(workspaceRoot, "examples", ".hevy-token.json"),
  join(homedir(), ".hevy-mcp", "token.json"),
];
if (process.env.HEVY_TOKEN_FILE) {
  defaultJsonFiles.push(process.env.HEVY_TOKEN_FILE);
}
for (const f of defaultJsonFiles) {
  updateJsonTokenFile(f);
}

// 2. Scan the workspace for other files that might have the token written
findFilesToUpdate(workspaceRoot);

// Print summary
const valid = token.expiresAt && token.expiresAt > Date.now();
if (updatedFiles.size > 0) {
  console.log("Automatically updated tokens in these files:");
  for (const f of updatedFiles) {
    console.log(`  - ${f}`);
  }
} else {
  console.log("Tokens are already up-to-date in all target files.");
}
if (savedAccount?.userId) {
  console.log("  savedAccount:", `userId ${savedAccount.userId.slice(0, 8)}… secret present (persistent auth)`);
} else {
  console.log("  savedAccount: (none found — open Hevy app once with proxy to capture it)");
}
console.log("  refreshToken:", token.refreshToken ? "present" : "(none)");
console.log("  accessToken: ", token.accessToken ? "present" : "(none)", valid ? "(appears valid)" : "(may be expired)");
console.log("  expiresAt:   ", token.expiresAt ? new Date(token.expiresAt).toISOString() : "(unknown)");

