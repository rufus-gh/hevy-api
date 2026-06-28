# hevy-api

Unofficial TypeScript client for the [Hevy](https://www.hevyapp.com/) gym app's
private API, reverse-engineered from the iOS app's network traffic.

> ⚠️ **Unofficial & unsupported.** This uses Hevy's internal app API, not a
> public one. Endpoints, auth, and the app API key can change or break at any
> time, and using it may violate Hevy's Terms of Service. Use it only against
> your own account and at your own risk. If you just want stable, supported
> access, use Hevy's official developer API instead (PRO feature).

## Install

```bash
npm install hevy-api
```

## Authentication

The app authenticates with a **rotating refresh token**. The client exchanges
it for short-lived access tokens automatically and rotates the refresh token on
each refresh.

To get your refresh token, capture the app's traffic once (see
[CAPTURE.md](./CAPTURE.md)) and run:

```bash
node capture/extract-token.mjs
```

That prints the `refresh_token` to pass to the client.

> The refresh token is **single-use** — every refresh invalidates the previous
> one. Persist the rotated token via `onTokensRefreshed`, otherwise the next run
> starts from a stale token. Using your token here can also end the app's
> logged-in session, forcing a re-login on your phone.

## Usage

```ts
import { HevyClient } from "hevy-api";

const client = new HevyClient({
  refreshToken: process.env.HEVY_REFRESH_TOKEN!,
  // Persist rotated tokens so they survive restarts:
  onTokensRefreshed: (state) => saveToken(state.refreshToken),
});

// Read
const me = await client.getAccount();
const exercises = await client.getCustomExercises();
const { workouts } = await client.getFeedWorkouts({ limit: 10 });

// Sync everything the server knows (delta-sync; {} = full)
const { updated } = await client.syncWorkouts({});

// Routines (Hevy has no server-side routine search, so this filters locally)
const routines = await client.getRoutines();
const pushDays = await client.searchRoutines("push");
const withSquats = await client.searchRoutines("squat", { fields: ["exercises"] });

// Write
const { id } = await client.createCustomExercise({
  title: "Meadows Row",
  exercise_type: "weight_reps",
  muscle_group: "lats",
  equipment_category: "barbell",
});

const { routineId } = await client.createRoutine({
  title: "Push Day",
  exercises: [
    {
      exercise_template_id: id,
      rest_seconds: 90,
      sets: [
        { index: 0, weight_kg: 60, reps: 8 },
        { index: 1, weight_kg: 60, reps: 8 },
      ],
    },
  ],
});
```

## Try it — interactive demo

An interactive CLI that exercises every method against the live API:

```bash
# 1. Get a refresh token from a capture (see CAPTURE.md)
node capture/extract-token.mjs
# 2. Make it available, either:
export HEVY_REFRESH_TOKEN="<refresh_token>"
#    or write examples/.hevy-token.json: { "refreshToken": "<refresh_token>" }
# 3. Run the demo
npm run example
```

You get a menu to read your account, workouts, routines, etc., search routines,
and (opt-in, guarded) create/delete exercises and routines. The rotating refresh
token is persisted back to `examples/.hevy-token.json` so repeated runs keep
working. Option **15** runs all read-only checks in one go.

## Implemented endpoints

| Method | Description | Endpoint |
| --- | --- | --- |
| `getAccount()` | Authenticated user account | `GET /user/account` |
| `getUserPreferences()` | App preferences | `GET /user_preferences` |
| `getCustomExercises()` | Your custom exercise templates | `GET /custom_exercise_templates` |
| `getExerciseTemplateUnits()` | Per-exercise weight units | `GET /exercise_template_units` |
| `createCustomExercise(input)` | Create a custom exercise | `POST /custom_exercise_template` |
| `getUserWorkouts({username,limit,offset})` | A user's workouts (defaults to you) | `GET /user_workouts_paged` |
| `getWorkout(id)` | Single workout, full detail | `GET /workout/:id` |
| `getWorkoutCount()` | Total workouts logged | `GET /workout_count` |
| `getFeedWorkouts(beforeIndex?)` | Social feed, full detail | `GET /feed_workouts_paged[/:index]` |
| `syncWorkouts(known)` | Delta-sync workouts | `POST /workouts_sync_batch` |
| `getRoutineFolders()` | Routine folders | `GET /routine_folders` |
| `getRoutines()` | All your routines (full detail) | `POST /routines_sync_batch` |
| `searchRoutines(query, opts?)` | Search routines (client-side filter) | — |
| `syncRoutines(known)` | Delta-sync routines | `POST /routines_sync_batch` |
| `createRoutine(input)` | Create a routine/template | `POST /routine` |
| `deleteRoutine(id)` | Delete a routine | `DELETE /routine/:id` |

The raw `client.http` instance is exposed for endpoints not yet wrapped — over
30 more were seen in captured traffic (notifications, friends, body
measurements, etc.). Add them as typed methods as needed.

## Auth model

```
authorization: Bearer <access_token>     # short-lived, auto-minted
x-api-key: klean_kanteen_insulated       # static app key (same for all users)
hevy-app-version / hevy-app-build / hevy-platform / user-agent
```

`POST /auth/refresh_token { refresh_token }` →
`{ user_id, access_token, refresh_token, expires_at }`.

## Development

```bash
npm run build      # bundle (ESM + CJS + d.ts) via tsup
npm run typecheck
npm test           # vitest (mocked fetch)
```

## License

MIT
