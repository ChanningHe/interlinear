import { chineseScript } from "../languages";
import { en, type MessageKey, type Messages } from "./en";
import { ja } from "./ja";
import { zhHans } from "./zh-Hans";
import { zhHant } from "./zh-Hant";

export type { MessageKey, Messages } from "./en";

export type UiLanguage = "en" | "zh-Hans" | "zh-Hant" | "ja";
/** "auto" follows the browser's own UI language. */
export type UiLanguageSetting = "auto" | UiLanguage;

const DICTIONARIES: Readonly<Record<UiLanguage, Messages>> = { en, "zh-Hans": zhHans, "zh-Hant": zhHant, ja };

/** Native names, so people can find their language whatever the current interface language is. */
export const UI_LANGUAGES: readonly { readonly value: UiLanguage; readonly label: string }[] = [
  { value: "en", label: "English" },
  { value: "zh-Hans", label: "简体中文" },
  { value: "zh-Hant", label: "繁體中文" },
  { value: "ja", label: "日本語" },
];

export const isUiLanguageSetting = (v: unknown): v is UiLanguageSetting =>
  v === "auto" || UI_LANGUAGES.some((l) => l.value === v);

/** Maps a setting plus the browser's UI language (zh-CN, zh-TW, ja-JP, …) to a dictionary. */
export function resolveUiLanguage(setting: UiLanguageSetting, browserLanguage: string): UiLanguage {
  if (setting !== "auto") return setting;
  const script = chineseScript(browserLanguage);
  if (script) return script;
  return browserLanguage.toLowerCase().split(/[-_]/)[0] === "ja" ? "ja" : "en";
}

export type Translate = (key: MessageKey, vars?: Readonly<Record<string, string | number>>) => string;

/** Fills {name} placeholders; unknown names (such as the literal "{{to}}") are left as they are. */
export function format(template: string, vars: Readonly<Record<string, string | number>> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export function createT(lang: UiLanguage): Translate {
  const dict = DICTIONARIES[lang];
  return (key, vars) => format(dict[key], vars);
}

/** Strings shown inside web pages; only these are sent to content scripts. */
export const CONTENT_KEYS = [
  "translating",
  "copy",
  "copied",
  "copyFailed",
  "close",
  "translateSelection",
  "retry",
  "paused",
  "pausedMessage",
] as const satisfies readonly MessageKey[];

export type ContentLabels = Readonly<Record<(typeof CONTENT_KEYS)[number], string>>;

export function contentLabels(lang: UiLanguage): ContentLabels {
  const dict = DICTIONARIES[lang];
  return Object.fromEntries(CONTENT_KEYS.map((k) => [k, dict[k]])) as ContentLabels;
}

/** A target language's name in the interface language, via Intl; `fallback` if unavailable. */
export function languageLabel(code: string, ui: UiLanguage, fallback: string): string {
  try {
    return new Intl.DisplayNames([ui], { type: "language" }).of(code) ?? fallback;
  } catch {
    return fallback;
  }
}
