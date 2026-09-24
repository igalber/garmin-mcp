// Stand-in for Garmin Connect + the OAuth consumer document. Wired as the main worker's
// outbound service in vitest.config.ts, so every fetch() the Worker/Durable Object makes lands
// here instead of the public internet. Module-level counters let tests assert on call counts.
const counters = { consumer: 0, exchange: 0, profile: 0, activities: 0, other: 0 };

const ACTIVITY = {
  activityId: 1234567890,
  activityName: "Morning Run",
  activityType: { typeKey: "running" },
  eventType: { typeKey: "uncategorized" },
  startTimeLocal: "2026-09-20 07:01:02",
  distance: 5012.3,
  duration: 1501.2,
  movingDuration: 1490.0,
  calories: 402,
  averageHR: 148,
  maxHR: 171,
  steps: 5210,
  elevationGain: 32,
  elevationLoss: 30,
  ownerDisplayName: "tester",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === "garmin-mock.test") {
      if (url.pathname === "/stats") return json(counters);
      if (url.pathname === "/reset") {
        for (const k of Object.keys(counters)) counters[k] = 0;
        return json({ ok: true });
      }
      return json({ error: "unknown mock path" }, 404);
    }
    if (url.hostname === "thegarth.s3.amazonaws.com" && url.pathname === "/oauth_consumer.json") {
      counters.consumer++;
      return json({ consumer_key: "mock-consumer-key", consumer_secret: "mock-consumer-secret" });
    }
    if (url.hostname === "connectapi.garmin.com") {
      const auth = request.headers.get("authorization") ?? "";
      if (url.pathname === "/oauth-service/oauth/exchange/user/2.0") {
        counters.exchange++;
        if (!auth.startsWith("OAuth ")) return json({ error: "missing oauth1 signature" }, 401);
        return json({
          scope: "CONNECT_READ CONNECT_WRITE",
          jti: "mock-jti",
          token_type: "Bearer",
          access_token: `mock-access-${counters.exchange}`,
          refresh_token: "mock-refresh",
          expires_in: 3600,
          refresh_token_expires_in: 7776000,
        });
      }
      if (!auth.startsWith("Bearer mock-access-")) return json({ error: "unauthorized" }, 401);
      if (url.pathname === "/userprofile-service/socialProfile") {
        counters.profile++;
        return json({ displayName: "tester", fullName: "Test User" });
      }
      if (url.pathname === "/activitylist-service/activities/search/activities") {
        counters.activities++;
        const limit = Number(url.searchParams.get("limit") ?? "20");
        const start = Number(url.searchParams.get("start") ?? "0");
        const items = [];
        for (let i = 0; i < limit; i++) {
          items.push({ ...ACTIVITY, activityId: ACTIVITY.activityId - start - i });
        }
        return json(items);
      }
    }
    counters.other++;
    return json({ error: `unmocked ${request.method} ${url.href}` }, 599);
  },
};
