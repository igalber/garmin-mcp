import { evictAllDurableObjects } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  INITIALIZE,
  INITIALIZED_NOTIFICATION,
  mcpPost,
  mockStats,
  obtainAccessToken,
  openSession,
  rpc,
} from "./helpers";
import { tools as profileTools } from "../src/tools/profile";
import { tools as activityTools } from "../src/tools/activities";
import { tools as healthTools } from "../src/tools/health";
import { tools as trainingTools } from "../src/tools/training";
import { tools as workoutTools, resources as workoutResources } from "../src/tools/workouts";
import { tools as nutritionTools } from "../src/tools/nutrition";
import { tools as communityTools } from "../src/tools/community";
import { tools as bodyTools } from "../src/tools/body";
import { tools as analysisTools } from "../src/tools/analysis";

// The legacy adapter left the HTTP response open ~10 s after the final SSE event. Anything in
// the same order of magnitude as a local round trip proves the artificial tail is gone; this
// bound is deliberately generous so slow CI machines don't flake.
const TAIL_LIMIT_MS = 2_000;

const EXPECTED_TOOL_NAMES = Array.from(
  new Set(
    [
      ...profileTools,
      ...activityTools,
      ...healthTools,
      ...trainingTools,
      ...workoutTools,
      ...nutritionTools,
      ...communityTools,
      ...bodyTools,
      ...analysisTools,
    ].map((t) => t.name)
  )
);

const timings: Record<string, number> = {};
const record = (label: string, ms: number) => {
  timings[label] = Math.round(ms);
};

let accessToken: string;

beforeAll(async () => {
  accessToken = await obtainAccessToken();
});

describe("MCP over Streamable HTTP", () => {
  it("initialize returns a valid MCP response and a session id", async () => {
    const res = await mcpPost(accessToken, INITIALIZE());
    record("initialize (cold session) total", res.timings.end);
    record("initialize (cold session) tail", res.timings.tail);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.sessionId).toBeTruthy();
    expect(res.messages).toHaveLength(1);
    const msg = res.messages[0];
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(msg.result.serverInfo.name).toBe("garmin");
    expect(msg.result.capabilities.tools).toBeDefined();
    expect(msg.result.capabilities.resources).toBeDefined();
    expect(res.timings.tail).toBeLessThan(TAIL_LIMIT_MS);
  });

  it("notification-only requests return 202 promptly with no body", async () => {
    const init = await mcpPost(accessToken, INITIALIZE());
    const res = await mcpPost(accessToken, INITIALIZED_NOTIFICATION, init.sessionId);
    record("notifications/initialized total", res.timings.end);
    expect(res.status).toBe(202);
    expect(res.text).toBe("");
    expect(res.timings.end).toBeLessThan(TAIL_LIMIT_MS);
  });

  it("rejects requests without a session id and requests for unknown sessions", async () => {
    const noSession = await mcpPost(accessToken, rpc("tools/list"));
    expect(noSession.status).toBe(400);
    const unknown = await mcpPost(accessToken, rpc("tools/list"), "does-not-exist");
    expect(unknown.status).toBe(404);
  });

  it("tools/list returns every registered Garmin tool and resource", async () => {
    const { sessionId } = await openSession(accessToken);
    const res = await mcpPost(accessToken, rpc("tools/list"), sessionId);
    record("tools/list total", res.timings.end);
    record("tools/list tail", res.timings.tail);
    expect(res.status).toBe(200);
    expect(res.messages).toHaveLength(1);
    const names = (res.messages[0].result.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort());
    expect(names.length).toBeGreaterThanOrEqual(98);
    expect(res.timings.tail).toBeLessThan(TAIL_LIMIT_MS);

    const resources = await mcpPost(accessToken, rpc("resources/list"), sessionId);
    const uris = (resources.messages[0].result.resources as { uri: string }[]).map((r) => r.uri).sort();
    expect(uris).toEqual(workoutResources.map((r) => r.uri).sort());
  });

  it("get_activities keeps its input and output schemas", async () => {
    const { sessionId } = await openSession(accessToken);
    const res = await mcpPost(accessToken, rpc("tools/list"), sessionId);
    const tool = (res.messages[0].result.tools as any[]).find((t) => t.name === "get_activities");
    expect(tool).toBeDefined();
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["limit", "start"]);
    expect(Object.keys(tool.outputSchema.properties).sort()).toEqual(
      ["activities", "count", "has_more", "limit", "message", "next_start", "start"].sort()
    );
    const activity = tool.outputSchema.properties.activities.items;
    expect(Object.keys(activity.properties).sort()).toEqual(
      [
        "id", "name", "type", "event_type", "start_time", "distance_meters", "duration_seconds",
        "calories", "avg_hr_bpm", "max_hr_bpm", "steps", "elevation_gain_meters",
        "elevation_loss_meters", "moving_duration_seconds", "owner_display_name",
      ].sort()
    );
  });

  it("get_activities(limit=1) succeeds, exchanges the token lazily, and closes without a tail", async () => {
    const { sessionId } = await openSession(accessToken);
    // one Garmin fetch (the consumer doc is module-cached by the Worker between requests)
    const before = await mockStats();
    // no Garmin call happens during initialize / tools/list
    await mcpPost(accessToken, rpc("tools/list"), sessionId);
    const afterList = await mockStats();
    expect(afterList.exchange).toBe(before.exchange);
    expect(afterList.activities).toBe(before.activities);

    const res = await mcpPost(accessToken, rpc("tools/call", { name: "get_activities", arguments: { limit: 1 } }), sessionId);
    record("get_activities(limit=1) first call total", res.timings.end);
    record("get_activities(limit=1) first call tail", res.timings.tail);
    expect(res.status).toBe(200);
    expect(res.messages).toHaveLength(1);
    const result = res.messages[0].result;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      start: 0,
      limit: 1,
      count: 1,
      has_more: true,
      next_start: 1,
    });
    expect(result.structuredContent.activities).toHaveLength(1);
    expect(result.structuredContent.activities[0]).toEqual({
      id: 1234567890,
      name: "Morning Run",
      type: "running",
      event_type: "uncategorized",
      start_time: "2026-09-20 07:01:02",
      distance_meters: 5012.3,
      duration_seconds: 1501.2,
      calories: 402,
      avg_hr_bpm: 148,
      max_hr_bpm: 171,
      steps: 5210,
      elevation_gain_meters: 32,
      elevation_loss_meters: 30,
      moving_duration_seconds: 1490,
      owner_display_name: "tester",
    });
    // text content mirrors the structured result
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(res.timings.tail).toBeLessThan(TAIL_LIMIT_MS);

    const afterCall = await mockStats();
    expect(afterCall.exchange).toBe(before.exchange + 1);
    expect(afterCall.activities).toBe(before.activities + 1);

    // warm repeat on the same session: cached bearer, one Garmin call, still no tail
    const again = await mcpPost(accessToken, rpc("tools/call", { name: "get_activities", arguments: { limit: 1 } }), sessionId);
    record("get_activities(limit=1) warm repeat total", again.timings.end);
    record("get_activities(limit=1) warm repeat tail", again.timings.tail);
    expect(again.status).toBe(200);
    expect(again.messages[0].result.structuredContent.count).toBe(1);
    expect(again.timings.tail).toBeLessThan(TAIL_LIMIT_MS);
    const afterAgain = await mockStats();
    expect(afterAgain.exchange).toBe(afterCall.exchange);
    expect(afterAgain.activities).toBe(afterCall.activities + 1);
  });

  it("serves many requests on one session in order", async () => {
    const { sessionId } = await openSession(accessToken);
    for (let i = 0; i < 4; i++) {
      const res = await mcpPost(accessToken, rpc("tools/list"), sessionId);
      expect(res.status).toBe(200);
      expect(res.sessionId).toBe(sessionId);
      expect(res.messages[0].result.tools.length).toBe(EXPECTED_TOOL_NAMES.length);
      expect(res.timings.tail).toBeLessThan(TAIL_LIMIT_MS);
    }
    const ping = await mcpPost(accessToken, rpc("ping"), sessionId);
    expect(ping.status).toBe(200);
    expect(ping.messages[0].result).toEqual({});
  });

  it("closes a batched request only after every response has been sent", async () => {
    const { sessionId } = await openSession(accessToken);
    const a = rpc("tools/list");
    const b = rpc("ping");
    const res = await mcpPost(accessToken, [a, b], sessionId);
    expect(res.status).toBe(200);
    const ids = res.messages.map((m) => m.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
    expect(res.timings.tail).toBeLessThan(TAIL_LIMIT_MS);
  });

  it("survives Durable Object eviction: a cold object still serves the existing session", async () => {
    const { sessionId } = await openSession(accessToken);
    const warm = await mcpPost(accessToken, rpc("tools/list"), sessionId);
    expect(warm.status).toBe(200);
    record("tools/list warm DO total", warm.timings.end);

    await evictAllDurableObjects();

    const cold = await mcpPost(accessToken, rpc("tools/list"), sessionId);
    record("tools/list cold DO total", cold.timings.end);
    record("tools/list cold DO tail", cold.timings.tail);
    expect(cold.status).toBe(200);
    expect(cold.sessionId).toBe(sessionId);
    expect(cold.messages[0].result.tools.length).toBe(EXPECTED_TOOL_NAMES.length);
    expect(cold.timings.tail).toBeLessThan(TAIL_LIMIT_MS);

    // and a Garmin-backed tool still works: props (the Garmin grant) were restored from storage
    const call = await mcpPost(accessToken, rpc("tools/call", { name: "get_activities", arguments: { limit: 1 } }), sessionId);
    expect(call.status).toBe(200);
    expect(call.messages[0].result.structuredContent.count).toBe(1);
  });

  it("requires the OAuth bearer token on /mcp", async () => {
    const res = await mcpPost("not-a-real-token", INITIALIZE());
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("reports timings", () => {
    // eslint-disable-next-line no-console
    console.log("\nlocal timings (ms):\n" + Object.entries(timings).map(([k, v]) => `  ${k.padEnd(46)} ${v}`).join("\n"));
  });
});
