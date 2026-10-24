import { describe, expect, test } from "vitest";
import { MAX_CONTEXT_LENGTH } from "../src/core/prompt";
import { MAX_TEXTS_PER_MESSAGE, MAX_TEXT_LENGTH, isTranslateResult, parseBackgroundRequest } from "../src/shared/messages";
import { serialize } from "../src/content/serialize";

describe("parseBackgroundRequest", () => {
  test("accepts well-formed requests", () => {
    expect(parseBackgroundRequest({ type: "translate", texts: ["a", "b"] })).toEqual({ type: "translate", texts: ["a", "b"] });
    expect(parseBackgroundRequest({ type: "toggle-tab", tabId: 3 })).toEqual({ type: "toggle-tab", tabId: 3 });
    expect(parseBackgroundRequest({ type: "page-config", junk: 1 })).toEqual({ type: "page-config" });
    expect(parseBackgroundRequest({ type: "test-provider", provider: { id: "x" } })).toMatchObject({ type: "test-provider" });
    expect(parseBackgroundRequest({ type: "page-init" })).toEqual({ type: "page-init" });
    expect(parseBackgroundRequest({ type: "set-mode", tabId: 1, mode: "translation-only" })).toEqual({
      type: "set-mode",
      tabId: 1,
      mode: "translation-only",
    });
  });

  test("translate accepts a known target language and a cleaned, bounded context", () => {
    const req = parseBackgroundRequest({ type: "translate", texts: ["a"], targetLang: "en", context: `  My\n  page ${"x".repeat(500)}` });
    expect(req).toMatchObject({ type: "translate", targetLang: "en" });
    expect(req && "context" in req && req.context?.startsWith("My page x")).toBe(true);
    expect(req && "context" in req && req.context!.length).toBe(MAX_CONTEXT_LENGTH);
    expect(parseBackgroundRequest({ type: "translate", texts: ["a"], context: "" })).toEqual({ type: "translate", texts: ["a"] });
  });

  test("translate keeps a known priority", () => {
    expect(parseBackgroundRequest({ type: "translate", texts: ["a"], priority: "prefetch" })).toEqual({ type: "translate", texts: ["a"], priority: "prefetch" });
  });

  test.each([
    null,
    "translate",
    { type: "nope" },
    { type: "translate", texts: "abc" },
    { type: "translate", texts: [1, 2] },
    { type: "translate", texts: Array(MAX_TEXTS_PER_MESSAGE + 1).fill("a") },
    { type: "translate", texts: ["x".repeat(MAX_TEXT_LENGTH + 1)] },
    { type: "tab-state", tabId: "1" },
    { type: "test-provider", provider: null },
    { type: "translate", texts: ["a"], targetLang: "klingon" },
    { type: "translate", texts: ["a"], context: 5 },
    { type: "set-mode", tabId: 1, mode: "sideways" },
    { type: "set-mode", mode: "bilingual" },
    { type: "translate", texts: ["a"], priority: "urgent" },
  ])("rejects %j", (raw) => {
    expect(parseBackgroundRequest(raw)).toBeUndefined();
  });
});

describe("form controls inside paragraphs", () => {
  test("are dropped, never cloned into the translation", () => {
    document.body.innerHTML =
      '<p id="r">Agree <input name="tos" type="checkbox"> and <a href="#">read <button type="submit">go</button></a> now</p>';
    const { text, tokens } = serialize([...document.getElementById("r")!.childNodes]);
    expect(text).toBe("Agree and <g1>read </g1> now");
    expect([...tokens.values()].map((t) => t.el.localName)).toEqual(["a"]);
  });
});

describe("isTranslateResult", () => {
  test.each([
    [{ ok: true, text: "x" }, true],
    [{ ok: false, error: "e" }, true],
    [{ ok: true }, false],
    [{ ok: "yes", text: "x" }, false],
    [null, false],
  ])("%j → %s", (v, expected) => {
    expect(isTranslateResult(v)).toBe(expected);
  });
});
