import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLanguageFilter, normalizeLang } from "../src/content/lang";
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
  inputTargetLang: "en",
  selectionButton: true,
  pageContext: false,
  labels: contentLabels("en"),
};

/** Every observed element is "visible" on the next microtask. */
const alwaysVisible = (onVisible: (els: readonly Element[]) => void): Visibility => ({
  observe: (el) => queueMicrotask(() => onVisible([el])),
  unobserve: () => {},
  disconnect: () => {},
});

const upper = vi.fn(async (texts: readonly string[]): Promise<TranslateResult[]> =>
  texts.map((t) => ({ ok: true, text: t.toUpperCase().replace(/<(\/?)([GX])(\d+)/g, (_, c, k, n) => `<${c}${k.toLowerCase()}${n}`) })),
);

const started: ReturnType<typeof createPageTranslator>[] = [];

function setup(html: string, overrides: Partial<Parameters<typeof createPageTranslator>[0]> = {}) {
  document.body.innerHTML = html;
  const t = createPageTranslator({
    config,
    root: document.body,
    translate: upper,
    isTargetLanguage: async () => false,
    createVisibility: alwaysVisible,
    queueDelayMs: 0,
    mutationDelayMs: 0,
    requireTrustedClick: false,
    ...overrides,
  });
  started.push(t);
  return t;
}

const translations = () => [...document.querySelectorAll("bt-tr.bt-done")].map((n) => n.textContent);

beforeEach(() => {
  upper.mockClear();
});
afterEach(() => {
  started.splice(0).forEach((t) => t.stop());
  document.body.innerHTML = "";
});

describe("page translator", () => {
  test("inserts translations after each paragraph, batched into one request", async () => {
    const t = setup("<p>First paragraph</p><p>Second <a href='/x'>link</a> here</p>");
    t.start();
    await vi.waitFor(() => expect(translations()).toHaveLength(2));
    expect(translations()).toEqual(["FIRST PARAGRAPH", "SECOND LINK HERE"]);
    expect(upper).toHaveBeenCalledTimes(1);
    expect(document.querySelector("p:nth-of-type(2) bt-tr a")?.getAttribute("href")).toBe("/x");
  });

  test("stop restores the original DOM exactly", async () => {
    const html = "<p>Some text to translate</p><div>More <b>words</b> here</div>";
    const t = setup(html);
    t.start();
    await vi.waitFor(() => expect(translations()).toHaveLength(2));
    t.stop();
    expect(document.body.innerHTML).toBe(html);
  });

  test("skips paragraphs already in the target language", async () => {
    const t = setup("<p>Hello there</p><p>你好世界</p>", {
      isTargetLanguage: async (text) => /\p{Script=Han}/u.test(text),
    });
    t.start();
    await vi.waitFor(() => expect(translations()).toEqual(["HELLO THERE"]));
    expect(upper.mock.calls[0]![0]).toEqual(["Hello there"]);
  });

  test("translates content added later and does not loop on its own output", async () => {
    const t = setup("<main><p>Initial text</p></main>");
    t.start();
    await vi.waitFor(() => expect(translations()).toHaveLength(1));

    const p = document.createElement("p");
    p.textContent = "Loaded later";
    document.querySelector("main")!.append(p);
    await vi.waitFor(() => expect(translations()).toEqual(["INITIAL TEXT", "LOADED LATER"]));

    await new Promise((r) => setTimeout(r, 20));
    expect(upper).toHaveBeenCalledTimes(2);
  });

  test("re-translates a paragraph whose text changed", async () => {
    const t = setup("<p id='p'>Old text here</p>");
    t.start();
    await vi.waitFor(() => expect(translations()).toEqual(["OLD TEXT HERE"]));
    document.getElementById("p")!.firstChild!.nodeValue = "New text here";
    await vi.waitFor(() => expect(translations()).toEqual(["NEW TEXT HERE"]));
    expect(document.querySelectorAll("bt-tr")).toHaveLength(1);
  });

  test("shows a retry button on failure and retries on click", async () => {
    const translate = vi
      .fn()
      .mockResolvedValueOnce([{ ok: false, error: "HTTP 500" }])
      .mockResolvedValueOnce([{ ok: true, text: "成功" }]);
    const t = setup("<p>Flaky paragraph</p>", { translate });
    t.start();
    const button = await vi.waitFor(() => {
      const b = document.querySelector<HTMLButtonElement>("bt-tr.bt-error button");
      expect(b).not.toBeNull();
      return b!;
    });
    expect(button.closest("bt-tr")!.getAttribute("title")).toBe("HTTP 500");
    button.click();
    await vi.waitFor(() => expect(translations()).toEqual(["成功"]));
  });

  test("pauses after the character allowance until the user confirms", async () => {
    const t = setup("<p>First paragraph text</p><p>Second paragraph text</p>", { charAllowance: 25 });
    t.start();
    await vi.waitFor(() => expect(translations()).toEqual(["FIRST PARAGRAPH TEXT"]));
    const paused = document.querySelector<HTMLButtonElement>("bt-tr.bt-error button")!;
    expect(paused.textContent).toContain("paused");
    paused.click();
    await vi.waitFor(() => expect(translations()).toHaveLength(2));
  });

  test("ignores synthetic clicks on retry when trusted clicks are required", async () => {
    const translate = vi.fn().mockResolvedValue([{ ok: false, error: "HTTP 500" }]);
    const t = setup("<p>Flaky paragraph</p>", { translate, requireTrustedClick: true });
    t.start();
    const button = await vi.waitFor(() => {
      const b = document.querySelector<HTMLButtonElement>("bt-tr.bt-error button");
      expect(b).not.toBeNull();
      return b!;
    });
    button.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(translate).toHaveBeenCalledTimes(1);
  });

  test("a rejected transport call becomes a visible error", async () => {
    const t = setup("<p>Some paragraph</p>", { translate: vi.fn().mockRejectedValue(new Error("Extension reloaded")) });
    t.start();
    await vi.waitFor(() => expect(document.querySelector("bt-tr.bt-error")?.getAttribute("title")).toBe("Extension reloaded"));
  });
});

describe("translation only", () => {
  const onlyHosts = () => [...document.querySelectorAll("[data-bt-only]")].map((el) => el.id);

  test("hides the original of paragraphs that own their host and restores the page on stop", async () => {
    const html = '<p id="a">Alpha <b>text</b> here</p><li id="b">Beta item<ul><li id="c">Gamma item</li></ul></li>';
    const t = setup(html, { config: { ...config, displayMode: "translation-only" } });
    t.start();
    await vi.waitFor(() => expect(translations()).toHaveLength(3));
    // #b also contains a nested list, so it must stay bilingual.
    expect(onlyHosts()).toEqual(["a", "c"]);
    const wrapper = document.querySelector<HTMLElement>("#a > bt-tr")!;
    expect(wrapper.style.fontSize).not.toBe("");
    t.stop();
    expect(document.body.innerHTML).toBe(html);
  });

  test("keeps the host's margins and restores its style attribute verbatim", async () => {
    const html = '<p id="a" style="color:red">Styled paragraph</p><p id="b">Plain paragraph</p>';
    const t = setup(html, { config: { ...config, displayMode: "translation-only" } });
    t.start();
    await vi.waitFor(() => expect(onlyHosts()).toEqual(["a", "b"]));
    expect(document.getElementById("a")!.style.color).toBe("red");
    t.setMode("bilingual");
    expect(document.getElementById("a")!.getAttribute("style")).toBe("color:red");
    expect(document.getElementById("b")!.hasAttribute("style")).toBe(false);
    t.setMode("translation-only");
    t.stop();
    expect(document.body.innerHTML).toBe(html);
  });

  test("shows the original again when the page deletes the translation", async () => {
    const t = setup("<p id='a'>Some paragraph</p>", { config: { ...config, displayMode: "translation-only" } });
    t.start();
    await vi.waitFor(() => expect(onlyHosts()).toEqual(["a"]));
    document.querySelector("#a > bt-tr")!.remove();
    await vi.waitFor(() => expect(onlyHosts()).toEqual([]));
  });

  test("does not undo style changes the page made while the translation was shown", async () => {
    const t = setup("<p id='a'>Some paragraph</p>", { config: { ...config, displayMode: "translation-only" } });
    t.start();
    await vi.waitFor(() => expect(onlyHosts()).toEqual(["a"]));
    document.getElementById("a")!.style.color = "blue";
    t.stop();
    expect(document.getElementById("a")!.style.color).toBe("blue");
    expect(document.getElementById("a")!.style.getPropertyValue("--bt-mt")).toBe("");
  });

  test("switching modes needs no new requests and is reversible", async () => {
    const html = "<p id='a'>Alpha paragraph</p>";
    const t = setup(html);
    t.start();
    await vi.waitFor(() => expect(translations()).toHaveLength(1));
    t.setMode("translation-only");
    expect(onlyHosts()).toEqual(["a"]);
    expect(t.getMode()).toBe("translation-only");
    t.setMode("bilingual");
    expect(onlyHosts()).toEqual([]);
    expect(document.querySelector("bt-tr")!.hasAttribute("style")).toBe(false);
    expect(upper).toHaveBeenCalledTimes(1);
  });

  test("never hides paragraphs that contain form controls", async () => {
    const t = setup("<label id='l'><input type='checkbox'> Remember me please</label>", {
      config: { ...config, displayMode: "translation-only" },
    });
    t.start();
    await vi.waitFor(() => expect(translations()).toHaveLength(1));
    expect(onlyHosts()).toEqual([]);
  });

  test("a failed or stale translation shows the original again", async () => {
    const t = setup("<p id='p'>Old text here</p>", { config: { ...config, displayMode: "translation-only" } });
    t.start();
    await vi.waitFor(() => expect(onlyHosts()).toEqual(["p"]));
    document.getElementById("p")!.firstChild!.nodeValue = "New text here";
    await vi.waitFor(() => expect(translations()).toEqual(["NEW TEXT HERE"]));
    expect(onlyHosts()).toEqual(["p"]);

    upper.mockResolvedValueOnce([{ ok: false, error: "HTTP 500" }]);
    document.getElementById("p")!.firstChild!.nodeValue = "Newer text here";
    await vi.waitFor(() => expect(document.querySelector("bt-tr.bt-error")).not.toBeNull());
    expect(onlyHosts()).toEqual([]);
  });
});

describe("region translation (hover)", () => {
  test("translates only the hovered paragraph, without whole-page mode", async () => {
    const t = setup("<p id='a'>First <a href='#'>linked</a> paragraph</p><p id='b'>Second paragraph</p>");
    t.translateRegion(document.querySelector("#a a")!);
    await vi.waitFor(() => expect(translations()).toEqual(["FIRST LINKED PARAGRAPH"]));
    // Something is shown, so the toolbar button must offer "Show original", not "Translate page".
    expect(t.isActive()).toBe(true);
    t.translateRegion(document.getElementById("a")!);
    await new Promise((r) => setTimeout(r, 20));
    expect(upper).toHaveBeenCalledTimes(1);
  });

  test("keeps a translated region up to date but ignores the rest of the page", async () => {
    const t = setup("<div id='box'><p id='a'>Region text here</p></div><div id='other'></div>");
    t.translateRegion(document.getElementById("a")!);
    await vi.waitFor(() => expect(translations()).toHaveLength(1));
    document.getElementById("a")!.firstChild!.nodeValue = "Changed region text";
    await vi.waitFor(() => expect(translations()).toEqual(["CHANGED REGION TEXT"]));
    const p = document.createElement("p");
    p.textContent = "Unrelated new content";
    document.getElementById("other")!.append(p);
    await new Promise((r) => setTimeout(r, 20));
    expect(translations()).toEqual(["CHANGED REGION TEXT"]);
  });

  test("whole-page mode keeps region translations and stop removes everything", async () => {
    const html = '<p id="a">First paragraph</p><p id="b">Second paragraph</p>';
    const t = setup(html);
    t.translateRegion(document.getElementById("b")!);
    await vi.waitFor(() => expect(translations()).toHaveLength(1));
    t.start();
    await vi.waitFor(() => expect(translations()).toHaveLength(2));
    expect(upper).toHaveBeenCalledTimes(2);
    t.stop();
    expect(document.body.innerHTML).toBe(html);
  });

  test("stop removes region translations and restores their hosts", async () => {
    const html = '<p id="a">Region paragraph</p>';
    const t = setup(html, { config: { ...config, displayMode: "translation-only" } });
    t.translateRegion(document.getElementById("a")!);
    await vi.waitFor(() => expect(document.querySelector("[data-bt-only]")).not.toBeNull());
    t.stop();
    expect(t.isActive()).toBe(false);
    expect(document.body.innerHTML).toBe(html);
  });

  test("ignores targets inside skipped content or our own output", async () => {
    const t = setup("<pre id='code'>const x = 1;</pre><p id='p'>Some paragraph</p>");
    t.translateRegion(document.getElementById("code")!);
    t.translateRegion(document.getElementById("p")!);
    await vi.waitFor(() => expect(translations()).toHaveLength(1));
    t.translateRegion(document.querySelector("bt-tr")!);
    await new Promise((r) => setTimeout(r, 20));
    expect(upper).toHaveBeenCalledTimes(1);
  });
});

describe("language filter", () => {
  test("normalizes codes", () => {
    expect(normalizeLang("en-GB")).toBe("en");
    expect(normalizeLang("zh")).toBe("zh-hans");
    expect(normalizeLang("zh-CN")).toBe("zh-hans");
    expect(normalizeLang("zh-Hant")).toBe("zh-hant");
    expect(normalizeLang("zh_TW")).toBe("zh-hant");
    expect(normalizeLang("zh-HK")).toBe("zh-hant");
    expect(normalizeLang("zh-Hans-HK")).toBe("zh-hans");
  });

  test("uses reliable detection, otherwise the page language", async () => {
    const detect = vi.fn(async (text: string) =>
      text.length > 10 ? { language: "zh-CN", reliable: true } : { language: "en", reliable: false },
    );
    const onChinesePage = createLanguageFilter("zh-Hans", detect, "zh-CN");
    expect(await onChinesePage("这是一段足够长的中文文本内容")).toBe(true);
    expect(await onChinesePage("Short")).toBe(true);
    const onEnglishPage = createLanguageFilter("zh-Hans", detect, "en");
    expect(await onEnglishPage("Short")).toBe(false);
  });

  test("treats detector failures as unknown", async () => {
    const filter = createLanguageFilter("ja", async () => Promise.reject(new Error("boom")), "");
    expect(await filter("text")).toBe(false);
  });
});

describe("streaming and priority", () => {
  test("each paragraph is shown as soon as its result arrives", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const translate = vi.fn(async (texts: readonly string[], opts?: { onResult?: (i: number, r: TranslateResult) => void }) => {
      opts?.onResult?.(0, { ok: true, text: "FIRST" });
      await gate;
      return texts.map((t, i) => ({ ok: true as const, text: i === 0 ? "FIRST" : t.toUpperCase() }));
    });
    const t = setup("<p>first paragraph</p><p>second paragraph</p>", { translate });
    t.start();
    await vi.waitFor(() => expect(translations()).toEqual(["FIRST"]));
    release();
    await vi.waitFor(() => expect(translations()).toEqual(["FIRST", "SECOND PARAGRAPH"]));
  });

  test("turning translation off cancels requests still in flight", async () => {
    let signal: AbortSignal | undefined;
    const translate = vi.fn((_texts: readonly string[], opts?: { signal?: AbortSignal }) => {
      signal = opts?.signal;
      return new Promise<TranslateResult[]>(() => {});
    });
    const t = setup("<p>Some paragraph</p>", { translate });
    t.start();
    await vi.waitFor(() => expect(translate).toHaveBeenCalled());
    expect(signal?.aborted).toBe(false);
    t.stop();
    expect(signal?.aborted).toBe(true);
  });

  test("text on screen is sent first, marked visible", async () => {
    const calls: { texts: readonly string[]; priority?: string }[] = [];
    const translate = vi.fn(async (texts: readonly string[], opts?: { priority?: string }) => {
      calls.push({ texts, priority: opts?.priority });
      return texts.map((x) => ({ ok: true as const, text: x.toUpperCase() }));
    });
    const t = setup('<p id="below">below the fold</p><p id="seen">on the screen</p>', {
      translate,
      isOnScreen: (el) => el.id === "seen",
    });
    t.start();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual([
      { texts: ["on the screen"], priority: "visible" },
      { texts: ["below the fold"], priority: "prefetch" },
    ]);
  });
});


describe("translation-only stays put while the page changes", () => {
  // The same rule content.css uses to hide the original of a translation-only paragraph.
  const hideRule = "[data-bt-only] > :not(bt-tr[data-bt]) { display: none !important; }";

  test("a page update around a hidden original does not bring the original back", async () => {
    const style = document.createElement("style");
    style.textContent = hideRule;
    document.head.append(style);
    try {
      const t = setup('<div id="post"><p id="a">Read <a href="#">the docs</a> before you start</p></div>', { config: { ...config, displayMode: "translation-only" } });
      t.start();
      const host = document.getElementById("a")!;
      await vi.waitFor(() => expect(host.hasAttribute("data-bt-only")).toBe(true));
      document.getElementById("post")!.className = "highlighted"; // a page update that does not change the text
      await new Promise((r) => setTimeout(r, 20));
      expect(host.hasAttribute("data-bt-only")).toBe(true);
      expect(host.querySelectorAll("bt-tr")).toHaveLength(1);
      expect(upper).toHaveBeenCalledTimes(1);
    } finally {
      style.remove();
    }
  });

  test("a paragraph the page re-renders gets its earlier translation without a new request", async () => {
    const t = setup('<div id="post"><p>First reply in the thread</p></div>');
    t.start();
    await vi.waitFor(() => expect(translations()).toEqual(["FIRST REPLY IN THE THREAD"]));
    // Virtualised lists replace a post with fresh nodes when it scrolls back into view.
    document.getElementById("post")!.innerHTML = "<p>First reply in the thread</p>";
    await vi.waitFor(() => expect(translations()).toEqual(["FIRST REPLY IN THE THREAD"]));
    expect(upper).toHaveBeenCalledTimes(1);
  });
});
