import { afterEach, describe, expect, test, vi } from "vitest";
import { createPageTranslator, type Visibility } from "../src/content/translator";
import { contentLabels } from "../src/shared/i18n";
import type { PageConfig, TranslateResult } from "../src/shared/messages";

const config: PageConfig = {
  targetLang: "zh-Hans",
  style: "plain",
  displayMode: "bilingual",
  scope: "page",
  maxCharsPerBatch: 2000,
  maxItemsPerBatch: 20,
  hoverModifier: "ctrl",
  inputTranslation: true,
  selectionButton: true,
  pageContext: false,
  labels: contentLabels("en"),
};

const alwaysVisible = (onVisible: (els: readonly Element[]) => void): Visibility => ({
  observe: (el) => queueMicrotask(() => onVisible([el])),
  unobserve: () => {},
  disconnect: () => {},
});

const upper = vi.fn(async (texts: readonly string[]): Promise<TranslateResult[]> =>
  texts.map((t) => ({ ok: true, text: t.toUpperCase() })),
);

const translations = () => [...document.querySelectorAll("bt-tr.bt-done")].map((n) => n.textContent);

afterEach(() => {
  document.body.innerHTML = "";
  upper.mockClear();
});

describe("whole-page state", () => {
  test("translating one region is not whole-page translation; start promotes it without duplicates", async () => {
    document.body.innerHTML = '<p id="a">First paragraph</p><p id="b">Second paragraph</p>';
    const t = createPageTranslator({
      config,
      root: () => document.body,
      translate: upper,
      isTargetLanguage: async () => false,
      createVisibility: alwaysVisible,
      queueDelayMs: 0,
      mutationDelayMs: 0,
      requireTrustedClick: false,
    });
    expect(t.isWholePage()).toBe(false);
    t.translateRegion(document.getElementById("a")!);
    await vi.waitFor(() => expect(translations()).toEqual(["FIRST PARAGRAPH"]));
    expect(t.isActive()).toBe(true);
    expect(t.isWholePage()).toBe(false);

    t.start();
    expect(t.isWholePage()).toBe(true);
    await vi.waitFor(() => expect(translations()).toEqual(["FIRST PARAGRAPH", "SECOND PARAGRAPH"]));
    expect(upper.mock.calls.flatMap(([texts]) => texts)).toEqual(["First paragraph", "Second paragraph"]);

    t.stop();
    expect(t.isWholePage()).toBe(false);
  });
});
