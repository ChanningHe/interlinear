import type { ChoiceField, OptionField, OptionValue, ProviderOptions } from "../providers/adapters";
import type { ModelInfo } from "../providers/models";
import { h } from "../shared/h";
import type { Translate } from "../shared/i18n";
import { segmented, selectInput, switchInput } from "../shared/ui";

// Renders an adapter's option schema. Values come back through onChange; nothing here knows
// which service it is configuring.

/** More choices than this become a dropdown instead of a segmented control. */
const MAX_SEGMENTS = 5;

/** Reasoning levels narrowed to what the chosen model accepts, when the service says (OpenRouter). */
function choicesFor(field: ChoiceField, model?: ModelInfo): ChoiceField["choices"] {
  if (field.key !== "reasoning" || !model?.reasoning) return field.choices;
  return field.choices.filter((c) => {
    if (c.value === "off") return model.reasoning !== "mandatory";
    if (c.value === "default" || !model.efforts) return true;
    return model.efforts.includes(c.value);
  });
}

function recommendation(t: Translate, field: OptionField): string | null {
  if (field.kind === "choice" && field.recommended !== undefined) {
    const choice = field.choices.find((c) => c.value === field.recommended);
    return choice ? t("recommended", { value: t(choice.label) }) : null;
  }
  if (field.kind === "switch" && field.recommended === false) return t("recommended", { value: t("levelOff") });
  return null;
}

/** Tag input for lists such as preferred providers: Enter or comma adds, × removes. */
function chips(t: Translate, values: readonly string[], placeholder: string, onChange: (v: string[]) => void): HTMLElement {
  let current = [...values];
  const box = h("span", { class: "chips" });
  const input = h("input", { type: "text", class: "chip-input", placeholder, "aria-label": placeholder });
  const draw = () => {
    box.replaceChildren(
      ...current.map((v) =>
        h(
          "span",
          { class: "chip" },
          v,
          h("button", { type: "button", title: t("remove"), "aria-label": t("removeItem", { name: v }), onClick: () => set(current.filter((x) => x !== v)) }, "×"),
        ),
      ),
      input,
    );
  };
  const set = (next: string[]) => {
    current = next;
    onChange(next);
    draw();
    input.focus();
  };
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    const value = input.value.trim().replace(/,$/, "");
    if ((e.key === "Enter" || e.key === ",") && value) {
      e.preventDefault();
      input.value = "";
      if (!current.includes(value)) set([...current, value]);
    } else if (e.key === "Backspace" && !input.value && current.length > 0) {
      set(current.slice(0, -1));
    }
  });
  draw();
  return box;
}

function control(t: Translate, field: OptionField, value: OptionValue | undefined, onChange: (v: OptionValue) => void, model?: ModelInfo): HTMLElement | null {
  const label = t(field.label);
  if (field.kind === "switch") return switchInput(value === true, onChange, label);
  if (field.kind === "list") {
    return chips(t, Array.isArray(value) ? value : [], field.placeholder ? t(field.placeholder) : "", onChange);
  }
  const choices = choicesFor(field, model).map((c) => ({ value: c.value, label: t(c.label) }));
  if (choices.length === 0) return null;
  const selected = typeof value === "string" && choices.some((c) => c.value === value) ? value : choices[0]!.value;
  if (selected !== value) onChange(selected); // the model no longer offers the stored level
  if (choices.length > MAX_SEGMENTS) return selectInput(selected, choices, onChange, { "aria-label": label });
  const seg = segmented(selected, choices, onChange, label);
  seg.classList.add("small");
  return seg;
}

function row(t: Translate, field: OptionField, options: ProviderOptions, onChange: (key: string, v: OptionValue) => void, model?: ModelInfo): HTMLElement | null {
  // A model without reasoning has nothing to configure there.
  if (field.key === "reasoning" && model?.reasoning === "none") return null;
  const ctl = control(t, field, options[field.key], (v) => onChange(field.key, v), model);
  if (!ctl) return null;
  const rec = recommendation(t, field);
  return h(
    "div",
    { class: "opt" },
    h("span", { class: "opt-title" }, t(field.label), rec ? h("span", { class: "rec" }, rec) : null),
    h("span", { class: "ctl" }, ctl),
    field.desc ? h("span", { class: "opt-desc" }, t(field.desc)) : null,
  );
}

/** Option rows; advanced ones stay behind a "More options" toggle. */
export function optionRows(
  t: Translate,
  fields: readonly OptionField[],
  options: ProviderOptions,
  onChange: (key: string, v: OptionValue) => void,
  model?: ModelInfo,
): HTMLElement {
  const basic = fields.filter((f) => !f.advanced).map((f) => row(t, f, options, onChange, model));
  const advancedFields = fields.filter((f) => f.advanced);
  const advanced = h("div", { hidden: true }, ...advancedFields.map((f) => row(t, f, options, onChange, model)));
  const toggle = h("button", { type: "button", class: "ghost more-toggle" }, t("moreOptions"));
  toggle.addEventListener("click", () => {
    advanced.hidden = !advanced.hidden;
    toggle.textContent = t(advanced.hidden ? "moreOptions" : "fewerOptions");
  });
  return h("div", {}, ...basic, ...(advancedFields.length > 0 ? [toggle, advanced] : []));
}
