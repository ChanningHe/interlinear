import type { TranslateResult } from "../shared/messages";
import { MAX_TEXT_LENGTH } from "../shared/messages";

// Input-box translation: press Space three times quickly inside a text field to replace its
// contents with a translation.

export type Field = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

const TEXT_INPUT_TYPES = new Set(["text", "search", ""]);
const TRIPLE_SPACE_WINDOW_MS = 600;
const PRESSES = 3;
const TRAILING_SPACES = /[  ]+$/;
const HAS_LETTER = /\p{L}/u;

const isTextControl = (f: Field): f is HTMLInputElement | HTMLTextAreaElement =>
  f instanceof HTMLTextAreaElement || f instanceof HTMLInputElement;

/** The editable field an event targets. Passwords, read-only and disabled fields never qualify. */
export function editableField(target: EventTarget | null): Field | undefined {
  if (target instanceof HTMLTextAreaElement) return target.readOnly || target.disabled ? undefined : target;
  if (target instanceof HTMLInputElement) {
    const usable = TEXT_INPUT_TYPES.has(target.getAttribute("type")?.toLowerCase() ?? "");
    return usable && !target.readOnly && !target.disabled ? target : undefined;
  }
  if (target instanceof HTMLElement && target.isContentEditable) {
    // The editing host, not whichever inner node the key landed on.
    let host: HTMLElement = target;
    while (host.parentElement?.isContentEditable) host = host.parentElement;
    return host;
  }
  return undefined;
}

export function readField(f: Field): string {
  return isTextControl(f) ? f.value : (f.innerText ?? f.textContent ?? "");
}

/**
 * Replaces the field's contents. insertText keeps the undo stack and fires the input events
 * frameworks listen to; the fallback sets the value through the native setter for the same reason.
 */
export function writeField(f: Field, text: string, doc: Document = document): void {
  f.focus();
  if (isTextControl(f)) {
    f.select();
  } else {
    const range = doc.createRange();
    range.selectNodeContents(f);
    doc.getSelection()?.removeAllRanges();
    doc.getSelection()?.addRange(range);
  }
  let inserted = false;
  try {
    inserted = doc.execCommand("insertText", false, text);
  } catch {
    inserted = false;
  }
  if (inserted) return;
  if (isTextControl(f)) {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(f), "value")?.set?.call(f, text);
    f.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    f.textContent = text;
  }
}

export interface TripleSpaceDeps {
  readonly onTrigger: (field: Field) => void;
  readonly doc?: Document;
  readonly now?: () => number;
  /** Tests cannot produce trusted events; production always requires them. */
  readonly requireTrusted?: boolean;
}

/** Calls onTrigger on the third quick Space in the same field (which is not typed). */
export function installTripleSpace(deps: TripleSpaceDeps): () => void {
  const doc = deps.doc ?? document;
  const now = deps.now ?? Date.now;
  const requireTrusted = deps.requireTrusted ?? true;
  let field: Field | undefined;
  let presses: readonly number[] = [];

  const onKeyDown = (e: KeyboardEvent) => {
    // Holding Space auto-repeats faster than anyone types; that is not a triple press.
    const plainSpace =
      e.key === " " && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !e.isComposing;
    const target = plainSpace && (e.isTrusted || !requireTrusted) ? editableField(e.target) : undefined;
    if (!target) {
      presses = [];
      return;
    }
    const t = now();
    presses = target === field ? [...presses.filter((p) => t - p <= TRIPLE_SPACE_WINDOW_MS), t] : [t];
    field = target;
    if (presses.length < PRESSES) return;
    presses = [];
    e.preventDefault();
    deps.onTrigger(target);
  };
  doc.addEventListener("keydown", onKeyDown, true);
  return () => doc.removeEventListener("keydown", onKeyDown, true);
}

export interface FieldTranslation {
  readonly translate: (text: string) => Promise<TranslateResult>;
  readonly onError: (message: string) => void;
  readonly doc?: Document;
}

/**
 * Translates a field in place. The two spaces already typed are not part of the text, and if
 * the user keeps typing while the request runs their edits win: nothing is overwritten.
 */
export async function translateField(f: Field, deps: FieldTranslation): Promise<boolean> {
  const before = readField(f);
  const source = before.replace(TRAILING_SPACES, "");
  if (!HAS_LETTER.test(source) || source.length > MAX_TEXT_LENGTH) return false;
  const result = await deps.translate(source);
  if (readField(f) !== before) return false;
  if (!result.ok) {
    deps.onError(result.error);
    return false;
  }
  writeField(f, result.text, deps.doc);
  return true;
}
