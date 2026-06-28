#!/usr/bin/env node
/**
 * Drives the running web tester (examples/server.mjs) through every endpoint,
 * including a create→delete write cycle that cleans up after itself.
 *
 *   node examples/server.mjs          # in one terminal
 *   node examples/smoke-test.mjs      # in another (PORT env honored)
 */
const PORT = Number(process.env.PORT || 5173);
const BASE = `http://localhost:${PORT}`;

async function call(name, args = {}) {
  const r = await fetch(`${BASE}/api/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return r.json();
}

const pass = (n, extra) => console.log(`  \x1b[32m✓\x1b[0m ${n.padEnd(26)} ${extra ?? ""}`);
const fail = (n, e) => {
  console.log(`  \x1b[31m✗\x1b[0m ${n.padEnd(26)} ${e}`);
  failures++;
};
let failures = 0;

function summarize(r) {
  if (Array.isArray(r)) return `${r.length} items`;
  if (r && typeof r === "object") return `${Object.keys(r).length} keys`;
  return String(r);
}

async function read(name, args, pick) {
  const res = await call(name, args);
  if (res.ok) {
    pass(name, pick ? pick(res.result) : summarize(res.result));
    return res.result;
  }
  fail(name, res.error);
  return null;
}

console.log("\n=== READ ENDPOINTS ===");
const account = await read("getAccount", {}, (r) => `${r.username} (${r.country_code})`);
await read("getUserPreferences");
const exercises = await read("getCustomExercises", {}, (r) => `${r.length} exercises`);
await read("getExerciseTemplateUnits");
await read("getWorkoutCount", {}, (r) => `${r} workouts`);
const userWorkouts = await read("getUserWorkouts", { limit: 3 }, (r) => `${r.workouts.length} workouts`);
await read("getFeedWorkouts", {}, (r) => `${r.workouts.length} feed items`);
await read("getRoutineFolders");
await read("getRoutines", {}, (r) => `${r.length} routines`);
await read("searchRoutines", { query: "" }, (r) => `${r.length} (empty query → all)`);

console.log("\n=== PARAMETERIZED READ ===");
const wid = userWorkouts?.workouts?.[0]?.id;
if (wid) await read("getWorkout", { id: wid }, (r) => `${r.name}, ${r.exercises.length} exercises`);
else fail("getWorkout", "no workout id available");
const exMatch = await call("searchRoutines", { query: "press", matchExercises: true });
exMatch.ok ? pass("searchRoutines+exercises", `${exMatch.result.length} matches`) : fail("searchRoutines+exercises", exMatch.error);

console.log("\n=== WRITE CYCLE (creates real data, then deletes the routine) ===");
const tplId = exercises?.[0]?.id;

const exRes = await call("createCustomExercise", {
  title: "API Test (safe to delete)",
  muscle_group: "biceps",
  equipment_category: "dumbbell",
});
exRes.ok ? pass("createCustomExercise", `id=${exRes.result.id}`) : fail("createCustomExercise", exRes.error);

let routineId = null;
if (tplId) {
  const rRes = await call("createRoutine", {
    title: "API Test Routine (safe to delete)",
    exercise_template_id: tplId,
    weight_kg: 40,
    reps: 8,
  });
  if (rRes.ok) {
    routineId = rRes.result.routineId;
    pass("createRoutine", `routineId=${routineId}`);
  } else {
    fail("createRoutine", `${rRes.error} ${JSON.stringify(rRes.body ?? "")}`);
  }
} else {
  fail("createRoutine", "no exercise template id available");
}

if (routineId) {
  const dRes = await call("deleteRoutine", { id: routineId });
  dRes.ok ? pass("deleteRoutine", "(cleaned up test routine)") : fail("deleteRoutine", dRes.error);
}

console.log(
  failures === 0
    ? "\n\x1b[32mAll endpoints passed.\x1b[0m"
    : `\n\x1b[31m${failures} endpoint(s) failed.\x1b[0m`,
);
console.log("\x1b[2mNote: the test custom exercise persists (no delete-exercise endpoint); remove it in-app if you like.\x1b[0m");
process.exit(failures ? 1 : 0);
