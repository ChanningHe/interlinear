import { chunkBatches } from "../core/batch";
import { buildPrompt, completedSegments, matchGlossary, parseResponse, placeholdersMatch, type PromptExtras } from "../core/prompt";
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
  /** Text on screen goes ahead of text prefetched below it. Default: visible. */
  readonly priority?: Priority;
  /** Each result as soon as it is known: cache hits first, then segments as the reply streams in. */
  readonly onResult?: (index: number, result: TranslateResult) => void;
  /** Aborted when the page no longer needs the results; queued requests are then never sent. */
  readonly signal?: AbortSignal;
}

export type Priority = "visible" | "prefetch";

export interface CompleteRequestOptions {
  readonly onText?: (text: string) => void;
  readonly signal?: AbortSignal;
}

export interface TranslatorDeps {
  readonly getSettings: () => Promise<Settings>;
  readonly cache: Cache;
  readonly complete: (p: Provider, req: ChatRequest, opts?: CompleteRequestOptions) => Promise<string>;
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

const RANK: Readonly<Record<Priority, number>> = { visible: 0, prefetch: 1 };

const aborted = () => new ProviderError("Request aborted", false);

/**
 * Global concurrency gate shared by every tab. Lower ranks go first, FIFO within a rank;
 * `front` puts a task ahead of its rank (retries of text that is already waiting on screen).
 */
function createLimiter() {
  let active = 0;
  let waiting: readonly { readonly rank: number; readonly wake: () => void }[] = [];
  const wait = (rank: number, front: boolean) =>
    new Promise<void>((wake) => {
      const at = waiting.findIndex((w) => (front ? w.rank >= rank : w.rank > rank));
      const entry = { rank, wake };
      waiting = at < 0 ? [...waiting, entry] : [...waiting.slice(0, at), entry, ...waiting.slice(at)];
    });
  const wakeNext = () => {
    const [next, ...rest] = waiting;
    waiting = rest;
    next?.wake();
  };
  return async function run<T>(limit: number, rank: number, front: boolean, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    for (let ahead = front; active >= limit; ahead = true) await wait(rank, ahead); // woken but outrun: keep its place
    if (signal?.aborted) {
      wakeNext(); // pass the free slot on
      throw aborted();
    }
    active++;
    try {
      return await task();
    } finally {
      active--;
      wakeNext();
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
    if (!provider) {
      texts.forEach((_, i) => opts.onResult?.(i, fail(NO_PROVIDER)));
      return texts.map(() => fail(NO_PROVIDER));
    }

    const targetLang = opts.targetLang ?? s.targetLang;
    const lang = languageName(targetLang);
    const context = s.pageContext ? (opts.context ?? "") : "";
    const rank = RANK[opts.priority ?? "visible"];
    /** Reports every item of `items` exactly once, each as soon as it is final. */
    const runBatch = async (items: readonly string[], report: (j: number, r: TranslateResult) => void, front = false): Promise<void> => {
      const settled = new Set<number>();
      const settle = (j: number, r: TranslateResult) => {
        if (settled.has(j)) return;
        settled.add(j);
        report(j, r);
      };
      const accept = (parsed: readonly (string | undefined)[]) =>
        parsed.forEach((v, j) => v !== undefined && placeholdersMatch(items[j]!, v) && settle(j, ok(v)));
      const prompt = buildPrompt(items, lang, s.customPrompt, { glossary: batchGlossary(s, items), context });
      let parsed: (string | undefined)[];
      try {
        // Segments can only complete when a line does; reparsing on every token would be quadratic.
        let lineEnd = -1;
        const onText = (text: string) => {
          const end = text.lastIndexOf("\n");
          if (end === lineEnd) return;
          lineEnd = end;
          accept(completedSegments(text, items.length));
        };
        const raw = await limit(s.concurrency, rank, front, opts.signal, () => deps.complete(provider, prompt, { onText: items.length > 1 ? onText : undefined, signal: opts.signal }));
        parsed = parseResponse(raw, items.length);
      } catch (e) {
        if (!opts.signal?.aborted) console.warn("[interlinear] request failed:", e);
        // A failed request fails what is left of the batch; retrying item by item would multiply cost.
        items.forEach((_, j) => settle(j, fail(publicError(e))));
        return;
      }
      if (items.length === 1) return settle(0, parsed[0] === undefined ? fail("Model returned an empty translation") : ok(parsed[0]));
      accept(parsed);
      // Segments the model dropped, garbled or stripped of links/code get one more chance alone,
      // ahead of other waiting text of the same priority.
      await Promise.all(items.map((item, j) => (settled.has(j) ? undefined : runBatch([item], (_, r) => settle(j, r), true))));
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

    cached.forEach((hit, i) => hit !== undefined && opts.onResult?.(i, ok(hit)));
    const fresh = new Map<number, TranslateResult>();
    const report = (i: number, r: TranslateResult) => {
      fresh.set(i, r);
      opts.onResult?.(i, r);
    };
    await Promise.all(batches.map((batch) => runBatch(batch.map((i) => texts[i]!), (j, r) => report(batch[j]!, r))));
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
