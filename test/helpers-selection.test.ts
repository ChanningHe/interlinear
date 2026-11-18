import { afterEach, describe, expect, test, vi } from "vitest";
import { createPopover } from "../src/content/popover";
import { installSelectionButton, selectionRect } from "../src/content/selection";
import { contentLabels } from "../src/shared/i18n";

const labels = contentLabels("en");

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((d) => d());
  document.body.innerHTML = "";
  document.documentElement.querySelectorAll("bt-popover").forEach((n) => n.remove());
  vi.useRealTimers();
});

const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
const field = <T extends HTMLElement>(html: string) => {
  document.body.innerHTML = html;
  return document.body.firstElementChild as T;
};
describe("selection button", () => {
  const setup = () => {
    const popover = createPopover(labels, { shadowMode: "open", requireTrustedClick: false });
    const onTranslate = vi.fn();
    disposers.push(() => popover.destroy());
    disposers.push(installSelectionButton({ popover, onTranslate, requireTrusted: false }));
    return { popover, onTranslate };
  };
  const trigger = () => document.querySelector("bt-popover")?.shadowRoot?.querySelector<HTMLButtonElement>(".trigger");

  test("text selected inside a textarea gets a button next to the field", async () => {
    const ta = field<HTMLTextAreaElement>("<textarea>Select this sentence please</textarea>");
    ta.getBoundingClientRect = () => new DOMRect(10, 20, 300, 80);
    ta.focus();
    ta.setSelectionRange(7, 11);
    const { onTranslate } = setup();
    ta.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    await vi.waitFor(() => expect(trigger()).toBeTruthy());
    trigger()!.click();
    expect(onTranslate).toHaveBeenCalledWith("this", ta.getBoundingClientRect());
  });

  test("a selection inside a password or one-time-code field is never offered", async () => {
    const input = field<HTMLInputElement>("<input type='text' autocomplete='one-time-code' value='secret words'>");
    input.focus();
    input.setSelectionRange(0, 6);
    setup();
    input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(trigger()).toBeFalsy();
  });

  describe("keyboard selections", () => {
    const select = (el: Node) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
    };
    const rects = (el: Element) => {
      Range.prototype.getClientRects = function () {
        return [new DOMRect(10, 10, 100, 20)] as unknown as DOMRectList;
      };
      return el;
    };

    test("Shift+Arrow in text shows the button once the selection settles", () => {
      vi.useFakeTimers();
      const p = rects(field<HTMLElement>("<p>Keyboard selected text</p>"));
      select(p);
      setup();
      document.dispatchEvent(key("ArrowRight", { shiftKey: true }));
      expect(trigger()).toBeFalsy();
      vi.runAllTimers();
      expect(trigger()).toBeTruthy();
    });

    test("select-all on the page is noise, select-all inside a field is not", () => {
      vi.useFakeTimers();
      const ta = field<HTMLTextAreaElement>("<textarea>Some words in a box</textarea>");
      rects(ta);
      setup();
      select(document.body);
      document.body.dispatchEvent(key("a", { ctrlKey: true }));
      vi.runAllTimers();
      expect(trigger()).toBeFalsy();
      ta.focus();
      ta.select();
      ta.dispatchEvent(key("a", { ctrlKey: true }));
      vi.runAllTimers();
      expect(trigger()).toBeTruthy();
    });
  });

  test("selectionRect anchors to the last rect that is on screen, not one far below a tall paragraph", () => {
    const rect = (top: number) => new DOMRect(0, top, 100, 20);
    const sel = {
      rangeCount: 1,
      isCollapsed: false,
      getRangeAt: () => ({ getClientRects: () => [rect(-300), rect(100), rect(500), rect(4800)], getBoundingClientRect: () => rect(0) }),
    } as unknown as Selection;
    expect(selectionRect(sel, 720)).toEqual(rect(500));
  });
});
