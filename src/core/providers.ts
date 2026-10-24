import { adapterOf, type WireKind } from "../providers/adapters";
import type { Provider } from "./settings";

export interface ChatRequest {
  readonly system: string;
  readonly user: string;
}

export interface CompleteOptions {
  readonly signal?: AbortSignal;
  /** Injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Current access token for sign-in services (ChatGPT); refreshed by the caller. */
  readonly accessToken?: () => Promise<string>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 90_000;
const ANTHROPIC_MAX_TOKENS = 16_000;

interface WireRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** One parsed server-sent event. */
interface StreamDelta {
  readonly text?: string;
  readonly stop?: string;
  /** The service reported an error mid-stream; `final` errors (quota, eligibility) are not retried. */
  readonly failed?: { readonly final: boolean; readonly message?: string };
}

interface Wire {
  build(p: Provider, req: ChatRequest, token?: string): WireRequest;
  /** Non-streaming JSON body (servers that ignore stream: true). */
  parse(data: unknown): string;
  event(data: unknown): StreamDelta;
}

const shapeError = () => new ProviderError("Unexpected response shape from provider", false);

const TRUNCATED = new Set(["length", "max_tokens"]);
const REFUSED = new Set(["refusal", "content_filter"]);

function checkStop(stop: unknown): void {
  if (typeof stop !== "string") return;
  if (REFUSED.has(stop)) throw new ProviderError("Model refused to translate this content", false);
  if (TRUNCATED.has(stop)) throw new ProviderError("Response truncated (max_tokens reached)", false);
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

const openaiWire: Wire = {
  build: (p, req) => ({
    url: p.endpoint,
    headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : ({} as Record<string, string>),
    body: {
      model: p.model,
      stream: true,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    },
  }),
  parse: (data) => {
    const choice = (data as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] })?.choices?.[0];
    if (typeof choice?.message?.content !== "string") throw shapeError();
    checkStop(choice.finish_reason);
    return choice.message.content;
  },
  event: (data) => {
    const d = data as { error?: unknown; choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[] };
    if (d?.error) return { failed: { final: false } };
    const choice = d?.choices?.[0];
    return { text: str(choice?.delta?.content), stop: str(choice?.finish_reason) };
  },
};

const anthropicWire: Wire = {
  build: (p, req) => ({
    url: p.endpoint,
    headers: {
      "x-api-key": p.apiKey,
      "anthropic-version": "2023-06-01",
      // Required for requests that carry a browser Origin, which extension workers do.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: {
      model: p.model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      stream: true,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    },
  }),
  parse: (data) => {
    const msg = data as { stop_reason?: unknown; content?: { type?: unknown; text?: unknown }[] };
    if (!Array.isArray(msg?.content)) throw shapeError();
    checkStop(msg.stop_reason);
    return msg.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
  },
  event: (data) => {
    const d = data as { type?: unknown; delta?: { type?: unknown; text?: unknown; stop_reason?: unknown } };
    if (d?.type === "error") return { failed: { final: false } };
    if (d?.type === "content_block_delta" && d.delta?.type === "text_delta") return { text: str(d.delta.text) };
    if (d?.type === "message_delta") return { stop: str(d.delta?.stop_reason) };
    return {};
  },
};

/** ChatGPT plan errors that retrying cannot fix (developers.openai.com/siwc, errors and recovery). */
const FINAL_PLAN_ERRORS: ReadonlyMap<string, string> = new Map([
  ["subscription_sharing_usage_limit_exceeded", "ChatGPT plan usage limit for this extension reached"],
  ["subscription_sharing_user_not_eligible", "This ChatGPT account cannot use its plan in other apps"],
  ["subscription_sharing_invalid_user", "Signed out of ChatGPT; sign in again in settings"],
]);

type ResponsesError = { code?: unknown };

function responsesFailure(error: ResponsesError | undefined): StreamDelta {
  const code = typeof error?.code === "string" ? error.code : "";
  const message = FINAL_PLAN_ERRORS.get(code);
  return { failed: message ? { final: true, message } : { final: false } };
}

/** OpenAI Responses API, as required for ChatGPT plan usage: streamed, never stored. */
const responsesWire: Wire = {
  build: (p, req, token) => ({
    url: p.endpoint,
    headers: token ? { Authorization: `Bearer ${token}` } : ({} as Record<string, string>),
    body: {
      model: p.model,
      instructions: req.system,
      input: [{ role: "user", content: [{ type: "input_text", text: req.user }] }],
      stream: true,
      store: false,
    },
  }),
  parse: (data) => {
    const r = data as { status?: unknown; incomplete_details?: { reason?: unknown }; output?: { content?: { type?: unknown; text?: unknown }[] }[] };
    if (!Array.isArray(r?.output)) throw shapeError();
    if (r.status === "incomplete") checkStop(r.incomplete_details?.reason === "content_filter" ? "refusal" : "max_tokens");
    return r.output
      .flatMap((item) => item.content ?? [])
      .filter((c) => c.type === "output_text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");
  },
  event: (data) => {
    const d = data as { type?: unknown; delta?: unknown; error?: ResponsesError; response?: { error?: ResponsesError; incomplete_details?: { reason?: unknown } } };
    switch (d?.type) {
      case "response.output_text.delta":
        return { text: str(d.delta) };
      case "response.refusal.delta":
        return { stop: "refusal" };
      case "response.incomplete":
        return { stop: d.response?.incomplete_details?.reason === "content_filter" ? "refusal" : "max_tokens" };
      case "response.failed":
        return responsesFailure(d.response?.error);
      case "error":
        return responsesFailure(d.error);
      default:
        return {};
    }
  },
};

const WIRES: Record<WireKind, Wire> = { chat: openaiWire, messages: anthropicWire, responses: responsesWire };

async function errorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: { message?: unknown } | string; message?: unknown };
    const msg = typeof data.error === "string" ? data.error : (data.error?.message ?? data.message);
    if (typeof msg === "string" && msg) return msg;
  } catch {
    // Body was not JSON; fall through to status text.
  }
  return res.statusText || "request failed";
}

/** Reads an SSE body. Errors reported inside the stream never surface server text. */
async function readStream(body: ReadableStream<Uint8Array>, wire: Wire): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let stop: string | undefined;
  /** Returns true at the end-of-stream sentinel. */
  const onLine = (raw: string): boolean => {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith("data:")) return false;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return true;
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      return false; // keep-alive comments and partial junk
    }
    const delta = wire.event(data);
    if (delta.failed) {
      throw new ProviderError(delta.failed.message ?? "The service reported an error while responding", !delta.failed.final);
    }
    text += delta.text ?? "";
    stop = delta.stop ?? stop;
    return false;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const lines = (buffer + decoder.decode(value, { stream: true })).split("\n");
    buffer = lines.pop() ?? "";
    if (lines.some(onLine)) {
      await reader.cancel();
      buffer = "";
      break;
    }
  }
  if (buffer) onLine(buffer);
  checkStop(stop);
  return text;
}

/** A body that starts like server-sent events (field line or comment). */
const SSE_START_RE = /^\s*(event|data|id|retry)?:/;

async function readSse(body: ReadableStream<Uint8Array>, wire: Wire): Promise<string> {
  try {
    return await readStream(body, wire);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError("Network error: " + (e as Error).message, true);
  }
}

async function readBody(res: Response, wire: Wire): Promise<string> {
  const isStream = res.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
  if (isStream && res.body) return readSse(res.body, wire);
  let raw: string;
  try {
    raw = await res.text();
  } catch (e) {
    throw new ProviderError("Network error: " + (e as Error).message, true);
  }
  // Every request asks for a stream; some servers send one without the event-stream type.
  if (SSE_START_RE.test(raw)) return readSse(new Response(raw).body!, wire);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw shapeError();
  }
  return wire.parse(data);
}

function retryAfterMs(res: Response): number | undefined {
  const seconds = Number(res.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_BACKOFF_MS) : undefined;
}

async function attempt(wire: Wire, p: Provider, req: ChatRequest, opts: CompleteOptions): Promise<string> {
  const { signal } = opts;
  const spec = adapterOf(p.adapter);
  const token = spec.auth === "oauth" ? await opts.accessToken?.() : undefined;
  if (spec.auth === "oauth" && !token) throw new ProviderError("Not signed in; sign in again in settings", false);
  const request = wire.build(p, req, token);
  const { url, headers } = request;
  // Adapter options (reasoning, routing…) are plain body fields; they never touch URL or headers.
  const body = { ...(request.body as Record<string, unknown>), ...spec.body(p.options, p.model) };
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      // A redirect would carry the key header and page text to another origin.
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    if (signal?.aborted) throw new ProviderError("Request aborted", false);
    throw new ProviderError(`Network error: ${(e as Error).message}`, true);
  }
  if (!res.ok) {
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    throw new ProviderError(`HTTP ${res.status}: ${await errorMessage(res)}`, retryable, res.status, retryAfterMs(res));
  }
  return readBody(res, wire);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sends one chat request, retrying transient failures with exponential backoff. */
export async function complete(p: Provider, req: ChatRequest, opts: CompleteOptions = {}): Promise<string> {
  const wire = WIRES[adapterOf(p.adapter).wire];
  const sleep = opts.sleep ?? defaultSleep;
  for (let i = 1; ; i++) {
    try {
      return await attempt(wire, p, req, opts);
    } catch (e) {
      if (!(e instanceof ProviderError) || !e.retryable || i >= MAX_ATTEMPTS) throw e;
      await sleep(e.retryAfterMs ?? Math.min(BASE_BACKOFF_MS * 2 ** (i - 1), MAX_BACKOFF_MS));
    }
  }
}
