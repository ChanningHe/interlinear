import { beforeEach, describe, expect, test } from "vitest";
import { collectUnits, contentRoots, isTranslatable } from "../src/content/dom";
import { HIDE_ATTR, ONLY_ATTR, canHideOriginal, createWrapper, hideOriginals, insertAfter, showTranslation } from "../src/content/render";
import { plainText } from "../src/content/serialize";

// Display fixes found on real sites (GitHub, Stack Overflow, YouTube). Markup is reduced to
// the structure that matters, without site class names.

beforeEach(() => {
  document.body.innerHTML = "";
});

const texts = (html: string, skipChrome = false) => {
  document.body.innerHTML = html;
  return collectUnits(document.body, { skipChrome }).map((u) => plainText(u.text));
};

const byId = (id: string) => document.getElementById(id)!;

function translateAll(html: string) {
  document.body.innerHTML = html;
  return collectUnits(document.body).map((unit) => {
    const wrapper = createWrapper(unit, "zh", "plain");
    insertAfter(unit, wrapper);
    showTranslation(wrapper, unit, unit.text.toUpperCase());
    return { unit, wrapper };
  });
}

describe("code drawn with divs", () => {
  const MONO = "font-family: ui-monospace, SFMono-Regular, Menlo, monospace";

  test("a monospace block that keeps its whitespace is code: skipped line by line", () => {
    const html = `<div style="white-space: pre; ${MONO}"><div>def dumps(obj, *, skipkeys=False):</div><div>    return encoder.encode(obj)</div></div><p>Real prose text</p>`;
    expect(texts(html)).toEqual(["Real prose text"]);
  });

  test("pre-wrap monospace editors are code too", () => {
    expect(texts(`<div style="white-space: pre-wrap; font-family: monospace"><div>import json as library</div></div>`)).toEqual([]);
  });

  test("pre-wrap prose in a proportional font stays translatable", () => {
    const html = `<div style="white-space: pre-wrap; font-family: Roboto, Arial, sans-serif">Never gonna give you up, never gonna let you down</div>`;
    expect(texts(html)).toEqual(["Never gonna give you up, never gonna let you down"]);
  });

  test("monospace text that wraps normally stays translatable", () => {
    expect(texts(`<div style="${MONO}">A blog written in a typewriter font</div>`)).toEqual(["A blog written in a typewriter font"]);
  });

  test("inline monospace spans stay part of their sentence", () => {
    const html = `<p>Run <span style="display: inline; white-space: pre; ${MONO}">npm install</span> before building</p>`;
    expect(texts(html)).toEqual(["Run npm install before building"]);
  });
});

describe("short button labels are page chrome in content scope", () => {
  test("labels wrapped in divs or paragraphs are still control labels", () => {
    const html = `<main>
      <button><div><span>Subscribe</span></div></button>
      <button><div><p>Add a comment</p></div></button>
      <div role="button" tabindex="0"><div>Load more</div></div>
      <p>Article body text</p></main>`;
    expect(texts(html, true)).toEqual(["Article body text"]);
  });

  test("clickable cards with a heading or long text stay content", () => {
    const html = `<main>
      <div role="button" tabindex="0"><h3>Card title</h3></div>
      <div role="button" tabindex="0"><p>A long clickable card that holds real post content inside it</p></div></main>`;
    expect(texts(html, true)).toEqual(["Card title", "A long clickable card that holds real post content inside it"]);
  });
});

describe("translation only next to chips and status icons", () => {
  const INLINE = 'style="display: inline"';

  test("label chips after a title do not keep the title bilingual, and stay shown", () => {
    const placed = translateAll(
      `<div id="row"><h3 ${INLINE}><a href="#">Confusing message on inconsistent</a></h3><span></span>` +
        `<span id="chips"><button aria-label="Filter by label A-diagnostics">A-diagnostics</button></span></div>`,
    );
    expect(placed.map((p) => plainText(p.unit.text))).toEqual(["Confusing message on inconsistent"]);
    expect(hideOriginals(byId("row"), placed)).toBe(true);
    expect(byId("chips").hasAttribute(HIDE_ATTR)).toBe(false);
  });

  test("a small labelled status icon is decoration", () => {
    const [p] = translateAll(
      `<a id="t" href="#" style="display: block"><span><svg ${INLINE} role="img" aria-label="Status: Open." width="16" height="16"></svg></span><span>Tracking issue title</span></a>`,
    );
    expect(canHideOriginal(p!.unit)).toBe(true);
    expect(hideOriginals(byId("t"), [p!])).toBe(true);
    expect(byId("t").hasAttribute(ONLY_ATTR)).toBe(true);
  });

  test("a labelled picture of unknown size is still content", () => {
    const [p] = translateAll(`<p><img ${INLINE} alt="Diagram of the pipeline"> Paragraph under a picture</p>`);
    expect(canHideOriginal(p!.unit)).toBe(false);
  });
});

describe("the page title outside the main landmark", () => {
  const LONG = `<p>${"Question body text. ".repeat(30)}</p>`;

  test("is translated with the main content", () => {
    document.body.innerHTML = `<header><h1>Site name</h1></header><div id="qh"><h1 id="t">Why is a sorted array faster?</h1></div><main>${LONG}</main>`;
    const roots = contentRoots(document.body);
    expect(roots).toContain(byId("t"));
    expect(roots.map((r) => r.localName)).toEqual(["h1", "main"]);
  });

  test("is not added when the main landmark has its own", () => {
    document.body.innerHTML = `<div><h1>Banner heading</h1></div><main><h1>Article title</h1>${LONG}</main>`;
    expect(contentRoots(document.body).map((r) => r.localName)).toEqual(["main"]);
  });
});

describe("web components that render their own text", () => {
  function shadowed(html: string, shadow: string) {
    document.body.innerHTML = html;
    document.querySelectorAll("x-time").forEach((el) => {
      el.attachShadow({ mode: "open" }).innerHTML = shadow;
    });
    return collectUnits(document.body).map((u) => plainText(u.text));
  }

  test("light-DOM fallback text that is never shown is not translated", () => {
    expect(shadowed('<p>opened <x-time style="display: inline">on Nov 18, 2026</x-time> by someone</p>', '<span>53m ago</span>')).toEqual(["opened by someone"]);
  });

  test("text a component shows through a slot is translated", () => {
    expect(shadowed('<p>opened <x-time style="display: inline">on Nov 18, 2026</x-time></p>', '<b><slot></slot></b>')).toEqual(["opened on Nov 18, 2026"]);
  });
});

describe("bare addresses", () => {
  test("domains and URLs without a scheme are not sent", () => {
    expect(["rust-lang.org", "runtimewire.com", "stackoverflow.com/questions/11227809/why-is", "docs.python.org:443/3/"].filter(isTranslatable)).toEqual([]);
  });

  test("words and sentences with dots are", () => {
    expect(["Read the docs.", "Hello world", "See e.g. this"].every(isTranslatable)).toBe(true);
  });
});
