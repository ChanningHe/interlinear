import { afterEach, describe, expect, test, vi } from "vitest";
import { installHover, onlyModifier } from "../src/content/hover";
import { editableField, installTripleSpace, readField, translateField, writeField } from "../src/content/input";
import { createPopover, place } from "../src/content/popover";
import { installSelectionButton, selectedText } from "../src/content/selection";
import { contentLabels } from "../src/shared/i18n";

const labels = contentLabels("en");

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((d) => d());
  document.body.innerHTML = "";
  document.documentElement.querySelectorAll("bt-popover").forEach((n) => n.remove());
});

const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });

describe("hover translation", () => {
  test("onlyModifier requires exactly the configured key", () => {
    const none = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    expect(onlyModifier({ ...none, ctrlKey: true }, "ctrl")).toBe(true);
    expect(onlyModifier({ ...none, ctrlKey: true, shiftKey: true }, "ctrl")).toBe(false);
    expect(onlyModifier({ ...none, altKey: true, metaKey: true }, "alt")).toBe(false);
    expect(onlyModifier(none, "shift")).toBe(false);
  });

  const up = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keyup", { key: k, bubbles: true, ...init });
  const tap = (k: string, init: KeyboardEventInit = {}) => {
    document.dispatchEvent(key(k, init));
    document.dispatchEvent(up(k));
  };

  test("tapping the modifier translates the hovered element", () => {
    document.body.innerHTML = "<p id='p'>Text</p>";
    const p = document.getElementById("p")!;
    const onTarget = vi.fn();
    disposers.push(installHover({ modifier: "ctrl", onTarget, getHovered: () => p, requireTrusted: false }));
    tap("Control", { ctrlKey: true });
    tap("Alt", { altKey: true });
    expect(onTarget).toHaveBeenCalledTimes(1);
    expect(onTarget).toHaveBeenCalledWith(p);
  });

  test("the modifier used in a shortcut, a click or a zoom does not translate", () => {
    document.body.innerHTML = "<p id='p'>Text</p>";
    const onTarget = vi.fn();
    disposers.push(installHover({ modifier: "ctrl", onTarget, getHovered: () => document.body, requireTrusted: false }));
    for (const interrupt of [
      () => document.dispatchEvent(key("c", { ctrlKey: true })),
      () => document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, ctrlKey: true })),
      () => document.dispatchEvent(new WheelEvent("wheel", { bubbles: true, ctrlKey: true })),
    ]) {
      document.dispatchEvent(key("Control", { ctrlKey: true }));
      interrupt();
      document.dispatchEvent(up("Control"));
    }
    expect(onTarget).not.toHaveBeenCalled();
  });

  test("moving over paragraphs while holding the key translates each", () => {
    document.body.innerHTML = "<p id='a'>A</p><p id='b'>B</p>";
    const onTarget = vi.fn();
    disposers.push(installHover({ modifier: "alt", onTarget, getHovered: () => undefined, requireTrusted: false }));
    document.getElementById("a")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, altKey: true }));
    document.dispatchEvent(key("Alt", { altKey: true }));
    document.getElementById("a")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, altKey: true }));
    document.getElementById("b")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(onTarget.mock.calls.map(([el]) => el.id)).toEqual(["a"]);
  });

  test("synthetic events are ignored and 'off' installs nothing", () => {
    document.body.innerHTML = "<p id='p'>Text</p>";
    const onTarget = vi.fn();
    disposers.push(installHover({ modifier: "ctrl", onTarget, getHovered: () => document.body }));
    disposers.push(installHover({ modifier: "off", onTarget, requireTrusted: false }));
    tap("Control", { ctrlKey: true });
    expect(onTarget).not.toHaveBeenCalled();
  });
});

describe("input box translation", () => {
  test("only plain text fields qualify", () => {
    document.body.innerHTML = `
      <input id="text"><input id="search" type="search"><input id="pw" type="password">
      <input id="ro" readonly><textarea id="ta"></textarea><textarea id="dis" disabled></textarea>
      <div id="ce" contenteditable="true"><p id="inner">x</p></div><p id="plain">x</p>`;
    const ids = ["text", "search", "pw", "ro", "ta", "dis", "plain"];
    const qualifies = ids.map((id) => editableField(document.getElementById(id)) !== undefined);
    expect(qualifies).toEqual([true, true, false, false, true, false, false]);
  });

  test("the third quick Space triggers and is not typed", () => {
    document.body.innerHTML = "<input id='f'>";
    const f = document.getElementById("f")!;
    let t = 0;
    const onTrigger = vi.fn();
    disposers.push(installTripleSpace({ onTrigger, now: () => t, requireTrusted: false }));
    const space = () => {
      const e = key(" ");
      f.dispatchEvent(e);
      return e;
    };
    space();
    t += 200;
    space();
    t += 200;
    const third = space();
    expect(onTrigger).toHaveBeenCalledWith(f);
    expect(third.defaultPrevented).toBe(true);
  });

  test("holding Space (auto-repeat) does not trigger", () => {
    document.body.innerHTML = "<input id='f'>";
    const f = document.getElementById("f")!;
    const onTrigger = vi.fn();
    disposers.push(installTripleSpace({ onTrigger, now: () => 0, requireTrusted: false }));
    f.dispatchEvent(key(" "));
    for (let i = 0; i < 5; i++) f.dispatchEvent(key(" ", { repeat: true }));
    expect(onTrigger).not.toHaveBeenCalled();
  });

  test("slow presses, other keys and synthetic events do not trigger", () => {
    document.body.innerHTML = "<input id='f'>";
    const f = document.getElementById("f")!;
    let t = 0;
    const onTrigger = vi.fn();
    disposers.push(installTripleSpace({ onTrigger, now: () => t, requireTrusted: false }));
    f.dispatchEvent(key(" "));
    t += 700;
    f.dispatchEvent(key(" "));
    f.dispatchEvent(key("a"));
    f.dispatchEvent(key(" "));
    t += 100;
    f.dispatchEvent(key(" "));
    expect(onTrigger).not.toHaveBeenCalled();

    const strict = vi.fn();
    disposers.push(installTripleSpace({ onTrigger: strict }));
    for (let i = 0; i < 3; i++) f.dispatchEvent(key(" "));
    expect(strict).not.toHaveBeenCalled();
  });

  test("replaces the field without the typed spaces and fires input", async () => {
    document.body.innerHTML = "<textarea id='f'></textarea>";
    const f = document.getElementById("f") as HTMLTextAreaElement;
    f.value = "你好世界  ";
    const onInput = vi.fn();
    f.addEventListener("input", onInput);
    const translate = vi.fn(async () => ({ ok: true as const, text: "Hello world" }));
    expect(await translateField(f, { translate, onError: vi.fn() })).toBe(true);
    expect(translate).toHaveBeenCalledWith("你好世界");
    expect(f.value).toBe("Hello world");
    expect(onInput).toHaveBeenCalled();
  });

  test("never overwrites text the user kept typing, and reports errors", async () => {
    document.body.innerHTML = "<input id='f'>";
    const f = document.getElementById("f") as HTMLInputElement;
    f.value = "bonjour  ";
    const slow = vi.fn(async () => {
      f.value = "bonjour tout le monde";
      return { ok: true as const, text: "hello" };
    });
    expect(await translateField(f, { translate: slow, onError: vi.fn() })).toBe(false);
    expect(f.value).toBe("bonjour tout le monde");

    f.value = "bonjour  ";
    const onError = vi.fn();
    await translateField(f, { translate: async () => ({ ok: false, error: "HTTP 500" }), onError });
    expect(onError).toHaveBeenCalledWith("HTTP 500");
    expect(f.value).toBe("bonjour  ");
  });

  test("skips fields without letters", async () => {
    document.body.innerHTML = "<input id='f'>";
    const f = document.getElementById("f") as HTMLInputElement;
    f.value = "123  ";
    const translate = vi.fn();
    expect(await translateField(f, { translate, onError: vi.fn() })).toBe(false);
    expect(translate).not.toHaveBeenCalled();
  });

  test("contenteditable fields are read and written as text", () => {
    document.body.innerHTML = "<div id='ce' contenteditable='true'>Hola <b>mundo</b></div>";
    const ce = document.getElementById("ce")!;
    expect(readField(ce).trim()).toBe("Hola mundo");
    writeField(ce, "Hello <b>world</b>");
    expect(ce.innerHTML).not.toContain("<b>world</b>");
    expect(readField(ce)).toContain("Hello <b>world</b>");
  });
});

describe("selection", () => {
  const select = (el: Node) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
  };

  test("selectedText trims, requires a letter and is bounded", () => {
    document.body.innerHTML = "<p id='p'>  Hello there  </p><p id='n'>12345</p>";
    select(document.getElementById("p")!);
    expect(selectedText()).toBe("Hello there");
    select(document.getElementById("n")!);
    expect(selectedText()).toBeUndefined();
  });

  test("a mouse selection shows the button; clicking it translates", async () => {
    document.body.innerHTML = "<p id='p'>Select me please</p>";
    const popover = createPopover(labels, { shadowMode: "open", requireTrustedClick: false });
    disposers.push(() => popover.destroy());
    const onTranslate = vi.fn();
    disposers.push(installSelectionButton({ popover, onTranslate, requireTrusted: false }));
    select(document.getElementById("p")!);
    document.getElementById("p")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    const host = await vi.waitFor(() => {
      const h = document.querySelector("bt-popover");
      expect(h).not.toBeNull();
      return h!;
    });
    host.shadowRoot!.querySelector<HTMLButtonElement>(".trigger")!.click();
    expect(onTranslate).toHaveBeenCalledWith("Select me please", expect.anything());
  });
});

describe("popover", () => {
  const anchor = new DOMRect(10, 10, 50, 20);

  test("place flips above the anchor near the bottom and stays inside the viewport", () => {
    const view = { width: 800, height: 600 };
    expect(place(new DOMRect(100, 100, 10, 20), 200, 50, view)).toEqual({ left: 100, top: 128 });
    expect(place(new DOMRect(750, 560, 10, 20), 200, 50, view)).toEqual({ left: 592, top: 502 });
  });

  test("renders loading, text and error states; Close and Escape hide it", () => {
    const popover = createPopover(labels, { shadowMode: "open", requireTrustedClick: false });
    disposers.push(() => popover.destroy());
    popover.showResult(anchor, { state: "loading" });
    const host = document.querySelector("bt-popover")!;
    expect(host.hasAttribute("data-bt")).toBe(true);
    expect(host.shadowRoot!.textContent).toContain("Translating…");

    popover.showResult(anchor, { state: "text", text: "<b>你好</b>" });
    expect(host.shadowRoot!.querySelector(".text")!.textContent).toBe("<b>你好</b>");
    expect(host.shadowRoot!.querySelector("b")).toBeNull();
    expect(popover.isShowingResult()).toBe(true);

    const close = [...host.shadowRoot!.querySelectorAll("button")].find((b) => b.textContent === "Close")!;
    close.click();
    expect(document.querySelector("bt-popover")).toBeNull();

    popover.showResult(anchor, { state: "error", message: "HTTP 500" });
    expect(document.querySelector("bt-popover")!.shadowRoot!.querySelector(".error")!.textContent).toBe("HTTP 500");
    document.dispatchEvent(key("Escape"));
    expect(popover.isShowingResult()).toBe(false);
  });

  test("a click elsewhere on the page hides it", () => {
    const popover = createPopover(labels, { shadowMode: "open" });
    disposers.push(() => popover.destroy());
    popover.showResult(anchor, { state: "text", text: "hi" });
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector("bt-popover")).toBeNull();
  });

  test("production popovers use a closed shadow root and ignore synthetic clicks", () => {
    const popover = createPopover(labels);
    disposers.push(() => popover.destroy());
    const onClick = vi.fn();
    popover.showButton(anchor, onClick);
    const host = document.querySelector("bt-popover")!;
    expect(host.shadowRoot).toBeNull();
    host.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
