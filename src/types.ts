/**
 * Types derived from captured Hevy app responses. Fields marked optional were
 * either absent in some captures or are nullable in practice. Localized title
 * fields (de_title, es_title, …) are collapsed into an index signature.
 */

export type ExerciseType =
  | "weight_reps"
  | "reps_only"
  | "duration"
  | "distance"
  | "weight_distance"
  | "duration_weight"
  | (string & {});

export type SetIndicator = "normal" | "warmup" | "drop" | "failure" | (string & {});

export interface Account {
  id: string;
  username: string;
  email: string;
  country_code: string | null;
  city: string | null;
  private_profile: boolean;
  created_at: string;
  last_workout_at: string | null;
  email_verified: boolean;
  is_coached: boolean;
  is_a_coach: boolean;
  [key: string]: unknown;
}

export interface UserPreferences {
  username: string;
  first_weekday: string;
  rpe_enabled: boolean;
  [key: string]: unknown;
}

export interface ExerciseTemplate {
  id: string;
  title: string;
  exercise_type: ExerciseType;
  muscle_group: string;
  other_muscles: string[];
  equipment_category: string;
  priority?: number;
  is_custom?: boolean;
  is_archived?: boolean;
  thumbnail_url?: string;
  url?: string;
  media_type?: string;
  custom_exercise_image_url?: string;
  /** Localized titles: de_title, es_title, fr_title, … */
  [localizedTitle: string]: unknown;
}

export interface WorkoutSet {
  id: string;
  index: number;
  indicator: SetIndicator;
  reps: number | null;
  weight_kg: number | null;
  rpe: number | null;
  duration_seconds: number | null;
  distance_meters: number | null;
  custom_metric: number | null;
  completed_at: string | null;
  prs: unknown[];
  personalRecords: unknown[];
}

export interface WorkoutExercise {
  id: string;
  exercise_template_id: string;
  title: string;
  notes: string;
  sets: WorkoutSet[];
  rest_seconds: number;
  superset_id: string | null;
  exercise_type: ExerciseType;
  muscle_group: string;
  other_muscles: string[];
  equipment_category: string;
  url?: string;
  thumbnail_url?: string;
  media_type?: string;
  [key: string]: unknown;
}

export interface Workout {
  id: string;
  name: string;
  description: string | null;
  index: number;
  short_id: string;
  user_id: string;
  username: string;
  start_time: number;
  end_time: number;
  created_at: string;
  updated_at: string;
  estimated_volume_kg: number;
  nth_workout: number;
  like_count: number;
  comment_count: number;
  is_private: boolean;
  exercises: WorkoutExercise[];
  [key: string]: unknown;
}

export interface FeedWorkoutsPage {
  workouts: Workout[];
}

/** Generic delta-sync envelope used by *_sync_batch endpoints. */
export interface SyncBatchResponse<T = unknown> {
  updated: T[];
  deleted: string[];
  isMore: boolean;
  updated_at?: string;
}

/** Request body for POST /custom_exercise_template */
export interface CreateExerciseInput {
  title: string;
  exercise_type: ExerciseType;
  muscle_group: string;
  equipment_category: string;
  other_muscles?: string[];
}

/** Request body for POST /routine (routine.exercises[].sets) */
export interface RoutineSetInput {
  index: number;
  indicator?: SetIndicator;
  weight_kg?: number;
  reps?: number;
  duration_seconds?: number;
  distance_meters?: number;
}

export interface RoutineExerciseInput {
  exercise_template_id: string;
  notes?: string;
  rest_seconds?: number;
  sets: RoutineSetInput[];
}

export interface CreateRoutineInput {
  title: string;
  folder_id?: string | null;
  notes?: string | null;
  exercises: RoutineExerciseInput[];
}

export interface RoutineFolder {
  id: string;
  title: string;
  index: number;
  [key: string]: unknown;
}

/** A target set within a saved routine. */
export interface RoutineSet {
  index: number;
  indicator: SetIndicator;
  weight_kg: number | null;
  reps: number | null;
  distance_meters: number | null;
  duration_seconds: number | null;
  custom_metric: number | null;
  rpe: number | null;
}

export interface RoutineExercise {
  id: string;
  exercise_template_id: string;
  title: string;
  notes: string;
  sets: RoutineSet[];
  rest_seconds: number;
  superset_id: string | null;
  exercise_type: ExerciseType;
  muscle_group: string;
  other_muscles: string[];
  equipment_category: string;
  warmup_set_count: number;
  normal_set_count: number;
  url?: string;
  thumbnail_url?: string;
  media_type?: string;
  [key: string]: unknown;
}

/** A saved routine (template) as returned by routines_sync_batch. */
export interface Routine {
  id: string;
  title: string;
  username: string;
  notes: string | null;
  index: number;
  folder_id: string | null;
  short_id: string;
  program_id: string | null;
  parent_routine_id: string | null;
  created_at: string;
  updated_at: string;
  exercises: RoutineExercise[];
  [key: string]: unknown;
}

export interface ExerciseTemplateUnit {
  id: number;
  exercise_template_id: string;
  weight_unit: string;
}
