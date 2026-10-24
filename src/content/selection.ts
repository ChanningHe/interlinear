import { MAX_TEXT_LENGTH } from "../shared/messages";
import type { Popover } from "./popover";

// Selection translation: a small button appears next to text the user selected with the mouse.

const HAS_LETTER = /\p{L}/u;

/** Viewport rectangle of the current selection, or undefined when nothing is selected. */
export function selectionRect(sel: Selection | null = getSelection()): DOMRect | undefined {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return undefined;
  const rects = [...sel.getRangeAt(0).getClientRects()];
  return rects[rects.length - 1] ?? sel.getRangeAt(0).getBoundingClientRect();
}

/** Selected text worth translating, trimmed and length-limited; undefined otherwise. */
export function selectedText(sel: Selection | null = getSelection()): string | undefined {
  const text = sel?.toString().trim() ?? "";
  return HAS_LETTER.test(text) ? text.slice(0, MAX_TEXT_LENGTH) : undefined;
}

export interface SelectionDeps {
  readonly popover: Popover;
  readonly onTranslate: (text: string, anchor: DOMRect) => void;
  readonly doc?: Document;
  /** Tests cannot produce trusted events; production always requires them. */
  readonly requireTrusted?: boolean;
}

/** Shows the translate button after a real mouse selection. Returns a disposer. */
export function installSelectionButton(deps: SelectionDeps): () => void {
  const doc = deps.doc ?? document;
  const requireTrusted = deps.requireTrusted ?? true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onMouseUp = (e: MouseEvent) => {
    if ((requireTrusted && !e.isTrusted) || e.button !== 0 || deps.popover.owns(e)) return;
    clearTimeout(timer);
    // The selection is only final after the mouseup has been handled by the browser.
    timer = setTimeout(() => {
      const sel = doc.getSelection();
      const text = selectedText(sel);
      const anchor = selectionRect(sel);
      if (!text || !anchor || deps.popover.isShowingResult()) return;
      deps.popover.showButton(anchor, () => deps.onTranslate(text, anchor));
    }, 0);
  };
  doc.addEventListener("mouseup", onMouseUp, true);
  return () => {
    clearTimeout(timer);
    doc.removeEventListener("mouseup", onMouseUp, true);
  };
}
