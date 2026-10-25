import type { HoverModifier } from "../core/settings";

// Hover translation: tap the modifier key while the mouse is over a paragraph, or hold it and
// move onto paragraphs. A key used as part of a shortcut (Ctrl+C, Ctrl+click, Ctrl+wheel zoom)
// never triggers a translation: only a "clean" press with nothing else in between counts.

const KEY_NAMES: Readonly<Record<Exclude<HoverModifier, "off">, string>> = {
  ctrl: "Control",
  alt: "Alt",
  shift: "Shift",
};

type ModifierState = Pick<MouseEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/** True when exactly the configured modifier is held (Ctrl+Shift must not trigger "ctrl"). */
export function onlyModifier(e: ModifierState, modifier: Exclude<HoverModifier, "off">): boolean {
  const held = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
  return !e.metaKey && Object.entries(held).every(([name, down]) => down === (name === modifier));
}

/**
 * Deepest element under the mouse. `:hover` is tracked by the browser even for scripts injected
 * after the mouse stopped moving, which is what the "translate paragraph" shortcut relies on.
 */
export function hoveredElement(doc: Document = document): Element | undefined {
  const chain = doc.querySelectorAll(":hover");
  return chain[chain.length - 1];
}

type TextRects = (text: Node) => ArrayLike<DOMRect>;

const LETTER_RE = /\p{L}/u;

const rangeRects: TextRects = (text) => {
  const range = (text.ownerDocument ?? document).createRange();
  range.selectNodeContents(text);
  return range.getClientRects();
};

/**
 * The topmost element at (x, y) with laid-out text of its own, looking beneath whatever lies on
 * top: feed cards are often covered by an empty link so a click anywhere opens the post, and that
 * link is what `:hover` and hit testing report. Not "the text box contains the point": the gaps
 * between lines would miss. Undefined when nothing there has text.
 */
export function textElementAt(x: number, y: number, doc: Document = document, rects: TextRects = rangeRects): Element | undefined {
  if (typeof doc.elementsFromPoint !== "function") return undefined;
  const isText = (n: Node) => n.nodeType === Node.TEXT_NODE && LETTER_RE.test(n.nodeValue ?? "") && rects(n).length > 0;
  const stack = doc.elementsFromPoint(x, y);
  const hit = stack.find((el) => [...el.childNodes].some(isText));
  if (hit) return hit;
  // Text with pointer-events: none (card content left for the overlay to click) is never hit.
  for (const el of stack) {
    if (el === doc.body || el === doc.documentElement) break;
    const found = textInside(el, x, y, isText, doc);
    if (found) return found;
  }
  return undefined;
}

/** Text nodes looked at per element when searching by position; bounds the cost of one key press. */
const MAX_TEXT_NODES = 400;

/** The smallest element under `root` that has its own text and whose box holds (x, y). */
function textInside(root: Element, x: number, y: number, isText: (n: Node) => boolean, doc: Document): Element | undefined {
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let best: Element | undefined;
  let bestArea = Infinity;
  for (let n = walker.nextNode(), seen = 0; n && seen < MAX_TEXT_NODES; n = walker.nextNode(), seen++) {
    const parent = n.parentElement;
    if (!parent || !isText(n)) continue;
    const r = parent.getBoundingClientRect();
    const area = r.width * r.height;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && area < bestArea) {
      best = parent;
      bestArea = area;
    }
  }
  return best;
}

/** Remembers where the pointer is, so "the paragraph under the mouse" can look beneath overlays. */
export function trackPointer(doc: Document = document) {
  let at: { readonly x: number; readonly y: number } | undefined;
  const onMove = (e: PointerEvent) => {
    at = { x: e.clientX, y: e.clientY };
  };
  doc.addEventListener("pointermove", onMove, { capture: true, passive: true });
  return {
    /** Text under the pointer, else the deepest hovered element (no move seen since loading). */
    target: (): Element | undefined => (at && textElementAt(at.x, at.y, doc)) ?? hoveredElement(doc),
    dispose: () => doc.removeEventListener("pointermove", onMove, true),
  };
}

export interface HoverDeps {
  readonly modifier: HoverModifier;
  readonly onTarget: (el: Element) => void;
  readonly doc?: Document;
  readonly getHovered?: () => Element | undefined;
  /** Tests cannot produce trusted events; production always requires them. */
  readonly requireTrusted?: boolean;
}

/**
 * Disposes the listeners. `cancelTap` ends the current press without translating: a browser
 * shortcut on the same modifier (Alt+Q) hides its letter from the page, so the page alone would
 * see Alt pressed and released, which is a tap.
 */
export type HoverHandle = (() => void) & { readonly cancelTap: () => void };

/** Listens for the modifier key. */
export function installHover(deps: HoverDeps): HoverHandle {
  const { modifier } = deps;
  if (modifier === "off") return Object.assign(() => {}, { cancelTap: () => {} });
  const doc = deps.doc ?? document;
  const getHovered = deps.getHovered ?? (() => hoveredElement(doc));
  const requireTrusted = deps.requireTrusted ?? true;
  const trusted = (e: Event) => e.isTrusted || !requireTrusted;
  const isModifier = (e: KeyboardEvent) => e.key === KEY_NAMES[modifier];
  /** The modifier is down and has not been combined with anything else yet. */
  let clean = false;

  const onKeyDown = (e: KeyboardEvent) => {
    if (!trusted(e) || e.repeat) return;
    clean = isModifier(e) && onlyModifier(e, modifier);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (!trusted(e) || !isModifier(e)) return;
    const tapped = clean;
    clean = false;
    const el = tapped ? getHovered() : undefined;
    if (!el) return;
    // A lone Alt also focuses the browser's menu (Windows) or shows Firefox's menu bar.
    e.preventDefault();
    deps.onTarget(el);
  };
  const breakChord = () => {
    clean = false;
  };
  // Moving onto another paragraph while holding the key translates that one too.
  const onMouseOver = (e: MouseEvent) => {
    if (!clean || !trusted(e) || !onlyModifier(e, modifier) || !(e.target instanceof Element)) return;
    deps.onTarget(textElementAt(e.clientX, e.clientY, doc) ?? e.target);
  };
  const listeners: [string, EventListener][] = [
    ["keydown", onKeyDown as EventListener],
    ["keyup", onKeyUp as EventListener],
    ["mousedown", breakChord],
    ["wheel", breakChord],
    ["blur", breakChord],
    ["mouseover", onMouseOver as EventListener],
  ];
  listeners.forEach(([type, fn]) => doc.addEventListener(type, fn, true));
  return Object.assign(() => listeners.forEach(([type, fn]) => doc.removeEventListener(type, fn, true)), { cancelTap: breakChord });
}
