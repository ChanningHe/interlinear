import { afterEach, describe, expect, test, vi } from "vitest";
import { editableField, installTripleSpace, readField, translateField } from "../src/content/input";
import { MAX_TEXT_LENGTH } from "../src/shared/messages";

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((d) => d());
  document.body.innerHTML = "";
  document.documentElement.querySelectorAll("bt-popover").forEach((n) => n.remove());
  vi.useRealTimers();
});

const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
const spaces = (el: Element, n = 3) => Array.from({ length: n }, () => el.dispatchEvent(key(" ")));
const field = <T extends HTMLElement>(html: string) => {
  document.body.innerHTML = html;
  return document.body.firstElementChild as T;
};
const typed = (f: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  f.value = value;
  f.focus();
  f.setSelectionRange(value.length, value.length);
};

describe("triple space", () => {
  const install = () => {
    const onTrigger = vi.fn();
    disposers.push(installTripleSpace({ onTrigger, now: () => 0, requireTrusted: false }));
    return onTrigger;
  };

  test("fires in a shadow-DOM field, whose event target is retargeted to the host", () => {
    document.body.innerHTML = "<div id='host'></div>";
    const host = document.getElementById("host")!;
    const input = document.createElement("input");
    host.attachShadow({ mode: "open" }).append(input);
    typed(input, "hello  ");
    const onTrigger = install();
    for (let i = 0; i < 3; i++) {
      const e = key(" ", { composed: true });
      // What a real browser reports: the retargeted host as e.target, the real field first in the path.
      const path = e.composedPath.bind(e);
      e.composedPath = () => [input, ...path()];
      host.dispatchEvent(e);
    }
    expect(onTrigger).toHaveBeenCalledWith(input);
  });

  test("indentation at the start of a line is typed, not a trigger", () => {
    const ta = field<HTMLTextAreaElement>("<textarea></textarea>");
    typed(ta, "Some comment\n  ");
    const onTrigger = install();
    const events = spaces(ta);
    expect(onTrigger).not.toHaveBeenCalled();
    expect(events).toEqual([true, true, true]); // dispatchEvent is true when nothing prevented it
  });

  test("a third space is still typed when nothing would be translated", () => {
    const input = field<HTMLInputElement>("<input>");
    const onTrigger = install();
    for (const value of ["  ", "123  ", "a".repeat(MAX_TEXT_LENGTH + 1) + "  "]) {
      typed(input, value);
      expect(spaces(input)).toEqual([true, true, true]);
    }
    expect(onTrigger).not.toHaveBeenCalled();
    typed(input, "hello  ");
    expect(spaces(input)).toEqual([true, true, false]); // translatable: the third one is swallowed
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });
});

describe("secret fields", () => {
  test.each(["current-password", "new-password", "one-time-code", "cc-number", "cc-csc", "section-pay CC-Exp", "username current-password"])(
    "autocomplete=%s is never a translatable field",
    (token) => {
      const input = field<HTMLInputElement>(`<input type="text" autocomplete="${token}">`);
      expect(editableField(input)).toBeUndefined();
      const ta = field<HTMLTextAreaElement>(`<textarea autocomplete="${token}"></textarea>`);
      expect(editableField(ta)).toBeUndefined();
    },
  );

  test.each(["", "off", "email", "username", "street-address"])("autocomplete=%s stays translatable", (token) => {
    expect(editableField(field<HTMLInputElement>(`<input autocomplete="${token}">`))).toBeDefined();
  });
});

describe("writing back", () => {
  const ok = { translate: async () => ({ ok: true as const, text: "Hello" }), onError: vi.fn() };

  test("does not steal focus: a field the user has left is not written to", async () => {
    document.body.innerHTML = "<input id='a'><input id='b'>";
    const [a, b] = [document.getElementById("a"), document.getElementById("b")] as HTMLInputElement[];
    typed(a!, "bonjour  ");
    const move = vi.fn(async () => {
      b!.focus();
      return { ok: true as const, text: "Hello" };
    });
    expect(await translateField(a!, { ...ok, translate: move })).toBe(false);
    expect(a!.value).toBe("bonjour  ");
    expect(document.activeElement).toBe(b);
  });

  test("a focused field is replaced", async () => {
    const a = field<HTMLInputElement>("<input>");
    typed(a, "bonjour  ");
    expect(await translateField(a, ok)).toBe(true);
    expect(a.value).toBe("Hello");
  });

  test("paragraph blocks are joined by one newline, not the blank line innerText shows", () => {
    const ce = field<HTMLElement>("<div contenteditable='true'><p>line1</p><p><br></p><p>line2</p></div>");
    expect(readField(ce)).toBe("line1\n\nline2");
  });
});
