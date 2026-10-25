import { ATOMIC_TAGS, BOUNDARY_TAGS, INLINE_TAGS, OWN_ATTR, isChrome, isNoise, isSkipped } from "./rules";
import { MAX_TEXT_LENGTH } from "../shared/messages";
import { plainText, serialize, type Tokens } from "./serialize";

/** A paragraph: consecutive inline sibling nodes under one host element. */
export interface Unit {
  readonly host: Element;
  readonly nodes: readonly Node[];
  /** Serialized text with placeholders, exactly what is sent for translation. */
  readonly text: string;
  readonly tokens: Tokens;
  /** Raw text of the nodes when collected; tells a rewrite by the page from a style change. */
  readonly source: string;
}

/** Raw text of a run of nodes, independent of styles (unlike `text`). */
export const sourceOf = (nodes: readonly Node[]) => nodes.map((n) => n.textContent ?? "").join("");

const INLINE_DISPLAYS: ReadonlySet<string> = new Set([
  "inline", "inline-block", "inline-flex", "inline-grid", "inline-table", "contents", "ruby", "ruby-text",
]);

// Descendant check is tag-based: computing styles for every descendant would be too slow.
const BLOCK_DESCENDANT =
  "address,article,aside,blockquote,details,dialog,dd,div,dl,dt,fieldset,figcaption,figure,footer," +
  "form,h1,h2,h3,h4,h5,h6,header,hgroup,hr,li,main,nav,ol,p,pre,section,table,ul";

const MIN_LETTERS = 2;
const URL_OR_EMAIL_RE = /^(?:(?:https?:\/\/|www\.)\S+|\S+@\S+\.\S+)$/i;
const LETTER_RE = /\p{L}/gu;
/** u/name, r/name, @name, #tag: names, not language. ASCII only, so "#话题讨论" stays translatable. */
const HANDLE_RE = /^(?:[ur]\/|[@#])[A-Za-z0-9_.-]+$/;
/** "6 hrs ago", "17h ago", "just now": timestamps sites print without a <time> element. */
const RELATIVE_TIME_RE =
  /^(?:\d+\s*(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|mos|months?|y|yrs?|years?)\s+ago|just now)$/i;
/** One Latin token with digits or underscores (Platform4295, COVID-19, v2.0): nothing to translate. */
const IDENTIFIER_RE = /^(?=[A-Za-z0-9_.-]*[_\d])[A-Za-z0-9_.-]+$/;

export interface CollectOptions {
  /** Main-content scope: also skip navigation, page header and footer, toolbars and buttons. */
  readonly skipChrome?: boolean;
}

const display = (el: Element) => getComputedStyle(el).display;

/** A component that places its light-DOM children through slots: their order is not the layout. */
function composesWithSlots(el: Element): boolean {
  for (const child of el.children) if (child.hasAttribute("slot")) return true;
  return false;
}

function isInline(el: Element, d = display(el)): boolean {
  if (BOUNDARY_TAGS.has(el.localName)) return false;
  const inlineBox = d ? INLINE_DISPLAYS.has(d) : INLINE_TAGS.has(el.localName) || ATOMIC_TAGS.has(el.localName);
  return inlineBox && !composesWithSlots(el) && el.querySelector(BLOCK_DESCENDANT) === null;
}

function isWhitespace(n: Node): boolean {
  return n.nodeType === Node.TEXT_NODE && (n.nodeValue ?? "").trim() === "";
}

export function isTranslatable(text: string): boolean {
  if (text.length > MAX_TEXT_LENGTH) return false;
  const plain = plainText(text);
  if ((plain.match(LETTER_RE)?.length ?? 0) < MIN_LETTERS) return false;
  return ![URL_OR_EMAIL_RE, HANDLE_RE, IDENTIFIER_RE, RELATIVE_TIME_RE].some((re) => re.test(plain));
}

/** False when every letter sits inside <time> ("17h ago"): metadata a reader does not need translated. */
function hasTextOutsideTime(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return /\p{L}/u.test(node.nodeValue ?? "");
  if (!(node instanceof Element) || node.localName === "time") return false;
  return [...node.childNodes].some(hasTextOutsideTime);
}

function makeUnit(host: Element, run: readonly Node[]): Unit | undefined {
  const start = run.findIndex((n) => !isWhitespace(n));
  if (start === -1) return undefined;
  const end = run.findLastIndex((n) => !isWhitespace(n));
  const nodes = run.slice(start, end + 1);
  if (!nodes.some(hasTextOutsideTime)) return undefined;
  const { text, tokens } = serialize(nodes);
  return isTranslatable(text) ? { host, nodes, text, tokens, source: sourceOf(nodes) } : undefined;
}

/** Elements whose whole subtree is left untranslated under these options. */
function isExcluded(el: Element, style: CSSStyleDeclaration, opts: CollectOptions): boolean {
  return isNoise(el, style) || (opts.skipChrome === true && isChrome(el));
}

function visit(container: Element, out: Unit[], opts: CollectOptions): void {
  let run: Node[] = [];
  const flush = () => {
    const unit = makeUnit(container, run);
    if (unit) out.push(unit);
    run = [];
  };
  for (const child of container.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      run.push(child);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    // Our own output is invisible to detection so re-scans see the original text unchanged.
    if (el.hasAttribute(OWN_ATTR)) continue;
    const style = getComputedStyle(el);
    if (isExcluded(el, style, opts)) {
      // An excluded block still separates the text before and after it.
      if (!isInline(el, style.display)) flush();
      continue;
    }
    // Hidden content (tabs, accordions, modals) is collected now and translated when the
    // IntersectionObserver sees it appear; it never joins the surrounding visible paragraph.
    if (style.display === "none") {
      if (!isSkipped(el)) visit(el, out, opts);
      continue;
    }
    if (isInline(el, style.display)) {
      // A web component renders each slotted child where its slot is, not next to its siblings.
      if (el.hasAttribute("slot")) flush();
      run.push(el);
      if (el.hasAttribute("slot")) flush();
      continue;
    }
    flush();
    if (!isSkipped(el)) visit(el, out, opts);
  }
  flush();
}

/** Finds every translatable paragraph under `root`, in document order. */
export function collectUnits(root: Element, opts: CollectOptions = {}): Unit[] {
  const out: Unit[] = [];
  if (!isSkipped(root) && !isExcluded(root, getComputedStyle(root), opts)) visit(root, out, opts);
  return out;
}

const MAIN_SELECTOR = "main,[role=main]";
/** A main landmark holding less of the page's text than this is a widget wrapper, not the content. */
const MIN_MAIN_SHARE = 0.25;

const NOT_READ = new Set(["script", "style", "noscript", "template"]);

/** Characters of text a reader could see, ignoring scripts and JSON blobs; no layout is forced. */
function readableLength(el: Element): number {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.nodeType === Node.ELEMENT_NODE && NOT_READ.has((n as Element).localName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  let length = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) length += (n.nodeValue ?? "").replace(/\s+/g, "").length;
  }
  return length;
}

/**
 * Where the page's own content lives: its main landmark(s) when they hold a fair share of the
 * text, otherwise the whole body (chrome is then skipped element by element).
 */
export function contentRoots(body: Element): Element[] {
  const mains = [...body.querySelectorAll(MAIN_SELECTOR)].filter(
    (m) => !m.parentElement?.closest(MAIN_SELECTOR) && display(m) !== "none",
  );
  if (mains.length === 0) return [body];
  const covered = mains.reduce((n, m) => n + readableLength(m), 0);
  return covered >= readableLength(body) * MIN_MAIN_SHARE ? mains : [body];
}

/** The element whose paragraphs must be re-collected when `node` changes. */
export function blockAncestor(node: Node): Element {
  for (let el = node instanceof Element ? node : node.parentElement; el; el = el.parentElement) {
    if (!isInline(el)) return el;
  }
  return document.body;
}

/** True when `node` sits inside a subtree left untranslated under these options. */
export function isInsideSkipped(node: Node, opts: CollectOptions = {}): boolean {
  for (let el = node instanceof Element ? node : node.parentElement; el; el = el.parentElement) {
    if (isSkipped(el) || isExcluded(el, getComputedStyle(el), opts)) return true;
  }
  return false;
}
