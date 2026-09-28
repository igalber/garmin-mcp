// Generate the GitHub wiki (one page per module) from the tool definitions.
// Usage: npx tsx scripts/gen-wiki.ts <wiki-checkout-dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDef } from "../src/toolkit";
import { tools as profile } from "../src/tools/profile";
import { tools as activities } from "../src/tools/activities";
import { tools as health } from "../src/tools/health";
import { tools as training } from "../src/tools/training";
import { tools as workouts, resources } from "../src/tools/workouts";
import { tools as nutrition } from "../src/tools/nutrition";
import { tools as community } from "../src/tools/community";
import { tools as body } from "../src/tools/body";
import { tools as analysis } from "../src/tools/analysis";
import { tools as review } from "../src/tools/review";

const MODULES: { title: string; blurb: string; tools: ToolDef[] }[] = [
  { title: "Daily Review", blurb: "One-call composite for reviewing a day; fans out to the other tools in parallel server-side.", tools: review },
  { title: "Activity Management", blurb: "List, inspect, edit, create, upload and delete activities.", tools: activities },
  { title: "Health and Wellness", blurb: "Daily stats, sleep, heart rate, stress, SpO2, body battery, steps, respiration — full data and lightweight summaries.", tools: health },
  { title: "Training and Performance", blurb: "Training status and load, readiness, HRV, VO2max, endurance and hill scores, trends.", tools: training },
  { title: "Workouts and Builders", blurb: "Structured workouts: CRUD, scheduling, Garmin Coach, and high-level builders that emit valid workout JSON.", tools: workouts },
  { title: "Nutrition", blurb: "Food logs, meals, custom foods, macro goals, quick-add logging.", tools: nutrition },
  { title: "Challenges Devices and Gear", blurb: "Badges, personal records, challenges, race predictions, device settings and alarms, gear.", tools: community },
  { title: "Weight Body and Courses", blurb: "Weigh-ins, body composition, blood pressure, hydration, women's health, GPX courses.", tools: body },
  { title: "FIT Analysis", blurb: "Download and parse FIT files: power analysis, power-duration curve, W/kg, raw file export.", tools: analysis },
  { title: "User Profile and Passthrough", blurb: "Profile and settings reads, plus garmin_get — a raw GET escape hatch to any Garmin Connect endpoint.", tools: profile },
];
const WRITE = /^(upload|delete|create|set_|add_|log_|schedule|unschedule|update|remove|upsert|request_)/;
const REPO = "https://github.com/rohankmr414/garmin-mcp";

const out = process.argv[2];
if (!out) { console.error("usage: tsx scripts/gen-wiki.ts <wiki-checkout-dir>"); process.exit(1); }
mkdirSync(out, { recursive: true });

const page = (title: string) => title.replace(/\s+/g, "-") + ".md";
const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
const typeOf = (p: any): string => {
  if (!p) return "any";
  if (p.enum) return p.enum.map((v: unknown) => `\`${v}\``).join(" \\| ");
  if (p.anyOf) return p.anyOf.map(typeOf).join(" \\| ");
  if (p.type === "array") return `array<${typeOf(p.items)}>`;
  if (p.type === "object") return "object";
  return p.type ?? "any";
};

function renderTool(t: ToolDef): string {
  const lines = [`### \`${t.name}\``, ""];
  if (WRITE.test(t.name)) lines.push("**Writes to your Garmin account.**", "");
  lines.push(t.desc.trim(), "");
  if (t.params && Object.keys(t.params).length) {
    const js = zodToJsonSchema(z.object(t.params)) as any;
    const req = new Set<string>(js.required ?? []);
    lines.push("| Parameter | Type | Required | Default | Description |", "|---|---|---|---|---|");
    for (const [name, p] of Object.entries<any>(js.properties ?? {})) {
      const def = p.default === undefined ? "—" : `\`${JSON.stringify(p.default)}\``;
      lines.push(`| \`${name}\` | ${typeOf(p)} | ${req.has(name) ? "yes" : "no"} | ${def} | ${cell(p.description)} |`);
    }
    lines.push("");
  } else lines.push("_No parameters._", "");
  if (t.outputSchema) lines.push("_Returns structured output (declares an MCP `outputSchema`)._", "");
  return lines.join("\n");
}

const all = MODULES.flatMap((m) => m.tools);
const total = new Set(all.map((t) => t.name)).size;
const writes = all.filter((t) => WRITE.test(t.name)).length;

for (const m of MODULES) {
  const md = [`# ${m.title}`, "", m.blurb, "", `${m.tools.length} tools. Back to [[Home]].`, "",
    ...m.tools.map((t) => `- [\`${t.name}\`](#${t.name})`), "", "---", "",
    ...m.tools.map(renderTool)].join("\n");
  writeFileSync(join(out, page(m.title)), md + "\n");
}

const home = [
  "# Garmin MCP — Tool Reference",
  "",
  `Every tool exposed by the [garmin-mcp](${REPO}) server: **${total} tools** across ${MODULES.length} modules (${writes} of them write to your Garmin account), plus ${resources.length} workout template/reference resources.`,
  "",
  "Tools are grouped by module. Each entry lists its parameters exactly as MCP clients see them (name, type, required, default). Tools that declare an MCP `outputSchema` also return validated structured content.",
  "",
  "| Module | Tools | What it covers |", "|---|---|---|",
  ...MODULES.map((m) => `| [[${m.title}]] | ${m.tools.length} | ${cell(m.blurb)} |`),
  "",
  "## Resources",
  "",
  "Static MCP resources (workout templates and a structure reference):",
  "",
  ...resources.map((r) => `- \`${r.uri}\` — ${r.name}`),
  "",
  "## Usage notes",
  "",
  "- Reviewing a day? Use `get_daily_review(date)` — one round-trip instead of 6-15 calls.",
  "- Bulk sleep trends: `get_sleep_range(start_date, end_date)` (one call, compact per-night stats) rather than `get_sleep_data` per day.",
  "- `garmin_get(path)` reaches any Garmin Connect endpoint when no dedicated tool fits.",
  "- Dates are `YYYY-MM-DD`. Activity ids come from `get_activities` / `get_activities_by_date`.",
  "",
  `_This wiki is generated from the source by \`npm run wiki -- <wiki-checkout>\` — edit the tool definitions in [\`src/tools/\`](${REPO}/tree/main/src/tools), not these pages._`,
].join("\n");
writeFileSync(join(out, "Home.md"), home + "\n");

writeFileSync(join(out, "_Sidebar.md"), ["**[[Home]]**", "", "**Tools by module**", "", ...MODULES.map((m) => `- [[${m.title}]] (${m.tools.length})`), "", `[Repository](${REPO})`].join("\n") + "\n");

console.log(`wrote ${MODULES.length + 2} pages to ${out}: ${total} tools, ${resources.length} resources`);
