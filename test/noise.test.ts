import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { collectUnits, contentRoots } from "../src/content/dom";
import { plainText } from "../src/content/serialize";
import { createPageTranslator, type Visibility } from "../src/content/translator";
import { contentLabels } from "../src/shared/i18n";
import type { PageConfig, TranslateResult } from "../src/shared/messages";

// Fixtures follow real markup seen on Reddit (shreddit/faceplate components) and Discourse.

const texts = (html: string, skipChrome = false) => {
  document.body.innerHTML = html;
  return collectUnits(document.body, { skipChrome }).map((u) => plainText(u.text));
};

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("noise is never translated", () => {
  test("screen-reader-only text: sr-only classes, 1px boxes and off-screen labels", () => {
    const html = `
      <a href="/" style="display:flex"><svg></svg><span class="sr-only">Go to Reddit Home</span></a>
      <h1 class="visually-hidden">Reddit - The heart of the internet</h1>
      <a href="#main" style="position:absolute;width:1px;height:1px;overflow:hidden">Skip to main content</a>
      <span style="position:absolute;left:-10000px">Off screen label</span>
      <p>Visible paragraph</p>`;
    expect(texts(html)).toEqual(["Visible paragraph"]);
  });

  test("invisible parts of a paragraph do not join its text", () => {
    const html = `
      <p>Visible text <span style="visibility:hidden">hover tip</span> continues</p>
      <p>Another line <span style="opacity:0">faded label</span> here</p>`;
    expect(texts(html)).toEqual(["Visible text continues", "Another line here"]);
  });

  test("tooltips, menus, listboxes and popovers", () => {
    const html = `
      <div role="tooltip">Open chat</div>
      <ul role="menu"><li>Settings menu item</li></ul>
      <ul role="listbox"><li>Option entry</li></ul>
      <div popover>Popover text</div>
      <p>Body text</p>`;
    expect(texts(html)).toEqual(["Body text"]);
  });

  test("ads by tag, class, id, data attributes and label, without catching look-alike names", () => {
    const html = `
      <shreddit-ad-post><p>Connect any agent to any model</p></shreddit-ad-post>
      <shreddit-comments-page-ad><p>Insurance leaders report returns</p></shreddit-comments-page-ad>
      <div class="ad-container"><p>Buy now cheap</p></div>
      <ins class="adsbygoogle">Ad text here</ins>
      <div id="google_ads_iframe_1"><p>Google ad text</p></div>
      <div data-ad-slot="1"><p>Slot ad text</p></div>
      <section aria-label="Advertisement"><p>Labelled ad text</p></section>
      <div class="badge header-loader add-button"><p>Real content</p></div>`;
    expect(texts(html)).toEqual(["Real content"]);
  });

  test("metadata: bare timestamps, handles and identifiers", () => {
    const html = `
      <div><span><time datetime="2026-10-22">17h ago</time></span></div>
      <p>u/Heavy_Platform4295</p>
      <p>r/ProtonMail</p>
      <p>@someone</p>
      <p>Platform4295</p>
      <span>6 hrs ago</span> <div>17h ago</div> <div>just now</div>
      <p>Posted <time>2 days ago</time> by someone</p>`;
    expect(texts(html)).toEqual(["Posted 2 days ago by someone"]);
  });

  test("text in Chinese or Japanese with digits is not mistaken for an identifier", () => {
    expect(texts("<p>2024年に発売された</p><p>第3章内容</p>")).toEqual(["2024年に発売された", "第3章内容"]);
  });
});

const PAGE = `
  <header><nav><a href="/">Home page</a></nav><button>Create post</button></header>
  <nav aria-label="Primary"><a href="/p">Popular posts</a></nav>
  <main>
    <article>
      <header><h1>Article title here</h1></header>
      <p>Article body text</p>
      <footer><p>Article footer note</p></footer>
    </article>
    <div role="toolbar"><span>Share this</span></div>
    <button>Reply now</button>
    <div role="button" tabindex="0">Upvote</div>
    <div role="button" tabindex="0"><p>A long clickable card that holds real post content inside it</p></div>
  </main>
  <aside><p>Sidebar rules text</p></aside>
  <footer><p>Copyright footer text</p></footer>`;

describe("main content scope", () => {
  test("only the main landmark, without its toolbars and buttons", () => {
    document.body.innerHTML = PAGE;
    const roots = contentRoots(document.body);
    expect(roots.map((r) => r.localName)).toEqual(["main"]);
    const found = roots.flatMap((r) => collectUnits(r, { skipChrome: true })).map((u) => plainText(u.text));
    expect(found).toEqual([
      "Article title here",
      "Article body text",
      "Article footer note",
      "A long clickable card that holds real post content inside it",
    ]);
  });

  test("whole-page scope keeps chrome but still drops noise", () => {
    const found = texts(PAGE + '<span class="sr-only">Screen reader note</span>');
    expect(found).toContain("Home page");
    expect(found).toContain("Create post");
    expect(found).toContain("Sidebar rules text");
    expect(found).not.toContain("Screen reader note");
  });

  test("without a main landmark the body is used, minus page header, navigation and footer", () => {
    document.body.innerHTML = PAGE.replace("<main>", "<div>").replace("</main>", "</div>");
    expect(contentRoots(document.body)).toEqual([document.body]);
    const found = texts(document.body.innerHTML, true);
    expect(found).not.toContain("Home page");
    expect(found).not.toContain("Copyright footer text");
    expect(found).toContain("Article footer note"); // an article's own footer is content
    expect(found).toContain("Sidebar rules text");
  });

  test("a main landmark holding little of the page is not trusted", () => {
    document.body.innerHTML = `<main><p>Tiny widget</p></main><div><p>${"Long article text. ".repeat(50)}</p></div>`;
    expect(contentRoots(document.body)).toEqual([document.body]);
  });
});

const config: PageConfig = {
  targetLang: "zh-Hans",
  style: "plain",
  displayMode: "bilingual",
  scope: "content",
  maxCharsPerBatch: 2000,
  maxItemsPerBatch: 20,
  hoverModifier: "ctrl",
  inputTranslation: true,
  inputTargetLang: "en",
  selectionButton: true,
  pageContext: false,
  labels: contentLabels("en"),
};

const alwaysVisible = (onVisible: (els: readonly Element[]) => void): Visibility => ({
  observe: (el) => queueMicrotask(() => onVisible([el])),
  unobserve: () => {},
  disconnect: () => {},
});

/** Uppercases, except names, which come back unchanged like a real model would. */
const model = vi.fn(async (texts: readonly string[]): Promise<TranslateResult[]> =>
  texts.map((t) => ({ ok: true, text: /Proton Mail/.test(t) ? t : t.toUpperCase().replace(/<(\/?)([GX])(\d+)/g, (_, c, k, n) => `<${c}${k.toLowerCase()}${n}`) })),
);

const started: ReturnType<typeof createPageTranslator>[] = [];
function translator(html: string, overrides: Partial<PageConfig> = {}) {
  document.body.innerHTML = html;
  const t = createPageTranslator({
    config: { ...config, ...overrides },
    root: document.body,
    translate: model,
    isTargetLanguage: async () => false,
    createVisibility: alwaysVisible,
    queueDelayMs: 0,
    mutationDelayMs: 0,
    requireTrustedClick: false,
  });
  started.push(t);
  return t;
}
const shown = () => [...document.querySelectorAll("bt-tr.bt-done")].map((n) => n.textContent);

describe("page translator with real-world noise", () => {
  afterEach(() => {
    started.splice(0).forEach((t) => t.stop());
    model.mockClear();
  });

  test("main-content scope translates the article only, and keeps doing so after SPA navigation", async () => {
    const t = translator(PAGE);
    t.start();
    await vi.waitFor(() => expect(shown()).toHaveLength(4));
    expect(document.querySelector("nav bt-tr, aside bt-tr, body > footer bt-tr, button bt-tr")).toBeNull();

    document.querySelector("nav a")!.textContent = "Changed navigation";
    const next = document.createElement("main");
    const body = "Next page content with enough text to be the main part of this page. ".repeat(4).trim();
    next.innerHTML = `<p>${body}</p>`;
    document.querySelector("main")!.replaceWith(next);
    await vi.waitFor(() => expect(shown()).toEqual([body.toUpperCase()]));
  });

  test("a translation identical to the original is not shown", async () => {
    const t = translator("<main><p>Proton Mail</p><p>Secure email</p></main>");
    t.start();
    await vi.waitFor(() => expect(shown()).toEqual(["SECURE EMAIL"]));
    expect(document.querySelectorAll("bt-tr")).toHaveLength(1);
  });

  test("text slotted into a hidden part of a component is skipped; visible slotted text keeps its slot", async () => {
    const html = `<main>
      <div id="tip"><span slot="content">Open chat window</span></div>
      <div id="card"><span slot="title">Visible slotted title</span></div>
      <p>Plain paragraph text</p></main>`;
    const t = translator(html);
    // Stand-in for the browser: the tooltip slot is not rendered until hover.
    const tip = document.querySelector("#tip span")!;
    Object.defineProperty(tip, "checkVisibility", { value: () => false });
    t.start();
    await vi.waitFor(() => expect(shown()).toEqual(["VISIBLE SLOTTED TITLE", "PLAIN PARAGRAPH TEXT"]));
    expect(document.querySelector("#tip bt-tr")).toBeNull();
    expect(document.querySelector("#card bt-tr")!.getAttribute("slot")).toBe("title");
  });

  test("hover translation still works on chrome the user points at", async () => {
    const t = translator(PAGE);
    t.translateRegion(document.querySelector("aside p")!);
    await vi.waitFor(() => expect(shown()).toEqual(["SIDEBAR RULES TEXT"]));
  });
});

describe("no false positives (review findings)", () => {
  test("ad-sounding classes on page structure or content containers do not hide the page", () => {
    document.body.className = "ad-free has-ads";
    const html = `
      <main class="no-ads"><p>Main text here</p></main>
      <div class="ads-sidebar-layout"><h1>Page title</h1><p>Lead paragraph</p></div>`;
    expect(texts(html)).toEqual(["Main text here", "Page title", "Lead paragraph"]);
    document.body.className = "";
  });

  test("accordion headings and title-bearing headers are content, short buttons are not", () => {
    const html = `
      <h3><button aria-expanded="false">How do refunds work?</button></h3>
      <header><h1>Post title on a page without article</h1></header>
      <button>Close</button>`;
    expect(texts(html, true)).toEqual(["How do refunds work?", "Post title on a page without article"]);
  });

  test("off-screen carousel slides and unclipped 1px wrappers are not screen-reader text", () => {
    const html = `
      <div style="position:absolute;left:-1200px"><p>Next slide text</p></div>
      <div style="position:absolute;width:0;height:0"><p>Overflowing child text</p></div>
      <a style="text-indent:-9999px">Image replacement label</a>`;
    expect(texts(html)).toEqual(["Next slide text", "Overflowing child text"]);
  });

  test("hashtags in Chinese are sentences, not handles", () => {
    expect(texts("<p>#话题讨论内容</p><p>#ascii_tag</p>")).toEqual(["#话题讨论内容"]);
  });
});

describe("translator follow-ups (review findings)", () => {
  afterEach(() => {
    started.splice(0).forEach((t) => t.stop());
    model.mockClear();
  });

  test("text revealed by an attribute change is picked up", async () => {
    const html = "<style>.later{display:none}</style><main><p id='p'>Intro text <span class='later'>revealed words</span></p></main>";
    const t = translator(html, { scope: "page" });
    t.start();
    await vi.waitFor(() => expect(shown()).toEqual(["INTRO TEXT"]));
    document.querySelector("#p span")!.classList.remove("later");
    await vi.waitFor(() => expect(shown()).toEqual(["INTRO TEXT REVEALED WORDS"]));
  });

  test("translation only keeps paragraphs with pictures bilingual, since pictures are not copied", async () => {
    const t = translator(
      '<main><ul><li id="flag"><img src="fr.png" alt="France flag"> France country</li><li id="text">Plain country name</li></ul></main>',
      { displayMode: "translation-only" },
    );
    t.start();
    await vi.waitFor(() => expect(shown()).toHaveLength(2));
    expect(document.getElementById("flag")!.hasAttribute("data-bt-only")).toBe(false);
    expect(document.getElementById("text")!.hasAttribute("data-bt-only")).toBe(true);
  });
});
