import { describe, expect, test } from "vitest";
import { shortcutFromKey } from "../src/options/shortcut";

const key = (code: string, mods: Partial<Record<"altKey" | "ctrlKey" | "metaKey" | "shiftKey", boolean>> = {}) => ({
  code,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

describe("shortcutFromKey", () => {
  test("formats modifier + letter in browser syntax", () => {
    expect(shortcutFromKey(key("KeyT", { altKey: true, shiftKey: true }), false)).toEqual({ shortcut: "Alt+Shift+T" });
    expect(shortcutFromKey(key("Digit5", { ctrlKey: true }), false)).toEqual({ shortcut: "Ctrl+5" });
    expect(shortcutFromKey(key("ArrowUp", { altKey: true }), false)).toEqual({ shortcut: "Alt+Up" });
  });

  test("uses physical key codes so macOS Option combinations work", () => {
    // Option+A types "å" on a Mac; the code is still KeyA.
    expect(shortcutFromKey(key("KeyA", { altKey: true }), true)).toEqual({ shortcut: "Alt+A" });
    expect(shortcutFromKey(key("KeyK", { metaKey: true, shiftKey: true }), true)).toEqual({ shortcut: "Command+Shift+K" });
    expect(shortcutFromKey(key("KeyK", { ctrlKey: true }), true)).toEqual({ shortcut: "MacCtrl+K" });
  });

  test("ignores bare modifier presses while recording", () => {
    expect(shortcutFromKey(key("ShiftLeft", { shiftKey: true }), false)).toEqual({ pending: true });
    expect(shortcutFromKey(key("AltRight", { altKey: true }), false)).toEqual({ pending: true });
  });

  test("rejects combinations browsers do not accept", () => {
    expect(shortcutFromKey(key("KeyT"), false)).toHaveProperty("error");
    expect(shortcutFromKey(key("KeyT", { shiftKey: true }), false)).toHaveProperty("error");
    expect(shortcutFromKey(key("KeyT", { ctrlKey: true, altKey: true, shiftKey: true }), false)).toHaveProperty("error");
    expect(shortcutFromKey(key("KeyT", { metaKey: true }), false)).toHaveProperty("error");
    expect(shortcutFromKey(key("Backquote", { altKey: true }), false)).toHaveProperty("error");
  });

  test("function keys may stand alone", () => {
    expect(shortcutFromKey(key("F8"), false)).toEqual({ shortcut: "F8" });
  });
});
