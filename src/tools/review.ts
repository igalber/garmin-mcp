import { z } from "zod";
import { dateStr, withMessage, type Ctx, type ToolDef } from "../toolkit";
import { tools as health } from "./health";
import { tools as training } from "./training";
import { tools as activities } from "./activities";

const byName = new Map([...health, ...training, ...activities].map((t) => [t.name, t]));
// keeps the fan-out under the free-tier subrequest budget: 6 day-level + 3 per activity
const MAX_ACTIVITIES = 3;

// Run another tool's logic by name. Args go through that tool's own zod schema so its defaults
// apply; a failure becomes { error } so one bad endpoint doesn't sink the whole review.
async function part(name: string, args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  const t = byName.get(name);
  if (!t) return { error: `unknown tool ${name}` };
  try {
    return await t.run(t.params ? z.object(t.params).parse(args) : args, ctx);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export const tools: ToolDef[] = [
  {
    name: "get_daily_review",
    desc: `One-call daily review for a date: stats, sleep summary, training readiness, stress summary, HRV, and the day's activities — each activity with its splits, weather and gear (up to ${MAX_ACTIVITIES} activities). Everything is fetched in parallel server-side, so this is one round-trip instead of the 6-15 separate calls it replaces. Prefer it over calling those tools one by one when reviewing a day.`,
    params: { date: dateStr },
    outputSchema: withMessage({
      date: z.string().optional(),
      stats: z.unknown(),
      sleep: z.unknown(),
      training_readiness: z.unknown(),
      stress: z.unknown(),
      hrv: z.unknown(),
      activities: z.array(z.unknown()).optional(),
    }),
    run: async (args, ctx) => {
      const d = { date: args.date };
      const [stats, sleep, training_readiness, stress, hrv, list] = await Promise.all([
        part("get_stats", d, ctx),
        part("get_sleep_summary", d, ctx),
        part("get_training_readiness", d, ctx),
        part("get_stress_summary", d, ctx),
        part("get_hrv_data", d, ctx),
        part("get_activities_by_date", { start_date: args.date, end_date: args.date, page_size: MAX_ACTIVITIES }, ctx),
      ]);
      const listed: Record<string, any>[] = ((list as any)?.activities ?? []).slice(0, MAX_ACTIVITIES);
      const activitiesDetail = await Promise.all(
        listed.map(async (a) => {
          const id = { activity_id: a.id };
          const [splits, weather, gear] = await Promise.all([
            part("get_activity_splits", id, ctx),
            part("get_activity_weather", id, ctx),
            part("get_activity_gear", id, ctx),
          ]);
          return { ...a, splits, weather, gear };
        })
      );
      return { date: args.date, stats, sleep, training_readiness, stress, hrv, activities: activitiesDetail };
    },
  },
];
