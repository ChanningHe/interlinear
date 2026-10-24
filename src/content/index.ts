import type { DisplayMode } from "../core/settings";
import type {
  BackgroundRequest,
  ContentRequest,
  PageConfig,
  PageInit,
  TabState,
  TranslateResult,
} from "../shared/messages";
import { installHover, hoveredElement } from "./hover";
import { installTripleSpace, translateField, type Field } from "./input";
import { chromeDetector, createLanguageFilter } from "./lang";
import { createPopover, type Popover } from "./popover";
import { installSelectionButton, selectionRect } from "./selection";
import { createPageTranslator, intersectionVisibility } from "./translator";

// Loaded either on demand (toolbar button, shortcut, context menu) or by the browser on sites the
// user opted into, and may be injected more than once. The flag lives in the extension's
// isolated world, so pages cannot see or spoof it.
declare global {
  interface Window {
    __browserTranslateLoaded?: true;
  }
}

type PageTranslator = ReturnType<typeof createPageTranslator>;

let translator: PageTranslator | undefined;
let config: PageConfig | undefined;
/** Display mode chosen on this page (shortcut or popup); survives toggling translation off and on. */
let pageMode: DisplayMode | undefined;
let popover: Popover | undefined;

function send<T>(msg: BackgroundRequest): Promise<T> {
  return chrome.runtime.sendMessage<BackgroundRequest, T>(msg);
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function translateTexts(texts: readonly string[], targetLang?: string): Promise<TranslateResult[]> {
  const context = config?.pageContext ? document.title : undefined;
  const res = await send<TranslateResult[] | { error?: string }>({ type: "translate", texts, targetLang, context });
  if (!Array.isArray(res)) throw new Error(res?.error ?? "No response from the extension background");
  return res;
}

async function translateOne(text: string, targetLang?: string): Promise<TranslateResult> {
  try {
    return (await translateTexts([text], targetLang))[0] ?? { ok: false, error: "No result returned" };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** Created with the configured interface language; config is always loaded before any UI shows. */
const getPopover = (c: PageConfig) => (popover ??= createPopover(c.labels));

async function loadConfig(): Promise<PageConfig> {
  config = await send<PageConfig>({ type: "page-config" });
  return config;
}

/** The translator for this page, created with fresh settings when none is running. */
async function ensureTranslator(): Promise<PageTranslator> {
  if (translator) return translator;
  const c = await loadConfig();
  translator ??= createPageTranslator({
    config: { ...c, displayMode: pageMode ?? c.displayMode },
    root: document.body,
    translate: (texts) => translateTexts(texts),
    isTargetLanguage: createLanguageFilter(c.targetLang, chromeDetector, document.documentElement.lang),
    createVisibility: intersectionVisibility,
  });
  return translator;
}

const state = (): TabState => ({
  active: translator?.isActive() ?? false,
  mode: translator?.getMode() ?? pageMode ?? config?.displayMode,
});

let pendingToggle: Promise<TabState> | undefined;

/** Overlapping toggles (double shortcut press while the worker wakes up) share one transition. */
function toggle(): Promise<TabState> {
  pendingToggle ??= runToggle().finally(() => {
    pendingToggle = undefined;
  });
  return pendingToggle;
}

async function runToggle(): Promise<TabState> {
  if (translator?.isActive()) {
    translator.stop();
    translator = undefined;
    return state();
  }
  (await ensureTranslator()).start();
  return state();
}

function setMode(mode: DisplayMode): TabState {
  pageMode = mode;
  translator?.setMode(mode);
  return state();
}

async function translateHovered(target = hoveredElement()): Promise<void> {
  if (target) (await ensureTranslator()).translateRegion(target);
}

/** Shows the translation of `text` next to `anchor` (or the current selection). */
async function translateSelection(text: string, anchor = selectionRect()): Promise<void> {
  const rect = anchor ?? new DOMRect(innerWidth / 2 - 100, 16, 200, 0);
  const pop = getPopover(config ?? (await loadConfig()));
  pop.showResult(rect, { state: "loading" });
  const r = await translateOne(text);
  pop.showResult(rect, r.ok ? { state: "text", text: r.text } : { state: "error", message: r.error });
}

async function translateInput(field: Field, c: PageConfig): Promise<void> {
  const pop = getPopover(c);
  const rect = field.getBoundingClientRect();
  pop.showResult(rect, { state: "loading" });
  let failed = false;
  await translateField(field, {
    translate: (text) => translateOne(text, c.inputTargetLang),
    onError: (message) => {
      failed = true;
      pop.showResult(rect, { state: "error", message });
    },
  });
  if (!failed) pop.hide();
}

/** Hover, selection and input helpers. They only ever act on real (trusted) user input. */
function installHelpers(c: PageConfig): void {
  installHover({ modifier: c.hoverModifier, onTarget: (el) => void translateHovered(el) });
  if (c.selectionButton) {
    installSelectionButton({ popover: getPopover(c), onTranslate: (text, anchor) => void translateSelection(text, anchor) });
  }
  if (c.inputTranslation) installTripleSpace({ onTrigger: (field) => void translateInput(field, c) });
}

function onMessage(msg: ContentRequest): Promise<TabState> | TabState | undefined {
  switch (msg?.type) {
    case "state":
      return state();
    case "toggle":
      return toggle();
    case "set-mode":
      return setMode(msg.mode);
    case "translate-hovered":
      return translateHovered().then(state);
    case "translate-selection":
      return translateSelection(msg.text).then(state);
    default:
      return undefined;
  }
}

async function init(): Promise<void> {
  const { config: c, autoTranslate } = await send<PageInit>({ type: "page-init" });
  config = c;
  installHelpers(c);
  if (autoTranslate && !translator?.isActive()) await toggle();
}

if (!window.__browserTranslateLoaded) {
  window.__browserTranslateLoaded = true;
  chrome.runtime.onMessage.addListener((msg: ContentRequest, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    const reply = onMessage(msg);
    if (reply === undefined) return false;
    if (!(reply instanceof Promise)) {
      sendResponse(reply);
      return false;
    }
    reply.then(sendResponse, (e: unknown) => sendResponse({ ...state(), error: errorText(e) }));
    return true;
  });
  init().catch((e: unknown) => console.warn("[browser-translate] init failed:", e));
}
