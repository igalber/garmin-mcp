import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { api, exchange, type OAuth1Token, type OAuth2Token } from "./garmin";
import { authHandler } from "./auth";
import type { Ctx, ToolDef } from "./toolkit";
import { makeTimer, timingEnabled, withRequestTiming, type Timer } from "./timing";
import { tools as profileTools } from "./tools/profile";
import { tools as activityTools } from "./tools/activities";
import { tools as healthTools } from "./tools/health";
import { tools as trainingTools } from "./tools/training";
import { tools as workoutTools, resources as workoutResources } from "./tools/workouts";
import { tools as nutritionTools } from "./tools/nutrition";
import { tools as communityTools } from "./tools/community";
import { tools as bodyTools } from "./tools/body";
import { tools as analysisTools } from "./tools/analysis";

// Env comes from worker-configuration.d.ts (wrangler types)

// Garmin OAuth1 token arrives per-request from the MCP client's Authorization header
type Props = { oauth1: OAuth1Token };

const ALL_TOOLS: ToolDef[] = [
  ...profileTools,
  ...activityTools,
  ...healthTools,
  ...trainingTools,
  ...workoutTools,
  ...nutritionTools,
  ...communityTools,
  ...bodyTools,
  ...analysisTools,
];

// Text content always carries the raw result. When a tool declares an outputSchema the SDK
// requires structuredContent (an object), so fold strings -> {message} and arrays -> {items}.
const toResult = (data: unknown, structured: boolean) => {
  const content = [{ type: "text" as const, text: JSON.stringify(data) }];
  if (!structured) return { content };
  const structuredContent: Record<string, unknown> = Array.isArray(data)
    ? { items: data }
    : data !== null && typeof data === "object"
      ? (data as Record<string, unknown>)
      : { message: String(data) };
  return { content, structuredContent };
};

export class GarminMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "garmin", version: "0.2.0" });
  // agents' default observability console.logs a "Connection established/closed" object for every
  // POST (each one is a short-lived internal WebSocket). The MCP_TIMING lines cover that lifecycle
  // with correlation ids, so drop the generic ones.
  observability = undefined;
  private oauth2?: OAuth2Token;
  private dn?: string;
  private principal?: string;

  // Correlation for Durable Object-side timing lines: the MCP session id (this object's name is
  // `streamable-http:<session>`) plus a per-instance id that changes on every cold start.
  private timer(): Timer {
    let session: string | undefined;
    try {
      session = this.name.split(":")[1]; // partyserver throws if the name is not yet set
    } catch {
      session = undefined;
    }
    return makeTimer(timingEnabled(this.env), "do", {
      session,
      instance: (this.instanceId ??= crypto.randomUUID().slice(0, 8)),
    });
  }
  private instanceId?: string;

  // The Garmin grant travels as OAuth props; a session with no grant cannot call Garmin.
  private grant(): OAuth1Token {
    const g = this.props?.oauth1;
    if (!g?.oauth_token || !g.oauth_token_secret) {
      throw new Error("No Garmin credentials on this MCP session — re-authorize the server.");
    }
    return g;
  }

  // drop cached tokens if this request's grant differs from the one they were derived from,
  // so a reused Durable Object never serves one principal's data under another's credential
  private syncPrincipal() {
    const token = this.grant().oauth_token;
    if (this.principal !== token) {
      this.principal = token;
      this.oauth2 = undefined;
      this.dn = undefined;
    }
  }

  // Lazy: the OAuth1 -> OAuth2 exchange only happens on the first Garmin call of a live
  // instance (or after expiry), never during initialize / tools/list.
  private async accessToken(): Promise<string> {
    this.syncPrincipal();
    if (!this.oauth2 || this.oauth2.expires_at - 300 <= Date.now() / 1000) {
      this.oauth2 = await this.timer().time("token-exchange", () => exchange(this.grant()));
    }
    return this.oauth2.access_token;
  }

  // Runs once per live Durable Object instance (McpAgent.onStart -> init). Registration cost is
  // paid on cold start only, not per request.
  async onStart(props?: Props) {
    const t = this.timer();
    await super.onStart(props);
    t.mark("do-start", { tools: ALL_TOOLS.length, resources: workoutResources.length });
  }

  async init() {
    const t = this.timer();
    const ctx: Ctx = {
      api: async (path, opts) => {
        const token = await this.accessToken(); // logged separately as token-exchange when it happens
        return this.timer().time("garmin-api", () => api(token, path, opts), {
          path,
          method: opts?.method ?? "GET",
        });
      },
      displayName: async () => {
        this.syncPrincipal();
        if (!this.dn) {
          const profile = (await ctx.api("/userprofile-service/socialProfile")) as {
            displayName: string;
          };
          this.dn = encodeURIComponent(profile.displayName);
        }
        return this.dn;
      },
    };

    const seen = new Set<string>();
    for (const tool of ALL_TOOLS) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      const structured = !!tool.outputSchema;
      const config = {
        description: tool.desc,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      };
      const run = (args: Record<string, unknown>, extra: { requestId?: unknown }) =>
        this.timer().time("tool", async () => toResult(await tool.run(args, ctx), structured), {
          tool: tool.name,
          rpc_id: extra.requestId,
        });
      if (tool.params) {
        this.server.registerTool(tool.name, { ...config, inputSchema: tool.params }, run);
      } else {
        this.server.registerTool(tool.name, config, (extra) => run({}, extra));
      }
    }

    for (const r of workoutResources) {
      this.server.registerResource(r.name, r.uri, { mimeType: "application/json" }, async (uri) => ({
        contents: [{ uri: uri.href, mimeType: "application/json", text: r.text }],
      }));
    }
    t.mark("init", { tools: seen.size, resources: workoutResources.length });
  }
}

// OAuth 2.1 only: /authorize serves the Garmin connect page; grants carry oauth1 as encrypted
// props; every /mcp request is gated on a provider-validated access token (no raw-header path).
export default new OAuthProvider({
  apiRoute: "/mcp",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiHandler: withRequestTiming(GarminMCP.serve("/mcp")) as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultHandler: authHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,
});
