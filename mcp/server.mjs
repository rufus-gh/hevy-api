#!/usr/bin/env node
/**
 * MCP server for the Hevy API.
 *
 * Lets an MCP client (Claude Desktop / Claude Code) design a workout plan and
 * push it to Hevy as a routine, **prioritising exercises you already have over
 * creating new custom ones**: each planned exercise is fuzzy-matched against a
 * catalog built from your custom exercises + routines + workout history, and a
 * custom exercise is created only when nothing matches.
 *
 * Auth: set HEVY_REFRESH_TOKEN, or point HEVY_TOKEN_FILE at a JSON file
 * containing { "refreshToken": "...", "accessToken"?, "expiresAt"? }.
 * Rotated tokens are persisted back to the token file.
 *
 * All logging goes to stderr — stdout is reserved for the MCP protocol.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HevyClient, findBestMatch } from "../dist/index.js";

const log = (...a) => console.error("[hevy-mcp]", ...a);

// ---- Auth ----
const TOKEN_FILE = process.env.HEVY_TOKEN_FILE || join(homedir(), ".hevy-mcp", "token.json");

/**
 * Priority order:
 *  1. HEVY_USER_ID + HEVY_SECRET env vars  (saved-account, persistent)
 *  2. TOKEN_FILE { userId, secret }          (saved-account, persistent)
 *  3. HEVY_REFRESH_TOKEN env var             (rotating, expires)
 *  4. TOKEN_FILE { refreshToken / accessToken }
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
    } catch {
      /* fall through */
    }
  }
  if (process.env.HEVY_REFRESH_TOKEN) return { refreshToken: process.env.HEVY_REFRESH_TOKEN };
  log(`No credentials. Add { "userId": "...", "secret": "..." } to ${TOKEN_FILE} for persistent login.`);
  process.exit(1);
}

function persist(state) {
  try {
    mkdirSync(dirname(TOKEN_FILE), { recursive: true });
    const existing = existsSync(TOKEN_FILE) ? JSON.parse(readFileSync(TOKEN_FILE, "utf8")) : {};
    writeFileSync(TOKEN_FILE, JSON.stringify({ ...existing, refreshToken: state.refreshToken, accessToken: state.accessToken, expiresAt: state.expiresAt }, null, 2));
  } catch (e) {
    log("could not persist token:", e.message);
  }
}

const auth = loadAuth();
const client = new HevyClient({
  savedAccount: auth.savedAccount,
  refreshToken: auth.refreshToken,
  accessToken: auth.accessToken,
  expiresAt: auth.expiresAt,
  onTokensRefreshed: persist,
});

// ---- Exercise catalog (cached for the process lifetime) ----
// Seeded with Hevy's full bundled default library (~140 exercises) plus the
// user's custom exercises, routines and history. `includeFeed` additionally
// mines the social feed for defaults the user has never used themselves.
let catalogCache = null;
async function catalog({ force = false, includeFeed = false } = {}) {
  if (!catalogCache || force) catalogCache = await client.getExerciseCatalog({ includeFeed });
  return catalogCache;
}

// ---- MCP server ----
const server = new McpServer(
  { name: "hevy", version: "0.1.0" },
  {
    instructions:
      "Tools for designing workouts and saving them to Hevy. list_exercises returns " +
      "Hevy's full built-in exercise library (~140 default exercises) plus your custom " +
      "ones — use it to browse or pick exact exercises. To add a plan, call create_routine " +
      "with a list of exercises by name; the server matches each name against that whole " +
      "library before creating a new custom exercise, so existing exercises are reused.",
  },
);

// Valid Hevy enums (cable exercises use "machine"; there is no generic "other"
// muscle group). Provided values are validated at the protocol layer.
const MUSCLE_GROUPS = [
  "abdominals", "abductors", "adductors", "biceps", "calves", "cardio", "chest",
  "forearms", "full_body", "glutes", "hamstrings", "lats", "lower_back", "neck",
  "quadriceps", "shoulders", "traps", "triceps", "upper_back",
];
const EQUIPMENT = [
  "none", "barbell", "dumbbell", "kettlebell", "machine", "plate", "resistance_band", "suspension_system", "other",
];
const EXERCISE_TYPES = ["weight_reps", "bodyweight_reps", "reps_only", "duration", "distance", "weight_distance"];

const setSchema = z.object({
  weight_kg: z.number().optional().describe("Target weight in kg"),
  reps: z.number().int().optional().describe("Target reps"),
  duration_seconds: z.number().optional().describe("For timed exercises"),
  distance_meters: z.number().optional().describe("For distance exercises"),
  rpe: z.number().optional().describe("Rate of perceived exertion (optional)"),
  indicator: z.enum(["normal", "warmup", "drop", "failure"]).default("normal"),
});

const exerciseSchema = z.object({
  name: z.string().describe("Exercise name, e.g. 'Barbell Bench Press'. Matched against existing exercises."),
  exercise_template_id: z
    .string()
    .optional()
    .describe("Skip matching and use this exact template id (from list_exercises)."),
  muscle_group: z
    .enum(MUSCLE_GROUPS)
    .optional()
    .describe("Primary muscle. REQUIRED only if this exercise has to be created new (no match). Cable exercises use equipment 'machine'."),
  equipment: z
    .enum(EQUIPMENT)
    .optional()
    .describe("Equipment. REQUIRED only if this exercise has to be created new. Note: cable → 'machine'."),
  exercise_type: z.enum(EXERCISE_TYPES).optional().describe("Defaults to weight_reps."),
  rest_seconds: z.number().int().optional(),
  notes: z.string().optional(),
  sets: z.array(setSchema).min(1).describe("The target sets for this exercise"),
});

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const err = (message, extra) => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }, null, 2) }],
});

server.registerTool(
  "get_profile",
  {
    title: "Get profile",
    description: "The authenticated Hevy user's account and total workout count, for context.",
    inputSchema: {},
  },
  async () => {
    try {
      const [account, workout_count] = await Promise.all([client.getAccount(), client.getWorkoutCount()]);
      return ok({ username: account.username, country: account.country_code, workout_count });
    } catch (e) {
      return err(e.message);
    }
  },
);

server.registerTool(
  "list_exercises",
  {
    title: "List/search all Hevy exercises",
    description:
      "List exercises from Hevy's full built-in library (~140 default exercises) plus the user's custom ones " +
      "and any seen in their routines/history, optionally filtered by a search query. Use this to browse what " +
      "exists or pick exact exercises before creating a routine. Set include_feed to also surface defaults " +
      "harvested from the social feed.",
    inputSchema: {
      query: z.string().optional().describe("Case-insensitive fuzzy filter on the exercise name."),
      limit: z.number().int().optional().describe("Max results (default 50; use a high number to see everything)."),
      include_feed: z.boolean().optional().describe("Also mine the social feed for extra default exercises (slower)."),
    },
  },
  async ({ query, limit, include_feed }) => {
    try {
      const all = await catalog({ includeFeed: include_feed, force: include_feed });
      let entries = all;
      if (query && query.trim()) {
        const best = findBestMatch(query, all, 0.3);
        const q = query.toLowerCase();
        entries = all
          .filter((e) => e.title.toLowerCase().includes(q) || (best && e.exercise_template_id === best.entry.exercise_template_id))
          .sort((a, b) => a.title.localeCompare(b.title));
      } else {
        entries = [...all].sort((a, b) => a.title.localeCompare(b.title));
      }
      return ok({
        count: entries.length,
        total_in_catalog: all.length,
        custom_count: all.filter((e) => e.is_custom).length,
        default_count: all.filter((e) => !e.is_custom).length,
        exercises: entries.slice(0, limit ?? 50).map((e) => ({
          id: e.exercise_template_id,
          title: e.title,
          muscle_group: e.muscle_group,
          equipment: e.equipment_category,
          is_custom: e.is_custom,
        })),
      });
    } catch (e) {
      return err(e.message);
    }
  },
);

server.registerTool(
  "list_routines",
  {
    title: "List routines",
    description: "List the user's existing Hevy routines (id, title, exercise count).",
    inputSchema: {},
  },
  async () => {
    try {
      const routines = await client.getRoutines();
      return ok({
        count: routines.length,
        routines: routines.map((r) => ({ id: r.id, title: r.title, exercises: r.exercises?.length ?? 0 })),
      });
    } catch (e) {
      return err(e.message);
    }
  },
);

server.registerTool(
  "create_routine",
  {
    title: "Create a routine from a workout plan",
    description:
      "Save a workout plan to Hevy as a routine. For each exercise, the server first matches the name against " +
      "exercises the user already has (custom + history); only when there is no good match does it create a new " +
      "custom exercise (using muscle_group/equipment if provided). Returns a per-exercise report of matched vs created.",
    inputSchema: {
      title: z.string().describe("Routine title, e.g. 'Upper Body A'."),
      notes: z.string().optional(),
      folder_id: z.string().nullable().optional(),
      exercises: z.array(exerciseSchema).min(1),
    },
  },
  async ({ title, notes, folder_id, exercises }) => {
    try {
      const cat = await catalog();

      // Pass 1 — resolve every exercise to match / explicit / needs-creation,
      // WITHOUT mutating anything, so a validation failure creates no orphans.
      const plan = exercises.map((ex) => {
        if (ex.exercise_template_id) {
          const title = cat.find((c) => c.exercise_template_id === ex.exercise_template_id)?.title ?? ex.name;
          return { ex, action: "explicit", templateId: ex.exercise_template_id, resolvedTitle: title };
        }
        const match = findBestMatch(ex.name, cat);
        if (match) {
          return { ex, action: "matched", templateId: match.entry.exercise_template_id, resolvedTitle: match.entry.title, score: Number(match.score.toFixed(2)) };
        }
        return { ex, action: "create", resolvedTitle: ex.name };
      });

      // Validate: anything to be created needs a valid muscle_group + equipment.
      const missing = plan
        .filter((p) => p.action === "create" && (!p.ex.muscle_group || !p.ex.equipment))
        .map((p) => p.ex.name);
      if (missing.length) {
        return err(
          "These exercises have no existing match and need a muscle_group and equipment to be created. " +
            "Re-call with those fields (cable exercises use equipment 'machine').",
          { needs_muscle_group_and_equipment: missing, valid_muscle_groups: MUSCLE_GROUPS, valid_equipment: EQUIPMENT },
        );
      }

      // Pass 2 — create the missing exercises, then assemble the routine.
      const report = [];
      const resolved = [];
      for (const p of plan) {
        let templateId = p.templateId;
        if (p.action === "create") {
          const created = await client.createCustomExercise({
            title: p.ex.name,
            exercise_type: p.ex.exercise_type ?? "weight_reps",
            muscle_group: p.ex.muscle_group,
            equipment_category: p.ex.equipment,
          });
          templateId = created.id;
          cat.push({ exercise_template_id: templateId, title: p.ex.name, is_custom: true }); // reuse within this plan
        }
        resolved.push({
          exercise_template_id: templateId,
          rest_seconds: p.ex.rest_seconds ?? 0,
          notes: p.ex.notes ?? "",
          sets: p.ex.sets.map((s, i) => ({
            index: i,
            indicator: s.indicator ?? "normal",
            weight_kg: s.weight_kg,
            reps: s.reps,
            duration_seconds: s.duration_seconds,
            distance_meters: s.distance_meters,
            rpe: s.rpe,
          })),
        });
        report.push({
          requested: p.ex.name,
          status: p.action,
          resolved_to: p.resolvedTitle,
          template_id: templateId,
          ...(p.score ? { match_score: p.score } : {}),
        });
      }

      const { routineId } = await client.createRoutine({ title, notes, folder_id, exercises: resolved });
      const newCount = report.filter((r) => r.status === "create").length;
      const existing = report.length - newCount;
      return ok({
        routineId,
        title,
        summary: `Created routine "${title}" with ${report.length} exercises (${existing} existing, ${newCount} new).`,
        exercises: report,
      });
    } catch (e) {
      return err(e.message, { body: e.body ?? null });
    }
  },
);

server.registerTool(
  "delete_routine",
  {
    title: "Delete a routine",
    description: "Delete a Hevy routine by id (e.g. to undo one this tool created).",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    try {
      await client.deleteRoutine(id);
      return ok({ deleted: id });
    } catch (e) {
      return err(e.message);
    }
  },
);

server.registerTool(
  "refresh_catalog",
  {
    title: "Refresh exercise catalog",
    description: "Rebuild the cached catalog of existing exercises (after external changes in the app).",
    inputSchema: {},
  },
  async () => {
    const c = await catalog({ force: true });
    return ok({ refreshed: true, exercise_count: c.length });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log("Hevy MCP server ready on stdio.");
