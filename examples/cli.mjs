#!/usr/bin/env node
/**
 * Interactive demo that exercises every HevyClient feature against the live API.
 *
 *   npm run build           # produce dist/ first
 *   node examples/cli.mjs
 *
 * Auth: set HEVY_REFRESH_TOKEN, or drop a refresh token into examples/.hevy-token.json
 * as { "refreshToken": "..." }. Get one with `node capture/extract-token.mjs`.
 *
 * The refresh token rotates on every use; this script persists the rotated token
 * back to examples/.hevy-token.json so subsequent runs keep working.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { HevyClient } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(here, ".hevy-token.json");

// ---- ANSI helpers ----
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

function loadRefreshToken() {
  if (existsSync(TOKEN_FILE)) {
    const t = JSON.parse(readFileSync(TOKEN_FILE, "utf8")).refreshToken;
    if (t) return t;
  }
  if (process.env.HEVY_REFRESH_TOKEN) return process.env.HEVY_REFRESH_TOKEN;
  console.error(
    c.red("No refresh token found.\n") +
      "Set HEVY_REFRESH_TOKEN, or write examples/.hevy-token.json:\n" +
      c.dim('  { "refreshToken": "..." }\n') +
      "Get one with: node capture/extract-token.mjs",
  );
  process.exit(1);
}

function persistToken(refreshToken) {
  writeFileSync(TOKEN_FILE, JSON.stringify({ refreshToken }, null, 2));
}

const client = new HevyClient({
  refreshToken: loadRefreshToken(),
  onTokensRefreshed: (state) => persistToken(state.refreshToken),
});

const rl = createInterface({ input, output });

// Pretty-print a result, trimming huge arrays/objects.
function show(label, data) {
  console.log(c.green(`\n✓ ${label}`));
  const json = JSON.stringify(data, null, 2);
  console.log(json.length > 4000 ? json.slice(0, 4000) + c.dim("\n… (truncated)") : json);
}

async function run(label, fn) {
  try {
    show(label, await fn());
  } catch (e) {
    console.log(c.red(`\n✗ ${label} failed: ${e.message}`));
    if (e.body) console.log(c.dim(JSON.stringify(e.body).slice(0, 300)));
    if (/refresh token/i.test(e.message)) {
      console.log(c.yellow("→ Your token is stale. Re-capture one and update examples/.hevy-token.json."));
    }
  }
}

const actions = {
  "1": ["Account", () => run("getAccount()", () => client.getAccount())],
  "2": ["Preferences", () => run("getUserPreferences()", () => client.getUserPreferences())],
  "3": ["Custom exercises", () => run("getCustomExercises()", () => client.getCustomExercises())],
  "4": ["Exercise units", () => run("getExerciseTemplateUnits()", () => client.getExerciseTemplateUnits())],
  "5": ["Workout count", () => run("getWorkoutCount()", () => client.getWorkoutCount())],
  "6": [
    "Recent workouts",
    async () => {
      const limit = Number((await rl.question("How many? [5] ")) || "5");
      await run(`getUserWorkouts({ limit: ${limit} })`, () => client.getUserWorkouts({ limit }));
    },
  ],
  "7": [
    "Get workout by id",
    async () => {
      const id = (await rl.question("Workout id: ")).trim();
      if (id) await run(`getWorkout(${id})`, () => client.getWorkout(id));
    },
  ],
  "8": ["Feed", () => run("getFeedWorkouts()", () => client.getFeedWorkouts())],
  "9": ["Routine folders", () => run("getRoutineFolders()", () => client.getRoutineFolders())],
  "10": ["List routines", () => run("getRoutines()", () => client.getRoutines())],
  "11": [
    "Search routines",
    async () => {
      const q = (await rl.question("Query: ")).trim();
      const ex = (await rl.question("Also match exercise names? [y/N] ")).trim().toLowerCase() === "y";
      await run(
        `searchRoutines(${JSON.stringify(q)}${ex ? ", exercises" : ""})`,
        () => client.searchRoutines(q, ex ? { fields: ["title", "notes", "exercises"] } : {}),
      );
    },
  ],
  "12": [
    c.yellow("Create custom exercise (write)"),
    async () => {
      const title = (await rl.question("Title: ")).trim();
      if (!title) return;
      const muscle_group = (await rl.question("Muscle group [biceps]: ")).trim() || "biceps";
      const equipment_category = (await rl.question("Equipment [barbell]: ")).trim() || "barbell";
      await run("createCustomExercise()", () =>
        client.createCustomExercise({ title, exercise_type: "weight_reps", muscle_group, equipment_category }),
      );
    },
  ],
  "13": [
    c.yellow("Create routine (write)"),
    async () => {
      const title = (await rl.question("Routine title: ")).trim();
      if (!title) return;
      const tplId = (await rl.question("An exercise_template_id (from option 3): ")).trim();
      if (!tplId) return;
      await run("createRoutine()", () =>
        client.createRoutine({
          title,
          exercises: [
            { exercise_template_id: tplId, rest_seconds: 60, sets: [
              { index: 0, weight_kg: 20, reps: 10 },
              { index: 1, weight_kg: 20, reps: 10 },
            ] },
          ],
        }),
      );
    },
  ],
  "14": [
    c.red("Delete routine (write)"),
    async () => {
      const id = (await rl.question("Routine id to delete: ")).trim();
      if (!id) return;
      const ok = (await rl.question(c.red(`Really delete ${id}? [y/N] `))).trim().toLowerCase() === "y";
      if (ok) await run(`deleteRoutine(${id})`, () => client.deleteRoutine(id));
    },
  ],
  "15": [
    "Run all read-only checks",
    async () => {
      await run("getAccount()", () => client.getAccount());
      await run("getUserPreferences()", () => client.getUserPreferences());
      await run("getCustomExercises()", () => client.getCustomExercises());
      await run("getWorkoutCount()", () => client.getWorkoutCount());
      await run("getUserWorkouts({ limit: 3 })", () => client.getUserWorkouts({ limit: 3 }));
      await run("getRoutineFolders()", () => client.getRoutineFolders());
      await run("getRoutines()", () => client.getRoutines());
    },
  ],
};

function menu() {
  console.log(c.bold("\n=== Hevy API demo ==="));
  for (const [key, [label]] of Object.entries(actions)) {
    console.log(`  ${c.cyan(key.padStart(2))}  ${label}`);
  }
  console.log(`  ${c.cyan(" q")}  Quit`);
}

console.log(c.dim("Reverse-engineered Hevy client — interactive tester."));
while (true) {
  menu();
  const choice = (await rl.question("\nChoose: ")).trim().toLowerCase();
  if (choice === "q" || choice === "quit" || choice === "exit") break;
  const action = actions[choice];
  if (!action) {
    console.log(c.red("Unknown option."));
    continue;
  }
  await action[1]();
}
rl.close();
console.log(c.dim("Bye."));
