import type { HoverModifier } from "../core/settings";

// Hover translation: tap the modifier key while the mouse is over a paragraph, or hold it and
// move onto paragraphs. A key used as part of a shortcut (Ctrl+C, Ctrl+click, Ctrl+wheel zoom)
// never triggers a translation: only a "clean" press with nothing else in between counts.

const KEY_NAMES: Readonly<Record<Exclude<HoverModifier, "off">, string>> = {
  ctrl: "Control",
  alt: "Alt",
  shift: "Shift",
};

type ModifierState = Pick<MouseEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/** True when exactly the configured modifier is held (Ctrl+Shift must not trigger "ctrl"). */
export function onlyModifier(e: ModifierState, modifier: Exclude<HoverModifier, "off">): boolean {
  const held = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
  return !e.metaKey && Object.entries(held).every(([name, down]) => down === (name === modifier));
}

/**
 * Deepest element under the mouse. `:hover` is tracked by the browser even for scripts injected
 * after the mouse stopped moving, which is what the "translate paragraph" shortcut relies on.
 */
export function hoveredElement(doc: Document = document): Element | undefined {
  const chain = doc.querySelectorAll(":hover");
  return chain[chain.length - 1];
}

export interface HoverDeps {
  readonly modifier: HoverModifier;
  readonly onTarget: (el: Element) => void;
  readonly doc?: Document;
  readonly getHovered?: () => Element | undefined;
  /** Tests cannot produce trusted events; production always requires them. */
  readonly requireTrusted?: boolean;
}

/** Listens for the modifier key. Returns a disposer. */
export function installHover(deps: HoverDeps): () => void {
  const { modifier } = deps;
  if (modifier === "off") return () => {};
  const doc = deps.doc ?? document;
  const getHovered = deps.getHovered ?? (() => hoveredElement(doc));
  const requireTrusted = deps.requireTrusted ?? true;
  const trusted = (e: Event) => e.isTrusted || !requireTrusted;
  const isModifier = (e: KeyboardEvent) => e.key === KEY_NAMES[modifier];
  /** The modifier is down and has not been combined with anything else yet. */
  let clean = false;

  const onKeyDown = (e: KeyboardEvent) => {
    if (!trusted(e) || e.repeat) return;
    clean = isModifier(e) && onlyModifier(e, modifier);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (!trusted(e) || !isModifier(e)) return;
    const tapped = clean;
    clean = false;
    const el = tapped ? getHovered() : undefined;
    if (el) deps.onTarget(el);
  };
  const breakChord = () => {
    clean = false;
  };
  // Moving onto another paragraph while holding the key translates that one too.
  const onMouseOver = (e: MouseEvent) => {
    if (!clean || !trusted(e) || !onlyModifier(e, modifier) || !(e.target instanceof Element)) return;
    deps.onTarget(e.target);
  };
  const listeners: [string, EventListener][] = [
    ["keydown", onKeyDown as EventListener],
    ["keyup", onKeyUp as EventListener],
    ["mousedown", breakChord],
    ["wheel", breakChord],
    ["blur", breakChord],
    ["mouseover", onMouseOver as EventListener],
  ];
  listeners.forEach(([type, fn]) => doc.addEventListener(type, fn, true));
  return () => listeners.forEach(([type, fn]) => doc.removeEventListener(type, fn, true));
}
