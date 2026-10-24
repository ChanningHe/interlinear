import { chunkBatches } from "../core/batch";
import { buildPrompt, matchGlossary, parseResponse, placeholdersMatch, type PromptExtras } from "../core/prompt";
import { ProviderError, type ChatRequest } from "../core/providers";
import { activeProvider, type Provider, type Settings } from "../core/settings";
import { adapterOf, outputOptions } from "../providers/adapters";
import { languageName } from "../shared/languages";
import type { TranslateResult } from "../shared/messages";

export interface Cache {
  get(keys: readonly string[]): Promise<(string | undefined)[]>;
  set(entries: readonly (readonly [string, string])[]): Promise<void>;
}

export interface TranslateOptions {
  /** False for incognito tabs: nothing is read from or written to the persistent cache. */
  readonly useCache?: boolean;
  /** Overrides the configured target language (input-box translation). */
  readonly targetLang?: string;
  /** Page title; ignored unless the pageContext setting is on. */
  readonly context?: string;
}

export interface TranslatorDeps {
  readonly getSettings: () => Promise<Settings>;
  readonly cache: Cache;
  readonly complete: (p: Provider, req: ChatRequest) => Promise<string>;
}

const NO_PROVIDER = "No translation service configured. Open the extension settings to add one.";

const ok = (text: string): TranslateResult => ({ ok: true, text });
const fail = (error: string): TranslateResult => ({ ok: false, error });

/**
 * Results end up inside the web page's DOM, so provider error bodies (which can echo key
 * fragments or internal hostnames) are replaced by status-based text. Details go to the log.
 */
export function publicError(e: unknown): string {
  if (!(e instanceof ProviderError)) return "Translation failed";
  if (e.status === 401 || e.status === 403) return `The service rejected the request (HTTP ${e.status}). Check the API key in settings.`;
  if (e.status === 429) return "Rate limited by the service (HTTP 429). Try again later.";
  if (e.status !== undefined) return `The service returned an error (HTTP ${e.status}).`;
  return e.message; // our own messages, which never include server-provided text
}

/** Global FIFO concurrency gate shared by every tab. */
function createLimiter() {
  let active = 0;
  const waiters: (() => void)[] = [];
  return async function run<T>(limit: number, task: () => Promise<T>): Promise<T> {
    while (active >= limit) await new Promise<void>((resolve) => waiters.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiters.shift()?.();
    }
  };
}

async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Everything that changes the output must be part of the key. */
function cacheKey(p: Provider, s: Settings, lang: string, extras: PromptExtras, text: string): Promise<string> {
  const terms = (extras.glossary ?? []).map((g) => [g.source, g.target]);
  // Options such as reasoning effort can change the wording; routing preferences cannot.
  const spec = outputOptions(adapterOf(p.adapter), p.options);
  return sha256(JSON.stringify([p.adapter, p.endpoint, p.model, spec, lang, s.customPrompt, extras.context ?? "", terms, text]));
}

/** Glossary entries used by any of the texts, without duplicates, in glossary order. */
function batchGlossary(s: Settings, texts: readonly string[]) {
  return s.glossary.filter((g) => texts.some((t) => matchGlossary([g], t).length > 0));
}

export function createTranslator(deps: TranslatorDeps) {
  const limit = createLimiter();

  async function readCache(keys: readonly string[]): Promise<(string | undefined)[]> {
    try {
      return await deps.cache.get(keys);
    } catch (e) {
      // The cache is an optimisation; translation must still work without it.
      console.warn("[interlinear] cache read failed:", e);
      return keys.map(() => undefined);
    }
  }

  async function writeCache(entries: readonly (readonly [string, string])[]): Promise<void> {
    if (entries.length === 0) return;
    try {
      await deps.cache.set(entries);
    } catch (e) {
      console.warn("[interlinear] cache write failed:", e);
    }
  }

  async function translate(texts: readonly string[], opts: TranslateOptions = {}): Promise<TranslateResult[]> {
    const useCache = opts.useCache ?? true;
    const s = await deps.getSettings();
    const provider = activeProvider(s);
    if (!provider) return texts.map(() => fail(NO_PROVIDER));

    const targetLang = opts.targetLang ?? s.targetLang;
    const lang = languageName(targetLang);
    const context = s.pageContext ? (opts.context ?? "") : "";
    const runBatch = async (items: readonly string[]): Promise<TranslateResult[]> => {
      let parsed: (string | undefined)[];
      const prompt = buildPrompt(items, lang, s.customPrompt, { glossary: batchGlossary(s, items), context });
      try {
        const raw = await limit(s.concurrency, () => deps.complete(provider, prompt));
        parsed = parseResponse(raw, items.length);
      } catch (e) {
        console.warn("[interlinear] request failed:", e);
        // A failed request fails the whole batch; retrying item by item would multiply cost.
        return items.map(() => fail(publicError(e)));
      }
      if (items.length === 1) return [parsed[0] === undefined ? fail("Model returned an empty translation") : ok(parsed[0])];
      // Segments the model dropped, garbled or stripped of links/code get one more chance alone.
      return Promise.all(
        parsed.map(async (v, i) =>
          v === undefined || !placeholdersMatch(items[i]!, v) ? (await runBatch([items[i]!]))[0]! : ok(v),
        ),
      );
    };

    const keys = await Promise.all(
      texts.map((t) => cacheKey(provider, s, targetLang, { glossary: matchGlossary(s.glossary, t), context }, t)),
    );
    const cached = useCache ? await readCache(keys) : keys.map(() => undefined);
    const missing = texts.map((_, i) => i).filter((i) => cached[i] === undefined);
    const batches = chunkBatches(missing, (i) => texts[i]!.length, {
      maxChars: s.maxCharsPerBatch,
      maxItems: s.maxItemsPerBatch,
    });

    const fresh = new Map<number, TranslateResult>();
    await Promise.all(
      batches.map(async (batch) => {
        const out = await runBatch(batch.map((i) => texts[i]!));
        batch.forEach((index, j) => fresh.set(index, out[j]!));
      }),
    );
    // A translation that lost placeholders is still shown, but never cached for 30 days.
    const cacheable = [...fresh].filter(([i, r]) => r.ok && placeholdersMatch(texts[i]!, r.text));
    if (useCache) await writeCache(cacheable.map(([i, r]) => [keys[i]!, (r as { text: string }).text] as const));

    return texts.map((_, i) => {
      const hit = cached[i];
      return hit === undefined ? fresh.get(i)! : ok(hit);
    });
  }

  return { translate };
}
