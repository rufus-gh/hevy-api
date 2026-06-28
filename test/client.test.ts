import { describe, it, expect, vi } from "vitest";
import { HevyClient } from "../src/index.js";

/** Build a fake fetch that records calls and returns canned JSON. */
function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    const { status = 200, body } = handler(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("HevyClient", () => {
  it("sends the api key, version headers and bearer token", async () => {
    let seen: RequestInit | undefined;
    const fetch = fakeFetch((url, init) => {
      seen = init;
      return { body: { id: "u1", username: "rufus" } };
    });

    const client = new HevyClient({
      refreshToken: "r1",
      accessToken: "a1",
      expiresAt: Date.now() + 3_600_000,
      fetch,
    });

    const acct = await client.getAccount();
    expect(acct.username).toBe("rufus");

    const headers = seen!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("klean_kanteen_insulated");
    expect(headers.authorization).toBe("Bearer a1");
    expect(headers["hevy-app-version"]).toBeTruthy();
  });

  it("refreshes an expired access token before the request", async () => {
    const calls: string[] = [];
    const fetch = fakeFetch((url) => {
      calls.push(new URL(url).pathname);
      if (url.includes("/auth/refresh_token")) {
        return {
          body: {
            user_id: "u1",
            access_token: "fresh",
            refresh_token: "r2",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
        };
      }
      return { body: { id: "u1", username: "rufus" } };
    });

    const rotated: string[] = [];
    const client = new HevyClient({
      refreshToken: "r1",
      accessToken: "stale",
      expiresAt: Date.now() - 1000, // already expired
      fetch,
      onTokensRefreshed: (s) => rotated.push(s.refreshToken),
    });

    await client.getAccount();
    expect(calls).toContain("/auth/refresh_token");
    expect(rotated).toEqual(["r2"]);
  });

  it("retries once on 401 after forcing a refresh", async () => {
    let accountHits = 0;
    const fetch = fakeFetch((url) => {
      if (url.includes("/auth/refresh_token")) {
        return {
          body: {
            user_id: "u1",
            access_token: "fresh",
            refresh_token: "r2",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
        };
      }
      accountHits++;
      if (accountHits === 1) return { status: 401, body: { error: "unauthorized" } };
      return { body: { id: "u1", username: "rufus" } };
    });

    const client = new HevyClient({
      refreshToken: "r1",
      accessToken: "a1",
      expiresAt: Date.now() + 3_600_000,
      fetch,
    });

    const acct = await client.getAccount();
    expect(acct.username).toBe("rufus");
    expect(accountHits).toBe(2);
  });

  it("searches routines client-side by title and exercise", async () => {
    const routines = [
      { id: "1", title: "Push Day", notes: "chest", exercises: [{ title: "Bench Press" }] },
      { id: "2", title: "Pull Day", notes: null, exercises: [{ title: "Lat Pulldown" }] },
      { id: "3", title: "Legs", notes: null, exercises: [{ title: "Squat" }] },
    ];
    const fetch = fakeFetch(() => ({ body: { updated: routines, deleted: [], isMore: false } }));
    const client = new HevyClient({
      refreshToken: "r1",
      accessToken: "a1",
      expiresAt: Date.now() + 3_600_000,
      fetch,
    });

    expect((await client.searchRoutines("day")).map((r) => r.id)).toEqual(["1", "2"]);
    // empty query returns everything
    expect((await client.searchRoutines("  ")).length).toBe(3);
    // exercise-title matching is opt-in
    expect((await client.searchRoutines("squat")).length).toBe(0);
    expect(
      (await client.searchRoutines("squat", { fields: ["exercises"] })).map((r) => r.id),
    ).toEqual(["3"]);
  });

  it("shapes createRoutine into the app's payload", async () => {
    let sentBody: any;
    const fetch = fakeFetch((url, init) => {
      sentBody = JSON.parse(init.body as string);
      return { body: { routineId: "new-routine" } };
    });

    const client = new HevyClient({
      refreshToken: "r1",
      accessToken: "a1",
      expiresAt: Date.now() + 3_600_000,
      fetch,
    });

    const res = await client.createRoutine({
      title: "Push Day",
      exercises: [
        { exercise_template_id: "ABC123", sets: [{ index: 0, weight_kg: 60, reps: 5 }] },
      ],
    });

    expect(res.routineId).toBe("new-routine");
    expect(sentBody.routine.title).toBe("Push Day");
    expect(sentBody.routine.exercises[0].sets[0].indicator).toBe("normal");
    expect(sentBody.routine.clientId).toBeTruthy();
  });
});
