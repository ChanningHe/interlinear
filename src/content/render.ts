import type { DisplayStyle } from "../core/settings";
import type { Unit } from "./dom";
import { MEDIA_TAGS, OWN_ATTR, isDropped } from "./rules";
import { deserialize, isEmojiImage, plainText } from "./serialize";

// Every translation is one <bt-tr data-bt> element inserted right after the paragraph's
// last node, inside its host. An unknown custom tag inherits the page's font but no page CSS
// targets it, and removing all [data-bt] nodes restores the page exactly.

const TAG = "bt-tr";
/** On a host whose only paragraph is translated: CSS hides the original, shows the translation. */
export const ONLY_ATTR = "data-bt-only";

/** Hiding these would take working controls away from the page. */
const CONTROLS = "input,select,textarea,button";
/** Shorter paragraphs (menu items, buttons, headings) get their translation on the same line. */
const INLINE_MAX_CHARS = 24;

export function createWrapper(unit: Unit, lang: string, style: DisplayStyle): HTMLElement {
  const el = document.createElement(TAG);
  el.setAttribute(OWN_ATTR, "");
  el.setAttribute("lang", lang);
  el.setAttribute("translate", "no");
  const layout = plainText(unit.text).length <= INLINE_MAX_CHARS ? "bt-inline" : "bt-block";
  el.className = `${layout} bt-s-${style}`;
  return el;
}

export function insertAfter(unit: Unit, wrapper: HTMLElement): void {
  const anchor = unit.nodes[unit.nodes.length - 1];
  // Inside a web component, light-DOM children are placed by their slot attribute; without
  // the same slot the translation would land in the default slot (next to the button, say).
  const slot = anchor instanceof Element ? anchor.getAttribute("slot") : null;
  if (slot) wrapper.setAttribute("slot", slot);
  anchor?.parentNode?.insertBefore(wrapper, anchor.nextSibling);
}

function setState(el: HTMLElement, state: "loading" | "done" | "error"): void {
  el.classList.remove("bt-loading", "bt-done", "bt-error");
  el.classList.add(`bt-${state}`);
  // Only a finished translation may stand in for the original text.
  if (state !== "done") showOriginal(el);
}

const isBlank = (n: Node) => n.nodeType === Node.TEXT_NODE && (n.nodeValue ?? "").trim() === "";
const isOwn = (n: Node) => n instanceof Element && n.hasAttribute(OWN_ATTR);
const isControl = (n: Node) => n instanceof Element && (isDropped(n) || n.matches(CONTROLS) || n.querySelector(CONTROLS) !== null);
const MEDIA_SELECTOR = [...MEDIA_TAGS].join(",");
/** Pictures are not carried into translations, so hiding the original would lose them (emoji excepted). */
const hasMedia = (n: Node) =>
  n instanceof Element && [n, ...n.querySelectorAll(MEDIA_SELECTOR)].some((e) => MEDIA_TAGS.has(e.localName) && !isEmojiImage(e));

/**
 * Text nodes cannot be styled individually, so the original is only hidden when the paragraph
 * is all its host contains. Anything else on the host (a nested list, a second paragraph,
 * a checkbox) would disappear with it, so those paragraphs stay bilingual.
 */
export function canHideOriginal(unit: Unit): boolean {
  const own = new Set<Node>(unit.nodes);
  const alone = [...unit.host.childNodes].every((n) => own.has(n) || isBlank(n) || isOwn(n));
  return alone && !unit.nodes.some((n) => isControl(n) || hasMedia(n));
}

/** Shows only the translation. Returns false when the paragraph must stay bilingual. */
export function hideOriginal(unit: Unit, wrapper: HTMLElement): boolean {
  if (!wrapper.classList.contains("bt-done") || wrapper.parentElement !== unit.host || !canHideOriginal(unit)) return false;
  if (unit.host.hasAttribute(ONLY_ATTR)) return true;
  // The host's font-size becomes 0. The translation keeps the size the original had, and the
  // host keeps its original margins (default margins are in em and would collapse to 0).
  const style = getComputedStyle(unit.host);
  wrapper.style.fontSize = style.fontSize;
  wrapper.style.lineHeight = style.lineHeight;
  if (unit.host instanceof HTMLElement) keepMargins(unit.host, style.marginTop, style.marginBottom);
  unit.host.setAttribute(ONLY_ATTR, "");
  return true;
}

interface SavedStyle {
  readonly attr: string | null;
  readonly cssText: string;
}

const savedStyles = new WeakMap<Element, SavedStyle>();
const MARGIN_VARS = ["--bt-mt", "--bt-mb"] as const;

function keepMargins(host: HTMLElement, top: string, bottom: string): void {
  savedStyles.set(host, { attr: host.getAttribute("style"), cssText: host.style.cssText });
  host.style.setProperty(MARGIN_VARS[0], top);
  host.style.setProperty(MARGIN_VARS[1], bottom);
}

/** Puts the host's style attribute back exactly, unless the page restyled the host meanwhile. */
export function restoreHost(host: Element): void {
  host.removeAttribute(ONLY_ATTR);
  const saved = savedStyles.get(host);
  if (!saved || !(host instanceof HTMLElement)) return;
  savedStyles.delete(host);
  MARGIN_VARS.forEach((v) => host.style.removeProperty(v));
  if (host.style.cssText !== saved.cssText) return;
  if (saved.attr === null) host.removeAttribute("style");
  else host.setAttribute("style", saved.attr);
}

/** Undoes hideOriginal for the host of this translation. */
export function showOriginal(wrapper: HTMLElement): void {
  if (wrapper.parentElement) restoreHost(wrapper.parentElement);
  wrapper.style.removeProperty("font-size");
  wrapper.style.removeProperty("line-height");
  if (wrapper.getAttribute("style") === "") wrapper.removeAttribute("style");
}

/** Removes one translation and restores its host. */
export function removeWrapper(wrapper: Element): void {
  if (wrapper instanceof HTMLElement) showOriginal(wrapper);
  wrapper.remove();
}

export function showLoading(el: HTMLElement): void {
  setState(el, "loading");
  el.removeAttribute("title");
  el.replaceChildren();
}

export function showTranslation(el: HTMLElement, unit: Unit, text: string): void {
  setState(el, "done");
  el.removeAttribute("title");
  el.replaceChildren(deserialize(text, unit.tokens));
}

export interface ErrorView {
  readonly message: string;
  readonly label: string;
  /** Page scripts can synthesize clicks; only real user clicks may spend API quota. */
  readonly requireTrustedClick: boolean;
}

export function showError(el: HTMLElement, view: ErrorView, onRetry: () => void): void {
  setState(el, "error");
  el.title = view.message;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = view.label;
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (view.requireTrustedClick && !e.isTrusted) return;
    onRetry();
  });
  el.replaceChildren(button);
}

export function removeAllTranslations(root: Element): void {
  root.querySelectorAll(`${TAG}[${OWN_ATTR}]`).forEach(removeWrapper);
  // Normally removed with each wrapper; also covers wrappers the page itself deleted.
  [root, ...root.querySelectorAll(`[${ONLY_ATTR}]`)].forEach(restoreHost);
}
