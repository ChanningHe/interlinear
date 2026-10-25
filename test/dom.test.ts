import { beforeEach, describe, expect, test } from "vitest";
import { blockAncestor, collectUnits } from "../src/content/dom";
import { canHideOriginal, createWrapper, findClip, insertAfter, isMoved, moveBack, moveOutOf, movedLook } from "../src/content/render";

function units(html: string) {
  document.body.innerHTML = html;
  return collectUnits(document.body).map((u) => ({ host: u.host.localName, text: u.text }));
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("collectUnits", () => {
  test("a paragraph with inline formatting is one unit", () => {
    expect(units("<p>Hello <b>bold</b> world</p>")).toEqual([{ host: "p", text: "Hello <g1>bold</g1> world" }]);
  });

  test("text around nested blocks becomes separate units", () => {
    expect(units("<div>Intro text<p>Para one</p>Tail text</div>")).toEqual([
      { host: "div", text: "Intro text" },
      { host: "p", text: "Para one" },
      { host: "div", text: "Tail text" },
    ]);
  });

  test("list items and headings", () => {
    expect(units("<h2>Title here</h2><ul><li>One item</li><li>Two items</li></ul>").map((u) => u.text)).toEqual([
      "Title here",
      "One item",
      "Two items",
    ]);
  });

  test("br splits lines into units", () => {
    expect(units("<p>Line one<br>Line two</p>").map((u) => u.text)).toEqual(["Line one", "Line two"]);
  });

  test("an inline element that wraps blocks is treated as a container", () => {
    expect(units("<span>Hi there <div>Inside div</div></span>")).toEqual([
      { host: "span", text: "Hi there" },
      { host: "div", text: "Inside div" },
    ]);
  });

  test("skips code, scripts, editable regions, notranslate and our own output", () => {
    const html = `
      <pre>const x = 1;</pre>
      <script>var y = 2;</script>
      <div contenteditable="true">Editable text</div>
      <p class="notranslate">Brand Name</p>
      <p translate="no">Keep me</p>
      <span data-bt>Already translated</span>
      <p>Real text</p>`;
    expect(units(html).map((u) => u.text)).toEqual(["Real text"]);
  });

  test("ignores numbers, single letters and bare URLs", () => {
    expect(units("<p>42</p><p>a</p><p>https://example.com/x</p><p>— 3.5 —</p>")).toEqual([]);
  });

  test("collects hidden blocks (tabs, accordions) but keeps hidden inline text out of visible paragraphs", () => {
    const html = '<div style="display:none"><p>Hidden panel</p></div><p>Shown <span style="display:none">tooltip</span>text</p>';
    expect(units(html)).toEqual([
      { host: "p", text: "Hidden panel" },
      { host: "span", text: "tooltip" },
      { host: "p", text: "Shown text" },
    ]);
  });

  test("skips paragraphs too long for one request", () => {
    expect(units(`<p>${"word ".repeat(5000)}</p>`)).toEqual([]);
  });

  test("respects inline display overrides from CSS", () => {
    expect(units('<section>Start <div style="display:inline">middle</div> end</section>').map((u) => u.text)).toEqual([
      "Start <g1>middle</g1> end",
    ]);
  });

  test("unit nodes exclude surrounding whitespace so insertion lands right after the text", () => {
    document.body.innerHTML = "<p>\n  Hello world \n</p>";
    const [u] = collectUnits(document.body);
    expect(u!.nodes).toHaveLength(1);
  });
});

describe("web component light DOM", () => {
  test("an inline component that composes its children with slots is a container, not part of the sentence", () => {
    // Custom elements are display:inline by default; their light DOM is laid out by their slots.
    expect(units('<div>Intro text <x-card style="display: inline"><span slot="title">Card title words</span>Other words in the card</x-card></div>')).toEqual([
      { host: "div", text: "Intro text" },
      { host: "x-card", text: "<g1>Card title words</g1>" },
      { host: "x-card", text: "Other words in the card" },
    ]);
  });

  test("an element assigned to a slot is a paragraph of its own, apart from its siblings", () => {
    expect(units('<x-card><span slot="title">Card title words</span>Other words in the card</x-card>')).toEqual([
      { host: "x-card", text: "<g1>Card title words</g1>" },
      { host: "x-card", text: "Other words in the card" },
    ]);
  });
});

describe("<object> without data", () => {
  // Such an object loads nothing and renders its children (HTML fallback content); sites use it
  // to nest links inside clickable cards.
  // happy-dom has no UA stylesheet; browsers lay out <object> inline by default.
  const html = '<p>See <object role="none" style="display: inline"><a href="#g">the guide</a></object> for details</p>';

  test("is a plain container: its link stays in the sentence", () => {
    expect(units(html)).toEqual([
      { host: "p", text: "See <g1>the guide</g1> for details" },
    ]);
  });

  test("an object that loads something is still media and stays out of the text", () => {
    const texts = units('<p>Watch <object data="clip.swf">fallback words</object> here now</p>').map((u) => u.text);
    expect(texts.join(" ")).not.toContain("fallback");
  });

  test("does not keep its paragraph from being shown as translation only", () => {
    document.body.innerHTML = html;
    expect(canHideOriginal(collectUnits(document.body)[0]!)).toBe(true);
  });
});

describe("blockAncestor", () => {
  test("finds the nearest block container of an inline node", () => {
    document.body.innerHTML = "<article><p>Some <b><i id='t'>deep</i></b></p></article>";
    expect(blockAncestor(document.getElementById("t")!)?.localName).toBe("p");
  });
});

describe("translations a box would clip", () => {
  const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 300, width: 300, height, x: 0, y: top, toJSON: () => ({}) });
  const place = (el: Element, top: number, height: number) => {
    el.getBoundingClientRect = () => rect(top, height) as DOMRect;
  };

  function preview(clampStyle: string) {
    document.body.innerHTML = `<div id="card"><div id="box" style="${clampStyle}"><p style="display: inline">Long preview text</p></div><p id="after">Next</p></div>`;
    const box = document.getElementById("box")!;
    const unit = collectUnits(document.body)[0]!;
    const wrapper = createWrapper(unit, "zh-Hans", "plain");
    insertAfter(unit, wrapper);
    return { box, unit, wrapper };
  }

  test("a translation pushed past a line-clamped box is found and moved after it, clamped the same", () => {
    const { box, unit, wrapper } = preview("overflow: hidden; -webkit-line-clamp: 3; line-clamp: 3");
    place(box, 0, 60);
    place(wrapper, 60, 40); // starts where the box stops showing content
    expect(findClip(wrapper)).toEqual({ clipper: box, movable: true });
    moveOutOf(wrapper, box, movedLook(box, unit));
    expect(box.nextElementSibling).toBe(wrapper);
    expect(isMoved(wrapper)).toBe(true);
    expect(wrapper.style.getPropertyValue("--bt-clamp")).toBe("3");
    moveBack(unit, wrapper);
    expect(wrapper.parentElement).toBe(unit.host);
    expect(isMoved(wrapper)).toBe(false);
    expect(wrapper.getAttribute("style")).toBeNull();
  });

  test("a translation that fits, or a box that does not clip, is left alone", () => {
    const fits = preview("overflow: hidden");
    place(fits.box, 0, 120);
    place(fits.wrapper, 60, 40);
    expect(findClip(fits.wrapper)).toBeUndefined();
    const open = preview("");
    place(open.box, 0, 60);
    place(open.wrapper, 60, 40);
    expect(findClip(open.wrapper)).toBeUndefined();
  });

  test("a parent with display: contents lays out nothing itself: its own parent decides", () => {
    const { box, wrapper } = preview("overflow: hidden");
    const card = document.getElementById("card") as HTMLElement;
    card.style.display = "contents";
    place(box, 0, 60);
    place(wrapper, 60, 40);
    expect(findClip(wrapper)).toEqual({ clipper: box, movable: true }); // body lays out in flow
    card.outerHTML = `<div style="display: flex">${card.outerHTML}</div>`;
    const moved = document.querySelector("bt-tr") as HTMLElement;
    place(document.getElementById("box")!, 0, 60);
    place(moved, 60, 40);
    expect(findClip(moved)?.movable).toBe(false);
  });

  test("a scroll container does not clip: what is past its edge can be scrolled to", () => {
    for (const overflow of ["auto", "scroll"]) {
      const pane = preview(`overflow: ${overflow}`);
      place(pane.box, 0, 60);
      place(pane.wrapper, 40, 40);
      expect(findClip(pane.wrapper)).toBeUndefined();
    }
  });

  test("a clip inside a flex or grid row is reported as not movable; nothing is measured without layout", () => {
    const { box, wrapper } = preview("overflow: hidden");
    (document.getElementById("card") as HTMLElement).style.display = "flex";
    place(box, 0, 60);
    place(wrapper, 60, 40);
    expect(findClip(wrapper)).toEqual({ clipper: box, movable: false });
    const unlaid = preview("overflow: hidden");
    expect(findClip(unlaid.wrapper)).toBeUndefined(); // happy-dom reports 0×0 boxes
  });
});
