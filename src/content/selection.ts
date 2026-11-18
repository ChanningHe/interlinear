import { MAX_TEXT_LENGTH } from "../shared/messages";
import { deepActiveElement, selectionOf } from "./focus";
import { textControl } from "./input";
import type { Popover } from "./popover";

// Selection translation: a small button appears next to text the user selected with the mouse
// or the keyboard.

const HAS_LETTER = /\p{L}/u;
/** Keys that, with Shift held, extend a selection. */
const EXTEND_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
/** A held key repeats faster than this; the selection is final once it stops. */
const KEY_SETTLE_MS = 250;

/**
 * Viewport rectangle of the current selection, or undefined when nothing is selected. A selection
 * taller than the viewport is anchored at its last line that is on screen.
 */
export function selectionRect(sel: Selection | null = getSelection(), viewHeight: number = innerHeight): DOMRect | undefined {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return undefined;
  const rects = [...sel.getRangeAt(0).getClientRects()];
  const visible = rects.filter((r) => r.bottom > 0 && r.top < viewHeight);
  return visible[visible.length - 1] ?? rects[rects.length - 1] ?? sel.getRangeAt(0).getBoundingClientRect();
}

/** Selected text worth translating, trimmed and length-limited; undefined otherwise. */
export function selectedText(sel: Selection | null = getSelection()): string | undefined {
  const text = sel?.toString().trim() ?? "";
  return HAS_LETTER.test(text) ? text.slice(0, MAX_TEXT_LENGTH) : undefined;
}

interface Picked {
  readonly text: string;
  readonly anchor: DOMRect;
}

/**
 * What the user has selected: text inside a text box (which the page selection does not describe),
 * else the selection of the document or, when `origin` is in an open shadow root, of that root.
 */
export function pickSelection(origin: EventTarget | null | undefined, doc: Document = document): Picked | undefined {
  const control = textControl(deepActiveElement(doc));
  if (control) {
    const slice = control.value.slice(control.selectionStart ?? 0, control.selectionEnd ?? 0);
    if (HAS_LETTER.test(slice)) return { text: slice.trim().slice(0, MAX_TEXT_LENGTH), anchor: control.getBoundingClientRect() };
  }
  const sel = selectionOf(origin instanceof Node ? origin : null, doc);
  const text = selectedText(sel);
  const anchor = selectionRect(sel);
  return text && anchor ? { text, anchor } : undefined;
}

/** Select-all on a page is noise; inside a text field it selects the user's own text. */
function inEditableText(doc: Document): boolean {
  const el = deepActiveElement(doc);
  return textControl(el) !== undefined || (el instanceof HTMLElement && el.isContentEditable);
}

export interface SelectionDeps {
  readonly popover: Popover;
  readonly onTranslate: (text: string, anchor: DOMRect) => void;
  readonly doc?: Document;
  /** Tests cannot produce trusted events; production always requires them. */
  readonly requireTrusted?: boolean;
}

/** Shows the translate button after a real mouse or keyboard selection. Returns a disposer. */
export function installSelectionButton(deps: SelectionDeps): () => void {
  const doc = deps.doc ?? document;
  const requireTrusted = deps.requireTrusted ?? true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const showAfter = (delay: number, origin: EventTarget | undefined) => {
    clearTimeout(timer);
    // The selection is only final after the browser has handled the event and the user paused.
    timer = setTimeout(() => {
      const picked = pickSelection(origin, doc);
      if (!picked || deps.popover.isShowingResult()) return;
      deps.popover.showButton(picked.anchor, () => deps.onTranslate(picked.text, picked.anchor));
    }, delay);
  };
  const onMouseUp = (e: MouseEvent) => {
    if ((requireTrusted && !e.isTrusted) || e.button !== 0 || deps.popover.owns(e)) return;
    showAfter(0, e.composedPath()[0]);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (requireTrusted && !e.isTrusted) return;
    const extending = e.shiftKey && EXTEND_KEYS.has(e.key);
    const selectsAll = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && inEditableText(doc);
    if (extending || selectsAll) showAfter(KEY_SETTLE_MS, e.composedPath()[0]);
  };
  doc.addEventListener("mouseup", onMouseUp, true);
  doc.addEventListener("keydown", onKeyDown, true);
  return () => {
    clearTimeout(timer);
    doc.removeEventListener("mouseup", onMouseUp, true);
    doc.removeEventListener("keydown", onKeyDown, true);
  };
}
