// Tag classification shared by paragraph detection and inline serialization.
// Names are Element.localName (lowercase, also correct for svg/math).

/** Phrasing elements whose text is translated along with the surrounding paragraph. */
export const INLINE_TAGS: ReadonlySet<string> = new Set([
  "a", "abbr", "b", "bdi", "bdo", "cite", "data", "dfn", "del", "em", "font", "i", "ins",
  "label", "mark", "q", "s", "small", "span", "strong", "sub", "sup", "time", "u",
]);

/** Phrasing elements kept verbatim (deep-cloned) inside a translated paragraph. */
export const ATOMIC_TAGS: ReadonlySet<string> = new Set([
  "br", "wbr", "code", "kbd", "samp", "tt", "var", "math", "ruby",
]);

/**
 * Pictures and icons. They stay in the original only: a copy in the translation duplicates
 * logos and icon buttons. An image whose alt text is an emoji contributes that text instead.
 */
export const MEDIA_TAGS: ReadonlySet<string> = new Set([
  "img", "picture", "svg", "video", "audio", "canvas", "iframe", "object", "embed",
]);

/**
 * Subtrees that are never translated. Inside a paragraph they are dropped from the
 * translation (unless atomic). Form controls belong here: a cloned <input> would be
 * submitted with its form, and a cloned submit button could submit it.
 */
export const SKIP_TAGS: ReadonlySet<string> = new Set([
  "script", "style", "noscript", "template", "pre", "textarea", "select", "option", "input",
  "output", "meter", "progress", "svg", "math", "canvas", "video", "audio", "iframe", "object",
  "embed", "head",
]);

/** Elements that always end the current paragraph, whatever their CSS display. */
export const BOUNDARY_TAGS: ReadonlySet<string> = new Set(["br", "button"]);

const EDITABLE_VALUES = new Set(["", "true", "plaintext-only"]);

/** Marker attribute on every node this extension inserts. */
export const OWN_ATTR = "data-bt";

export function isNoTranslate(el: Element): boolean {
  return el.getAttribute("translate") === "no" || el.classList.contains("notranslate") || el.hasAttribute(OWN_ATTR);
}

export function isSkipped(el: Element): boolean {
  const editable = el.getAttribute("contenteditable");
  return SKIP_TAGS.has(el.localName) || isNoTranslate(el) || (editable !== null && EDITABLE_VALUES.has(editable));
}

/**
 * Removed from serialized text entirely (scripts, form controls…). Buttons are translated
 * on their own as paragraph boundaries, but must never be cloned into another translation.
 */
export function isDropped(el: Element): boolean {
  return el.localName === "button" || (SKIP_TAGS.has(el.localName) && !ATOMIC_TAGS.has(el.localName));
}

/** True when the element must be carried through translation as an opaque token. */
export function isAtomic(el: Element): boolean {
  return ATOMIC_TAGS.has(el.localName) || isNoTranslate(el);
}

// ---- Noise: content that is on the page but not meant to be read there --------------------------

/** Class names CSS frameworks use for text meant only for screen readers. */
const SR_ONLY_CLASSES: ReadonlySet<string> = new Set([
  "sr-only", "visually-hidden", "visuallyhidden", "screen-reader-text", "screen-reader-only",
  "a11y-hidden", "assistive-text", "hidden-visually", "u-hidden-visually", "element-invisible",
]);

const px = (v: string) => Number.parseFloat(v);

/**
 * Screen-reader-only text: a 1px (or far off-screen) absolutely positioned box. Translating it
 * wastes quota, and inserting a translation next to it can make it visible.
 */
export function isScreenReaderOnly(el: Element, style: CSSStyleDeclaration): boolean {
  if ([...el.classList].some((c) => SR_ONLY_CLASSES.has(c))) return true;
  // Classic image replacement and "left: -9999px" labels; carousels slide by far less.
  if (px(style.textIndent) <= -999) return true;
  if (style.position !== "absolute" && style.position !== "fixed") return false;
  if (px(style.left) <= -9999) return true;
  // A 1px box only hides text when it also clips; otherwise its children overflow visibly.
  const set = (v: string, none: string) => v !== "" && v !== none;
  const clips = style.overflow === "hidden" || set(style.clip, "auto") || set(style.clipPath, "none");
  return clips && px(style.width) <= 1 && px(style.height) <= 1;
}

/** Not visible but still taking part in layout; translating it would show text nobody sees. */
export function isInvisible(style: CSSStyleDeclaration): boolean {
  return style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0";
}

/** Shown only on hover or on demand: translating them grows tooltips and menus. */
const POPUP_SELECTOR = "[role=tooltip],[role=menu],[role=listbox],[popover]";

export function isPopup(el: Element): boolean {
  return el.matches(POPUP_SELECTOR);
}

/** Tokens of tag, id and class names that mark advertising (shreddit-ad-post, ad-slot, adsbygoogle…). */
const AD_TOKENS: ReadonlySet<string> = new Set([
  "ad", "ads", "adv", "advert", "adverts", "advertisement", "advertisements", "advertising",
  "adsbygoogle", "adslot", "adunit", "adbox", "adbanner", "adcontainer", "sponsored", "promoted", "promotedlink",
]);
const AD_SELECTOR = '[data-ad-slot],[data-ad-client],[data-google-query-id],[id^="google_ads"]';
const AD_LABEL_RE = /^(?:advertisement|sponsored|ad)$/i;

/** Page structure is never an ad, whatever its class says (<body class="ad-free">, <main class="has-ads">). */
const STRUCTURE_SELECTOR = "html,body,main,article,[role=main],[role=article]";
const HOLDS_CONTENT = "main,article,[role=main],[role=article],h1";

export function isAd(el: Element): boolean {
  const names = `${el.localName} ${el.id} ${el.getAttribute("class") ?? ""}`.toLowerCase();
  const marked =
    names.split(/[\s_:-]+/).some((t) => AD_TOKENS.has(t)) ||
    AD_LABEL_RE.test(el.getAttribute("aria-label") ?? "") ||
    el.matches(AD_SELECTOR);
  return marked && !el.matches(STRUCTURE_SELECTOR) && el.querySelector(HOLDS_CONTENT) === null;
}

/** Never translated, whatever the scope. */
export function isNoise(el: Element, style: CSSStyleDeclaration): boolean {
  return isScreenReaderOnly(el, style) || isPopup(el) || isAd(el);
}

// ---- Page chrome: skipped when only the main content is translated ------------------------------

const CHROME_ROLES: ReadonlySet<string> = new Set([
  "navigation", "banner", "contentinfo", "search", "toolbar", "menubar", "tablist",
]);
/** A button with block content or more text than this is a clickable card, not a control label. */
const MAX_BUTTON_LABEL = 60;
const CARD_CONTENT = "p,div,section,article,li,h1,h2,h3,h4,h5,h6";
const HEADING = "h1,h2,h3,h4,h5,h6,[role=heading]";

/** Short control labels; not accordion headings (<h3><button>Question?</button></h3>) or clickable cards. */
function isControlLabel(el: Element): boolean {
  if (el.closest(HEADING) !== null || el.querySelector(CARD_CONTENT) !== null) return false;
  return (el.textContent ?? "").trim().length <= MAX_BUTTON_LABEL;
}

/** Navigation, page header and footer, toolbars and control labels. */
export function isChrome(el: Element): boolean {
  const role = el.getAttribute("role");
  if (el.localName === "nav" || (role !== null && CHROME_ROLES.has(role))) return true;
  if (el.localName === "button" || role === "button") return isControlLabel(el);
  // header/footer are page landmarks only outside sectioning content (HTML-AAM). A header that
  // carries the page's title is the start of the content on pages without <article>.
  if (el.localName === "footer") return el.parentElement?.closest("article,aside,main,nav,section") == null;
  if (el.localName !== "header") return false;
  return el.parentElement?.closest("article,aside,main,nav,section") == null && el.querySelector("h1,h2") === null;
}
