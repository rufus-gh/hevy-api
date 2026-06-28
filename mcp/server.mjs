#!/usr/bin/env node
/**
 * MCP server for the Hevy API.
 *
 * Exposes the full HevyClient surface to an MCP client (Claude Desktop / Claude
 * Code): profile & preferences, the full exercise library (browse/search),
 * workouts (list/detail), the social feed, routines (list/detail/search/create/
 * delete), routine folders, and custom-exercise creation.
 *
 * create_routine **prioritises exercises you already have over creating new
 * custom ones**: each planned exercise is fuzzy-matched against Hevy's bundled
 * library + your custom exercises/routines/history, and a custom exercise is
 * created only when nothing matches.
 *
 * Auth (preferred → fallback):
 *   1. HEVY_USER_ID + HEVY_SECRET env vars      (saved-account, never expires)
 *   2. HEVY_TOKEN_FILE { userId, secret }        (saved-account, never expires)
 *   3. HEVY_REFRESH_TOKEN / { refreshToken }     (rotating, can expire)
 * With saved-account credentials the server stays logged in indefinitely,
 * minting a fresh access token from the stable secret on each call.
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
      "Tools to read and manage a Hevy account and design workouts.\n" +
      "Read: get_profile, get_preferences, list_exercises (full built-in library + custom), " +
      "list_workouts/get_workout, get_feed, list_routines/get_routine/search_routines, list_routine_folders.\n" +
      "Write: create_routine (the main one), create_exercise, delete_routine.\n" +
      "To save a plan, call create_routine with exercises by name; each name is matched against " +
      "Hevy's whole library + your exercises before any new custom exercise is created, so existing " +
      "ones are reused. Use list_exercises first to browse or pick exact exercises/ids.",
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

// Hevy workout times are unix seconds; render ISO and minutes for readability.
const isoFromSeconds = (s) => (typeof s === "number" ? new Date(s * 1000).toISOString() : null);

/** Compact summary of a workout (avoids dumping every set into context). */
function summarizeWorkout(w) {
  return {
    id: w.id,
    name: w.name,
    by: w.username,
    date: isoFromSeconds(w.start_time),
    duration_min:
      typeof w.start_time === "number" && typeof w.end_time === "number"
        ? Math.round((w.end_time - w.start_time) / 60)
        : null,
    volume_kg: w.estimated_volume_kg,
    exercises: (w.exercises ?? []).map((e) => ({
      title: e.title,
      sets: e.sets?.length ?? 0,
    })),
  };
}

/** Full detail of a workout, including every set. */
function detailWorkout(w) {
  return {
    id: w.id,
    name: w.name,
    by: w.username,
    date: isoFromSeconds(w.start_time),
    duration_min:
      typeof w.start_time === "number" && typeof w.end_time === "number"
        ? Math.round((w.end_time - w.start_time) / 60)
        : null,
    volume_kg: w.estimated_volume_kg,
    description: w.description,
    exercises: (w.exercises ?? []).map((e) => ({
      title: e.title,
      exercise_template_id: e.exercise_template_id,
      notes: e.notes || undefined,
      sets: (e.sets ?? []).map((s) => ({
        type: s.indicator,
        weight_kg: s.weight_kg,
        reps: s.reps,
        duration_seconds: s.duration_seconds,
        distance_meters: s.distance_meters,
        rpe: s.rpe,
      })),
    })),
  };
}

/** Compact summary of a routine. */
function summarizeRoutine(r) {
  return {
    id: r.id,
    title: r.title,
    folder_id: r.folder_id,
    updated_at: r.updated_at,
    exercises: (r.exercises ?? []).map((e) => ({
      title: e.title,
      exercise_template_id: e.exercise_template_id,
      sets: e.sets?.length ?? 0,
    })),
  };
}

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
  "get_preferences",
  {
    title: "Get preferences",
    description: "The user's Hevy app preferences (units, first weekday, RPE settings, etc.).",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await client.getUserPreferences());
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
  "create_exercise",
  {
    title: "Create a custom exercise",
    description:
      "Create a single custom exercise template. Normally you don't need this — create_routine creates any " +
      "missing exercises automatically. Use it to add an exercise on its own. Note: cable exercises use equipment 'machine'.",
    inputSchema: {
      title: z.string().describe("Exercise name, e.g. 'Meadows Row'."),
      muscle_group: z.enum(MUSCLE_GROUPS).describe("Primary muscle group."),
      equipment: z.enum(EQUIPMENT).describe("Equipment (cable → 'machine')."),
      exercise_type: z.enum(EXERCISE_TYPES).optional().describe("Defaults to weight_reps."),
    },
  },
  async ({ title, muscle_group, equipment, exercise_type }) => {
    try {
      const created = await client.createCustomExercise({
        title,
        exercise_type: exercise_type ?? "weight_reps",
        muscle_group,
        equipment_category: equipment,
      });
      catalogCache = null; // invalidate so the new exercise is matchable next time
      return ok({ created: true, id: created.id, title, muscle_group, equipment });
    } catch (e) {
      return err(e.message, { body: e.body ?? null });
    }
  },
);

server.registerTool(
  "list_workouts",
  {
    title: "List recent workouts",
    description:
      "The user's own logged workouts, most recent first, as compact summaries (name, date, duration, volume, " +
      "per-exercise set counts). Paginate with limit/offset. Use get_workout for full set-by-set detail.",
    inputSchema: {
      limit: z.number().int().optional().describe("How many to return (default 10)."),
      offset: z.number().int().optional().describe("Skip this many (default 0)."),
    },
  },
  async ({ limit, offset }) => {
    try {
      const page = await client.getUserWorkouts({ limit: limit ?? 10, offset: offset ?? 0 });
      const workouts = page.workouts ?? [];
      return ok({ count: workouts.length, workouts: workouts.map(summarizeWorkout) });
    } catch (e) {
      return err(e.message);
    }
  },
);

server.registerTool(
  "get_workout",
  {
    title: "Get a workout",
    description: "Full set-by-set detail of one workout by id (get ids from list_workouts).",
    inputSchema: { id: z.string().describe("Workout id from list_workouts.") },
  },
  async ({ id }) => {
    try {
      return ok(detailWorkout(await client.getWorkout(id)));
    } catch (e) {
      return err(e.message);
    }
  },
);

server.registerTool(
  "get_feed",
  {
    title: "Get social feed",
    description:
      "The social workout feed (people the user follows + their own), as compact summaries. Paginate by passing " +
      "before_index = the index of the last workout from the previous page.",
    inputSchema: {
      before_index: z.number().int().optional().describe("Fetch older entries before this workout index."),
    },
  },
  async ({ before_index }) => {
    try {
      const page = await client.getFeedWorkouts(before_index);
      const workouts = page.workouts ?? [];
      const next = workouts.length ? workouts[workouts.length - 1].index : null;
      return ok({ count: workouts.length, next_before_index: next, workouts: workouts.map(summarizeWorkout) });
    } catch (e) {
      return err(e.message);
    }
  },
);

server.registerTool(
  "list_routines",
  {
    title: "List routines",
    description: "List the user's existing Hevy routines as compact summaries (id, title, folder, exercises).",
    inputSchema: {},
  },
  async () => {
    try {
      const routines = await client.getRoutines();
      return ok({ count: routines.length, routines: routines.map(summarizeRoutine) });
    } catch (e) {
      return err(e.message);
    }
  },
);

server.registerTool(
  "get_routine",
  {
    title: "Get a routine",
    description: "Full detail of one routine by id, including every exercise's target sets.",
    inputSchema: { id: z.string().describe("Routine id from list_routines.") },
  },
  async ({ id }) => {
    try {
      const routines = await client.getRoutines();
      const r = routines.find((x) => x.id === id || x.short_id === id);
      if (!r) return err(`No routine found with id ${id}.`);
      return ok({
        ...summarizeRoutine(r),
        notes: r.notes,
        exercises: (r.exercises ?? []).map((e) => ({
          title: e.title,
          exercise_template_id: e.exercise_template_id,
          notes: e.notes || undefined,
          rest_seconds: e.rest_seconds,
          sets: (e.sets ?? []).map((s) => ({
            type: s.indicator,
            weight_kg: s.weight_kg,
            reps: s.reps,
            duration_seconds: s.duration_seconds,
            distance_meters: s.distance_meters,
            rpe: s.rpe,
          })),
        })),
      });
    } catch (e) {
      return err(e.message);
    }
  },
);

server.registerTool(
  "search_routines",
  {
    title: "Search routines",
    description:
      "Search the user's routines by text (Hevy has no server-side routine search, so this filters locally). " +
      "Matches the routine title by default; optionally also notes and exercise names.",
    inputSchema: {
      query: z.string().describe("Text to match (case-insensitive)."),
      match_notes: z.boolean().optional().describe("Also match routine notes."),
      match_exercises: z.boolean().optional().describe("Also match exercise names within routines."),
    },
  },
  async ({ query, match_notes, match_exercises }) => {
    try {
      const fields = ["title"];
      if (match_notes) fields.push("notes");
      if (match_exercises) fields.push("exercises");
      const routines = await client.searchRoutines(query, { fields });
      return ok({ query, count: routines.length, routines: routines.map(summarizeRoutine) });
    } catch (e) {
      return err(e.message);
    }
  },
);

server.registerTool(
  "list_routine_folders",
  {
    title: "List routine folders",
    description: "The user's routine folders (id, title) — use a folder id as folder_id when creating a routine.",
    inputSchema: {},
  },
  async () => {
    try {
      const folders = await client.getRoutineFolders();
      return ok({
        count: folders.length,
        folders: folders.map((f) => ({ id: f.id, title: f.title, index: f.index })),
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
