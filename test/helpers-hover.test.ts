import { afterEach, describe, expect, test, vi } from "vitest";
import { installHover } from "../src/content/hover";

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((d) => d());
  document.body.innerHTML = "";
  document.documentElement.querySelectorAll("bt-popover").forEach((n) => n.remove());
  vi.useRealTimers();
});

const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });

describe("hold mode", () => {
  test("the paragraph under the pointer when the second press began is translated too", () => {
    document.body.innerHTML = "<p id='a'>A</p><p id='b'>B</p>";
    const [a, b] = [document.getElementById("a")!, document.getElementById("b")!];
    const onTarget = vi.fn();
    disposers.push(installHover({ modifier: "alt", onTarget, getHovered: () => a, requireTrusted: false }));
    const down = () => document.dispatchEvent(key("Alt", { altKey: true }));
    const up = () => document.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", bubbles: true }));
    down();
    up();
    down(); // second press, held over A
    b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, altKey: true }));
    b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, altKey: true }));
    expect(onTarget.mock.calls.map(([el]) => (el as Element).id)).toEqual(["a", "b", "b"]);
  });
});
