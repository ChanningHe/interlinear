import {
  loadSettings,
  originPattern,
  revokeUnusedOrigins,
  saveSettings,
  siteOrigin,
  type DisplayMode,
  type Settings,
} from "../core/settings";
import { h } from "../shared/h";
import { createT, languageLabel, resolveUiLanguage, type Translate, type UiLanguage } from "../shared/i18n";
import { LANGUAGES } from "../shared/languages";
import { HOVER_COMMAND, MODE_COMMAND, TOGGLE_COMMAND, type BackgroundRequest, type TabState } from "../shared/messages";
import { ICONS, group, icon, segmented, selectInput, settingRow, showStatus, switchInput } from "../shared/ui";

const app = document.getElementById("app")!;
const settingsButton = document.getElementById("settings")!;
settingsButton.append(icon(ICONS.settings, 16));
settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());

/** Set once settings are loaded; English until then (only used for a load failure). */
let t: Translate = createT("en");

function applyLanguage(ui: UiLanguage): void {
  t = createT(ui);
  document.documentElement.lang = ui;
  settingsButton.title = t("settings");
  settingsButton.setAttribute("aria-label", t("openSettings"));
}

interface ActiveTab {
  readonly id: number | undefined;
  /** http(s) origin of the page; undefined for browser pages, files and the like. */
  readonly origin: string | undefined;
}

function send<T>(msg: BackgroundRequest): Promise<T> {
  return chrome.runtime.sendMessage<BackgroundRequest, T>(msg);
}

/** Shortcuts the browser actually assigned; a command whose default key was taken has none. */
async function shortcuts(): Promise<ReadonlyMap<string, string>> {
  const commands = await chrome.commands.getAll().catch(() => []);
  return new Map(commands.map((c) => [c.name ?? "", c.shortcut ?? ""]));
}

function hints(keys: ReadonlyMap<string, string>): HTMLElement | null {
  const items = [
    [MODE_COMMAND, t("hintMode")],
    [HOVER_COMMAND, t("hintHover")],
  ].filter(([name]) => keys.get(name!));
  if (items.length === 0) return null;
  return h("div", { class: "hints" }, ...items.map(([name, label]) => h("span", {}, h("kbd", {}, keys.get(name!)!), label!)));
}

function renderUnconfigured(): void {
  app.replaceChildren(
    h(
      "div",
      { class: "group empty" },
      h("p", {}, t("unconfigured")),
      h("button", { class: "primary", id: "toggle", onClick: () => chrome.runtime.openOptionsPage() }, t("openSettings")),
    ),
  );
}

async function render(initial: Settings, tab: ActiveTab): Promise<void> {
  const ui = resolveUiLanguage(initial.uiLanguage, chrome.i18n.getUILanguage());
  applyLanguage(ui);
  if (initial.providers.length === 0) return renderUnconfigured();

  let settings = initial;
  const tabId = tab.id;
  const [state, keys] = await Promise.all([
    tabId === undefined ? Promise.resolve<TabState>({ active: false }) : send<TabState>({ type: "tab-state", tabId }),
    shortcuts(),
  ]);
  const status = h("div", { class: "status", role: "status" });
  const toggleKey = keys.get(TOGGLE_COMMAND);
  const toggle = h(
    "button",
    { class: state.active ? "primary active" : "primary", id: "toggle", disabled: tabId === undefined },
    h("span", {}, state.active ? t("showOriginal") : t("translatePage")),
    toggleKey ? h("kbd", {}, toggleKey) : null,
  );

  const toggleTab = async (): Promise<boolean> => {
    if (tabId === undefined) return false;
    const res = await send<TabState & { error?: string }>({ type: "toggle-tab", tabId }).catch((e: unknown) => ({
      active: state.active,
      error: String(e),
    }));
    if (res.error) showStatus(status, res.error, "error");
    return !res.error;
  };

  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    if (await toggleTab()) return window.close();
    toggle.disabled = false;
  });

  const update = async (patch: Partial<Settings>, note = t("savedToggle")) => {
    settings = { ...settings, ...patch };
    await saveSettings(settings);
    showStatus(status, state.active ? note : t("saved"));
  };

  const translateIfIdle = async () => {
    if (!state.active) await toggleTab();
  };

  const setMode = async (mode: DisplayMode) => {
    await update({ displayMode: mode }, t("saved"));
    // Also reaches pages that are not translated right now, so a mode chosen there by shortcut
    // does not outlive this change.
    if (tabId !== undefined) await send({ type: "set-mode", tabId, mode });
  };

  const providerOptions = settings.providers.map((p) => ({ value: p.id, label: p.name }));
  const languageOptions = LANGUAGES.map((l) => ({ value: l.code, label: languageLabel(l.code, ui, l.name) }));
  const modes = [
    { value: "bilingual" as const, label: t("bilingual") },
    { value: "translation-only" as const, label: t("translationShort") },
  ];

  app.replaceChildren(
    toggle,
    group(
      settingRow(t("service"), null, selectInput(settings.activeProviderId, providerOptions, (v) => update({ activeProviderId: v }), { "aria-label": t("service") })),
      settingRow(t("translateTo"), null, selectInput(settings.targetLang, languageOptions, (v) => update({ targetLang: v }), { "aria-label": t("translateTo") })),
      settingRow(t("show"), null, segmented(settings.displayMode, modes, (v) => void setMode(v), t("show"))),
      settingRow(
        t("scope"),
        null,
        segmented(
          settings.scope,
          [
            { value: "content" as const, label: t("scopeContent") },
            { value: "page" as const, label: t("scopePage") },
          ],
          (v) => void update({ scope: v }),
          t("scope"),
        ),
      ),
    ),
    ...(tab.origin ? [group(siteToggle(tab.origin, () => settings, update, translateIfIdle, status))] : []),
    status,
    ...[hints(keys)].filter((n): n is HTMLElement => n !== null),
  );
}

/**
 * "Always translate this site". Host access for just this origin is requested here, inside the
 * click, because browsers only show the permission prompt during a user gesture.
 */
function siteToggle(
  origin: string,
  current: () => Settings,
  update: (patch: Partial<Settings>, note?: string) => Promise<void>,
  translateNow: () => Promise<void>,
  status: HTMLElement,
): HTMLElement {
  const host = new URL(origin).host;
  const control = switchInput(
    current().autoSites.includes(origin),
    (on) => {
      const granted = on ? chrome.permissions.request({ origins: [originPattern(origin)] }) : Promise.resolve(true);
      void (async () => {
        if (!(await granted)) {
          (control.querySelector("input") as HTMLInputElement).checked = false;
          return showStatus(status, t("siteDenied"), "error");
        }
        const sites = current().autoSites.filter((o) => o !== origin);
        await update({ autoSites: on ? [...sites, origin] : sites }, t("saved"));
        if (on) return translateNow();
        await revokeUnusedOrigins(current());
      })().catch((e: unknown) => showStatus(status, String(e), "error"));
    },
    t("alwaysTranslateNamed", { host }),
  );
  return settingRow(t("alwaysTranslate"), host, control);
}

async function main(): Promise<void> {
  const [settings, [tab]] = await Promise.all([loadSettings(), chrome.tabs.query({ active: true, currentWindow: true })]);
  await render(settings, { id: tab?.id, origin: tab?.url ? siteOrigin(tab.url) : undefined });
}

main().catch((e: unknown) => {
  app.replaceChildren(h("p", { class: "status error" }, t("popupLoadFailed", { error: String(e) })));
});
