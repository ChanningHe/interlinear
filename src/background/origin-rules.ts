import type { Provider } from "../core/settings";
import { HIDE_ORIGIN_OPTION, adapterOf } from "../providers/adapters";

// Some services reject any request whose Origin is an extension address. Browsers add that
// header themselves, so services that opted out get it removed by declarativeNetRequest session
// rules. Each rule is limited to the service's host and to requests this extension starts
// (initiator = our own host), so the user's normal browsing of that site is untouched.

type Rule = chrome.declarativeNetRequest.Rule;

/** Session rules belong to this module alone; ids start here. */
const FIRST_RULE_ID = 1;

function hostOf(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).hostname || undefined;
  } catch {
    return undefined;
  }
}

const hidesOrigin = (p: Provider) =>
  p.options[HIDE_ORIGIN_OPTION] === true && adapterOf(p.adapter).options.some((f) => f.key === HIDE_ORIGIN_OPTION);

/** One rule per host of a service that has "don't send the extension's origin" switched on. */
export function originRules(providers: readonly Provider[], extensionHost: string): Rule[] {
  const hosts = [...new Set(providers.filter(hidesOrigin).flatMap((p) => hostOf(p.endpoint) ?? []))];
  return hosts.map((host, i) => ({
    id: FIRST_RULE_ID + i,
    priority: 1,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "remove" }] },
    // Background fetches count as xmlhttprequest in both Chrome and Firefox.
    condition: { requestDomains: [host], initiatorDomains: [extensionHost], resourceTypes: ["xmlhttprequest"] },
  }));
}

/** Replaces every session rule with the ones the given services need. */
export async function syncOriginRules(providers: readonly Provider[]): Promise<void> {
  const dnr = chrome.declarativeNetRequest;
  const existing = await dnr.getSessionRules();
  await dnr.updateSessionRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: originRules(providers, new URL(chrome.runtime.getURL("")).host),
  });
}
