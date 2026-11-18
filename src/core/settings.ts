import { adapterOf, isAdapterId, normalizeOptions, type AdapterId, type ProviderOptions } from "../providers/adapters";
import { isUiLanguageSetting, type MessageKey, type UiLanguageSetting } from "../shared/i18n";
import { isKnownLanguage, languageForLocale } from "../shared/languages";

export type DisplayStyle =
  | "plain" | "underline" | "dotted" | "wavy" | "highlight" | "marker" | "background"
  | "blockquote" | "border" | "italic" | "bold" | "muted" | "blur";
export type DisplayMode = "bilingual" | "translation-only";
/** "content": the page's main content without navigation, buttons and other chrome. "page": everything visible. */
export type TranslationScope = "content" | "page";
/** Key held while hovering a paragraph to translate it; "off" disables hover translation. */
export type HoverModifier = "off" | "ctrl" | "alt" | "shift";

export interface GlossaryEntry {
  readonly source: string;
  readonly target: string;
}

/** A translation service the user added: a type (adapter) plus their own name and settings. */
export interface Provider {
  readonly id: string;
  /** The user's own name for it, shown in the list and the popup. */
  readonly name: string;
  readonly adapter: AdapterId;
  /** Full request URL, used verbatim. Fixed by the adapter unless it lets the user edit it. */
  readonly endpoint: string;
  /** Empty for local services and for sign-in services (tokens live in their own storage). */
  readonly apiKey: string;
  readonly model: string;
  /** Adapter-specific options (reasoning, routing…), validated against the adapter's schema. */
  readonly options: ProviderOptions;
}

export interface Settings {
  readonly targetLang: string;
  readonly activeProviderId: string;
  readonly providers: readonly Provider[];
  readonly style: DisplayStyle;
  /** Empty string means "use the built-in prompt". */
  readonly customPrompt: string;
  readonly maxCharsPerBatch: number;
  readonly maxItemsPerBatch: number;
  readonly concurrency: number;
  readonly displayMode: DisplayMode;
  readonly scope: TranslationScope;
  /** Origins (e.g. https://example.com) translated automatically on load. */
  readonly autoSites: readonly string[];
  /** Hover, input-box and selection helpers on every site (needs all-sites access). */
  readonly everywhere: boolean;
  readonly hoverModifier: HoverModifier;
  /** Triple-space inside a text field translates its contents into the page's language. */
  readonly inputTranslation: boolean;
  /** Show a translate button next to selected text on pages where the helpers run. */
  readonly selectionButton: boolean;
  readonly glossary: readonly GlossaryEntry[];
  /** Send the page title along as context. Off by default: it changes cache keys per page. */
  readonly pageContext: boolean;
  /** Language of the extension's own interface; "auto" follows the browser. */
  readonly uiLanguage: UiLanguageSetting;
}

export const STORAGE_KEY = "settings";

export const DISPLAY_STYLES: readonly DisplayStyle[] = [
  "plain", "underline", "dotted", "wavy", "highlight", "marker", "background",
  "blockquote", "border", "italic", "bold", "muted", "blur",
];
const DISPLAY_MODES: readonly DisplayMode[] = ["bilingual", "translation-only"];
const SCOPES: readonly TranslationScope[] = ["content", "page"];
const HOVER_MODIFIERS: readonly HoverModifier[] = ["off", "ctrl", "alt", "shift"];

export const GLOSSARY_LIMITS = { entries: 200, chars: 100 } as const;
const MAX_AUTO_SITES = 500;

/** Ranges of the numeric settings; the settings page uses the same bounds. */
export const LIMITS = {
  maxCharsPerBatch: { min: 200, max: 20000 },
  maxItemsPerBatch: { min: 1, max: 100 },
  // Shared by all tabs. HTTP/2 services multiplex this many requests on one connection, and 429s
  // back off; local HTTP/1.1 servers are capped at 6 connections by the browser anyway.
  concurrency: { min: 1, max: 32 },
} as const;

export const DEFAULT_SETTINGS: Settings = {
  targetLang: "en", // replaced by the browser language, see browserLanguage()
  activeProviderId: "",
  providers: [],
  style: "plain",
  customPrompt: "",
  maxCharsPerBatch: 2000,
  maxItemsPerBatch: 20,
  concurrency: 6,
  displayMode: "bilingual",
  scope: "content",
  autoSites: [],
  everywhere: false,
  hoverModifier: "alt",
  inputTranslation: true,
  selectionButton: true,
  glossary: [],
  pageContext: false,
  uiLanguage: "auto",
};

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

function clamp(v: unknown, range: { min: number; max: number }, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  // Every limit is a count; 2.5 parallel requests would otherwise admit 3.
  return Math.min(range.max, Math.max(range.min, Math.round(v)));
}

// Before adapters a service was {kind, endpoint}; such entries read as the matching custom type.
const LEGACY_KINDS: Readonly<Record<string, AdapterId>> = { openai: "custom-openai", anthropic: "custom-anthropic" };
// Settings saved before 0.2 stored a base URL and the path was appended at request time.
const LEGACY_PATHS: Readonly<Record<string, string>> = { openai: "/chat/completions", anthropic: "/v1/messages" };

function adapterIdOf(raw: Raw): AdapterId | undefined {
  if (isAdapterId(raw.adapter)) return raw.adapter;
  return typeof raw.kind === "string" ? LEGACY_KINDS[raw.kind] : undefined;
}

function endpointOf(raw: Raw): string {
  if (typeof raw.endpoint === "string") return raw.endpoint.trim();
  const legacy = str(raw.baseUrl, "").trim().replace(/\/+$/, "");
  return legacy && typeof raw.kind === "string" ? legacy + (LEGACY_PATHS[raw.kind] ?? "") : "";
}

function normalizeProvider(raw: unknown): Provider | undefined {
  if (!isObject(raw) || typeof raw.id !== "string" || raw.id === "") return undefined;
  const adapter = adapterIdOf(raw);
  if (!adapter) return undefined;
  const spec = adapterOf(adapter);
  return {
    id: raw.id,
    name: str(raw.name, "").trim() || "Unnamed",
    adapter,
    endpoint: spec.editableEndpoint ? endpointOf(raw) || spec.endpoint : spec.endpoint,
    apiKey: spec.auth === "oauth" ? "" : str(raw.apiKey, "").trim(),
    model: str(raw.model, "").trim(),
    options: normalizeOptions(spec, raw.options),
  };
}

/** A new service of the given type with its defaults; `name` is the user-facing default name. */
export function newProvider(adapter: AdapterId, name: string): Provider {
  const spec = adapterOf(adapter);
  return {
    id: crypto.randomUUID(),
    name,
    adapter,
    endpoint: spec.endpoint,
    apiKey: "",
    model: spec.defaultModel,
    options: normalizeOptions(spec, {}),
  };
}

/** Origin of an http(s) page URL, or undefined for anything else (chrome://, file:, junk). */
export function siteOrigin(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Host names (IDNs arrive as punycode) and IP literals; browsers accept more, e.g. "%20". */
const LABEL = "[a-z\\d](?:[a-z\\d-]*[a-z\\d])?"; // no leading or trailing hyphen
const HOSTNAME_RE = new RegExp(`^(\\[[\\da-f:.]+\\]|${LABEL}(\\.${LABEL})*)$`, "i");
/** Hosts a developer reaches over plain http: localhost, IPv4 and IPv6 literals. */
const isLocalHostName = (host: string) => host === "localhost" || host.endsWith(".localhost") || /^(\d+(\.\d+){3}|\[.*\])$/.test(host);

/**
 * The origin of an address typed by the user. Without a scheme, "example.com" means https and
 * "localhost" or an IP address means http, which is what dev servers speak (sites match by exact origin).
 */
export function siteFromInput(text: string): string | undefined {
  const value = text.trim();
  if (!value || /\s/.test(value)) return undefined;
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
  const probe = hasScheme ? undefined : siteOrigin(`http://${value}`);
  const isLocal = probe !== undefined && isLocalHostName(new URL(probe).hostname);
  const origin = siteOrigin(hasScheme ? value : `${isLocal ? "http" : "https"}://${value}`);
  return origin && HOSTNAME_RE.test(new URL(origin).hostname) ? origin : undefined;
}

function normalizeSites(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const origins = raw.map((v) => (typeof v === "string" ? siteOrigin(v) : undefined));
  return [...new Set(origins.filter((o): o is string => o !== undefined))].slice(0, MAX_AUTO_SITES);
}

/** Why glossary entries were left out, as counts. */
export interface GlossaryIgnored {
  /** Not "term = translation": no "=", or an empty side. */
  readonly invalid: number;
  readonly tooLong: number;
  /** Same term (case-insensitive) as an earlier entry. */
  readonly duplicate: number;
  /** Beyond the entry limit. */
  readonly overLimit: number;
}

function collectGlossary(raw: readonly unknown[]): { entries: GlossaryEntry[]; ignored: GlossaryIgnored } {
  const seen = new Set<string>();
  const entries: GlossaryEntry[] = [];
  const ignored = { invalid: 0, tooLong: 0, duplicate: 0, overLimit: 0 };
  for (const item of raw) {
    const source = isObject(item) ? str(item.source, "").replace(/\s+/g, " ").trim() : "";
    const target = isObject(item) ? str(item.target, "").replace(/\s+/g, " ").trim() : "";
    if (!source || !target) ignored.invalid++;
    else if (source.length > GLOSSARY_LIMITS.chars || target.length > GLOSSARY_LIMITS.chars) ignored.tooLong++;
    else if (seen.has(source.toLowerCase())) ignored.duplicate++;
    else if (entries.length >= GLOSSARY_LIMITS.entries) ignored.overLimit++;
    else {
      seen.add(source.toLowerCase());
      entries.push({ source, target });
    }
  }
  return { entries, ignored };
}

function normalizeGlossary(raw: unknown): GlossaryEntry[] {
  return Array.isArray(raw) ? collectGlossary(raw).entries : [];
}

const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const lang = (v: unknown, fallback: string) => (typeof v === "string" && isKnownLanguage(v) ? v : fallback);

/** Default target language: the browser's own, read at call time (English outside extensions). */
function browserLanguage(): string {
  return languageForLocale(typeof chrome !== "undefined" ? (chrome.i18n?.getUILanguage?.() ?? "") : "");
}

/** Turns untrusted stored data into a fully valid Settings object. Never mutates input. */
export function normalizeSettings(raw: unknown): Settings {
  if (!isObject(raw)) return normalizeSettings({});
  const d = DEFAULT_SETTINGS;
  const providers = Array.isArray(raw.providers)
    ? raw.providers.map(normalizeProvider).filter((p): p is Provider => p !== undefined)
    : d.providers;
  const wantedId = str(raw.activeProviderId, "");
  const activeProviderId = providers.some((p) => p.id === wantedId) ? wantedId : (providers[0]?.id ?? "");

  return {
    targetLang: lang(raw.targetLang, browserLanguage()),
    activeProviderId,
    providers,
    style: oneOf(raw.style, DISPLAY_STYLES, d.style),
    customPrompt: str(raw.customPrompt, d.customPrompt),
    maxCharsPerBatch: clamp(raw.maxCharsPerBatch, LIMITS.maxCharsPerBatch, d.maxCharsPerBatch),
    maxItemsPerBatch: clamp(raw.maxItemsPerBatch, LIMITS.maxItemsPerBatch, d.maxItemsPerBatch),
    concurrency: clamp(raw.concurrency, LIMITS.concurrency, d.concurrency),
    displayMode: oneOf(raw.displayMode, DISPLAY_MODES, d.displayMode),
    scope: oneOf(raw.scope, SCOPES, d.scope),
    autoSites: normalizeSites(raw.autoSites),
    everywhere: bool(raw.everywhere, d.everywhere),
    hoverModifier: oneOf(raw.hoverModifier, HOVER_MODIFIERS, d.hoverModifier),
    inputTranslation: bool(raw.inputTranslation, d.inputTranslation),
    selectionButton: bool(raw.selectionButton, d.selectionButton),
    glossary: normalizeGlossary(raw.glossary),
    pageContext: bool(raw.pageContext, d.pageContext),
    uiLanguage: isUiLanguageSetting(raw.uiLanguage) ? raw.uiLanguage : d.uiLanguage,
  };
}

// Must stay in sync with optional_host_permissions in scripts/build.mjs.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function isLocalUrl(url: URL): boolean {
  return LOCAL_HOSTS.has(url.hostname);
}

/** Host permission pattern needed to call this endpoint (match patterns ignore ports). */
export function originPattern(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.hostname}/*`;
}

/** Match patterns for "every website"; must stay in optional_host_permissions. */
export const ALL_SITES: readonly string[] = ["http://*/*", "https://*/*"];

/** Hosts a service type needs besides its request URL (sign-in and token refresh). */
const EXTRA_ORIGINS: Partial<Record<AdapterId, readonly string[]>> = { chatgpt: ["https://auth.openai.com/*"] };

/** Every host permission the settings rely on. Anything else granted earlier can be revoked. */
export function requiredOrigins(s: Settings): string[] {
  const extra = s.providers.flatMap((p) => EXTRA_ORIGINS[p.adapter] ?? []);
  const patterns = [...s.providers.map((p) => p.endpoint), ...s.autoSites].flatMap((url) => {
    try {
      return [originPattern(url)];
    } catch {
      return []; // invalid endpoints are rejected by validateProvider before saving
    }
  });
  return [...new Set([...patterns, ...extra, ...(s.everywhere ? ALL_SITES : [])])];
}

/** Pages where content.js is registered to load by itself: auto-translate sites, or everything. */
export function residentMatches(s: Settings): string[] {
  const sites = s.autoSites.map(originPattern);
  return [...new Set([...(s.everywhere ? ALL_SITES : []), ...sites])];
}

/** Settings as a JSON file. API keys are left out unless explicitly requested. */
export function exportSettings(s: Settings, includeKeys: boolean): string {
  const providers = includeKeys ? s.providers : s.providers.map((p) => ({ ...p, apiKey: "" }));
  return JSON.stringify({ ...s, providers }, null, 2);
}

/** Same service: a stored key may only ever be sent where it was sent before. */
function sameService(a: Provider, b: Provider): boolean {
  if (a.id !== b.id || a.adapter !== b.adapter) return false;
  try {
    return new URL(a.endpoint).origin === new URL(b.endpoint).origin;
  } catch {
    return false;
  }
}

/** The file is not JSON, or does not look like an exported settings file. */
export class ImportError extends Error {}

const SETTINGS_KEYS = new Set<string>(Object.keys(DEFAULT_SETTINGS));
const LIST_KEYS = ["providers", "autoSites", "glossary"] as const;

/**
 * Parses an exported file and applies it on top of the current settings, so a partial file
 * changes only what it contains. Anything that does not look like a settings file is refused.
 * A provider imported without a key keeps the key already stored for the same service, so sharing
 * a key-less export does not wipe anyone's credentials. A file that reuses a provider id with
 * another endpoint gets no key: it could otherwise send it elsewhere.
 */
export function importSettings(json: string, current: Settings): Settings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ImportError("not JSON");
  }
  const known = isObject(parsed) && Object.keys(parsed).some((k) => SETTINGS_KEYS.has(k));
  if (!isObject(parsed) || !known || LIST_KEYS.some((k) => k in parsed && !Array.isArray(parsed[k]))) {
    throw new ImportError("not a settings file");
  }
  const imported = normalizeSettings({ ...current, ...parsed });
  const keyFor = (p: Provider) => current.providers.find((c) => sameService(c, p))?.apiKey ?? "";
  return {
    ...imported,
    providers: imported.providers.map((p) => (p.apiKey ? p : { ...p, apiKey: keyFor(p) })),
  };
}

/**
 * Applies a save made elsewhere (the popup, another options tab): fields the draft has not
 * edited since `before` follow `after`; locally edited fields keep the draft's value.
 */
export function mergeRemote(draft: Settings, before: Settings, after: Settings): Settings {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const keys = Object.keys(after) as (keyof Settings)[];
  return Object.fromEntries(keys.map((k) => [k, same(draft[k], before[k]) ? after[k] : draft[k]])) as unknown as Settings;
}

export type ProviderProblem = Extract<MessageKey, "endpointInvalid" | "endpointInsecure" | "modelRequired" | "keyRequired">;

/** Returns problems as message keys for the UI to translate; empty means the provider is usable. */
export function validateProvider(p: Provider): ProviderProblem[] {
  const errors: ProviderProblem[] = [];
  let url: URL | undefined;
  try {
    url = new URL(p.endpoint);
  } catch {
    errors.push("endpointInvalid");
  }
  if (url && url.protocol !== "https:" && !(url.protocol === "http:" && isLocalUrl(url))) errors.push("endpointInsecure");
  if (!p.model) errors.push("modelRequired");
  // Sign-in services carry no key; local services need none; everything remote does.
  const { auth } = adapterOf(p.adapter);
  const needsKey = auth === "apiKey" || (auth === "optionalKey" && !(url && isLocalUrl(url)));
  if (needsKey && !p.apiKey) errors.push("keyRequired");
  return errors;
}

export function activeProvider(s: Settings): Provider | undefined {
  return s.providers.find((p) => p.id === s.activeProviderId);
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeSettings(stored[STORAGE_KEY]);
}

/** Drops host access that the given settings no longer need (removed services, sites, "everywhere"). */
export async function revokeUnusedOrigins(s: Settings): Promise<void> {
  const needed = new Set(requiredOrigins(s));
  const { origins = [] } = await chrome.permissions.getAll();
  const unused = origins.filter((o) => !needed.has(o));
  if (unused.length > 0) await chrome.permissions.remove({ origins: unused });
}

/** One "source = target" pair per line, as edited in the options page; blank lines are not entries. */
export function parseGlossaryText(text: string): { entries: GlossaryEntry[]; ignored: GlossaryIgnored } {
  const pairs = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const at = line.indexOf("=");
      return at > 0 ? { source: line.slice(0, at), target: line.slice(at + 1) } : null;
    });
  return collectGlossary(pairs);
}

export const parseGlossary = (text: string): GlossaryEntry[] => parseGlossaryText(text).entries;

export function formatGlossary(glossary: readonly GlossaryEntry[]): string {
  return glossary.map((g) => `${g.source} = ${g.target}`).join("\n");
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: normalizeSettings(s) });
}
