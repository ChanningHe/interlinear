import { afterEach, describe, expect, test, vi } from "vitest";
import { createPopover, place } from "../src/content/popover";
import { contentLabels } from "../src/shared/i18n";

const labels = contentLabels("en");

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((d) => d());
  document.body.innerHTML = "";
  document.documentElement.querySelectorAll("bt-popover").forEach((n) => n.remove());
  vi.useRealTimers();
});

describe("popover placement", () => {
  const view = { width: 800, height: 600 };

  test("place keeps the box inside the viewport whatever the anchor", () => {
    expect(place(new DOMRect(100, 4761, 10, 20), 30, 30, view).top).toBe(562); // bottom edge minus margin
    expect(place(new DOMRect(100, -500, 10, 20), 30, 30, view).top).toBe(8); // anchor scrolled above the page
  });

  test("shows as a manual popover so it can sit above a modal dialog", () => {
    const show = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "showPopover", { value: show, configurable: true });
    disposers.push(() => Reflect.deleteProperty(HTMLElement.prototype, "showPopover"));
    const popover = createPopover(labels, { shadowMode: "open" });
    disposers.push(() => popover.destroy());
    popover.showButton(new DOMRect(10, 10, 50, 20), () => {});
    expect(document.querySelector("bt-popover")!.getAttribute("popover")).toBe("manual");
    expect(show).toHaveBeenCalledTimes(1);
  });

  test("the button goes away when the page scrolls; a result panel stays", () => {
    const popover = createPopover(labels, { shadowMode: "open", requireTrustedClick: false });
    disposers.push(() => popover.destroy());
    popover.showButton(new DOMRect(10, 10, 50, 20), () => {});
    document.dispatchEvent(new Event("scroll"));
    expect(document.querySelector("bt-popover")).toBeNull();
    popover.showResult(new DOMRect(10, 10, 50, 20), { state: "text", text: "hi" });
    document.dispatchEvent(new Event("scroll"));
    expect(document.querySelector("bt-popover")).not.toBeNull();
  });
});
