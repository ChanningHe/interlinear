import {
  loadSettings,
  normalizeSettings,
  requiredOrigins,
  revokeUnusedOrigins,
  saveSettings,
  validateProvider,
  type Provider,
  type Settings,
} from "../core/settings";
import { h } from "../shared/h";
import { createT, resolveUiLanguage, type Translate, type UiLanguage } from "../shared/i18n";
import { ICONS, icon, showStatus, type StatusKind } from "../shared/ui";
import { pruneCredentials } from "../providers/chatgpt-auth";
import { SECTIONS, uiLanguageSelect, type OptionsContext } from "./sections";
import { requestAccess } from "./services";

const app = document.getElementById("app")!;
const nav = document.getElementById("nav")!;
const statusEl = document.getElementById("status")!;
const dirtyEl = document.getElementById("dirty")!;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const discardButton = document.getElementById("discard") as HTMLButtonElement;

let draft: Settings = normalizeSettings(undefined);
/** Last saved state, to tell whether the draft has unsaved changes. */
let saved = JSON.stringify(draft);

const setStatus = (text: string, kind: StatusKind = "muted") => showStatus(statusEl, text, kind);

/** Follows the draft, so picking another interface language previews it before saving. */
const uiOf = (s: Settings): UiLanguage => resolveUiLanguage(s.uiLanguage, chrome.i18n.getUILanguage());
let t: Translate = createT(uiOf(draft));

function refreshDirty(): void {
  const dirty = JSON.stringify(normalizeSettings(draft)) !== saved;
  dirtyEl.hidden = !dirty;
  discardButton.hidden = !dirty;
  if (dirty) setStatus("");
}

const ctx: OptionsContext = {
  get draft() {
    return draft;
  },
  get ui() {
    return uiOf(draft);
  },
  get t() {
    return t;
  },
  patch(patch) {
    draft = { ...draft, ...patch };
    refreshDirty();
  },
  patchAndRender(patch) {
    ctx.patch(patch);
    render();
  },
  patchProvider(id: string, patch: Partial<Provider>) {
    ctx.patch({ providers: draft.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  },
  replace(next) {
    draft = next;
    refreshDirty();
    render();
  },
  render: () => render(),
  setStatus,
  persistServices: (update) => persistServices(update),
  tidy: () => void tidy(normalizeSettings(JSON.parse(saved))).catch((e: unknown) => console.warn("[browser-translate] tidy:", e)),
};

const savedSettings = () => normalizeSettings(JSON.parse(saved));

async function tidy(s: Settings): Promise<void> {
  await revokeUnusedOrigins(s);
  await pruneCredentials(s.providers.map((p) => p.id));
}

/** Applies a services change to the saved settings and saves it now; the draft keeps other edits. */
function persistServices(update: (saved: Settings) => Pick<Settings, "providers" | "activeProviderId">): void {
  const base = savedSettings();
  const next = normalizeSettings({ ...base, ...update(base) });
  const granted = requestAccess(requiredOrigins(next)); // synchronous call keeps the user gesture
  void (async () => {
    const ok = await granted;
    await saveSettings(next);
    await tidy(next);
    draft = { ...draft, providers: next.providers, activeProviderId: next.activeProviderId };
    saved = JSON.stringify(next);
    render();
    refreshDirty();
    setStatus(ok ? t("saved") : t("savedNoAccess"), ok ? "ok" : "error");
  })().catch((e: unknown) => setStatus(t("saveFailed", { error: String(e) }), "error"));
}

function renderChrome(): void {
  const version = chrome.runtime.getManifest().version;
  document.documentElement.lang = uiOf(draft);
  nav.setAttribute("aria-label", t("navLabel"));
  nav.replaceChildren(
    h(
      "div",
      { class: "brand" },
      h("img", { src: "icons/48.png", alt: "" }),
      h("div", {}, h("h1", {}, "Browser Translate"), h("div", { class: "version" }, t("version", { version }))),
    ),
    ...SECTIONS.map((s) => h("a", { href: `#${s.id}`, "data-section": s.id }, t(s.title))),
    h("label", { class: "nav-lang", title: t("interfaceLanguage") }, icon(ICONS.globe, 15), uiLanguageSelect(ctx)),
  );
  dirtyEl.textContent = t("unsavedChanges");
  discardButton.textContent = t("discard");
  saveButton.textContent = t("save");
}

/** Highlights the nav entry of the section currently at the top of the viewport. */
const spy = new IntersectionObserver(
  (entries) => {
    const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!visible) return;
    nav.querySelectorAll("a").forEach((a) => a.classList.toggle("current", a.dataset.section === visible.target.id));
  },
  { rootMargin: "0px 0px -70% 0px" },
);

function render(): void {
  // Rebuilding replaces every node; keep keyboard focus on the same control (e.g. arrowing
  // through the service radios) by id.
  const focusedId = document.activeElement?.id;
  t = createT(uiOf(draft));
  renderChrome();
  spy.disconnect();
  const sections = SECTIONS.map((s) =>
    h(
      "section",
      { class: "section", id: s.id },
      h("header", { class: "section-head" }, h("h2", {}, t(s.title)), h("p", {}, t(s.description))),
      ...s.build(ctx),
    ),
  );
  app.replaceChildren(...sections);
  sections.forEach((s) => spy.observe(s));
  if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
}

saveButton.addEventListener("click", () => {
  const next = normalizeSettings(draft);
  const problems = next.providers.flatMap((p) => validateProvider(p).map((k) => `${p.name}: ${t(k)}`));
  if (problems.length > 0) return setStatus(problems.join(" · "), "error");
  const granted = requestAccess(requiredOrigins(next)); // synchronous call keeps the user gesture
  void (async () => {
    const ok = await granted;
    await saveSettings(next);
    await tidy(next);
    draft = next;
    saved = JSON.stringify(next);
    render();
    refreshDirty();
    setStatus(ok ? t("saved") : t("savedNoAccess"), ok ? "ok" : "error");
  })().catch((e: unknown) => setStatus(t("saveFailed", { error: String(e) }), "error"));
});

discardButton.addEventListener("click", () => {
  draft = normalizeSettings(JSON.parse(saved));
  refreshDirty();
  render();
  setStatus(t("changesDiscarded"));
});

// "⋯" menus (<details class="menu">) close on a click outside them and on Escape. One listener
// for the page: the toggle event is async and coalesced, so per-menu listeners miss reopenings.
const openMenus = () => document.querySelectorAll<HTMLDetailsElement>("details.menu[open]");
document.addEventListener("pointerdown", (e) => {
  for (const menu of openMenus()) if (!menu.contains(e.target as Node)) menu.open = false;
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const menu of openMenus()) {
    menu.open = false;
    menu.querySelector("summary")?.focus();
  }
});

renderChrome();
loadSettings()
  .then((s) => {
    draft = s;
    saved = JSON.stringify(s);
    render();
  })
  .catch((e: unknown) => setStatus(t("loadFailed", { error: String(e) }), "error"));
