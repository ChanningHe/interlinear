import type { TranslateResult } from "../shared/messages";
import { MAX_TEXT_LENGTH } from "../shared/messages";
import { deepActiveElement, selectionOf } from "./focus";

// Input-box translation: press Space three times quickly inside a text field to replace its
// contents with a translation.

export type Field = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

const TEXT_INPUT_TYPES = new Set(["text", "search", ""]);
const TRIPLE_SPACE_WINDOW_MS = 600;
const PRESSES = 3;
const TRAILING_SPACES = /[  ]+$/;
const HAS_LETTER = /\p{L}/u;
/** Fields holding passwords, one-time codes or card details, even when a page makes them type=text. */
const SECRET_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|cc-.+)$/;
/** Two spaces typed after nothing but a line break (or nothing) are indentation, not a request. */
const LINE_START_SPACES = /(^|\n)[  ]*$/;
/** Elements that make up one line each in block editors (Quill, ProseMirror, Gmail). */
const BLOCK_TAGS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE"]);

const isTextControl = (f: Field): f is HTMLInputElement | HTMLTextAreaElement =>
  f instanceof HTMLTextAreaElement || f instanceof HTMLInputElement;

const isSecret = (el: Element) =>
  (el.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/).some((token) => SECRET_AUTOCOMPLETE.test(token));

/** A single-line or multi-line text box that is not meant to hold a secret; undefined for anything else. */
export function textControl(el: unknown): HTMLInputElement | HTMLTextAreaElement | undefined {
  if (el instanceof HTMLTextAreaElement) return isSecret(el) ? undefined : el;
  if (!(el instanceof HTMLInputElement)) return undefined;
  return TEXT_INPUT_TYPES.has(el.getAttribute("type")?.toLowerCase() ?? "") && !isSecret(el) ? el : undefined;
}

/** The editable field an event targets. Secrets, read-only and disabled fields never qualify. */
export function editableField(target: EventTarget | null): Field | undefined {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const control = textControl(target);
    return control && !control.readOnly && !control.disabled ? control : undefined;
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
  if (isTextControl(f)) return f.value;
  const blocks = [...f.children] as HTMLElement[];
  // One block per line: innerText would put a blank line between <p>s that writing back turns into extra paragraphs.
  if (blocks.length > 1 && blocks.length === f.childNodes.length && blocks.every((b) => BLOCK_TAGS.has(b.tagName))) {
    return blocks.map((b) => b.innerText.replace(/\n$/, "")).join("\n");
  }
  return f.innerText ?? f.textContent ?? "";
}

/** What to translate: the text without the spaces just typed; undefined when it is not worth sending. */
export function sourceText(f: Field): string | undefined {
  const source = readField(f).replace(TRAILING_SPACES, "");
  return HAS_LETTER.test(source) && source.length <= MAX_TEXT_LENGTH ? source : undefined;
}

function textBeforeCaret(f: Field, doc: Document): string {
  if (isTextControl(f)) return f.value.slice(0, f.selectionStart ?? f.value.length);
  const sel = selectionOf(f, doc);
  if (!sel || sel.rangeCount === 0 || !f.contains(sel.focusNode)) return readField(f);
  const range = sel.getRangeAt(0).cloneRange();
  range.setStart(f, 0);
  return range.toString();
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
    const sel = selectionOf(f, doc);
    sel?.removeAllRanges();
    sel?.addRange(range);
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
    // The listener sits on the document, so inside a shadow root e.target is only the host.
    const target = plainSpace && (e.isTrusted || !requireTrusted) ? editableField(e.composedPath()[0] ?? e.target) : undefined;
    if (!target) {
      presses = [];
      return;
    }
    const t = now();
    presses = target === field ? [...presses.filter((p) => t - p <= TRIPLE_SPACE_WINDOW_MS), t] : [t];
    field = target;
    if (presses.length < PRESSES) return;
    presses = [];
    // Indentation and fields with nothing to translate keep their space.
    if (!sourceText(target) || LINE_START_SPACES.test(textBeforeCaret(target, doc))) return;
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
 * the user keeps typing or leaves the field while the request runs, nothing is overwritten.
 */
export async function translateField(f: Field, deps: FieldTranslation): Promise<boolean> {
  const source = sourceText(f);
  if (source === undefined) return false;
  const before = readField(f);
  const result = await deps.translate(source);
  if (readField(f) !== before) return false;
  if (!result.ok) {
    deps.onError(result.error);
    return false;
  }
  // The user moved on to another field: writing would pull focus back and capture their typing.
  if (deepActiveElement(deps.doc) !== f) return false;
  writeField(f, result.text, deps.doc);
  return true;
}
