import type { ContentLabels } from "../shared/i18n";
import { OWN_ATTR } from "./rules";

// Floating UI for selection and input-box translation. It lives in a closed shadow root:
// page CSS cannot restyle it and page scripts get no reference to anything inside it.

export type PopoverContent =
  | { readonly state: "loading" }
  | { readonly state: "text"; readonly text: string }
  | { readonly state: "error"; readonly message: string };

export interface Popover {
  /** Small "translate" button next to a selection. Only real clicks reach `onClick`. */
  showButton(anchor: DOMRect, onClick: () => void): void;
  showResult(anchor: DOMRect, content: PopoverContent): void;
  hide(): void;
  isShowingResult(): boolean;
  /** True when the event happened inside the popover (its host is the target seen by the page). */
  owns(e: Event): boolean;
  destroy(): void;
}

export interface PopoverOptions {
  readonly doc?: Document;
  /** Tests need to look inside and cannot produce trusted clicks; production uses the defaults. */
  readonly shadowMode?: ShadowRootMode;
  readonly requireTrustedClick?: boolean;
}

const MARGIN = 8;
const MAX_WIDTH = 420;

const CSS = `
:host { all: initial; }
.box { position: fixed; z-index: 2147483647; font: 14px/1.5 system-ui, sans-serif; color: #111827; }
.panel { max-width: ${MAX_WIDTH}px; max-height: 50vh; overflow: auto; background: #fff; border: 1px solid #e5e7eb;
  border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.15); padding: 10px 12px; }
.text { white-space: pre-wrap; word-break: break-word; }
.error { color: #dc2626; }
.actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
button { font: inherit; font-size: 12px; cursor: pointer; border: 1px solid #d1d5db; border-radius: 6px;
  background: #f9fafb; color: inherit; padding: 2px 8px; }
button:focus-visible { outline: 2px solid #2563eb; outline-offset: 1px; }
.trigger { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border-radius: 50%; background: #2563eb;
  border-color: #2563eb; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
.spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent;
  border-radius: 50%; opacity: .5; animation: spin .8s linear infinite; vertical-align: middle; margin-right: 6px; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
@media (prefers-color-scheme: dark) {
  .box { color: #e5e7eb; }
  .panel { background: #1f2937; border-color: #374151; }
  button { background: #111827; border-color: #4b5563; }
}`;

/** Puts a box of the given size next to the anchor, flipping above it and clamping to the viewport. */
export function place(anchor: DOMRect, width: number, height: number, view: { width: number; height: number }) {
  const left = Math.max(MARGIN, Math.min(anchor.left, view.width - width - MARGIN));
  const below = anchor.bottom + MARGIN;
  const top = below + height <= view.height - MARGIN ? below : Math.max(MARGIN, anchor.top - height - MARGIN);
  return { left, top };
}

function button(label: string, onClick: () => void, trusted: boolean, cls?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.isTrusted || !trusted) onClick();
  });
  return b;
}

/** "Translate" glyph that reads the same in every language (Lucide "languages", ISC). */
function translateIcon(doc: Document): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(ns, "svg");
  const attrs = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" };
  Object.entries(attrs).forEach(([k, v]) => svg.setAttribute(k, String(v)));
  for (const d of ["m5 8 6 6", "m4 14 6-6 2-3", "M2 5h12", "M7 2h1", "m22 22-5-10-5 10", "M14 18h6"]) {
    const path = doc.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function contentNodes(content: PopoverContent, close: () => void, trusted: boolean, labels: ContentLabels): Node[] {
  if (content.state === "loading") {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    return [spinner, document.createTextNode(labels.translating)];
  }
  const body = document.createElement("div");
  body.className = content.state === "error" ? "text error" : "text";
  body.textContent = content.state === "error" ? content.message : content.text;
  const actions = document.createElement("div");
  actions.className = "actions";
  if (content.state === "text") {
    const copy = button(labels.copy, () => {
      navigator.clipboard.writeText(content.text).then(
        () => (copy.textContent = labels.copied),
        () => (copy.textContent = labels.copyFailed),
      );
    }, trusted);
    actions.append(copy);
  }
  actions.append(button(labels.close, close, trusted));
  return [body, actions];
}

export function createPopover(labels: ContentLabels, opts: PopoverOptions = {}): Popover {
  const doc = opts.doc ?? document;
  const trusted = opts.requireTrustedClick ?? true;
  const host = doc.createElement("bt-popover");
  host.setAttribute(OWN_ATTR, "");
  host.setAttribute("translate", "no");
  const shadow = host.attachShadow({ mode: opts.shadowMode ?? "closed" });
  const style = doc.createElement("style");
  style.textContent = CSS;
  const box = doc.createElement("div");
  box.className = "box";
  box.setAttribute("role", "dialog");
  shadow.append(style, box);
  let showingResult = false;

  const mount = (anchor: DOMRect, nodes: Node[]) => {
    if (!host.isConnected) doc.documentElement.append(host);
    box.replaceChildren(...nodes);
    const rect = box.getBoundingClientRect();
    const view = { width: doc.documentElement.clientWidth || innerWidth, height: innerHeight };
    const { left, top } = place(anchor, rect.width || MAX_WIDTH, rect.height || 40, view);
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
  };

  const hide = () => {
    showingResult = false;
    box.replaceChildren();
    host.remove();
  };

  const owns = (e: Event) => e.composedPath().includes(host);
  const onPointerDown = (e: Event) => {
    if (host.isConnected && !owns(e)) hide();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && host.isConnected) hide();
  };
  doc.addEventListener("mousedown", onPointerDown, true);
  doc.addEventListener("keydown", onKeyDown, true);

  return {
    showButton(anchor, onClick) {
      showingResult = false;
      const trigger = button("", onClick, trusted, "trigger");
      trigger.append(translateIcon(doc));
      trigger.title = labels.translateSelection;
      trigger.setAttribute("aria-label", labels.translateSelection);
      mount(anchor, [trigger]);
    },
    showResult(anchor, content) {
      showingResult = true;
      const panel = doc.createElement("div");
      panel.className = "panel";
      panel.setAttribute("aria-live", "polite");
      panel.append(...contentNodes(content, hide, trusted, labels));
      mount(anchor, [panel]);
    },
    hide,
    isShowingResult: () => showingResult && host.isConnected,
    owns,
    destroy() {
      hide();
      doc.removeEventListener("mousedown", onPointerDown, true);
      doc.removeEventListener("keydown", onKeyDown, true);
    },
  };
}
