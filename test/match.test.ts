import { describe, it, expect } from "vitest";
import { normalizeExerciseName, findBestMatch, type CatalogEntry } from "../src/match.js";

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
