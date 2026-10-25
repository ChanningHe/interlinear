import type { DisplayStyle } from "../core/settings";
import type { Unit } from "./dom";
import { MEDIA_TAGS, OWN_ATTR, isDropped, isMedia } from "./rules";
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

// ---- Translations a box would clip ------------------------------------------------------------

/** Ancestors of a translation checked for a box that cuts it off (a line-clamped preview, say). */
const MAX_CLIP_DEPTH = 4;
/** A moved translation becomes the next block in normal flow; in flex or grid it would be a new item. */
const FLOW_DISPLAYS: ReadonlySet<string> = new Set(["block", "flow-root", "list-item"]);
/** Overflow values that cut content off; auto and scroll only hide what the reader can scroll to. */
const CLIPPING: ReadonlySet<string> = new Set(["hidden", "clip"]);
const MOVED_CLASS = "bt-moved";
const CLAMP_CLASS = "bt-clamp";
const MOVED_VARS = ["--bt-fs", "--bt-lh", "--bt-clamp"] as const;

export interface Clip {
  readonly clipper: Element;
  /** The translation can sit right after the clipper: the clipper's parent lays out in normal flow. */
  readonly movable: boolean;
}

/**
 * The nearest box that hides part of this translation: it clips (overflow hidden or clip) and the
 * translation reaches past its bottom. Undefined when nothing clips it or there is no layout.
 */
export function findClip(wrapper: HTMLElement): Clip | undefined {
  const r = wrapper.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return undefined;
  let el = wrapper.parentElement;
  for (let depth = 0; el && el !== document.body && depth < MAX_CLIP_DEPTH; depth++, el = el.parentElement) {
    const style = getComputedStyle(el);
    if (!CLIPPING.has(style.overflowY || style.overflow)) continue;
    if (r.bottom <= el.getBoundingClientRect().bottom + 1) continue;
    return { clipper: el, movable: FLOW_DISPLAYS.has(layoutParentDisplay(el)) };
  }
  return undefined;
}

/** Display of the box that lays out `el`'s siblings: display:contents ancestors have none. */
function layoutParentDisplay(el: Element): string {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const display = getComputedStyle(p).display;
    if (display !== "contents") return display;
  }
  return "block";
}

/** A box clamped to a number of lines: a text preview, not a one-line control label. */
export const isLineClamped = (el: Element) => lineClamp(el) > 0;

export interface MovedLook {
  readonly fontSize: string;
  readonly lineHeight: string;
  /** Lines the clipping box shows; 0 when it is not line-clamped. */
  readonly clamp: number;
}

/** Read before any move is made, so measuring many translations needs one style pass. */
export function movedLook(clipper: Element, unit: Unit): MovedLook {
  const host = getComputedStyle(unit.host);
  return { fontSize: host.fontSize, lineHeight: host.lineHeight, clamp: lineClamp(clipper) };
}

/**
 * Moves a translation to just after the box that clips it, in the paragraph's font. A line clamp
 * on that box applies to the translation too, so a card shows N lines of each.
 */
export function moveOutOf(wrapper: HTMLElement, clipper: Element, look: MovedLook): void {
  wrapper.style.setProperty(MOVED_VARS[0], look.fontSize);
  wrapper.style.setProperty(MOVED_VARS[1], look.lineHeight);
  if (look.clamp > 0) {
    wrapper.style.setProperty(MOVED_VARS[2], String(look.clamp));
    wrapper.classList.add(CLAMP_CLASS);
  }
  wrapper.classList.add(MOVED_CLASS);
  const slot = clipper.getAttribute("slot");
  if (slot) wrapper.setAttribute("slot", slot);
  else wrapper.removeAttribute("slot");
  clipper.after(wrapper);
}

/** Lines a box is clamped to; engines that do not compute the property still expose an inline one. */
function lineClamp(el: Element): number {
  const computed = getComputedStyle(el);
  const inline = el instanceof HTMLElement ? el.style : undefined;
  const values = [computed, inline].flatMap((s) => (s ? [s.getPropertyValue("-webkit-line-clamp"), s.getPropertyValue("line-clamp")] : []));
  return values.map((v) => Number.parseInt(v, 10)).find((n) => n > 0) ?? 0;
}

export const isMoved = (wrapper: Element) => wrapper.classList.contains(MOVED_CLASS);

/** Puts a moved translation back next to its paragraph (translation-only replaces it there). */
export function moveBack(unit: Unit, wrapper: HTMLElement): void {
  wrapper.classList.remove(MOVED_CLASS, CLAMP_CLASS);
  MOVED_VARS.forEach((v) => wrapper.style.removeProperty(v));
  if (wrapper.getAttribute("style") === "") wrapper.removeAttribute("style");
  wrapper.removeAttribute("slot");
  insertAfter(unit, wrapper);
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
  n instanceof Element && [n, ...n.querySelectorAll(MEDIA_SELECTOR)].some((e) => isMedia(e) && !isEmojiImage(e));

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

/**
 * Runs `fn` while the translation-only paragraphs in and around `root` show their originals, so
 * detection sees the page as the page styled it: hidden originals would otherwise read as text
 * the page removed. Synchronous, so nothing is painted in between.
 */
export function withOriginalsShown<T>(root: Element, fn: () => T): T {
  const around: Element[] = [];
  for (let el = root.parentElement?.closest(`[${ONLY_ATTR}]`); el; el = el.parentElement?.closest(`[${ONLY_ATTR}]`)) around.push(el);
  const hosts = [...around, ...(root.hasAttribute(ONLY_ATTR) ? [root] : []), ...root.querySelectorAll(`[${ONLY_ATTR}]`)];
  hosts.forEach((h) => h.removeAttribute(ONLY_ATTR));
  try {
    return fn();
  } finally {
    hosts.forEach((h) => h.setAttribute(ONLY_ATTR, ""));
  }
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
