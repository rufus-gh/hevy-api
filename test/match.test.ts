import { describe, it, expect } from "vitest";
import { normalizeExerciseName, findBestMatch, type CatalogEntry } from "../src/match.js";
import { DEFAULT_EXERCISES } from "../src/exercises.js";

const catalog: CatalogEntry[] = [
  { exercise_template_id: "1", title: "Bench Press (Barbell)" },
  { exercise_template_id: "2", title: "Incline Bench Press (Dumbbell)" },
  { exercise_template_id: "3", title: "Lat Pulldown (Cable)" },
  { exercise_template_id: "4", title: "Squat (Barbell)" },
];

describe("normalizeExerciseName", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeExerciseName("Bench Press (Barbell)")).toBe("bench press barbell");
  });
});

describe("findBestMatch", () => {
  it("matches regardless of word order / equipment placement", () => {
    expect(findBestMatch("Barbell Bench Press", catalog)?.entry.exercise_template_id).toBe("1");
  });

  it("matches a generic name to the most generic catalog entry", () => {
    // "Bench Press" is a subset of both #1 and #2; prefers the shorter title.
    expect(findBestMatch("Bench Press", catalog)?.entry.exercise_template_id).toBe("1");
  });

  it("expands common abbreviations (db/bb)", () => {
    expect(findBestMatch("Incline Bench Press DB", catalog)?.entry.exercise_template_id).toBe("2");
  });

  it("returns null when nothing is close enough", () => {
    expect(findBestMatch("Romanian Deadlift", catalog)).toBeNull();
  });
});

describe("DEFAULT_EXERCISES (bundled Hevy library)", () => {
  it("is a non-trivial set of non-custom defaults", () => {
    expect(DEFAULT_EXERCISES.length).toBeGreaterThan(100);
    expect(DEFAULT_EXERCISES.every((e) => e.is_custom === false)).toBe(true);
  });

  it("uses Hevy's canonical 8-char hex template ids", () => {
    expect(DEFAULT_EXERCISES.every((e) => /^[0-9A-F]{8}$/.test(e.exercise_template_id))).toBe(true);
  });

  it("has unique ids and known anchors with verified ids", () => {
    const ids = new Set(DEFAULT_EXERCISES.map((e) => e.exercise_template_id));
    expect(ids.size).toBe(DEFAULT_EXERCISES.length);
    const byId = new Map(DEFAULT_EXERCISES.map((e) => [e.title, e.exercise_template_id]));
    expect(byId.get("Bench Press (Barbell)")).toBe("79D0BB3A");
    expect(byId.get("Lat Pulldown (Cable)")).toBe("6A6C31A5");
  });

  it("lets common exercises match that a user-history-only catalog would miss", () => {
    // "Romanian Deadlift" found nothing in the tiny catalog above; against the
    // bundled library it resolves to the real default template.
    const m = findBestMatch("Romanian Deadlift", DEFAULT_EXERCISES);
    expect(m?.entry.title).toMatch(/Romanian Deadlift/);
  });
});
