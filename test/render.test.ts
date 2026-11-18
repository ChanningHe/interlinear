import { beforeEach, describe, expect, test } from "vitest";
import { collectUnits, type Unit } from "../src/content/dom";
import {
  HIDE_ATTR,
  ONLY_ATTR,
  canHideOriginal,
  createWrapper,
  hideOriginals,
  insertAfter,
  removeAllTranslations,
  showTranslation,
  withOriginalsShown,
} from "../src/content/render";
import { isEmojiImage, serialize } from "../src/content/serialize";

beforeEach(() => {
  document.body.innerHTML = "";
});

// happy-dom has no UA stylesheet: pictures are inline in browsers, so they are here too.
const INLINE = 'style="display: inline"';

/** Translates every paragraph of the page (upper-cased) and returns them with their translations. */
function translateAll(html: string, skip: (u: Unit) => boolean = () => false) {
  document.body.innerHTML = html;
  return collectUnits(document.body).map((unit) => {
    if (skip(unit)) return { unit, wrapper: undefined };
    const wrapper = createWrapper(unit, "zh", "plain");
    insertAfter(unit, wrapper);
    showTranslation(wrapper, unit, unit.text.toUpperCase());
    return { unit, wrapper };
  });
}

const byId = (id: string) => document.getElementById(id)!;
const hideHost = (host: Element, placed: ReturnType<typeof translateAll>) =>
  hideOriginals(host, placed.filter((p) => p.unit.host === host));

describe("images that do not keep an original visible", () => {
  test("emoji drawn as images count as emoji, by class or by shortcode alt", () => {
    document.body.innerHTML = '<img id="a" class="emoji" alt="smile"><img id="b" alt=":slight_smile:"><img id="c" alt="photo">';
    expect([isEmojiImage(byId("a")), isEmojiImage(byId("b")), isEmojiImage(byId("c"))]).toEqual([true, true, false]);
  });

  test("a shortcode alt is not sent as text", () => {
    document.body.innerHTML = '<p>Thanks a lot <img class="emoji" alt=":slight_smile:"></p>';
    expect(serialize([...document.querySelector("p")!.childNodes]).text).not.toContain(":");
  });

  test("a small decorative icon is hidden with its original", () => {
    const [p] = translateAll(`<p><a href="#"><svg ${INLINE} aria-hidden="true" width="16" height="16"></svg> Read more about it</a></p>`);
    expect(canHideOriginal(p!.unit)).toBe(true);
  });

  test("a small image with empty alt is decorative too", () => {
    const [p] = translateAll(`<p><img ${INLINE} alt="" width="12" height="12"> Small decorated paragraph</p>`);
    expect(canHideOriginal(p!.unit)).toBe(true);
  });

  test("a content picture keeps its paragraph bilingual", () => {
    const [big, labelled] = translateAll(
      `<p><img ${INLINE} alt="" width="200" height="120"> Paragraph with a large picture</p><p><svg ${INLINE} aria-label="Chart" width="200" height="120"></svg> Chart the page labels as content</p>`,
    );
    expect(canHideOriginal(big!.unit)).toBe(false);
    expect(canHideOriginal(labelled!.unit)).toBe(false);
  });
});

describe("hosts shared by several paragraphs", () => {
  test("text split by line breaks: originals hidden, breaks kept", () => {
    const placed = translateAll('<p id="p">First line of the post<br>Second line of the post</p>');
    expect(hideHost(byId("p"), placed)).toBe(true);
    expect(byId("p").hasAttribute(ONLY_ATTR)).toBe(true);
    expect(byId("p").querySelector("br")!.hasAttribute(HIDE_ATTR)).toBe(false);
  });

  test("paragraph elements of a translated paragraph are marked hidden, other children keep their type size", () => {
    const placed = translateAll('<div id="d">Lead <b id="b">text</b> before the list<ul id="u"><li id="l">Nested item text</li></ul></div>');
    hideHost(byId("d"), placed);
    expect(byId("b").hasAttribute(HIDE_ATTR)).toBe(true);
    const ul = byId("u");
    expect(ul.hasAttribute(HIDE_ATTR)).toBe(false);
    expect(ul.style.getPropertyValue("--bt-fs")).toBe(getComputedStyle(document.body).fontSize);
  });

  test("comments, styles, links and hidden cards do not keep a paragraph bilingual", () => {
    const placed = translateAll(
      '<p id="p"><!-- a --><style>.x{}</style>Some text with <a href="#">a link</a> here<link rel="mw-deduplicated-inline-style"><span style="display:none">Hover card</span><!---->.</p>',
    );
    expect(hideHost(byId("p"), placed)).toBe(true);
  });

  test("stays bilingual while some of its text has no finished translation", () => {
    const placed = translateAll('<p id="p">First line of the post<br>Second line of the post</p>', (u) => u.text.startsWith("Second"));
    expect(hideHost(byId("p"), placed)).toBe(false);
    expect(byId("p").hasAttribute(ONLY_ATTR)).toBe(false);
  });

  test("stays bilingual when text the reader sees was not translatable", () => {
    const placed = translateAll('<p id="p">First line of the post<br>2024</p>');
    expect(hideHost(byId("p"), placed)).toBe(false);
  });

  test("a host that no longer qualifies is restored", () => {
    const placed = translateAll('<p id="p">First line of the post<br>Second line of the post</p>');
    hideHost(byId("p"), placed);
    byId("p").append(document.createElement("br"), "2024");
    expect(hideHost(byId("p"), placed)).toBe(false);
    expect(byId("p").hasAttribute(ONLY_ATTR)).toBe(false);
  });

  test("keeps letter and word spacing on the translation and zeroes it on the host", () => {
    const placed = translateAll('<p id="p" style="letter-spacing: 2px; word-spacing: 3px">Widely spaced paragraph</p>');
    hideHost(byId("p"), placed);
    const wrapper = placed[0]!.wrapper!;
    expect([wrapper.style.letterSpacing, wrapper.style.wordSpacing]).toEqual(["2px", "3px"]);
  });

  test("measures with every original shown, even inside another translation-only host", () => {
    const style = document.createElement("style");
    style.textContent = `[${ONLY_ATTR}] { font-size: 0 !important; }`;
    document.head.append(style);
    try {
      const placed = translateAll('<div id="d" style="font-size: 20px">Outer lead text here<p id="p">Inner paragraph text</p></div>');
      hideHost(byId("d"), placed);
      hideHost(byId("p"), placed);
      expect(byId("p").querySelector<HTMLElement>("bt-tr")!.style.fontSize).toBe("20px");
      expect(byId("p").style.getPropertyValue("--bt-fs")).toBe("20px");
    } finally {
      style.remove();
    }
  });

  test("detection sees shared hosts as the page styled them", () => {
    const placed = translateAll('<p id="p">First line of the post<br>Second line of the post</p>');
    hideHost(byId("p"), placed);
    withOriginalsShown(document.body, () => {
      expect(document.querySelector(`[${ONLY_ATTR}]`)).toBeNull();
    });
    expect(byId("p").hasAttribute(ONLY_ATTR)).toBe(true);
  });

  test("turning translation off restores the page exactly", () => {
    const html =
      '<div id="d" style="color: red">Lead <b>text</b> before the list<ul style="margin: 0"><li>Nested item text</li></ul><p>Second paragraph<br>with a break line</p></div>';
    const placed = translateAll(html);
    [...new Set(placed.map((p) => p.unit.host))].forEach((h) => hideHost(h, placed));
    expect(document.querySelectorAll(`[${ONLY_ATTR}]`).length).toBe(3);
    removeAllTranslations(document.body);
    expect(document.body.innerHTML).toBe(html);
  });
});
