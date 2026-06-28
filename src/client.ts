import { HttpClient } from "./http.js";
import { HevyAuth, type AuthState, type SavedAccountCredentials } from "./auth.js";
import type { CatalogEntry } from "./match.js";
import {
  API_KEY,
  BASE_URL,
  DEFAULT_APP_BUILD,
  DEFAULT_APP_VERSION,
  DEFAULT_PLATFORM,
  DEFAULT_USER_AGENT,
} from "./constants.js";
import type {
  Account,
  CreateExerciseInput,
  CreateRoutineInput,
  ExerciseTemplate,
  ExerciseTemplateUnit,
  FeedWorkoutsPage,
  Routine,
  RoutineFolder,
  SyncBatchResponse,
  UserPreferences,
  Workout,
} from "./types.js";

export interface HevyClientOptions {
  /**
   * Stable saved-account credentials (userId + secret from the iOS keychain).
   * Unlike the refresh token, the secret never rotates, so the client stays
   * logged in indefinitely. Takes precedence over `refreshToken` when set.
   */
  savedAccount?: SavedAccountCredentials;
  /**
   * Rotating refresh token captured from the Hevy app. Exchanges for
   * short-lived access tokens automatically. Not needed when `savedAccount` is
   * provided.
   */
  refreshToken?: string;
  /** Optional access token + expiry (epoch ms) to skip the first refresh call. */
  accessToken?: string;
  expiresAt?: number;
  /** Called whenever tokens are minted — use to persist the latest state. */
  onTokensRefreshed?: (state: AuthState) => void;

  /** Override the API base URL. */
  baseUrl?: string;
  /** Spoofed app version headers; defaults mirror the captured iOS build. */
  appVersion?: string;
  appBuild?: string;
  platform?: string;
  userAgent?: string;
  /** Custom fetch (Node <18, tests, proxies). */
  fetch?: typeof fetch;
}

/**
 * Client for the Hevy app's private API, reverse-engineered from captured
 * traffic. Authentication uses the app's rotating refresh-token scheme plus the
 * static app API key.
 */
export class HevyClient {
  readonly http: HttpClient;
  readonly auth: HevyAuth;

  constructor(opts: HevyClientOptions) {
    if (!opts.savedAccount && !opts.refreshToken && !opts.accessToken) {
      throw new Error(
        "HevyClient requires either savedAccount (persistent) or refreshToken/accessToken captured from the app.",
      );
    }
    const baseUrl = opts.baseUrl ?? BASE_URL;
    const fetchImpl = opts.fetch ?? globalThis.fetch;

    this.auth = new HevyAuth({
      savedAccount: opts.savedAccount,
      refreshToken: opts.refreshToken,
      accessToken: opts.accessToken,
      expiresAt: opts.expiresAt,
      baseUrl,
      fetch: fetchImpl,
      onTokensRefreshed: opts.onTokensRefreshed,
    });

    this.http = new HttpClient({
      baseUrl,
      fetch: fetchImpl,
      headers: {
        "x-api-key": API_KEY,
        "hevy-app-version": opts.appVersion ?? DEFAULT_APP_VERSION,
        "hevy-app-build": opts.appBuild ?? DEFAULT_APP_BUILD,
        "hevy-platform": opts.platform ?? DEFAULT_PLATFORM,
        "user-agent": opts.userAgent ?? DEFAULT_USER_AGENT,
        accept: "application/json, text/plain, */*",
      },
      authHeaders: async () => ({
        authorization: `Bearer ${await this.auth.getAccessToken()}`,
      }),
      onUnauthorized: async () => {
        await this.auth.refresh();
      },
    });
  }

  private _username?: string;

  // ---- Account & preferences ----

  /** The authenticated user's account. */
  getAccount() {
    return this.http.get<Account>("/user/account");
  }

  /** Cached username of the authenticated user (for endpoints that require it). */
  private async username(): Promise<string> {
    if (!this._username) this._username = (await this.getAccount()).username;
    return this._username;
  }

  getUserPreferences() {
    return this.http.get<UserPreferences>("/user_preferences");
  }

  // ---- Exercises ----

  /** The user's custom exercise templates. */
  getCustomExercises() {
    return this.http.get<ExerciseTemplate[]>("/custom_exercise_templates");
  }

  getExerciseTemplateUnits() {
    return this.http.get<ExerciseTemplateUnit[]>("/exercise_template_units");
  }

  /** Create a custom exercise. Returns the new exercise id. */
  createCustomExercise(input: CreateExerciseInput) {
    return this.http.post<{ id: string }>("/custom_exercise_template", {
      exercise: { other_muscles: [], ...input },
    });
  }

  /**
   * Build a catalog of exercise templates the user already has access to,
   * deduped by `exercise_template_id`: their custom exercises plus every
   * exercise referenced in their routines and recent workout history. This is
   * the set to match against before creating a new custom exercise.
   *
   * @param opts.maxWorkouts How many recent workouts to scan (default 100).
   */
  async getExerciseCatalog(opts: { maxWorkouts?: number } = {}): Promise<CatalogEntry[]> {
    const byId = new Map<string, CatalogEntry>();
    const add = (e: Partial<CatalogEntry> & { exercise_template_id?: string; title?: string }) => {
      if (!e.exercise_template_id || !e.title) return;
      if (!byId.has(e.exercise_template_id)) {
        byId.set(e.exercise_template_id, {
          exercise_template_id: e.exercise_template_id,
          title: e.title,
          muscle_group: e.muscle_group,
          equipment_category: e.equipment_category,
          is_custom: e.is_custom ?? false,
        });
      }
    };

    const [custom, routines] = await Promise.all([
      this.getCustomExercises().catch(() => [] as ExerciseTemplate[]),
      this.getRoutines().catch(() => [] as Routine[]),
    ]);
    // Custom exercises key their id as `id`, not `exercise_template_id`.
    for (const c of custom)
      add({
        exercise_template_id: c.id,
        title: c.title,
        muscle_group: c.muscle_group,
        equipment_category: c.equipment_category,
        is_custom: true,
      });
    for (const r of routines) for (const e of r.exercises ?? []) add(e);

    // Walk workout history pages until exhausted or the cap is reached.
    // Hevy rejects large page sizes (400), so keep it small.
    const maxWorkouts = opts.maxWorkouts ?? 100;
    const pageSize = 10;
    for (let offset = 0; offset < maxWorkouts; offset += pageSize) {
      let page;
      try {
        page = await this.getUserWorkouts({ limit: pageSize, offset });
      } catch {
        break;
      }
      const workouts = page.workouts ?? [];
      for (const w of workouts) for (const e of w.exercises ?? []) add(e);
      if (workouts.length < pageSize) break;
    }

    return [...byId.values()];
  }

  // ---- Workouts ----

  /**
   * The social workout feed (your follows + own workouts), full exercise/set
   * detail. Paginate by passing the `index` of the last seen workout to fetch
   * older entries (`GET /feed_workouts_paged/:index`).
   */
  getFeedWorkouts(beforeIndex?: number) {
    const path = beforeIndex === undefined ? "/feed_workouts_paged" : `/feed_workouts_paged/${beforeIndex}`;
    return this.http.get<FeedWorkoutsPage>(path);
  }

  /**
   * A user's own workouts, paginated by limit/offset. Defaults to the
   * authenticated user (resolved + cached from the account on first use).
   */
  async getUserWorkouts(params: { username?: string; limit?: number; offset?: number } = {}) {
    const username = params.username ?? (await this.username());
    return this.http.get<FeedWorkoutsPage>("/user_workouts_paged", {
      query: { username, limit: params.limit ?? 10, offset: params.offset ?? 0 },
    });
  }

  /** A single workout by id, with full detail. */
  getWorkout(id: string) {
    return this.http.get<Workout>(`/workout/${id}`);
  }

  /** Total number of workouts the authenticated user has logged. */
  async getWorkoutCount() {
    const res = await this.http.get<{ workout_count: number }>("/workout_count");
    return res.workout_count;
  }

  /**
   * Delta-sync the user's workouts. Pass a map of `{ workoutId: lastUpdatedISO }`
   * the server already knows about; it returns only what changed. Pass `{}` to
   * fetch everything.
   */
  syncWorkouts(known: Record<string, string> = {}) {
    return this.http.post<SyncBatchResponse<Workout>>("/workouts_sync_batch", known);
  }

  // ---- Routines ----

  getRoutineFolders() {
    return this.http.get<RoutineFolder[]>("/routine_folders");
  }

  /**
   * Delta-sync routines. Pass a `{ routineId: updatedAtISO }` map of routines
   * the server already knows about to get only changes; pass `{}` (default) to
   * fetch everything. The full routine objects come back in `updated`.
   */
  syncRoutines(known: Record<string, string> = {}) {
    return this.http.post<SyncBatchResponse<Routine>>("/routines_sync_batch", known);
  }

  /** All of the authenticated user's routines (full detail). */
  async getRoutines(): Promise<Routine[]> {
    const { updated } = await this.syncRoutines({});
    return updated;
  }

  /**
   * Search the user's routines. Hevy has no server-side routine search, so this
   * fetches all routines and filters them locally (case-insensitive).
   *
   * @param query Text to match. Empty/whitespace returns all routines.
   * @param opts.fields Where to match: routine `title` (default), `notes`,
   *   and/or exercise `exercises` titles.
   */
  async searchRoutines(
    query: string,
    opts: { fields?: Array<"title" | "notes" | "exercises"> } = {},
  ): Promise<Routine[]> {
    const routines = await this.getRoutines();
    const q = query.trim().toLowerCase();
    if (!q) return routines;
    const fields = opts.fields ?? ["title"];
    return routines.filter((r) => {
      if (fields.includes("title") && r.title?.toLowerCase().includes(q)) return true;
      if (fields.includes("notes") && r.notes?.toLowerCase().includes(q)) return true;
      if (
        fields.includes("exercises") &&
        r.exercises?.some((e) => e.title?.toLowerCase().includes(q))
      )
        return true;
      return false;
    });
  }

  /** Delete a routine by id. */
  deleteRoutine(id: string) {
    return this.http.delete<void>(`/routine/${id}`);
  }

  /** Create a routine (template). Returns the new routine id. */
  createRoutine(input: CreateRoutineInput) {
    const clientId = makeClientId();
    const routine = {
      title: input.title,
      folder_id: input.folder_id ?? null,
      index: -1,
      notes: input.notes ?? null,
      program_id: null,
      exercises: input.exercises.map((ex) => ({
        exercise_template_id: ex.exercise_template_id,
        notes: ex.notes ?? "",
        rest_seconds: ex.rest_seconds ?? 0,
        sets: ex.sets.map((s) => ({ indicator: "normal", ...s })),
      })),
      _unsyncedObjectId: clientId,
      clientId,
    };
    return this.http.post<{ routineId: string }>("/routine", { routine });
  }
}

/** Hevy uses client-generated UUIDs for new routines. */
function makeClientId(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("crypto.randomUUID unavailable; pass a clientId or upgrade your runtime.");
  }
  return globalThis.crypto.randomUUID();
}
