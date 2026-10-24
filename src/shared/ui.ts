import { h } from "./h";

// Form building blocks shared by the popup and the options page (styles in public/ui.css).

export interface Option<T extends string> {
  readonly value: T;
  readonly label: string;
}

export type StatusKind = "ok" | "error" | "muted";

export function showStatus(el: HTMLElement, text: string, kind: StatusKind = "muted"): void {
  el.className = `status ${kind}`;
  el.textContent = text;
}

export function selectInput<T extends string>(
  value: T,
  options: readonly Option<T>[],
  onChange: (v: T) => void,
  props: Record<string, unknown> = {},
): HTMLSelectElement {
  return h(
    "select",
    { onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T), ...props },
    ...options.map((o) => h("option", { value: o.value, selected: o.value === value }, o.label)),
  );
}

export function textInput(value: string, onInput: (v: string) => void, props: Record<string, unknown> = {}): HTMLInputElement {
  return h("input", { value, onInput: (e: Event) => onInput((e.target as HTMLInputElement).value), ...props });
}

export function numberInput(value: number, onInput: (v: number) => void, min: number, max: number): HTMLInputElement {
  return textInput(String(value), (v) => onInput(Number(v)), { type: "number", min, max });
}

/**
 * Password-style input with a button that reveals or hides the value. Revealing only changes
 * how this page draws it; the value never leaves extension storage either way.
 */
export function secretInput(
  value: string,
  onInput: (v: string) => void,
  labels: { readonly show: string; readonly hide: string },
  props: Record<string, unknown> = {},
): HTMLElement {
  const input = textInput(value, onInput, { ...props, type: "password", spellcheck: false, class: "secret-field" });
  const toggle = h("button", { type: "button", class: "ghost icon secret-toggle" });
  const draw = (revealed: boolean) => {
    const label = revealed ? labels.hide : labels.show;
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
    toggle.replaceChildren(icon(revealed ? ICONS.eyeOff : ICONS.eye, 16));
  };
  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    draw(reveal);
  });
  draw(false);
  return h("span", { class: "secret" }, input, toggle);
}

/** A labelled input stacked above its label text. */
export function field(label: string, input: HTMLElement, cls = ""): HTMLLabelElement {
  return h("label", { class: `field ${cls}`.trim() }, label, input);
}

/** On/off switch. `label` is announced to screen readers; the visible text lives in the row. */
export function switchInput(checked: boolean, onChange: (v: boolean) => void, label: string): HTMLLabelElement {
  const input = h("input", {
    type: "checkbox",
    role: "switch",
    checked,
    "aria-label": label,
    onChange: (e: Event) => onChange((e.target as HTMLInputElement).checked),
  });
  return h("label", { class: "switch" }, input, h("span", { "aria-hidden": "true" }));
}

let segmentedCount = 0;

/** A small set of mutually exclusive choices shown side by side. */
export function segmented<T extends string>(
  value: T,
  options: readonly Option<T>[],
  onChange: (v: T) => void,
  label: string,
): HTMLElement {
  const name = `seg-${++segmentedCount}`;
  return h(
    "div",
    { class: "segmented", role: "radiogroup", "aria-label": label },
    ...options.map((o) =>
      h(
        "label",
        {},
        h("input", { type: "radio", name, value: o.value, checked: o.value === value, onChange: () => onChange(o.value) }),
        h("span", {}, o.label),
      ),
    ),
  );
}

/** One line of a settings group: title and description on the left, the control on the right. */
export function settingRow(
  title: string,
  description: string | Node | null,
  control: Node,
  opts: { readonly stacked?: boolean } = {},
): HTMLElement {
  return h(
    "div",
    { class: opts.stacked ? "setting stacked" : "setting" },
    h(
      "div",
      { class: "setting-text" },
      h("span", { class: "setting-title" }, title),
      description ? h("span", { class: "setting-desc" }, description) : null,
    ),
    h("div", { class: "setting-control" }, control),
  );
}

/** A rounded card holding setting rows separated by hairlines. */
export function group(...children: (Node | null | false)[]): HTMLElement {
  return h("div", { class: "group" }, ...children);
}

/** Small inline SVG icon from a list of path definitions (24×24, stroked). */
export function icon(paths: readonly string[], size = 16): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(k, String(v));
  }
  for (const d of paths) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

export const ICONS = {
  settings: [
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
    "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  ],
  chevron: ["m9 18 6-6-6-6"],
  search: ["m21 21-4.3-4.3", "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z"],
  eye: [
    "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0",
    "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  ],
  eyeOff: [
    "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49",
    "M14.084 14.158a3 3 0 0 1-4.242-4.242",
    "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143",
    "m2 2 20 20",
  ],
  globe: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M3 12h18", "M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"],
  plus: ["M12 5v14", "M5 12h14"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
  shield: ["M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"],
} as const;
