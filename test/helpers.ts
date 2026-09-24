import { SELF } from "cloudflare:test";

const ORIGIN = "https://garmin-mcp.test";
const REDIRECT_URI = "https://client.test/cb";

// The Garmin OAuth1 token a user would paste on /authorize. Only its shape matters: the mock
// Garmin worker accepts any OAuth1-signed exchange request.
export const FAKE_OAUTH1 = { oauth_token: "fake-oauth1-token", oauth_token_secret: "fake-oauth1-secret" };

const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Runs the real OAuth 2.1 flow against the Worker: register -> authorize (token paste) -> code -> token. */
export async function obtainAccessToken(): Promise<string> {
  const reg = await SELF.fetch(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "vitest",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
  const { client_id } = (await reg.json()) as { client_id: string };

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const authorize = new URL(`${ORIGIN}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", client_id);
  authorize.searchParams.set("redirect_uri", REDIRECT_URI);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", "st4te");

  const blob = btoa(JSON.stringify(FAKE_OAUTH1));
  const form = new URLSearchParams({ step: "token", token: blob });
  const authRes = await SELF.fetch(authorize, { method: "POST", body: form, redirect: "manual" });
  if (authRes.status !== 302) throw new Error(`authorize failed: ${authRes.status} ${await authRes.text()}`);
  const location = new URL(authRes.headers.get("location")!);
  const code = location.searchParams.get("code");
  if (!code) throw new Error(`no code in redirect: ${location}`);
  if (location.searchParams.get("state") !== "st4te") throw new Error("state mismatch");

  const tokenRes = await SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (tokenRes.status !== 200) throw new Error(`token failed: ${tokenRes.status} ${await tokenRes.text()}`);
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  return access_token;
}

export interface SseEvent {
  event?: string;
  id?: string;
  data: string;
}

export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split(/\n\n/)) {
    if (!block.trim()) continue;
    const ev: SseEvent = { data: "" };
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) ev.event = line.slice(6).trim();
      else if (line.startsWith("id:")) ev.id = line.slice(3).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    ev.data = dataLines.join("\n");
    events.push(ev);
  }
  return events;
}

export interface McpTimings {
  /** ms from request start until response headers arrived */
  headers: number;
  /** ms from request start until the first body byte arrived (undefined for empty bodies) */
  firstByte?: number;
  /** ms from request start until the body stream ended */
  end: number;
  /** ms between the first body byte and stream end: the "tail" this change removes */
  tail: number;
}

export interface McpResult {
  status: number;
  sessionId: string | null;
  headers: Headers;
  text: string;
  events: SseEvent[];
  messages: any[];
  timings: McpTimings;
}

export async function mcpPost(
  accessToken: string,
  body: unknown,
  sessionId?: string | null,
  extraHeaders: Record<string, string> = {}
): Promise<McpResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
    ...extraHeaders,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const t0 = performance.now();
  const res = await SELF.fetch(`${ORIGIN}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const tHeaders = performance.now();
  let firstByte: number | undefined;
  let text = "";
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength && firstByte === undefined) firstByte = performance.now();
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  const tEnd = performance.now();
  const events = parseSse(text);
  const messages = events.filter((e) => e.data).map((e) => JSON.parse(e.data));
  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id"),
    headers: res.headers,
    text,
    events,
    messages,
    timings: {
      headers: tHeaders - t0,
      firstByte: firstByte === undefined ? undefined : firstByte - t0,
      end: tEnd - t0,
      tail: firstByte === undefined ? 0 : tEnd - firstByte,
    },
  };
}

let nextId = 1;
export const rpc = (method: string, params: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0" as const,
  id: nextId++,
  method,
  params,
});

export const INITIALIZE = () =>
  rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vitest", version: "0.0.0" },
  });

export const INITIALIZED_NOTIFICATION = { jsonrpc: "2.0" as const, method: "notifications/initialized" };

/** initialize + notifications/initialized; returns the session id and the initialize result. */
export async function openSession(accessToken: string) {
  const init = await mcpPost(accessToken, INITIALIZE());
  if (init.status !== 200) throw new Error(`initialize failed: ${init.status} ${init.text}`);
  const sessionId = init.sessionId;
  if (!sessionId) throw new Error("no mcp-session-id on initialize response");
  const notified = await mcpPost(accessToken, INITIALIZED_NOTIFICATION, sessionId);
  if (notified.status !== 202) throw new Error(`notifications/initialized -> ${notified.status}`);
  return { sessionId, init, notified };
}

export async function mockStats() {
  const res = await fetch("https://garmin-mock.test/stats");
  return (await res.json()) as Record<string, number>;
}

export async function resetMockStats() {
  await fetch("https://garmin-mock.test/reset");
}
