// Structured timing instrumentation. One JSON line per stage on console.log so it shows up in
// Workers Logs. Enabled by the MCP_TIMING var ("1"/"true"/"on"); anything else is a no-op.
//
// Never log OAuth tokens, cookies, request params/bodies, or Garmin payloads through this: only
// stage names, durations, sizes, statuses, JSON-RPC ids/methods, tool names, and API paths.

export interface TimingEnv {
  MCP_TIMING?: unknown;
}

export function timingEnabled(env: TimingEnv | undefined): boolean {
  const v = String(env?.MCP_TIMING ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

export interface Timer {
  readonly enabled: boolean;
  /** ms since the timer was created */
  elapsed(): number;
  /** log a stage with the elapsed time since creation plus optional extra fields */
  mark(stage: string, extra?: Record<string, unknown>): void;
  /** time an async operation; logs `${stage}` with its own duration (and ok/error) */
  time<T>(stage: string, fn: () => Promise<T>, extra?: Record<string, unknown>): Promise<T>;
}

const noop: Timer = {
  enabled: false,
  elapsed: () => 0,
  mark: () => {},
  time: (_stage, fn) => fn(),
};

/**
 * @param scope   "worker" or "do" (which side of the Durable Object boundary emitted the line)
 * @param ids     correlation fields (session id, request id, JSON-RPC id ...)
 */
export function makeTimer(enabled: boolean, scope: string, ids: Record<string, unknown>): Timer {
  if (!enabled) return noop;
  const t0 = Date.now();
  const emit = (fields: Record<string, unknown>) => {
    console.log(JSON.stringify({ t: "mcp-timing", scope, ...ids, ...fields }));
  };
  return {
    enabled: true,
    elapsed: () => Date.now() - t0,
    mark(stage, extra) {
      emit({ stage, at_ms: Date.now() - t0, ...extra });
    },
    async time(stage, fn, extra) {
      const start = Date.now();
      try {
        const out = await fn();
        emit({ stage, at_ms: start - t0, dur_ms: Date.now() - start, ok: true, ...extra });
        return out;
      } catch (e) {
        emit({
          stage,
          at_ms: start - t0,
          dur_ms: Date.now() - start,
          ok: false,
          error: e instanceof Error ? e.constructor.name : typeof e,
          ...extra,
        });
        throw e;
      }
    },
  };
}

export const shortId = () => crypto.randomUUID().slice(0, 8);

/** Summarise a JSON-RPC body for logs: methods and ids only, never params. */
export function describeRpc(body: unknown): { methods: string[]; ids: (string | number)[] } {
  const msgs = Array.isArray(body) ? body : [body];
  const methods: string[] = [];
  const ids: (string | number)[] = [];
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const { method, id } = m as { method?: unknown; id?: unknown };
    if (typeof method === "string") methods.push(method);
    if (typeof id === "string" || typeof id === "number") ids.push(id);
  }
  return { methods, ids };
}

type Handler = { fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> };

/**
 * Wrap an MCP HTTP handler so each request logs: entry, response headers, first body byte, and
 * body-stream end. The gap between first byte and stream end is the "tail" a client waits on
 * after the JSON-RPC response has already arrived.
 */
export function withRequestTiming(handler: Handler): Handler {
  return {
    async fetch(request, env, ctx) {
      if (!timingEnabled(env)) return handler.fetch(request, env, ctx);
      const rid = shortId();
      const url = new URL(request.url);
      const ids: Record<string, unknown> = {
        rid,
        session: request.headers.get("mcp-session-id") ?? undefined,
      };
      const timer = makeTimer(true, "worker", ids);
      let rpc: ReturnType<typeof describeRpc> | undefined;
      if (request.method === "POST") {
        try {
          rpc = describeRpc(await request.clone().json());
        } catch {
          /* not JSON; the handler will reject it */
        }
      }
      timer.mark("request", { method: request.method, path: url.pathname, ...rpc });

      const res = await handler.fetch(request, env, ctx);
      const session = res.headers.get("mcp-session-id") ?? ids.session;
      timer.mark("response-headers", {
        status: res.status,
        session,
        content_type: res.headers.get("content-type") ?? undefined,
      });
      if (!res.body) {
        timer.mark("response-complete", { bytes: 0 });
        return res;
      }
      let bytes = 0;
      let first = true;
      const body = res.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength;
            if (first) {
              first = false;
              timer.mark("first-byte", { session });
            }
            controller.enqueue(chunk);
          },
          flush() {
            timer.mark("stream-end", { session, bytes });
          },
        })
      );
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    },
  };
}
