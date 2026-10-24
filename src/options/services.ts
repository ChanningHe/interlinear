import { newProvider, type Provider } from "../core/settings";
import { ADAPTERS, adapterOf, type AdapterGroup, type AdapterSpec } from "../providers/adapters";
import { h } from "../shared/h";
import type { MessageKey } from "../shared/i18n";
import { ICONS, icon } from "../shared/ui";
import type { OptionsContext } from "./sections";
import { openServiceDrawer, type DrawerHost } from "./service-drawer";

// Translation services: a fixed-height list of the user's services, a type picker to add one,
// and the setup drawer (service-drawer.ts) to configure it. Changes here are saved at once.

const GROUPS: readonly [AdapterGroup, MessageKey][] = [
  ["subscription", "groupSubscription"],
  ["api", "groupApi"],
  ["local", "groupLocal"],
  ["custom", "groupCustom"],
];

/** Requests host access. Must be called synchronously inside a click handler. */
export function requestAccess(origins: readonly string[]): Promise<boolean> {
  return origins.length === 0 ? Promise.resolve(true) : chrome.permissions.request({ origins: [...origins] });
}

/** "OpenRouter", then "OpenRouter 2", "OpenRouter 3"… so new services are told apart. */
function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}

function drawerHost(ctx: OptionsContext): DrawerHost {
  return {
    t: ctx.t,
    save(p: Provider, activate: boolean) {
      ctx.persistServices((s) => {
        const exists = s.providers.some((x) => x.id === p.id);
        const providers = exists ? s.providers.map((x) => (x.id === p.id ? p : x)) : [...s.providers, p];
        return { providers, activeProviderId: activate || !s.activeProviderId ? p.id : s.activeProviderId };
      });
    },
    tidy: () => ctx.tidy(),
  };
}

const logo = (spec: AdapterSpec, title: string) => h("span", { class: `logo l-${spec.id}`, title, "aria-hidden": "true" }, spec.mark);

/**
 * One row of the list. The whole left part is a radio label: services are a single choice, so the
 * active one is picked like a radio button instead of with a "Use" button on every other row.
 */
function serviceRow(ctx: OptionsContext, p: Provider): HTMLElement {
  const { t } = ctx;
  const spec = adapterOf(p.adapter);
  const remove = () =>
    ctx.persistServices((s) => {
      const providers = s.providers.filter((x) => x.id !== p.id);
      return { providers, activeProviderId: s.activeProviderId === p.id ? (providers[0]?.id ?? "") : s.activeProviderId };
    });
  const radio = h("input", { type: "radio", name: "active-service", id: `svc-${p.id}`, value: p.id, checked: p.id === ctx.draft.activeProviderId });
  radio.addEventListener("change", () => ctx.persistServices((s) => ({ providers: s.providers, activeProviderId: p.id })));
  return h(
    "div",
    { class: "svc provider" },
    h(
      "label",
      { class: "svc-pick" },
      radio,
      logo(spec, t(spec.label)),
      h("span", { class: "svc-text" }, h("span", { class: "svc-name" }, p.name), h("span", { class: "svc-meta" }, p.model || t("noModel"))),
    ),
    h(
      "div",
      { class: "svc-actions" },
      h("button", { onClick: () => openServiceDrawer(drawerHost(ctx), p, { isNew: false }) }, t("edit")),
      h(
        "details",
        { class: "menu" },
        h("summary", { class: "button ghost icon", title: t("more"), "aria-label": t("more") }, "⋯"),
        h("div", { class: "menu-items" }, h("button", { class: "danger", onClick: remove }, t("remove"))),
      ),
    ),
  );
}

/** The type picker: only icons and names, grouped by how the service is paid for. */
function openPicker(ctx: OptionsContext): void {
  const { t } = ctx;
  const dialog = h("dialog", { class: "sheet picker", "aria-label": t("pickerTitle") });
  const choose = (spec: AdapterSpec) => {
    dialog.close();
    const name = uniqueName(t(spec.label), ctx.draft.providers.map((p) => p.name));
    openServiceDrawer(drawerHost(ctx), newProvider(spec.id, name), { isNew: true });
  };
  const groups = h("div", { style: "display: grid; gap: 18px" });
  const draw = (query: string) => {
    const q = query.trim().toLowerCase();
    const matches = (spec: AdapterSpec) => !q || t(spec.label).toLowerCase().includes(q) || spec.id.includes(q);
    groups.replaceChildren(
      ...GROUPS.flatMap(([id, title]) => {
        const specs = ADAPTERS.filter((a) => a.group === id && matches(a));
        if (specs.length === 0) return [];
        return [
          h(
            "div",
            {},
            h("div", { class: "group-title" }, t(title)),
            h("div", { class: "tiles" }, ...specs.map((s) => h("button", { class: "tile", onClick: () => choose(s) }, logo(s, t(s.label)), t(s.label)))),
          ),
        ];
      }),
    );
  };
  const search = h("input", { type: "search", placeholder: t("searchProviders"), "aria-label": t("searchProviders") });
  search.addEventListener("input", () => draw(search.value));
  dialog.append(
    h(
      "header",
      { class: "sheet-head" },
      h("h2", {}, t("pickerTitle")),
      h("button", { class: "ghost icon", title: t("close"), "aria-label": t("close"), onClick: () => dialog.close() }, "✕"),
    ),
    h("div", { class: "picker-body" }, h("label", { class: "search" }, icon(ICONS.search, 15), search), groups),
  );
  dialog.addEventListener("close", () => dialog.remove());
  draw("");
  document.body.append(dialog);
  dialog.showModal();
}

export function servicesSection(ctx: OptionsContext): Node[] {
  const { t, draft } = ctx;
  const rows = draft.providers.map((p) => serviceRow(ctx, p));
  return [
    ...(rows.length > 0 ? [h("div", { class: "group services", role: "radiogroup", "aria-label": t("activeService") }, ...rows)] : []),
    h("div", { class: "add-row" }, h("button", { class: "primary", onClick: () => openPicker(ctx) }, `＋ ${t("addService")}`)),
  ];
}
