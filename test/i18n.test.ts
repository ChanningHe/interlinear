import { describe, expect, test } from "vitest";
import { normalizeSettings } from "../src/core/settings";
import {
  CONTENT_KEYS,
  UI_LANGUAGES,
  contentLabels,
  createT,
  format,
  languageLabel,
  resolveUiLanguage,
} from "../src/shared/i18n";
import { en } from "../src/shared/i18n/en";
import { ja } from "../src/shared/i18n/ja";
import { zhHans } from "../src/shared/i18n/zh-Hans";
import { zhHant } from "../src/shared/i18n/zh-Hant";
import { chineseScript } from "../src/shared/languages";

const DICTIONARIES = { "zh-Hans": zhHans, "zh-Hant": zhHant, ja };
const placeholders = (s: string) => [...s.matchAll(/\{\{?\w+\}?\}/g)].map((m) => m[0]).sort();

describe("dictionaries", () => {
  test.each(Object.entries(DICTIONARIES))("%s has exactly the English keys", (_, dict) => {
    expect(Object.keys(dict).sort()).toEqual(Object.keys(en).sort());
  });

  test.each(Object.entries(DICTIONARIES))("%s keeps every placeholder of each English string", (_, dict) => {
    for (const [key, text] of Object.entries(en)) {
      expect([key, placeholders(dict[key as keyof typeof en])]).toEqual([key, placeholders(text)]);
    }
  });

  test.each(Object.entries(DICTIONARIES))("%s keeps the selection marker in the menu title", (_, dict) => {
    expect(dict.menuSelection).toContain("%s");
  });

  test("no string is empty", () => {
    for (const dict of [en, ...Object.values(DICTIONARIES)]) {
      for (const value of Object.values(dict)) expect(value.trim()).not.toBe("");
    }
  });
});

describe("t()", () => {
  test("fills named placeholders and leaves the literal {{to}} alone", () => {
    expect(createT("en")("saveFailed", { error: "boom" })).toBe("Save failed: boom");
    expect(createT("zh-Hans")("version", { version: "1.2" })).toBe("版本 1.2");
    expect(createT("en")("customInstructionsDesc")).toContain("{{to}}");
    expect(format("{a} and {b}", { a: 1 })).toBe("1 and {b}");
  });
});

describe("resolveUiLanguage", () => {
  test.each([
    ["zh-CN", "zh-Hans"],
    ["zh-SG", "zh-Hans"],
    ["zh-TW", "zh-Hant"],
    ["zh-HK", "zh-Hant"],
    ["zh_MO", "zh-Hant"],
    ["ja", "ja"],
    ["ja-JP", "ja"],
    ["en-GB", "en"],
    ["de", "en"],
    ["", "en"],
  ])("auto with browser %s → %s", (browser, expected) => {
    expect(resolveUiLanguage("auto", browser)).toBe(expected);
  });

  test("an explicit choice wins over the browser", () => {
    expect(resolveUiLanguage("ja", "zh-CN")).toBe("ja");
  });
});

describe("chineseScript", () => {
  test.each([
    ["zh", "zh-Hans"],
    ["zh-Hans-HK", "zh-Hans"],
    ["zh-Hant", "zh-Hant"],
    ["zh-Hant-CN", "zh-Hant"],
    ["en", undefined],
    ["zha", undefined],
  ])("%s → %s", (code, expected) => {
    expect(chineseScript(code)).toBe(expected);
  });
});

describe("helpers", () => {
  test("content labels carry only the in-page strings", () => {
    const labels = contentLabels("zh-Hant");
    expect(Object.keys(labels).sort()).toEqual([...CONTENT_KEYS].sort());
    expect(labels.copy).toBe(zhHant.copy);
  });

  test("target languages are named in the interface language, with a fallback", () => {
    expect(languageLabel("ja", "en", "Japanese")).toBe("Japanese");
    expect(languageLabel("zh-Hans", "zh-Hans", "Simplified Chinese")).toMatch(/中文/);
    expect(languageLabel("not a tag!", "en", "Fallback")).toBe("Fallback");
  });

  test("interface language setting is validated", () => {
    expect(normalizeSettings({}).uiLanguage).toBe("auto");
    for (const { value } of UI_LANGUAGES) expect(normalizeSettings({ uiLanguage: value }).uiLanguage).toBe(value);
    expect(normalizeSettings({ uiLanguage: "zh-CN" }).uiLanguage).toBe("auto");
  });
});
