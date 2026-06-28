#!/usr/bin/env node
/**
 * Spins up the Hevy MCP server over stdio and exercises it like a real client:
 * lists tools, reads profile/exercises, then creates a routine from a plan that
 * mixes an existing exercise (should match) and a novel one (should be created),
 * and finally deletes the routine to clean up.
 *
 *   HEVY_TOKEN_FILE=examples/.hevy-token.json node mcp/test-client.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["mcp/server.mjs"],
  env: { ...process.env },
  stderr: "inherit",
});
const client = new Client({ name: "test", version: "0" });
await client.connect(transport);

const parse = (r) => {
  const text = r.content?.[0]?.text ?? "{}";
  try { return JSON.parse(text); } catch { return text; }
};
async function tool(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const data = parse(r);
  console.log(`\n── ${name}(${JSON.stringify(args).slice(0, 80)}) ${r.isError ? "✗" : "✓"}`);
  console.log(JSON.stringify(data, null, 2).slice(0, 900));
  return data;
}

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

await tool("get_profile");
await tool("list_exercises", { query: "bench", limit: 5 });

const plan = await tool("create_routine", {
  title: "MCP Test Plan (safe to delete)",
  exercises: [
    { name: "Bench Press (Barbell)", sets: [ { weight_kg: 60, reps: 8 }, { weight_kg: 60, reps: 8 } ] },
    { name: "Lat Pulldown", rest_seconds: 90, sets: [ { weight_kg: 50, reps: 10 } ] },
    { name: "Cable Woodchopper XYZ", muscle_group: "abdominals", equipment: "machine", sets: [ { reps: 12 } ] },
  ],
});

if (plan?.routineId) {
  await tool("delete_routine", { id: plan.routineId });
}

await client.close();
console.log("\nDone.");
