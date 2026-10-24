import { MEDIA_TAGS, isAtomic, isDropped, isInvisible, isNoise } from "./rules";

// Inline markup travels through the LLM as tiny placeholder tags:
//   <g1>…</g1>  a formatting element (link, bold…) whose contents get translated
//   <x2/>       an opaque element (code, image…) restored verbatim
// Model output is never parsed as HTML. Only these placeholders are recognised;
// everything else becomes text nodes, so a hostile page or model cannot inject markup.

interface Token {
  readonly kind: "g" | "x";
  readonly el: Element;
}

export type Tokens = ReadonlyMap<number, Token>;

export interface Serialized {
  readonly text: string;
  readonly tokens: Tokens;
}

const PLACEHOLDER_RE = /<(\/?)([gx])(\d+)\/?>/g;

// A deep clone of anything containing these would duplicate side effects on the page:
// form fields submitted twice, frames and media loaded again, scripts, custom element
// constructors. Such atomic elements are dropped from the translation instead.
const UNSAFE_DESCENDANTS =
  "input,button,select,textarea,form,iframe,frame,object,embed,video,audio,script,style,link,meta,base,portal";
const UNSAFE_ATTRS = new Set(["id", "name", "form", "formaction", "autofocus", "ping", "srcdoc", "tabindex"]);

const isCustomElement = (el: Element) => el.localName.includes("-");

function isSafeToDeepClone(el: Element): boolean {
  if (isCustomElement(el) || el.querySelector(UNSAFE_DESCENDANTS)) return false;
  return ![...el.querySelectorAll("*")].some(isCustomElement);
}

/** Literal placeholder look-alikes in page text must not be mistaken for real ones. */
export const escapeText = (text: string) => text.replace(PLACEHOLDER_RE, (m) => `‹${m.slice(1)}`);

/** Emoji drawn as images (Twitter, Discourse, Slack) carry the character in alt; "×" or "»" do not count. */
const EMOJI_ALT_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u200D|\uFE0F){1,16}$/u;

/** True for an image that stands for an emoji, which the translation keeps as text. */
export function isEmojiImage(el: Element): boolean {
  return el.localName === "img" && EMOJI_ALT_RE.test((el.getAttribute("alt") ?? "").trim());
}

/** Text an image contributes: its alt when that is an emoji, otherwise nothing. */
function mediaText(el: Element): string {
  return isEmojiImage(el) ? escapeText((el.getAttribute("alt") ?? "").trim()) : "";
}

/** Not part of what a reader sees: dropped from the text, never cloned into the translation. */
function isUnseen(el: Element): boolean {
  if (isDropped(el)) return true;
  const style = getComputedStyle(el);
  return style.display === "none" || isInvisible(style) || isNoise(el, style);
}

export function serialize(nodes: readonly Node[]): Serialized {
  const tokens = new Map<number, Token>();
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return escapeText(node.nodeValue ?? "");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    if (MEDIA_TAGS.has(el.localName)) return mediaText(el);
    if (isUnseen(el)) return "";
    const id = tokens.size + 1;
    if (isAtomic(el)) {
      if (!isSafeToDeepClone(el)) return "";
      tokens.set(id, { kind: "x", el });
      return `<x${id}/>`;
    }
    tokens.set(id, { kind: "g", el });
    const inner = [...el.childNodes].map(walk).join("");
    // Icon fonts and empty spacers (<i class="icon"></i>) would only be duplicated.
    if (inner.trim() === "") {
      tokens.delete(id); // nothing inside allocated an id, so ids stay dense
      return inner;
    }
    return `<g${id}>${inner}</g${id}>`;
  };
  const text = nodes.map(walk).join("").replace(/\s+/g, " ").trim();
  return { text, tokens };
}

/** Text with placeholders removed, used for length and language checks. */
export function plainText(serialized: string): string {
  return serialized.replace(PLACEHOLDER_RE, " ").replace(/\s+/g, " ").trim();
}

function stripAttributes(el: Element): void {
  for (const { name } of [...el.attributes]) {
    if (UNSAFE_ATTRS.has(name) || name.startsWith("on")) el.removeAttribute(name);
  }
}

/**
 * Copies an element for the translation without ids, inline handlers or form wiring.
 * Custom elements become plain <span>s so the page's constructors never run twice.
 */
function cleanClone(el: Element, deep: boolean): Element {
  if (!deep && isCustomElement(el)) {
    const span = document.createElement("span");
    const cls = el.getAttribute("class");
    if (cls) span.setAttribute("class", cls);
    return span;
  }
  const copy = el.cloneNode(deep) as Element;
  stripAttributes(copy);
  if (deep) copy.querySelectorAll("*").forEach(stripAttributes);
  return copy;
}

interface Frame {
  readonly id: number;
  readonly node: ParentNode;
}

export function deserialize(text: string, tokens: Tokens): DocumentFragment {
  const root = document.createDocumentFragment();
  const stack: Frame[] = [{ id: 0, node: root }];
  const used = new Set<number>();
  const top = () => stack[stack.length - 1]!.node;
  let cursor = 0;

  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    top().append(text.slice(cursor, m.index));
    cursor = m.index + m[0].length;
    const [, closing, kind, rawId] = m;
    const id = Number(rawId);
    const token = tokens.get(id);
    if (!token || token.kind !== kind) continue;

    if (closing) {
      const depth = stack.findLastIndex((f) => f.id === id);
      if (depth > 0) stack.splice(depth);
      continue;
    }
    if (used.has(id)) continue;
    used.add(id);
    if (kind === "x") {
      top().append(cleanClone(token.el, true));
    } else {
      const shell = cleanClone(token.el, false);
      top().append(shell);
      stack.push({ id, node: shell });
    }
  }
  top().append(text.slice(cursor));
  return root;
}
