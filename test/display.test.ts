import { beforeEach, describe, expect, test } from "vitest";
import { collectUnits } from "../src/content/dom";
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
