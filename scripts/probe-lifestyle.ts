// Read-only probe: dump lifestyle-logging shapes to reverse-engineer the write payload.
// Run: npx tsx scripts/probe-lifestyle.ts
import { readFileSync } from "node:fs";
import { exchange, api } from "../src/garmin";

const oauth1 = JSON.parse(readFileSync(`${process.env.HOME}/.garminconnect/oauth1_token.json`, "utf8"));
const tok = await exchange(oauth1);
const at = tok.access_token;

const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function tryGet(path: string, params?: Record<string, string>) {
  try {
    const r = await api(at, path, params ? { params } : undefined);
    const s = JSON.stringify(r);
    console.log(`OK   ${path}${params ? "?" + new URLSearchParams(params) : ""}\n     ${s.slice(0, 600)}`);
    return r;
  } catch (e) {
    console.log(`FAIL ${path} -> ${(e as Error).message.slice(0, 120)}`);
    return null;
  }
}

console.log("== recent dailyLog days ==");
for (let n = 0; n < 8; n++) await tryGet(`/lifestylelogging-service/dailyLog/${day(n)}`);

console.log("\n== candidate metadata / list endpoints ==");
await tryGet("/lifestylelogging-service/logTypes");
await tryGet("/lifestylelogging-service/eventTypes");
await tryGet("/lifestylelogging-service/lifestyleLog/types");
await tryGet("/lifestylelogging-service/dailyLog", { startDate: day(30), endDate: day(0) });
