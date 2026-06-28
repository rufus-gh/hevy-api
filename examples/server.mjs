#!/usr/bin/env node
/**
 * Local web app for exercising every HevyClient feature against the live API.
 *
 *   npm run build && node examples/server.mjs
 *   # then open http://localhost:5173
 *
 * Why a server? Browsers can't call api.hevyapp.com directly (CORS), and you
 * don't want your token in client-side JS. This server keeps the token
 * server-side and proxies each feature call to the Hevy client.
 *
 * Auth: set HEVY_REFRESH_TOKEN, or write examples/.hevy-token.json as
 * { "refreshToken": "..." }. Get one with `node capture/extract-token.mjs`.
 * The rotating refresh token is persisted back to that gitignored file.
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HevyClient } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(here, ".hevy-token.json");
const PORT = Number(process.env.PORT || 5173);

/**
 * Load auth. Preferred mode: stable saved-account credentials (userId + secret)
 * that never expire. Fallback: rotating refresh token from a prior capture.
 *
 * Priority order:
 *  1. HEVY_USER_ID + HEVY_SECRET env vars  (saved-account, persistent)
 *  2. examples/.hevy-token.json { userId, secret }  (saved-account, persistent)
 *  3. HEVY_REFRESH_TOKEN env var  (rotating token, expires)
 *  4. examples/.hevy-token.json { refreshToken / accessToken }  (rotating)
 */
function loadAuth() {
  if (process.env.HEVY_USER_ID && process.env.HEVY_SECRET) {
    return { savedAccount: { userId: process.env.HEVY_USER_ID, secret: process.env.HEVY_SECRET } };
  }
  if (existsSync(TOKEN_FILE)) {
    try {
      const t = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
      if (t.userId && t.secret) return { savedAccount: { userId: t.userId, secret: t.secret } };
      if (t.refreshToken || t.accessToken) return t;
    } catch (e) {
      console.error(`Failed to read ${TOKEN_FILE}: ${e.message}`);
    }
  }
  if (process.env.HEVY_REFRESH_TOKEN) return { refreshToken: process.env.HEVY_REFRESH_TOKEN };
  console.error(
    "No credentials found.\n" +
      "Preferred: write examples/.hevy-token.json with { userId, secret } for persistent login.\n" +
      "Fallback:  set HEVY_REFRESH_TOKEN or add { refreshToken } to that file.\n" +
      "Run: node capture/use-latest-token.mjs  to populate from a fresh capture.",
  );
  process.exit(1);
}

const auth = loadAuth();
const client = new HevyClient({
  savedAccount: auth.savedAccount,
  refreshToken: auth.refreshToken,
  accessToken: auth.accessToken,
  expiresAt: auth.expiresAt,
  onTokensRefreshed: (state) => {
    try {
      const existing = existsSync(TOKEN_FILE) ? JSON.parse(readFileSync(TOKEN_FILE, "utf8")) : {};
      writeFileSync(TOKEN_FILE, JSON.stringify({ ...existing, refreshToken: state.refreshToken, accessToken: state.accessToken, expiresAt: state.expiresAt }, null, 2));
    } catch { /* non-fatal */ }
  },
});

/**
 * Allowlist mapping API names → handlers. The frontend POSTs to /api/<name>
 * with a JSON body of arguments; only names in this map are callable.
 */
const handlers = {
  // read
  getAccount: () => client.getAccount(),
  getUserPreferences: () => client.getUserPreferences(),
  getCustomExercises: () => client.getCustomExercises(),
  getExerciseCatalog: (a = {}) => client.getExerciseCatalog({ includeFeed: !!a.includeFeed }),
  getExerciseTemplateUnits: () => client.getExerciseTemplateUnits(),
  getWorkoutCount: () => client.getWorkoutCount(),
  getUserWorkouts: (a = {}) => client.getUserWorkouts({ limit: a.limit ?? 5, offset: a.offset ?? 0 }),
  getWorkout: (a) => client.getWorkout(a.id),
  getFeedWorkouts: (a = {}) => client.getFeedWorkouts(a.beforeIndex),
  getRoutineFolders: () => client.getRoutineFolders(),
  getRoutines: () => client.getRoutines(),
  searchRoutines: (a) => client.searchRoutines(a.query ?? "", a.matchExercises ? { fields: ["title", "notes", "exercises"] } : {}),
  // write
  createCustomExercise: (a) =>
    client.createCustomExercise({
      title: a.title,
      exercise_type: a.exercise_type || "weight_reps",
      muscle_group: a.muscle_group || "biceps",
      equipment_category: a.equipment_category || "barbell",
    }),
  createRoutine: (a) => {
    // Nullish-coalesce so an explicit 0 weight/reps isn't replaced by the default.
    const num = (v, d) => (v === undefined || v === null || v === "" ? d : Number(v));
    const weight_kg = num(a.weight_kg, 20);
    const reps = num(a.reps, 10);
    return client.createRoutine({
      title: a.title,
      exercises: [
        {
          exercise_template_id: a.exercise_template_id,
          rest_seconds: 60,
          sets: [
            { index: 0, weight_kg, reps },
            { index: 1, weight_kg, reps },
          ],
        },
      ],
    });
  },
  deleteRoutine: (a) => client.deleteRoutine(a.id),
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const INDEX = join(here, "public", "index.html");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const html = readFileSync(INDEX);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    const name = url.pathname.slice("/api/".length);
    // Own-key check so prototype members (constructor, toString, …) aren't callable.
    if (!Object.prototype.hasOwnProperty.call(handlers, name)) {
      return sendJson(res, 404, { error: `Unknown method: ${name}` });
    }
    const handler = handlers[name];
    try {
      const args = await readBody(req);
      const result = await handler(args);
      return sendJson(res, 200, { ok: true, result: result ?? null });
    } catch (e) {
      return sendJson(res, 200, {
        ok: false,
        error: e.message,
        status: e.status ?? null,
        body: e.body ?? null,
        hint: /refresh token/i.test(e.message)
          ? "Your token is stale — re-capture one and update examples/.hevy-token.json."
          : undefined,
      });
    }
  }

  res.writeHead(404);
  res.end("Not found");
});

// Bind to loopback only — this proxy is authenticated and must stay local.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  Hevy API tester → http://localhost:${PORT}\n`);
});
