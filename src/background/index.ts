import { buildPrompt, parseResponse } from "../core/prompt";
import { ProviderError, complete, type ChatRequest } from "../core/providers";
import {
  STORAGE_KEY,
  loadSettings,
  normalizeSettings,
  originPattern,
  residentMatches,
  siteOrigin,
  validateProvider,
  type DisplayMode,
  type Provider,
  type Settings,
} from "../core/settings";
import { contentLabels, createT, resolveUiLanguage, type Translate } from "../shared/i18n";
import { languageName } from "../shared/languages";
import {
  HOVER_COMMAND,
  MAX_TEXT_LENGTH,
  MODE_COMMAND,
  TOGGLE_COMMAND,
  parseBackgroundRequest,
  type BackgroundRequest,
  type ContentRequest,
  type PageConfig,
  type PageInit,
  type TabState,
} from "../shared/messages";
import {
  SignedOutError,
  deleteCredential,
  loadCredential,
  needsRefresh,
  refreshCredential,
  saveCredential,
} from "../providers/chatgpt-auth";
import { listModels } from "../providers/models";
import { createIdbCache } from "./cache";
import { createTranslator, publicError } from "./translate";

const log = (...args: unknown[]) => console.warn("[browser-translate]", ...args);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Defence in depth: content scripts never read storage, and now they cannot either.
// Not every browser supports this for storage.local, so failure is only logged.
try {
  chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })?.catch((e: unknown) => log("setAccessLevel:", e));
} catch (e) {
  log("setAccessLevel unsupported:", e);
}

// --- settings (memoised, invalidated on change) -------------------------------------------

let settings: Promise<Settings> | undefined;
const getSettings = () => (settings ??= loadSettings());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(STORAGE_KEY in changes)) return;
  settings = undefined;
  syncContentScripts();
  void createMenus(); // titles follow the interface language
});

const uiLanguage = (s: Settings) => resolveUiLanguage(s.uiLanguage, chrome.i18n.getUILanguage());

function pageConfig(s: Settings): PageConfig {
  return {
    targetLang: s.targetLang,
    style: s.style,
    displayMode: s.displayMode,
    scope: s.scope,
    maxCharsPerBatch: s.maxCharsPerBatch,
    maxItemsPerBatch: s.maxItemsPerBatch,
    hoverModifier: s.hoverModifier,
    inputTranslation: s.inputTranslation,
    inputTargetLang: s.inputTargetLang,
    selectionButton: s.selectionButton,
    pageContext: s.pageContext,
    labels: contentLabels(uiLanguage(s)),
  };
}

// --- resident content scripts (sites the user opted into) ------------------------------------

const RESIDENT_ID = "bt-resident";
let syncing = Promise.resolve();

/**
 * Registers content.js for "always translate" sites, or for every site when the user enabled
 * the page helpers everywhere. Derived from settings plus the access actually granted.
 */
function syncContentScripts(): void {
  syncing = syncing
    .then(async () => {
      const wanted = residentMatches(await getSettings());
      const granted = await Promise.all(wanted.map((m) => chrome.permissions.contains({ origins: [m] })));
      const matches = wanted.filter((_, i) => granted[i]);
      const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [RESIDENT_ID] });
      if (existing.length > 0) await chrome.scripting.unregisterContentScripts({ ids: [RESIDENT_ID] });
      if (matches.length === 0) return;
      await chrome.scripting.registerContentScripts([
        { id: RESIDENT_ID, matches, js: ["content.js"], css: ["content.css"], runAt: "document_idle", persistAcrossSessions: true },
      ]);
    })
    .catch((e: unknown) => log("content script sync failed:", e));
}

chrome.permissions.onAdded.addListener(syncContentScripts);
chrome.permissions.onRemoved.addListener(syncContentScripts);

// --- translation ---------------------------------------------------------------------------

// MV3 workers are stopped after 30s without extension events. Streaming keeps response
// headers fast, and while any request is in flight an API call every 20s resets the idle timer.
const KEEPALIVE_MS = 20_000;
let inFlight = 0;
let keepAlive: ReturnType<typeof setInterval> | undefined;

async function withKeepAlive<T>(task: () => Promise<T>): Promise<T> {
  if (inFlight++ === 0) keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), KEEPALIVE_MS);
  try {
    return await task();
  } finally {
    if (--inFlight === 0) clearInterval(keepAlive);
  }
}

/** Host access is granted per endpoint from the options page; fail with a fixable message. */
// --- sign-in tokens (ChatGPT) --------------------------------------------------------------

/** One refresh at a time per service: a refresh token is single-use, so racing would sign out. */
const refreshing = new Map<string, Promise<string>>();

async function freshToken(providerId: string): Promise<string> {
  const cred = await loadCredential(providerId);
  if (!cred) throw new ProviderError("Not signed in; sign in again in settings", false);
  if (!needsRefresh(cred)) return cred.accessToken;
  let next;
  try {
    next = await refreshCredential(cred);
  } catch (e) {
    if (e instanceof SignedOutError) {
      // Only if nobody signed in again meanwhile.
      if ((await loadCredential(providerId))?.refreshToken === cred.refreshToken) await deleteCredential(providerId);
      throw new ProviderError(e.message, false);
    }
    // fetch rejects with TypeError on network failure; anything else will not fix itself.
    throw new ProviderError(`Token refresh failed: ${message(e)}`, e instanceof TypeError);
  }
  // A sign-out or a new sign-in during the refresh wins: never resurrect or overwrite it.
  if ((await loadCredential(providerId))?.refreshToken !== cred.refreshToken) throw new ProviderError("Signed out of ChatGPT; sign in again in settings", false);
  await saveCredential(providerId, next);
  return next.accessToken;
}

function accessToken(providerId: string): () => Promise<string> {
  return () => {
    const pending = refreshing.get(providerId) ?? freshToken(providerId).finally(() => refreshing.delete(providerId));
    refreshing.set(providerId, pending);
    return pending;
  };
}

async function assertAccess(p: Provider): Promise<void> {
  // Sign-in services also refresh tokens on their auth host.
  const origins = [originPattern(p.endpoint), ...(p.adapter === "chatgpt" ? ["https://auth.openai.com/*"] : [])];
  if (!(await chrome.permissions.contains({ origins }))) {
    log("host access missing for", new URL(p.endpoint).origin);
    // No hostname in the message: it may be shown inside the translated page.
    throw new ProviderError("Access to the API endpoint is not granted. Open settings and click Save.", false);
  }
}

async function completeWithPermission(p: Provider, req: ChatRequest): Promise<string> {
  await assertAccess(p);
  return withKeepAlive(() => complete(p, req, { accessToken: accessToken(p.id) }));
}

/** Model list for the settings page (extension pages only). */
async function modelsFor(input: Provider) {
  const provider = normalizeSettings({ providers: [input] }).providers[0];
  if (!provider) return { ok: false, error: "Invalid provider definition" };
  try {
    await assertAccess(provider);
    return { ok: true, models: await withKeepAlive(() => listModels(provider, { accessToken: accessToken(provider.id) })) };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

const cache = createIdbCache();
cache.prune().catch((e) => log("cache prune failed:", e));
const translator = createTranslator({ getSettings, cache, complete: completeWithPermission });

// --- tabs ----------------------------------------------------------------------------------

async function ensureInjected(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "state" });
    return; // already injected
  } catch {
    // No listener yet: inject below.
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (e) {
    throw new Error(`This page cannot be translated (${message(e)})`);
  }
}

function sendToTab<T>(tabId: number, msg: ContentRequest): Promise<T> {
  return chrome.tabs.sendMessage<ContentRequest, T>(tabId, msg);
}

async function toggleTab(tabId: number): Promise<TabState> {
  await ensureInjected(tabId);
  return sendToTab(tabId, { type: "toggle" });
}

async function setTabMode(tabId: number, mode: DisplayMode): Promise<TabState> {
  try {
    return await sendToTab(tabId, { type: "set-mode", mode });
  } catch {
    return { active: false }; // nothing injected: the saved setting applies next time
  }
}

/** Shortcut: flip bilingual / translation-only on this page, translating it first if needed. */
async function flipTabMode(tabId: number): Promise<void> {
  await ensureInjected(tabId);
  const current = await sendToTab<TabState>(tabId, { type: "state" });
  const next: DisplayMode = current.mode === "translation-only" ? "bilingual" : "translation-only";
  await sendToTab(tabId, { type: "set-mode", mode: next });
  if (!current.active) await sendToTab(tabId, { type: "toggle" });
}

async function runInTab(tabId: number, msg: ContentRequest): Promise<void> {
  await ensureInjected(tabId);
  await sendToTab(tabId, msg);
}

async function tabState(tabId: number): Promise<TabState> {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "state" });
  } catch {
    return { active: false };
  }
}

// --- provider test (options page) ----------------------------------------------------------

async function testProvider(input: Provider): Promise<{ ok: boolean; text?: string; error?: string }> {
  const provider = normalizeSettings({ providers: [input] }).providers[0];
  if (!provider) return { ok: false, error: "Invalid provider definition" };
  const errors = validateProvider(provider);
  if (errors.length > 0) {
    const t = createT(uiLanguage(await getSettings()));
    return { ok: false, error: errors.map((k) => t(k)).join("; ") };
  }
  const s = await getSettings();
  try {
    const raw = await completeWithPermission(
      provider,
      buildPrompt(["Hello, world! This is a test."], languageName(s.targetLang), s.customPrompt),
    );
    return { ok: true, text: parseResponse(raw, 1)[0] ?? "" };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

// --- message router ------------------------------------------------------------------------

const PRIVILEGED: ReadonlySet<BackgroundRequest["type"]> = new Set([
  "toggle-tab",
  "list-models",
  "chatgpt-account",
  "chatgpt-sign-out",
  "set-mode",
  "tab-state",
  "test-provider",
  "clear-cache",
]);

interface RequestContext {
  /** Incognito tabs never read or write the persistent translation cache. */
  readonly incognito: boolean;
  /** URL of the sending frame as reported by the browser (not by the page). */
  readonly url?: string;
  readonly isTopFrame: boolean;
}

async function handle(req: BackgroundRequest, ctx: RequestContext): Promise<unknown> {
  switch (req.type) {
    case "translate":
      return translator.translate(req.texts, { useCache: !ctx.incognito, targetLang: req.targetLang, context: req.context });
    case "page-config":
      return pageConfig(await getSettings());
    case "page-init": {
      const s = await getSettings();
      const origin = ctx.url ? siteOrigin(ctx.url) : undefined;
      const autoTranslate = ctx.isTopFrame && origin !== undefined && s.autoSites.includes(origin);
      return { config: pageConfig(s), autoTranslate } satisfies PageInit;
    }
    case "toggle-tab":
      return toggleTab(req.tabId);
    case "set-mode":
      return setTabMode(req.tabId, req.mode);
    case "tab-state":
      return tabState(req.tabId);
    case "test-provider":
      return testProvider(req.provider);
    case "list-models":
      return modelsFor(req.provider);
    case "chatgpt-account": {
      const cred = await loadCredential(req.providerId);
      return cred ? { signedIn: true, email: cred.email } : { signedIn: false };
    }
    case "chatgpt-sign-out":
      await deleteCredential(req.providerId);
      return { ok: true };
    case "clear-cache":
      await cache.clear();
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const req = parseBackgroundRequest(raw);
  if (!req) {
    sendResponse({ error: "Invalid request" });
    return false;
  }
  // Content scripts run inside web pages; only our own extension pages may use privileged calls.
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL("")) ?? false;
  if (PRIVILEGED.has(req.type) && !fromExtensionPage) {
    sendResponse({ error: "Not allowed from a web page" });
    return false;
  }
  const ctx = { incognito: sender.tab?.incognito ?? false, url: sender.url, isTopFrame: sender.frameId === 0 };
  handle(req, ctx).then(sendResponse, (e: unknown) => {
    log(`${req.type} failed:`, e);
    sendResponse({ error: fromExtensionPage ? message(e) : publicError(e) });
  });
  return true;
});

// Every entry point below is a user gesture, which grants activeTab for the current page.

chrome.commands.onCommand.addListener((command, tab) => {
  const tabId = tab?.id;
  if (tabId === undefined) return;
  const run: Record<string, () => Promise<unknown>> = {
    [TOGGLE_COMMAND]: () => toggleTab(tabId),
    [MODE_COMMAND]: () => flipTabMode(tabId),
    [HOVER_COMMAND]: () => runInTab(tabId, { type: "translate-hovered" }),
  };
  run[command]?.().catch((e: unknown) => log(`${command} failed:`, e));
});

const MENU_PAGE = "bt-page";
const MENU_SELECTION = "bt-selection";

async function createMenus(): Promise<void> {
  const t: Translate = createT(uiLanguage(await getSettings()));
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_PAGE, title: t("menuPage"), contexts: ["page"] });
  chrome.contextMenus.create({ id: MENU_SELECTION, title: t("menuSelection"), contexts: ["selection"] });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const tabId = tab?.id;
  if (tabId === undefined) return;
  const task =
    info.menuItemId === MENU_PAGE
      ? toggleTab(tabId)
      : runInTab(tabId, { type: "translate-selection", text: (info.selectionText ?? "").slice(0, MAX_TEXT_LENGTH) });
  task.catch((e: unknown) => log("context menu action failed:", e));
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  void createMenus();
  syncContentScripts();
  if (reason === "install") void chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => {
  void createMenus();
  syncContentScripts();
});
