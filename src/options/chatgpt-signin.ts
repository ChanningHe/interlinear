import {
  authorizeUrl,
  exchangeCode,
  callbackFrom,
  hostId,
  loadCredential,
  newPendingSignIn,
  parseCallback,
  saveCredential,
  type ChatgptCredential,
} from "../providers/chatgpt-auth";

// Runs in the options page, which stays open while the user signs in (a service worker could be
// stopped mid-flow). OpenAI only accepts a 127.0.0.1 callback and nothing listens there: the
// sign-in tab's URL is read when it reaches the callback, then the tab is closed.

/** Hosts sign-in needs. Request them synchronously in the click that starts sign-in. */
export const SIGN_IN_ORIGINS: readonly string[] = ["https://auth.openai.com/*", "https://api.openai.com/*", "http://127.0.0.1/*"];

const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/** Resolves with the callback URL the tab is sent to; rejects if the tab is closed or time runs out. */
function waitForCallback(tabId: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onUpdated = (id: number, change: { url?: string }, tab: chrome.tabs.Tab) => {
      const url = id === tabId ? callbackFrom(change.url ?? tab.url ?? "") : undefined;
      if (url) finish(() => resolve(url));
    };
    const onAbort = () => finish(() => reject(new Error("Sign-in was cancelled")));
    signal.addEventListener("abort", onAbort);
    const onRemoved = (id: number) => {
      if (id === tabId) finish(() => reject(new Error("Sign-in was cancelled")));
    };
    const timer = setTimeout(() => finish(() => reject(new Error("Sign-in timed out"))), SIGN_IN_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

/**
 * Signs in (or re-authorizes) the ChatGPT service with this id and stores its tokens. Aborting
 * (the drawer was closed) stops waiting, closes the tab and stores nothing.
 */
export async function signInWithChatGPT(providerId: string, signal: AbortSignal): Promise<ChatgptCredential> {
  const existing = await loadCredential(providerId);
  const pending = newPendingSignIn(existing?.clientId);
  const url = await authorizeUrl(pending, await hostId(), existing?.email || undefined);
  const tab = await chrome.tabs.create({ url });
  if (tab.id === undefined) throw new Error("Could not open the sign-in page");
  const callback = await waitForCallback(tab.id, signal).finally(() => {
    chrome.tabs.remove(tab.id!).catch(() => {}); // the user may already have closed it
  });
  const { code, clientId } = parseCallback(callback, pending);
  const cred = await exchangeCode(code, clientId, pending);
  if (signal.aborted) throw new Error("Sign-in was cancelled");
  await saveCredential(providerId, cred);
  return cred;
}
