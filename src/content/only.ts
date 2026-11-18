import type { Unit } from "./dom";
import { MEDIA_TAGS, OWN_ATTR, isDropped, isMedia } from "./rules";
import { isEmojiImage } from "./serialize";

// Translation only. Text nodes cannot be styled one by one, so the host's font-size goes to 0
// (content.css), which collapses all of its own text. The elements of translated paragraphs are
// marked and hidden; every other child (a nested list, a line break, a control, a hover card)
// keeps its display and gets its type size back from values measured before hiding. Page text
// nodes are never moved, wrapped or rewritten, so frameworks that own them keep working.

/** On a host whose paragraphs show their translations only. */
export const ONLY_ATTR = "data-bt-only";
/** On an element of a translated paragraph, directly inside such a host: hidden with its text. */
export const HIDE_ATTR = "data-bt-hide";

/** Hiding these would take working controls away from the page. */
const CONTROLS = "input,select,textarea,button";
const MEDIA_SELECTOR = [...MEDIA_TAGS].join(",");
/** Never rendered, whatever their CSS: no type size to give back. */
const NON_RENDERING: ReadonlySet<string> = new Set(["script", "style", "link", "meta", "template"]);
/** An icon no larger than this (in its own em) next to text is decoration, not content. */
const DECORATIVE_MAX_EM = 1.5;

const isOwn = (n: Node): n is HTMLElement => n instanceof HTMLElement && n.hasAttribute(OWN_ATTR);
const isVisibleText = (n: Node) => n.nodeType === Node.TEXT_NODE && (n.nodeValue ?? "").trim() !== "";
const isControl = (n: Node) =>
  n instanceof Element && ((isDropped(n) && !isMedia(n)) || n.matches(CONTROLS) || n.querySelector(CONTROLS) !== null);

/** Hidden from assistive technology or marked as presentation, between `el` and `top`. */
function isSilent(el: Element, top: Element): boolean {
  if (el.localName === "img" && el.getAttribute("alt") === "") return true;
  for (let e: Element | null = el; e; e = e === top ? null : e.parentElement) {
    if (e.getAttribute("aria-hidden") === "true" || ["presentation", "none"].includes(e.getAttribute("role") ?? "")) return true;
  }
  return false;
}

/** Laid-out size, or the size its attributes ask for when it has no layout yet. */
function isSmall(el: Element): boolean {
  const max = (Number.parseFloat(getComputedStyle(el).fontSize) || 16) * DECORATIVE_MAX_EM;
  const r = el.getBoundingClientRect();
  const width = r.width || Number(el.getAttribute("width")) || 0;
  const height = r.height || Number(el.getAttribute("height")) || 0;
  return width <= max && height <= max;
}

/** Pictures are not carried into translations, so hiding one would lose it (emoji and small icons excepted). */
const hasContentMedia = (n: Node) =>
  n instanceof Element &&
  [n, ...n.querySelectorAll(MEDIA_SELECTOR)].some((e) => isMedia(e) && !isEmojiImage(e) && !(isSilent(e, n) && isSmall(e)));

/** The paragraph holds nothing its translation would lose: no controls, no pictures. */
export function canHideOriginal(unit: Unit): boolean {
  return !unit.nodes.some((n) => isControl(n) || hasContentMedia(n));
}

// ---- Styles kept on page elements, restored exactly -------------------------------------------

type StyledElement = Element & ElementCSSInlineStyle;
type Role = "host" | "kept";

const TYPE_VARS = ["--bt-fs", "--bt-lh", "--bt-ls", "--bt-ws"] as const;
const ROLE_VARS: Readonly<Record<Role, readonly string[]>> = { host: ["--bt-mt", "--bt-mb", ...TYPE_VARS], kept: TYPE_VARS };
const TYPE_PROPS = ["font-size", "line-height", "letter-spacing", "word-spacing"] as const;

interface Look {
  readonly fontSize: string;
  readonly lineHeight: string;
  readonly letterSpacing: string;
  readonly wordSpacing: string;
}

const lookOf = (s: CSSStyleDeclaration): Look => ({
  fontSize: s.fontSize,
  lineHeight: s.lineHeight,
  letterSpacing: s.letterSpacing,
  wordSpacing: s.wordSpacing,
});
const typeValues = (l: Look) => [l.fontSize, l.lineHeight, l.letterSpacing, l.wordSpacing];

interface SavedStyle {
  readonly attr: string | null;
  readonly cssText: string;
  /** An element can be a host and, inside another host, a kept child at once. */
  readonly roles: ReadonlySet<Role>;
}

const savedStyles = new WeakMap<Element, SavedStyle>();
const isStyled = (el: Element): el is StyledElement => el instanceof HTMLElement || el instanceof SVGElement;

/** Custom properties only: a page never sets ours, so taking them off leaves its own styles intact. */
function setVars(el: Element, role: Role, values: readonly string[]): void {
  if (!isStyled(el)) return;
  const saved = savedStyles.get(el);
  const roles = new Set([...(saved?.roles ?? []), role]);
  savedStyles.set(el, saved ? { ...saved, roles } : { attr: el.getAttribute("style"), cssText: el.style.cssText, roles });
  ROLE_VARS[role].forEach((name, i) => el.style.setProperty(name, values[i] ?? ""));
}

/** Puts the style attribute back exactly once no role is left, unless the page restyled it meanwhile. */
function clearVars(el: Element, role: Role): void {
  const saved = savedStyles.get(el);
  if (!saved?.roles.has(role) || !isStyled(el)) return;
  const roles = new Set([...saved.roles].filter((r) => r !== role));
  const still = new Set([...roles].flatMap((r) => ROLE_VARS[r]));
  ROLE_VARS[role].filter((name) => !still.has(name)).forEach((name) => el.style.removeProperty(name));
  if (roles.size > 0) {
    savedStyles.set(el, { ...saved, roles });
    return;
  }
  savedStyles.delete(el);
  if (el.style.cssText !== saved.cssText) return;
  // Chromium writes CSSOM changes to the attribute lazily; without this read, a style attribute
  // removed right after removeProperty comes back as style="".
  el.getAttribute("style");
  if (saved.attr === null) el.removeAttribute("style");
  else el.setAttribute("style", saved.attr);
}

/** Our own element: plain inline styles, which no page script resets. */
function setTypography(wrapper: HTMLElement, look: Look): void {
  const values = typeValues(look);
  TYPE_PROPS.forEach((prop, i) => wrapper.style.setProperty(prop, values[i] ?? ""));
}

export function clearTypography(wrapper: HTMLElement): void {
  TYPE_PROPS.forEach((prop) => wrapper.style.removeProperty(prop));
  if (wrapper.getAttribute("style") === "") wrapper.removeAttribute("style");
}

// ---- Hiding and restoring a host --------------------------------------------------------------

/** A paragraph of a host and its translation, if one is attached. */
export interface Placed {
  readonly unit: Unit;
  readonly wrapper: HTMLElement | undefined;
}

interface Plan {
  readonly look: Look;
  readonly margins: readonly [string, string];
  readonly hidden: readonly Element[];
  readonly kept: readonly { readonly el: Element; readonly look: Look }[];
  readonly wrappers: readonly HTMLElement[];
}

interface HostRecord {
  readonly hidden: readonly Element[];
  readonly kept: readonly Element[];
}

const records = new WeakMap<Element, HostRecord>();
/** Hidden hosts, so that turning off also restores those the page detached meanwhile. */
const hiddenHosts = new Set<Element>();

/**
 * What hiding would change, read while every original is shown. Undefined when some text on the
 * host has no finished translation standing in for it right there: font-size 0 would lose it.
 */
function planHide(host: Element, placed: readonly Placed[]): Plan | undefined {
  const ready = placed.filter(
    (p) => p.unit.host === host && p.wrapper?.parentElement === host && p.wrapper.classList.contains("bt-done") && canHideOriginal(p.unit),
  );
  if (ready.length === 0) return undefined;
  const covered = new Set<Node>(ready.flatMap((p) => p.unit.nodes));
  if ([...host.childNodes].some((n) => isVisibleText(n) && !covered.has(n))) return undefined;
  const hidden = [...covered].filter((n): n is Element => n instanceof Element && n.parentNode === host);
  const hiddenSet = new Set<Element>(hidden);
  const others = [...host.children].filter((c) => !hiddenSet.has(c) && !isOwn(c));
  const style = getComputedStyle(host);
  return {
    look: lookOf(style),
    margins: [style.marginTop, style.marginBottom],
    hidden,
    kept: others.filter((el) => !NON_RENDERING.has(el.localName)).map((el) => ({ el, look: lookOf(getComputedStyle(el)) })),
    wrappers: [...host.children].filter(isOwn).filter((w) => !w.classList.contains("bt-moved")),
  };
}

function applyPlan(host: Element, plan: Plan): void {
  setVars(host, "host", [...plan.margins, ...typeValues(plan.look)]);
  plan.wrappers.forEach((w) => setTypography(w, plan.look));
  plan.hidden.forEach((el) => el.setAttribute(HIDE_ATTR, ""));
  plan.kept.forEach(({ el, look }) => setVars(el, "kept", typeValues(look)));
  records.set(host, { hidden: plan.hidden, kept: plan.kept.map((k) => k.el) });
  hiddenHosts.add(host);
  host.setAttribute(ONLY_ATTR, "");
}

/**
 * Shows only the translations on `host`, or restores the host when that would lose text.
 * Called again whenever one of its translations changes or the host is rescanned.
 * Returns false when the host stays bilingual.
 */
export function hideOriginals(host: Element, placed: readonly Placed[]): boolean {
  [...hiddenHosts].filter((h) => !h.isConnected).forEach(restoreHost);
  const plan = withOriginalsShown(host, () => planHide(host, placed));
  // Restored and hidden again in one go: nothing is painted, and nothing stale is left behind.
  restoreHost(host);
  if (plan) applyPlan(host, plan);
  return plan !== undefined;
}

/** Undoes hideOriginals: every attribute and style it set, put back exactly. */
export function restoreHost(host: Element): void {
  host.removeAttribute(ONLY_ATTR);
  hiddenHosts.delete(host);
  const record = records.get(host);
  records.delete(host);
  record?.hidden.forEach((el) => el.removeAttribute(HIDE_ATTR));
  record?.kept.forEach((el) => clearVars(el, "kept"));
  clearVars(host, "host");
  [...host.children].filter(isOwn).forEach(clearTypography);
}

/** Every host hidden under `root`, and those detached from the page since. */
export function restoreAllHosts(root: Element): void {
  [...hiddenHosts, root, ...root.querySelectorAll(`[${ONLY_ATTR}]`)].forEach(restoreHost);
}

/**
 * Runs `fn` while the translation-only hosts in and around `root` show their originals, so
 * detection sees the page as the page styled it: hidden originals would otherwise read as text
 * the page removed. Every rule for HIDE_ATTR and the kept type sizes applies only inside an
 * ONLY_ATTR host, so taking that attribute off is enough. Synchronous: nothing is painted between.
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
