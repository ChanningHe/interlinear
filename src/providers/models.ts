import type { Provider } from "../core/settings";
import { adapterOf, modelsUrl, type ModelSource } from "./adapters";

// Model lists for the settings page. Responses come from the service the user configured and are
// treated as untrusted data: every field is type-checked and only plain values are kept.

export interface ModelInfo {
  readonly id: string;
  readonly name?: string;
  /** Context window in tokens. */
  readonly context?: number;
  /** USD per million tokens (OpenRouter only). */
  readonly priceIn?: number;
  readonly priceOut?: number;
  /** "none": no reasoning; "optional": can be turned off; "mandatory": always reasons. */
  readonly reasoning?: "none" | "optional" | "mandatory";
  /** Effort levels the model accepts, when the service says (OpenRouter). */
  readonly efforts?: readonly string[];
  /** Download size in bytes (local services). */
  readonly size?: number;
}

const MAX_MODELS = 2000;
const TIMEOUT_MS = 15_000;
/** Model families that cannot translate text: embeddings, speech, images, moderation. */
const NOT_TEXT_RE = /(embed|whisper|tts|transcri|dall-e|image|audio|realtime|moderation|speech|vision-preview)/i;

const str = (v: unknown) => (typeof v === "string" && v.length <= 200 ? v : undefined);
const num = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
};
const rows = (v: unknown, key: string): Record<string, unknown>[] => {
  const list = (v as Record<string, unknown> | null)?.[key];
  return Array.isArray(list) ? list.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null).slice(0, MAX_MODELS) : [];
};
/** OpenRouter prices are USD per token as strings. */
const perMillion = (v: unknown) => {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n * 1_000_000 * 1000) / 1000;
};

function openrouterModel(r: Record<string, unknown>): ModelInfo | undefined {
  const id = str(r.id);
  if (!id) return undefined;
  const pricing = (r.pricing ?? {}) as Record<string, unknown>;
  const reasoning = (r.reasoning ?? undefined) as Record<string, unknown> | undefined;
  const params = Array.isArray(r.supported_parameters) ? r.supported_parameters : [];
  const efforts = Array.isArray(reasoning?.supported_efforts) ? reasoning.supported_efforts.filter((e): e is string => typeof e === "string") : undefined;
  return {
    id,
    name: str(r.name),
    context: num(r.context_length),
    priceIn: perMillion(pricing.prompt),
    priceOut: perMillion(pricing.completion),
    reasoning: reasoning?.mandatory === true ? "mandatory" : reasoning || params.includes("reasoning") ? "optional" : "none",
    efforts,
  };
}

/** Turns a model-list response into ModelInfo, dropping anything malformed. */
export function parseModels(source: ModelSource, data: unknown): ModelInfo[] {
  switch (source) {
    case "openrouter":
      return rows(data, "data").flatMap((r) => openrouterModel(r) ?? []);
    case "anthropic":
      return rows(data, "data").flatMap((r) => {
        const id = str(r.id);
        return id ? [{ id, name: str(r.display_name), context: num(r.max_input_tokens) }] : [];
      });
    case "ollama":
      return rows(data, "models").flatMap((r) => {
        const id = str(r.name) ?? str(r.model);
        return id ? [{ id, size: num(r.size) }] : [];
      });
    case "chatgpt":
      // Plan usage lists { models: [{ slug, display_name, visibility }] }; only "list" entries are
      // meant to be offered, in the server's order.
      return rows(data, "models").flatMap((r) => {
        const id = str(r.slug);
        return id && r.visibility === "list" ? [{ id, name: str(r.display_name) }] : [];
      });
    case "openai":
      return rows(data, "data")
        .flatMap((r) => {
          const id = str(r.id);
          return id && !NOT_TEXT_RE.test(id) ? [{ id }] : [];
        })
        .sort((a, b) => a.id.localeCompare(b.id));
  }
}

function headersFor(p: Provider, token?: string): Record<string, string> {
  const spec = adapterOf(p.adapter);
  if (spec.wire === "messages") {
    return { "x-api-key": p.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
  }
  const secret = token ?? p.apiKey;
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}

/** Lists the models a service offers, or throws an Error with a status-level message. */
export async function listModels(p: Provider, opts: { readonly accessToken?: () => Promise<string> } = {}): Promise<ModelInfo[]> {
  const spec = adapterOf(p.adapter);
  const url = modelsUrl(spec, p.endpoint);
  if (!spec.models || !url) return [];
  const token = spec.auth === "oauth" ? await opts.accessToken?.() : undefined;
  const res = await fetch(url, { headers: headersFor(p, token), redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseModels(spec.models, await res.json());
}
