import { chineseScript, supportedLanguage } from "../shared/languages";

// Decides whether a paragraph is already in the target language, entirely on-device.

export interface Detection {
  readonly language: string;
  readonly reliable: boolean;
}

export type Detector = (text: string) => Promise<Detection | undefined>;

/** Collapses codes to the granularity users care about: zh-Hant ≠ zh-Hans, en-GB = en. */
export function normalizeLang(code: string): string {
  const script = chineseScript(code);
  if (script) return script.toLowerCase();
  const lower = code.toLowerCase().replace("_", "-");
  return lower.split("-")[0] ?? lower;
}

export function createLanguageFilter(targetLang: string, detect: Detector, pageLang: string) {
  const target = normalizeLang(targetLang);
  const pageHint = pageLang ? normalizeLang(pageLang) : undefined;
  return async function isTargetLanguage(text: string): Promise<boolean> {
    let detection: Detection | undefined;
    try {
      detection = await detect(text);
    } catch {
      // Detection is best effort; an error just means "unknown".
      detection = undefined;
    }
    if (detection?.reliable) return normalizeLang(detection.language) === target;
    // Short text is rarely detected reliably; fall back to the page's declared language.
    return pageHint === target;
  };
}

/**
 * Language typed text is translated into: the page's own (what it declares, else what its text
 * reliably reads as), since replies go to the people reading that page. English when the page is
 * in the reader's own language or cannot be told.
 */
export async function inputLanguage(targetLang: string, pageLang: string, pageText: string, detect: Detector): Promise<string> {
  let page = supportedLanguage(pageLang);
  if (!page && pageText) {
    const detection = await detect(pageText).catch(() => undefined);
    page = detection?.reliable ? supportedLanguage(detection.language) : undefined;
  }
  return page && normalizeLang(page) !== normalizeLang(targetLang) ? page : "en";
}

/** Browser-provided detector (CLD, runs locally). */
export const chromeDetector: Detector = async (text) => {
  const res = await chrome.i18n.detectLanguage(text);
  const top = res.languages[0];
  return top ? { language: top.language, reliable: res.isReliable } : undefined;
};
