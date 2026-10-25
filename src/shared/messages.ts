import { MAX_CONTEXT_LENGTH } from "../core/prompt";
import type { DisplayMode, DisplayStyle, HoverModifier, Provider, TranslationScope } from "../core/settings";
import type { ContentLabels } from "./i18n";
import { isKnownLanguage } from "./languages";

export type TranslateResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string };

/** The only settings a content script ever sees. API keys never leave the background. */
export interface PageConfig {
  readonly targetLang: string;
  readonly style: DisplayStyle;
  readonly displayMode: DisplayMode;
  readonly scope: TranslationScope;
  readonly maxCharsPerBatch: number;
  readonly maxItemsPerBatch: number;
  readonly hoverModifier: HoverModifier;
  readonly inputTranslation: boolean;
  readonly selectionButton: boolean;
  readonly pageContext: boolean;
  /** In-page button and popover texts in the interface language. */
  readonly labels: ContentLabels;
}

/** Answer to page-init, sent by content scripts that the browser loads on its own. */
export interface PageInit {
  readonly config: PageConfig;
  /** Decided by the background from the sender's real tab URL, never by the page. */
  readonly autoTranslate: boolean;
}

export interface TranslateRequest {
  readonly type: "translate";
  readonly texts: readonly string[];
  /** Overrides the configured target language (input-box translation). */
  readonly targetLang?: string;
  /** Page title, used only when the pageContext setting is on. */
  readonly context?: string;
  /** Text on screen goes ahead of text prefetched below it. */
  readonly priority?: TranslatePriority;
}

export type TranslatePriority = "visible" | "prefetch";

/**
 * Page translation streams over a port with this name: the content script posts one
 * TranslateRequest, the background answers with a "result" per text as soon as it is known,
 * then "done". Disconnecting cancels whatever has not been sent to the service yet.
 */
export const TRANSLATE_PORT = "translate";

export type TranslateStreamMessage =
  | { readonly type: "result"; readonly index: number; readonly result: TranslateResult }
  | { readonly type: "done" }
  | { readonly type: "error"; readonly error: string };

// Content script / extension pages -> background
export type BackgroundRequest =
  | TranslateRequest
  | { readonly type: "page-config" }
  | { readonly type: "page-init" }
  | { readonly type: "toggle-tab"; readonly tabId: number }
  | { readonly type: "set-mode"; readonly tabId: number; readonly mode: DisplayMode }
  | { readonly type: "tab-state"; readonly tabId: number }
  | { readonly type: "test-provider"; readonly provider: Provider }
  | { readonly type: "list-models"; readonly provider: Provider }
  | { readonly type: "chatgpt-account"; readonly providerId: string }
  | { readonly type: "chatgpt-sign-out"; readonly providerId: string }
  | { readonly type: "clear-cache" };

// Background -> content script
export type ContentRequest =
  | { readonly type: "toggle" }
  | { readonly type: "state" }
  | { readonly type: "set-mode"; readonly mode: DisplayMode }
  | { readonly type: "translate-hovered" }
  | { readonly type: "translate-selection"; readonly text: string };

export interface TabState {
  readonly active: boolean;
  readonly mode?: DisplayMode;
}

/** Keyboard command ids; must match "commands" in scripts/build.mjs. */
export const TOGGLE_COMMAND = "toggle-translation";
export const MODE_COMMAND = "toggle-display-mode";
export const HOVER_COMMAND = "translate-hovered";

export const MAX_TEXTS_PER_MESSAGE = 200;
export const MAX_TEXT_LENGTH = 20_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export const isDisplayMode = (v: unknown): v is DisplayMode => v === "bilingual" || v === "translation-only";

export function isTranslateResult(v: unknown): v is TranslateResult {
  if (!isObject(v)) return false;
  return v.ok === true ? typeof v.text === "string" : v.ok === false && typeof v.error === "string";
}

function parseTranslate(raw: Record<string, unknown>): TranslateRequest | undefined {
  const { texts, targetLang, context, priority } = raw;
  const validTexts =
    Array.isArray(texts) &&
    texts.length <= MAX_TEXTS_PER_MESSAGE &&
    texts.every((t) => typeof t === "string" && t.length <= MAX_TEXT_LENGTH);
  if (!validTexts) return undefined;
  if (targetLang !== undefined && !(typeof targetLang === "string" && isKnownLanguage(targetLang))) return undefined;
  if (context !== undefined && typeof context !== "string") return undefined;
  if (priority !== undefined && priority !== "visible" && priority !== "prefetch") return undefined;
  return {
    type: "translate",
    texts,
    ...(targetLang !== undefined && { targetLang }),
    ...(priority !== undefined && { priority }),
    ...(context && { context: context.replace(/\s+/g, " ").trim().slice(0, MAX_CONTEXT_LENGTH) }),
  };
}

/** Validates untrusted message shapes at the background boundary. */
export function parseBackgroundRequest(raw: unknown): BackgroundRequest | undefined {
  if (!isObject(raw) || typeof raw.type !== "string") return undefined;
  switch (raw.type) {
    case "translate":
      return parseTranslate(raw);
    case "set-mode":
      return Number.isInteger(raw.tabId) && isDisplayMode(raw.mode)
        ? { type: "set-mode", tabId: raw.tabId as number, mode: raw.mode }
        : undefined;
    case "toggle-tab":
    case "tab-state":
      return Number.isInteger(raw.tabId) ? { type: raw.type, tabId: raw.tabId as number } : undefined;
    case "test-provider":
    case "list-models":
      return isObject(raw.provider) ? { type: raw.type, provider: raw.provider as unknown as Provider } : undefined;
    case "chatgpt-account":
    case "chatgpt-sign-out":
      return typeof raw.providerId === "string" && raw.providerId ? { type: raw.type, providerId: raw.providerId } : undefined;
    case "page-config":
    case "page-init":
    case "clear-cache":
      return { type: raw.type };
    default:
      return undefined;
  }
}
