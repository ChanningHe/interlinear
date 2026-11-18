import { describe, expect, test } from "vitest";
import { isTranslatableDocument } from "../src/content/support";

const parse = (text: string, type: DOMParserSupportedType) => new DOMParser().parseFromString(text, type);

describe("isTranslatableDocument", () => {
  test("HTML pages are translatable", () => {
    expect(isTranslatableDocument(document)).toBe(true);
  });

  test("XML feeds and SVG images are not, so nothing is inserted or observed in them", () => {
    expect(isTranslatableDocument(parse("<rss><channel><title>News</title></channel></rss>", "text/xml"))).toBe(false);
    expect(isTranslatableDocument(parse("<svg xmlns='http://www.w3.org/2000/svg'><text>Hi</text></svg>", "image/svg+xml"))).toBe(false);
  });

  test("plain-text views are not", () => {
    const doc = document.implementation.createHTMLDocument("t");
    Object.defineProperty(doc, "contentType", { value: "text/plain" });
    expect(isTranslatableDocument(doc)).toBe(false);
  });
});
