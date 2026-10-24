export interface Language {
  readonly code: string;
  readonly name: string;
}

// Names are what the LLM sees in the prompt, so keep them unambiguous English.
export const LANGUAGES: readonly Language[] = [
  { code: "zh-Hans", name: "Simplified Chinese" },
  { code: "zh-Hant", name: "Traditional Chinese" },
  { code: "en", name: "English" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "es", name: "Spanish" },
  { code: "pt", name: "Portuguese" },
  { code: "it", name: "Italian" },
  { code: "ru", name: "Russian" },
  { code: "ar", name: "Arabic" },
  { code: "hi", name: "Hindi" },
  { code: "id", name: "Indonesian" },
  { code: "vi", name: "Vietnamese" },
  { code: "th", name: "Thai" },
  { code: "tr", name: "Turkish" },
  { code: "nl", name: "Dutch" },
  { code: "pl", name: "Polish" },
  { code: "uk", name: "Ukrainian" },
];

export type ChineseScript = "zh-Hans" | "zh-Hant";

const TRADITIONAL_REGIONS = new Set(["tw", "hk", "mo"]);

/**
 * Script of a Chinese language tag. Browsers and pages report regions (zh-CN, zh-TW, zh-HK);
 * this project only distinguishes the script. Undefined for non-Chinese tags.
 */
export function chineseScript(code: string): ChineseScript | undefined {
  const parts = code.toLowerCase().replaceAll("_", "-").split("-");
  if (parts[0] !== "zh") return undefined;
  if (parts.includes("hant")) return "zh-Hant";
  if (parts.includes("hans")) return "zh-Hans";
  return parts.some((p) => TRADITIONAL_REGIONS.has(p)) ? "zh-Hant" : "zh-Hans";
}

export function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

export function isKnownLanguage(code: string): boolean {
  return LANGUAGES.some((l) => l.code === code);
}
