import type { MessageKey } from "../shared/i18n";

// Every kind of translation service the settings page can add. A service the user creates is an
// adapter id plus their own name, model, credentials and option values; the adapter decides how
// it connects, which options exist (with translation-friendly defaults) and how those options
// become request fields. Option values are data only: they never become URLs or headers.

export type AdapterId =
  | "openrouter"
  | "openai"
  | "chatgpt"
  | "anthropic"
  | "gemini"
  | "deepseek"
  | "ollama"
  | "lmstudio"
  | "custom-openai"
  | "custom-anthropic";

/** Request protocol: Chat Completions, Anthropic Messages, or OpenAI Responses. */
export type WireKind = "chat" | "messages" | "responses";
export type AuthKind = "apiKey" | "optionalKey" | "none" | "oauth";
export type AdapterGroup = "subscription" | "api" | "local" | "custom";
/** How a model list is fetched, if the service offers one. */
export type ModelSource = "openrouter" | "openai" | "anthropic" | "ollama" | "chatgpt";

export type OptionValue = string | boolean | readonly string[];
export type ProviderOptions = Readonly<Record<string, OptionValue>>;

interface FieldBase {
  readonly key: string;
  readonly label: MessageKey;
  readonly desc?: MessageKey;
  /** Shown only after "More" is expanded. */
  readonly advanced?: boolean;
  /** Part of the translation cache key: changing it can change the translated text. */
  readonly affectsOutput?: boolean;
}

export interface ChoiceField extends FieldBase {
  readonly kind: "choice";
  readonly choices: readonly { readonly value: string; readonly label: MessageKey }[];
  readonly default: string;
  /** Value labelled as the recommendation for translation. */
  readonly recommended?: string;
}

export interface SwitchField extends FieldBase {
  readonly kind: "switch";
  readonly default: boolean;
  readonly recommended?: boolean;
}

export interface ListField extends FieldBase {
  readonly kind: "list";
  readonly default: readonly string[];
  readonly placeholder?: MessageKey;
}

export type OptionField = ChoiceField | SwitchField | ListField;

export interface AdapterSpec {
  readonly id: AdapterId;
  /** Type name, also the default name of a new service. */
  readonly label: MessageKey;
  readonly group: AdapterGroup;
  /** Two or three letters drawn on the type's tile. */
  readonly mark: string;
  readonly wire: WireKind;
  readonly auth: AuthKind;
  /** Request URL; fixed unless `editableEndpoint`, in which case it is the default. */
  readonly endpoint: string;
  readonly editableEndpoint: boolean;
  /** Where to create an API key. */
  readonly keyUrl?: string;
  readonly defaultModel: string;
  readonly models?: ModelSource;
  readonly options: readonly OptionField[];
  /** Request body fields derived from the option values (already normalized). */
  readonly body: (options: ProviderOptions, model: string) => Record<string, unknown>;
}

// ---- Option building blocks -------------------------------------------------------------------

const choice = (
  key: string,
  label: MessageKey,
  values: readonly [string, MessageKey][],
  defaults: { default: string; recommended?: string },
  extra: Partial<FieldBase> = {},
): ChoiceField => ({ kind: "choice", key, label, choices: values.map(([value, l]) => ({ value, label: l })), ...defaults, ...extra });

const reasoning = (values: readonly [string, MessageKey][], value: string, desc: MessageKey = "optReasoningDesc") =>
  choice("reasoning", "optReasoning", values, { default: value, recommended: value }, { desc, affectsOutput: true });

const OFF: [string, MessageKey] = ["off", "levelOff"];
const MODEL_DEFAULT: [string, MessageKey] = ["default", "levelDefault"];
const MINIMAL: [string, MessageKey] = ["minimal", "levelMinimal"];
const LOW: [string, MessageKey] = ["low", "levelLow"];
const MEDIUM: [string, MessageKey] = ["medium", "levelMedium"];
const HIGH: [string, MessageKey] = ["high", "levelHigh"];

const str = (o: ProviderOptions, key: string) => (typeof o[key] === "string" ? (o[key] as string) : "");
const list = (o: ProviderOptions, key: string) => (Array.isArray(o[key]) ? (o[key] as readonly string[]) : []);
/** Reasoning effort for OpenAI-style APIs; "default" sends nothing and lets the model decide. */
const effortField = (o: ProviderOptions, name = "reasoning_effort") => {
  const v = str(o, "reasoning");
  if (v === "default" || v === "") return {};
  return { [name]: v === "off" ? "none" : v };
};

// ---- Anthropic thinking rules (Claude 5 family, 2026-10) ---------------------------------------

/**
 * The cheapest valid way to keep each model from thinking. Opus 5.5 / Fable cannot turn it off
 * (effort is the only control); Sonnet 5.5 uses between_tools; others accept disabled.
 * Checked in order, so the 5.5 rows come before their 5.x siblings.
 */
const THINKING_OFF: readonly [RegExp, Record<string, string> | undefined][] = [
  [/^claude-(opus-5-5|fable|mythos)/, undefined],
  [/^claude-sonnet-5-5/, { type: "between_tools" }],
  [/^claude-(haiku-5-5|opus-5|sonnet-5)/, { type: "disabled" }],
];
/** Models that accept output_config.effort; older ones reject the field. */
const EFFORT_RE = /^claude-((opus|sonnet|haiku|fable|mythos)-5|opus-4-[5-8]|sonnet-4-6)/;

function anthropicBody(o: ProviderOptions, model: string): Record<string, unknown> {
  const thinking = THINKING_OFF.find(([re]) => re.test(model))?.[1];
  return {
    ...(EFFORT_RE.test(model) && { output_config: { effort: str(o, "reasoning") || "low" } }),
    ...(thinking && { thinking }),
  };
}

// ---- OpenRouter -----------------------------------------------------------------------------

function openrouterBody(o: ProviderOptions): Record<string, unknown> {
  const sort = str(o, "sort");
  const provider = {
    ...(sort && sort !== "default" && { sort }),
    ...(o.dataCollection === true && { data_collection: "deny" }),
    ...(o.allowFallbacks === false && { allow_fallbacks: false }),
    ...(o.zdr === true && { zdr: true }),
    ...(list(o, "order").length > 0 && { order: list(o, "order") }),
    ...(list(o, "ignore").length > 0 && { ignore: list(o, "ignore") }),
  };
  const effort = str(o, "reasoning");
  return {
    ...(effort && effort !== "default" && { reasoning: { effort: effort === "off" ? "none" : effort } }),
    ...(Object.keys(provider).length > 0 && { provider }),
  };
}

// ---- The catalog ------------------------------------------------------------------------------

export const ADAPTERS: readonly AdapterSpec[] = [
  {
    id: "chatgpt",
    label: "adapterChatgpt",
    group: "subscription",
    mark: "GPT",
    wire: "responses",
    auth: "oauth",
    endpoint: "https://api.openai.com/v1/responses",
    editableEndpoint: false,
    defaultModel: "",
    models: "chatgpt",
    options: [reasoning([LOW, MEDIUM, HIGH], "low", "optReasoningNoOffDesc")],
    body: (o) => ({ reasoning: { effort: str(o, "reasoning") || "low" } }),
  },
  {
    id: "openrouter",
    label: "adapterOpenrouter",
    group: "api",
    mark: "OR",
    wire: "chat",
    auth: "apiKey",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    editableEndpoint: false,
    keyUrl: "https://openrouter.ai/keys",
    defaultModel: "",
    models: "openrouter",
    options: [
      reasoning([OFF, LOW, MEDIUM, HIGH], "off"),
      choice(
        "sort",
        "optSort",
        [
          ["default", "sortDefault"],
          ["price", "sortPrice"],
          ["throughput", "sortThroughput"],
          ["latency", "sortLatency"],
        ],
        { default: "throughput", recommended: "throughput" },
        { desc: "optSortDesc" },
      ),
      { kind: "switch", key: "dataCollection", label: "optDataCollection", desc: "optDataCollectionDesc", default: true },
      { kind: "list", key: "order", label: "optOrder", desc: "optOrderDesc", default: [], placeholder: "optProviderPlaceholder", advanced: true },
      { kind: "list", key: "ignore", label: "optIgnore", default: [], placeholder: "optProviderPlaceholder", advanced: true },
      { kind: "switch", key: "zdr", label: "optZdr", desc: "optZdrDesc", default: false, advanced: true },
      { kind: "switch", key: "allowFallbacks", label: "optFallbacks", desc: "optFallbacksDesc", default: true, advanced: true },
    ],
    body: openrouterBody,
  },
  {
    id: "openai",
    label: "adapterOpenai",
    group: "api",
    mark: "OA",
    wire: "chat",
    auth: "apiKey",
    endpoint: "https://api.openai.com/v1/chat/completions",
    editableEndpoint: false,
    keyUrl: "https://platform.openai.com/api-keys",
    defaultModel: "",
    models: "openai",
    options: [
      reasoning([MODEL_DEFAULT, OFF, MINIMAL, LOW, MEDIUM, HIGH], "low", "optReasoningModelDesc"),
      choice(
        "serviceTier",
        "optServiceTier",
        [
          ["auto", "tierAuto"],
          ["flex", "tierFlex"],
        ],
        { default: "auto" },
        { desc: "optServiceTierDesc", advanced: true },
      ),
    ],
    body: (o) => ({ ...effortField(o), ...(str(o, "serviceTier") === "flex" && { service_tier: "flex" }) }),
  },
  {
    id: "anthropic",
    label: "adapterAnthropic",
    group: "api",
    mark: "A",
    wire: "messages",
    auth: "apiKey",
    endpoint: "https://api.anthropic.com/v1/messages",
    editableEndpoint: false,
    keyUrl: "https://platform.claude.com/settings/keys",
    defaultModel: "claude-haiku-5-5",
    models: "anthropic",
    options: [reasoning([LOW, MEDIUM, HIGH], "low", "optEffortDesc")],
    body: anthropicBody,
  },
  {
    id: "gemini",
    label: "adapterGemini",
    group: "api",
    mark: "G",
    wire: "chat",
    auth: "apiKey",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    editableEndpoint: false,
    keyUrl: "https://aistudio.google.com/apikey",
    defaultModel: "",
    models: "openai",
    options: [reasoning([MODEL_DEFAULT, OFF, LOW, MEDIUM, HIGH], "low", "optReasoningModelDesc")],
    body: (o) => effortField(o),
  },
  {
    id: "deepseek",
    label: "adapterDeepseek",
    group: "api",
    mark: "DS",
    wire: "chat",
    auth: "apiKey",
    endpoint: "https://api.deepseek.com/chat/completions",
    editableEndpoint: false,
    keyUrl: "https://platform.deepseek.com/api_keys",
    defaultModel: "deepseek-chat",
    models: "openai",
    options: [],
    body: () => ({}),
  },
  {
    id: "ollama",
    label: "adapterOllama",
    group: "local",
    mark: "Ol",
    wire: "chat",
    auth: "none",
    endpoint: "http://localhost:11434/v1/chat/completions",
    editableEndpoint: true,
    defaultModel: "",
    models: "ollama",
    options: [{ kind: "switch", key: "think", label: "optThink", desc: "optThinkDesc", default: false, recommended: false, affectsOutput: true }],
    // Ollama's OpenAI endpoint reads reasoning_effort; think is its native name. Unknown fields are ignored.
    body: (o) => (o.think === true ? {} : { think: false, reasoning_effort: "none" }),
  },
  {
    id: "lmstudio",
    label: "adapterLmstudio",
    group: "local",
    mark: "LM",
    wire: "chat",
    auth: "none",
    endpoint: "http://localhost:1234/v1/chat/completions",
    editableEndpoint: true,
    defaultModel: "",
    models: "openai",
    options: [],
    body: () => ({}),
  },
  {
    id: "custom-openai",
    label: "adapterCustomOpenai",
    group: "custom",
    mark: "{ }",
    wire: "chat",
    auth: "optionalKey",
    endpoint: "",
    editableEndpoint: true,
    defaultModel: "",
    models: "openai",
    options: [],
    body: () => ({}),
  },
  {
    id: "custom-anthropic",
    label: "adapterCustomAnthropic",
    group: "custom",
    mark: "{ }",
    wire: "messages",
    auth: "optionalKey",
    endpoint: "",
    editableEndpoint: true,
    defaultModel: "",
    models: "anthropic",
    options: [],
    body: () => ({}),
  },
];

const BY_ID: ReadonlyMap<AdapterId, AdapterSpec> = new Map(ADAPTERS.map((a) => [a.id, a]));

export const isAdapterId = (v: unknown): v is AdapterId => typeof v === "string" && BY_ID.has(v as AdapterId);

export function adapterOf(id: AdapterId): AdapterSpec {
  return BY_ID.get(id) ?? BY_ID.get("custom-openai")!;
}

/** Keeps only known options with valid values; everything missing gets the adapter default. */
export function normalizeOptions(spec: AdapterSpec, raw: unknown): ProviderOptions {
  const src = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: Record<string, OptionValue> = {};
  for (const f of spec.options) {
    const v = src[f.key];
    if (f.kind === "choice") out[f.key] = f.choices.some((c) => c.value === v) ? (v as string) : f.default;
    else if (f.kind === "switch") out[f.key] = typeof v === "boolean" ? v : f.default;
    else out[f.key] = Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean))].slice(0, 20) : f.default;
  }
  return out;
}

/** Option values that change the translated text, in a stable order for cache keys. */
export function outputOptions(spec: AdapterSpec, options: ProviderOptions): OptionValue[] {
  return spec.options.filter((f) => f.affectsOutput).map((f) => options[f.key] ?? f.default);
}

/** URL of the model list for a service, derived from its request URL where the API allows. */
export function modelsUrl(spec: AdapterSpec, endpoint: string): string | undefined {
  if (!spec.models) return undefined;
  try {
    const url = new URL(endpoint);
    if (spec.models === "ollama") return `${url.origin}/api/tags`;
    const swapped = url.pathname.replace(/\/(chat\/completions|messages|responses)\/?$/, "/models");
    return swapped === url.pathname ? undefined : `${url.origin}${swapped}`;
  } catch {
    return undefined;
  }
}
