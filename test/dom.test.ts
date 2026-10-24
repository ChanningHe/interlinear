import { beforeEach, describe, expect, test } from "vitest";
import { blockAncestor, collectUnits } from "../src/content/dom";

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

describe("blockAncestor", () => {
  test("finds the nearest block container of an inline node", () => {
    document.body.innerHTML = "<article><p>Some <b><i id='t'>deep</i></b></p></article>";
    expect(blockAncestor(document.getElementById("t")!)?.localName).toBe("p");
  });
});
