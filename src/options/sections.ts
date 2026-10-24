import {
  GLOSSARY_LIMITS,
  exportSettings,
  formatGlossary,
  importSettings,
  normalizeSettings,
  parseGlossary,
  siteFromInput,
  type DisplayStyle,
  type HoverModifier,
  type Provider,
  type Settings,
} from "../core/settings";
import { h } from "../shared/h";
import { UI_LANGUAGES, languageLabel, resolveUiLanguage, type MessageKey, type Translate, type UiLanguage, type UiLanguageSetting } from "../shared/i18n";
import { LANGUAGES } from "../shared/languages";
import { HOVER_COMMAND, MODE_COMMAND, TOGGLE_COMMAND, type BackgroundRequest } from "../shared/messages";
import {
  ICONS,
  group,
  icon,
  numberInput,
  segmented,
  selectInput,
  settingRow,
  showStatus,
  switchInput,
  type StatusKind,
} from "../shared/ui";
import { servicesSection } from "./services";
import { currentShortcut, editableCommands, isMacPlatform, shortcutFromKey } from "./shortcut";

/** What a section may read and change. Edits go to an unsaved draft until Save. */
export interface OptionsContext {
  readonly draft: Settings;
  /** Interface language of the draft, so switching it previews immediately. */
  readonly ui: UiLanguage;
  readonly t: Translate;
  patch(patch: Partial<Settings>): void;
  patchAndRender(patch: Partial<Settings>): void;
  patchProvider(id: string, patch: Partial<Provider>): void;
  /** Replaces the whole draft (remove, import) and re-renders. */
  replace(next: Settings): void;
  render(): void;
  setStatus(text: string, kind?: StatusKind): void;
  /**
   * Saves a change to services at once (list and drawer); call synchronously inside a click.
   * `update` gets the saved settings, so unsaved edits elsewhere on the page are neither saved
   * nor lost.
   */
  persistServices(update: (saved: Settings) => Pick<Settings, "providers" | "activeProviderId">): void;
  /** Revokes host access and sign-ins nothing saved still uses (a drawer was closed). */
  tidy(): void;
}

export interface Section {
  readonly id: string;
  readonly title: MessageKey;
  readonly description: MessageKey;
  readonly build: (ctx: OptionsContext) => Node[];
}

const STYLES: readonly { value: DisplayStyle; label: MessageKey }[] = [
  { value: "plain", label: "stylePlain" },
  { value: "underline", label: "styleUnderline" },
  { value: "dotted", label: "styleDotted" },
  { value: "wavy", label: "styleWavy" },
  { value: "highlight", label: "styleHighlight" },
  { value: "marker", label: "styleMarker" },
  { value: "background", label: "styleBackground" },
  { value: "blockquote", label: "styleBlockquote" },
  { value: "border", label: "styleBorder" },
  { value: "italic", label: "styleItalic" },
  { value: "bold", label: "styleBold" },
  { value: "muted", label: "styleMuted" },
  { value: "blur", label: "styleBlur" },
];

const MODIFIERS: readonly { value: HoverModifier; label: MessageKey }[] = [
  { value: "ctrl", label: "modCtrl" },
  { value: "alt", label: "modAlt" },
  { value: "shift", label: "modShift" },
  { value: "off", label: "modOff" },
];

/** Labels of the commands declared in scripts/build.mjs. */
const COMMAND_LABELS: Readonly<Record<string, MessageKey>> = {
  [TOGGLE_COMMAND]: "cmdToggle",
  [MODE_COMMAND]: "cmdMode",
  [HOVER_COMMAND]: "cmdHover",
};

/** Preview sentence in the target language; others fall back to the interface language. */
const SAMPLES: Readonly<Record<string, string>> = {
  "zh-Hans": "阅读文档，几分钟即可上手。",
  "zh-Hant": "閱讀文件，幾分鐘即可上手。",
  ja: "ドキュメントを読めば数分で始められます。",
  ko: "문서를 읽으면 몇 분 만에 시작할 수 있습니다.",
  fr: "Lisez la documentation pour démarrer en quelques minutes.",
  de: "Lies die Dokumentation und leg in wenigen Minuten los.",
  es: "Lee la documentación y empieza en pocos minutos.",
};
const SAMPLE_SOURCE = "Read the docs to get started in minutes.";

const translatedOptions = <T extends string>(t: Translate, list: readonly { value: T; label: MessageKey }[]) =>
  list.map((o) => ({ value: o.value, label: t(o.label) }));

/** Target languages named in the interface language ("Japanese", "日语", "日本語"…). */
const languageOptions = (ui: UiLanguage) => LANGUAGES.map((l) => ({ value: l.code, label: languageLabel(l.code, ui, l.name) }));

function send<T>(msg: BackgroundRequest): Promise<T> {
  return chrome.runtime.sendMessage<BackgroundRequest, T>(msg);
}

// ---- Translation ----------------------------------------------------------------------------

function translationSection(ctx: OptionsContext): Node[] {
  const { draft, t } = ctx;
  const prompt = h("textarea", {
    value: draft.customPrompt,
    placeholder: "You are a professional translator. Translate the user's text into {{to}} so it reads naturally to a native speaker.",
    "aria-label": t("customInstructions"),
    onInput: (e: Event) => ctx.patch({ customPrompt: (e.target as HTMLTextAreaElement).value }),
  });
  const glossary = h("textarea", {
    value: formatGlossary(draft.glossary),
    placeholder: "Kubernetes = Kubernetes\npull request = 拉取请求",
    "aria-label": t("glossary"),
    onInput: (e: Event) => ctx.patch({ glossary: parseGlossary((e.target as HTMLTextAreaElement).value) }),
  });
  return [
    group(
      settingRow(
        t("targetLanguage"),
        t("targetLanguageDesc"),
        selectInput(draft.targetLang, languageOptions(ctx.ui), (v) => ctx.patch({ targetLang: v }), { "aria-label": t("targetLanguage") }),
      ),
      settingRow(
        t("scope"),
        t("scopeDesc"),
        segmented(
          draft.scope,
          [
            { value: "content" as const, label: t("scopeContent") },
            { value: "page" as const, label: t("scopePage") },
          ],
          (v) => ctx.patch({ scope: v }),
          t("scope"),
        ),
      ),
      settingRow(t("pageContext"), t("pageContextDesc"), switchInput(draft.pageContext, (v) => ctx.patch({ pageContext: v }), t("pageContext"))),
      settingRow(t("glossary"), t("glossaryDesc", { max: GLOSSARY_LIMITS.entries }), glossary, { stacked: true }),
      settingRow(t("customInstructions"), t("customInstructionsDesc"), prompt, { stacked: true }),
    ),
  ];
}

// ---- Appearance -----------------------------------------------------------------------------

/** One clickable preview per style, rendered with the real content.css rules. */
function stylePicker(ctx: OptionsContext): HTMLElement {
  const { t } = ctx;
  const sample = SAMPLES[ctx.draft.targetLang] ?? t("styleSampleFallback");
  return h(
    "div",
    { class: "styles", role: "radiogroup", "aria-label": t("translationStyle") },
    ...STYLES.map((s) => {
      const translation = document.createElement("bt-tr");
      translation.setAttribute("data-bt", "");
      translation.className = `bt-block bt-done bt-s-${s.value}`;
      translation.textContent = sample;
      return h(
        "label",
        { class: "style-tile" },
        h("input", { type: "radio", name: "style", value: s.value, checked: ctx.draft.style === s.value, onChange: () => ctx.patch({ style: s.value }) }),
        h("span", { class: "style-sample" }, h("span", { class: "style-source" }, SAMPLE_SOURCE), translation),
        h("span", { class: "style-name" }, t(s.label)),
      );
    }),
  );
}

/** Interface language picker, shown in the sidebar so it is found from anywhere on the page. */
export function uiLanguageSelect(ctx: OptionsContext): HTMLElement {
  const { t } = ctx;
  // "Automatic (日本語)": what "auto" resolves to in this browser, whatever is selected now.
  const browserUi = resolveUiLanguage("auto", chrome.i18n.getUILanguage());
  const options: { value: UiLanguageSetting; label: string }[] = [
    { value: "auto", label: t("automatic", { language: UI_LANGUAGES.find((l) => l.value === browserUi)?.label ?? browserUi }) },
    ...UI_LANGUAGES,
  ];
  return selectInput(ctx.draft.uiLanguage, options, (v) => ctx.patchAndRender({ uiLanguage: v }), {
    id: "ui-language",
    "aria-label": t("interfaceLanguage"),
  });
}

function appearanceSection(ctx: OptionsContext): Node[] {
  const { t } = ctx;
  const modes = [
    { value: "bilingual" as const, label: t("bilingual") },
    { value: "translation-only" as const, label: t("translationOnly") },
  ];
  return [
    group(settingRow(t("show"), t("showDesc"), segmented(ctx.draft.displayMode, modes, (v) => ctx.patch({ displayMode: v }), t("show")))),
    stylePicker(ctx),
  ];
}

// ---- Hover, selection, input box --------------------------------------------------------------

function helpersSection(ctx: OptionsContext): Node[] {
  const { draft, t } = ctx;
  return [
    group(
      settingRow(
        t("hoverKey"),
        t("hoverKeyDesc"),
        selectInput(draft.hoverModifier, translatedOptions(t, MODIFIERS), (v) => ctx.patch({ hoverModifier: v }), { "aria-label": t("hoverKey") }),
      ),
      settingRow(t("selectionButton"), t("selectionButtonDesc"), switchInput(draft.selectionButton, (v) => ctx.patch({ selectionButton: v }), t("selectionButton"))),
      settingRow(t("inputTranslation"), t("inputTranslationDesc"), switchInput(draft.inputTranslation, (v) => ctx.patch({ inputTranslation: v }), t("inputTranslation"))),
      settingRow(
        t("inputTarget"),
        null,
        selectInput(draft.inputTargetLang, languageOptions(ctx.ui), (v) => ctx.patch({ inputTargetLang: v }), { "aria-label": t("inputTarget") }),
      ),
    ),
    group(settingRow(t("everywhere"), t("everywhereDesc"), switchInput(draft.everywhere, (v) => ctx.patch({ everywhere: v }), t("everywhere")))),
  ];
}

// ---- Sites ----------------------------------------------------------------------------------

/** Address box under the list: "example.com", a full URL or a host with port; stored as an origin. */
function addSiteRow(ctx: OptionsContext): HTMLElement {
  const { t } = ctx;
  const note = h("span", { class: "status" });
  const input = h("input", { type: "text", id: "site-input", class: "site-input", placeholder: "example.com", spellcheck: false, "aria-label": t("addSite") });
  const add = () => {
    const origin = siteFromInput(input.value);
    if (!origin) return showStatus(note, t("siteInvalid"), "error");
    if (ctx.draft.autoSites.includes(origin)) return showStatus(note, t("siteExists", { site: new URL(origin).host }), "error");
    ctx.patchAndRender({ autoSites: [...ctx.draft.autoSites, origin] }); // focus stays in the box (by id) for the next one
  };
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") add();
  });
  return settingRow(t("addSite"), note, h("span", { class: "row" }, input, h("button", { onClick: add }, t("add"))));
}

function sitesSection(ctx: OptionsContext): Node[] {
  const { t } = ctx;
  const remove = (origin: string) => ctx.patchAndRender({ autoSites: ctx.draft.autoSites.filter((o) => o !== origin) });
  const rows = ctx.draft.autoSites.map((origin) =>
    settingRow(
      new URL(origin).host,
      origin,
      h(
        "button",
        { class: "ghost danger icon", title: t("remove"), "aria-label": t("removeItem", { name: origin }), onClick: () => remove(origin) },
        icon(ICONS.trash, 15),
      ),
    ),
  );
  return [group(...(rows.length > 0 ? rows : [h("div", { class: "setting empty-row muted" }, t("noSites"))]), addSiteRow(ctx))];
}

// ---- Shortcuts ------------------------------------------------------------------------------

/** Re-read when the page regains focus, e.g. after editing chrome://extensions/shortcuts. */
let refreshShortcut: () => void = () => {};
window.addEventListener("focus", () => refreshShortcut());

function shortcutControls(t: Translate, note: HTMLElement, refresh: () => Promise<void>): HTMLElement {
  const editable = editableCommands();
  if (!editable) {
    // Chrome and Edge only allow changing extension shortcuts on their own settings page.
    const open = () => void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    return settingRow(t("changeShortcuts"), t("changeShortcutsDesc"), h("button", { onClick: open }, t("changeShortcutButton")));
  }
  const recorder = h("input", { readOnly: true, placeholder: t("recorderPlaceholder"), "aria-label": t("newShortcut") });
  recorder.addEventListener("keydown", (e: KeyboardEvent) => {
    e.preventDefault();
    if (e.key === "Escape") return recorder.blur();
    const r = shortcutFromKey(e, isMacPlatform());
    if ("pending" in r) return;
    if ("error" in r) return showStatus(note, t(r.error), "error");
    editable
      .update({ name: TOGGLE_COMMAND, shortcut: r.shortcut })
      .then(refresh)
      .then(() => showStatus(note, t("shortcutSet", { shortcut: r.shortcut }), "ok"))
      .catch((err: unknown) => showStatus(note, t("shortcutRejected", { shortcut: r.shortcut, error: String(err) }), "error"));
    recorder.blur();
  });
  const reset = () => void editable.reset(TOGGLE_COMMAND).then(refresh);
  return settingRow(t("changePageShortcut"), null, h("span", { class: "row" }, recorder, h("button", { onClick: reset }, t("reset"))));
}

function shortcutsSection(ctx: OptionsContext): Node[] {
  const { t } = ctx;
  const current = h("kbd", {}, "…");
  const others = h("div", {});
  const note = h("div", { class: "status" });
  const refresh = async () => {
    const shortcut = await currentShortcut();
    const all = await chrome.commands.getAll();
    others.replaceChildren(
      ...all
        .filter((c) => c.name !== TOGGLE_COMMAND && c.name && COMMAND_LABELS[c.name])
        .map((c) => settingRow(t(COMMAND_LABELS[c.name!]!), null, h("kbd", {}, c.shortcut || t("notSet")))),
    );
    current.textContent = shortcut || t("notSet");
    if (!shortcut) showStatus(note, t("noShortcut"), "error");
    else if (note.classList.contains("error")) showStatus(note, "");
  };
  refreshShortcut = () => void refresh();
  void refresh();
  return [group(settingRow(t("cmdToggle"), null, current), others, shortcutControls(t, note, refresh)), note];
}

// ---- Advanced -------------------------------------------------------------------------------

/** Export downloads a JSON file without API keys unless asked; import is validated like stored data. */
function backupRows(ctx: OptionsContext): HTMLElement[] {
  const { t } = ctx;
  let includeKeys = false;
  const out = h("span", { class: "status" });
  const exportFile = () => {
    const blob = new Blob([exportSettings(normalizeSettings(ctx.draft), includeKeys)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    h("a", { href: url, download: "interlinear-settings.json" }).click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const picker = h("input", { type: "file", accept: "application/json,.json", hidden: true });
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    if (!file) return;
    file
      .text()
      .then((text) => {
        ctx.replace(importSettings(text, ctx.draft));
        ctx.setStatus(t("imported"), "ok");
      })
      .catch((e: unknown) => showStatus(out, t("importFailed", { error: String(e) }), "error"));
  });
  return [
    settingRow(
      t("exportSettings"),
      t("exportSettingsDesc"),
      h(
        "span",
        { class: "row" },
        h("label", { class: "inline-switch muted small" }, switchInput(false, (v) => (includeKeys = v), t("includeKeys")), t("keys")),
        h("button", { onClick: exportFile }, t("exportAction")),
      ),
    ),
    settingRow(t("importSettings"), out, h("span", {}, picker, h("button", { onClick: () => picker.click() }, t("importAction")))),
  ];
}

function advancedSection(ctx: OptionsContext): Node[] {
  const { draft, t } = ctx;
  const cacheStatus = h("span", { class: "status" });
  const clear = () =>
    send<{ ok?: boolean; error?: string }>({ type: "clear-cache" })
      .then((res) => showStatus(cacheStatus, res.ok ? t("cacheCleared") : (res.error ?? t("failed")), res.ok ? "ok" : "error"))
      .catch((e: unknown) => showStatus(cacheStatus, String(e), "error"));
  const number = (value: number, key: "maxCharsPerBatch" | "maxItemsPerBatch" | "concurrency", min: number, max: number) =>
    numberInput(value, (v) => ctx.patch({ [key]: v }), min, max);
  return [
    group(
      settingRow(t("charsPerRequest"), t("charsPerRequestDesc"), number(draft.maxCharsPerBatch, "maxCharsPerBatch", 200, 20000)),
      settingRow(t("itemsPerRequest"), null, number(draft.maxItemsPerBatch, "maxItemsPerBatch", 1, 100)),
      settingRow(t("parallelRequests"), t("parallelRequestsDesc"), number(draft.concurrency, "concurrency", 1, 10)),
    ),
    group(settingRow(t("cache"), cacheStatus, h("button", { onClick: () => void clear() }, t("clearCache"))), ...backupRows(ctx)),
  ];
}

// ---- Privacy --------------------------------------------------------------------------------

const PRIVACY_POINTS: readonly MessageKey[] = ["privacyTelemetry", "privacyStorage", "privacyDirect", "privacyCache", "privacyWhen"];

function privacySection(ctx: OptionsContext): Node[] {
  return [
    h(
      "div",
      { class: "group callout" },
      h("span", { class: "callout-icon" }, icon(ICONS.shield, 18)),
      h("ul", {}, ...PRIVACY_POINTS.map((k) => h("li", {}, ctx.t(k)))),
    ),
  ];
}

export const SECTIONS: readonly Section[] = [
  { id: "services", title: "secServices", description: "secServicesDesc", build: servicesSection },
  { id: "translation", title: "secTranslation", description: "secTranslationDesc", build: translationSection },
  { id: "appearance", title: "secAppearance", description: "secAppearanceDesc", build: appearanceSection },
  { id: "helpers", title: "secHelpers", description: "secHelpersDesc", build: helpersSection },
  { id: "sites", title: "secSites", description: "secSitesDesc", build: sitesSection },
  { id: "shortcuts", title: "secShortcuts", description: "secShortcutsDesc", build: shortcutsSection },
  { id: "advanced", title: "secAdvanced", description: "secAdvancedDesc", build: advancedSection },
  { id: "privacy", title: "secPrivacy", description: "secPrivacyDesc", build: privacySection },
];
