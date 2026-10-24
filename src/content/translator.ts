import { chunkBatches } from "../core/batch";
import type { DisplayMode } from "../core/settings";
import type { PageConfig, TranslateResult } from "../shared/messages";
import { blockAncestor, collectUnits, contentRoots, isInsideSkipped, sourceOf, type CollectOptions, type Unit } from "./dom";
import {
  ONLY_ATTR,
  createWrapper,
  hideOriginal,
  insertAfter,
  removeAllTranslations,
  removeWrapper,
  restoreHost,
  showError,
  showLoading,
  showOriginal,
  showTranslation,
} from "./render";
import { OWN_ATTR } from "./rules";
import { plainText } from "./serialize";

export interface Visibility {
  observe(el: Element): void;
  unobserve(el: Element): void;
  disconnect(): void;
}

export interface PageTranslatorDeps {
  readonly config: PageConfig;
  readonly root: Element;
  readonly translate: (texts: readonly string[]) => Promise<TranslateResult[]>;
  readonly isTargetLanguage: (text: string) => Promise<boolean>;
  readonly createVisibility: (onVisible: (els: readonly Element[]) => void) => Visibility;
  readonly queueDelayMs?: number;
  readonly mutationDelayMs?: number;
  /** Characters sent before asking the user to confirm more. */
  readonly charAllowance?: number;
  /** Tests cannot produce trusted events; production always requires them. */
  readonly requireTrustedClick?: boolean;
}

interface Tracked {
  readonly unit: Unit;
  readonly requested: boolean;
  readonly wrapper?: HTMLElement;
}

/**
 * Attribute changes that commonly reveal or restyle text (fade-ins, tabs, <details>). Our own
 * attributes (data-bt-only, host style) are deliberately not among them.
 */
const OBSERVED_ATTRIBUTES = ["class", "hidden", "open"];

/** Coalesces paragraphs that become visible together into fewer requests. */
const QUEUE_DELAY_MS = 120;
/** Lets SPA re-renders settle before re-scanning. */
const MUTATION_DELAY_MS = 300;
/**
 * A page that keeps generating text (or a hostile one) must not drain the API budget.
 * After this many characters per activation the user has to click to continue.
 */
const CHAR_ALLOWANCE = 200_000;

const anchorOf = (u: Unit): Node => u.nodes[u.nodes.length - 1]!;
const isOwnNode = (n: Node) => n instanceof Element && n.hasAttribute(OWN_ATTR);
const isInsideOwn = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest(`[${OWN_ATTR}]`) != null;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Text that differs only in digits ("3 seconds ago" → "4 seconds ago", live counters) keeps its
 * existing translation instead of being re-translated on every tick.
 */
const sameShape = (a: string, b: string) => a === b || a.replace(/\d+/g, "#") === b.replace(/\d+/g, "#");

/**
 * False once the page has removed or rewritten the paragraph since it was collected. Compares raw
 * text, so a style change (a fade-in, a class flip) is not mistaken for a rewrite.
 */
const stillValid = (u: Unit) => u.nodes.every((n) => n.isConnected) && sameShape(sourceOf(u.nodes), u.source);

/** display:contents has no box of its own, so checkVisibility reports it hidden; ask its parent. */
function boxOf(el: Element): Element {
  let box: Element = el;
  while (getComputedStyle(box).display === "contents" && box.parentElement) box = box.parentElement;
  return box;
}

/**
 * False when none of the paragraph is rendered, e.g. tooltip text slotted into a web component's
 * closed popup: its light-DOM parent is visible, so the IntersectionObserver alone would fire.
 */
function isRendered(u: Unit): boolean {
  return u.nodes.some((n) => {
    const el = n instanceof Element ? n : n.parentElement;
    if (!el || typeof el.checkVisibility !== "function") return true;
    return boxOf(el).checkVisibility({ checkVisibilityCSS: true });
  });
}

/** Letters and digits only, so "Proton Mail" and "Proton Mail." compare equal. Case still counts. */
const comparable = (serialized: string) => plainText(serialized).replace(/[^\p{L}\p{N}]/gu, "");

/** A "translation" that equals the original (names, brands, already-target text) adds only noise. */
const isUnchanged = (u: Unit, translated: string) => comparable(u.text) === comparable(translated);

function restoreOrphanedHost(target: Node): void {
  if (target instanceof Element && target.hasAttribute(ONLY_ATTR) && !target.querySelector(`:scope > bt-tr[${OWN_ATTR}]`)) {
    restoreHost(target);
  }
}

/** Visible paragraphs plus two screens below and half a screen above. */
export function intersectionVisibility(onVisible: (els: readonly Element[]) => void): Visibility {
  return new IntersectionObserver(
    (entries) => onVisible(entries.filter((e) => e.isIntersecting).map((e) => e.target)),
    { rootMargin: "50% 0px 200% 0px" },
  );
}

/**
 * Translates a page, or only the regions asked for (hover translation).
 * `start()` switches to whole-page mode; `translateRegion()` works with or without it.
 */
export function createPageTranslator(deps: PageTranslatorDeps) {
  const queueDelay = deps.queueDelayMs ?? QUEUE_DELAY_MS;
  const mutationDelay = deps.mutationDelayMs ?? MUTATION_DELAY_MS;
  const allowanceStep = deps.charAllowance ?? CHAR_ALLOWANCE;
  const requireTrustedClick = deps.requireTrustedClick ?? true;

  /** Observers are running: whole page, or at least one region. */
  let active = false;
  /** Whole-page translation is on (what the toolbar button and shortcut toggle). */
  let wholePage = false;
  /** Regions translated on request while the whole page is not. */
  let regions: ReadonlySet<Element> = new Set();
  let mode: DisplayMode = deps.config.displayMode;
  /** Main-content scope: where whole-page translation happens; cached until a root is detached. */
  let scopeRoots: readonly Element[] = [];
  const scopedOpts: CollectOptions = { skipChrome: deps.config.scope === "content" };

  function currentRoots(): readonly Element[] {
    if (deps.config.scope === "page") return [deps.root];
    // Recomputed when a root is gone or hidden (SPAs that keep the old page around hidden).
    const stale = (r: Element) => !r.isConnected || getComputedStyle(r).display === "none";
    if (scopeRoots.length === 0 || scopeRoots.some(stale)) scopeRoots = contentRoots(deps.root);
    return scopeRoots;
  }
  let tracked = new WeakMap<Node, Tracked>();
  let wrapperAnchor = new WeakMap<Element, Node>();
  let hostUnits = new WeakMap<Element, readonly Unit[]>();
  let queue: readonly Unit[] = [];
  let pendingRoots: ReadonlySet<Element> = new Set();
  let queueTimer: ReturnType<typeof setTimeout> | undefined;
  let mutationTimer: ReturnType<typeof setTimeout> | undefined;
  let visibility: Visibility | undefined;
  let mutations: MutationObserver | undefined;
  let allowance = allowanceStep;
  let spent = 0;
  let paused: readonly Unit[] = [];

  const isCurrent = (u: Unit) => active && tracked.get(anchorOf(u))?.unit === u;

  function update(u: Unit, patch: Partial<Tracked>): void {
    const t = tracked.get(anchorOf(u));
    if (t) tracked.set(anchorOf(u), { ...t, ...patch });
  }

  /** Drops translations whose paragraph changed or disappeared. */
  function pruneStale(root: Element, fresh: ReadonlyMap<Node, Unit>): void {
    root.querySelectorAll(`[${OWN_ATTR}]`).forEach((w) => {
      const anchor = wrapperAnchor.get(w);
      if (!anchor) return;
      const old = tracked.get(anchor);
      const now = fresh.get(anchor);
      if (old && now && sameShape(old.unit.text, now.text)) return;
      removeWrapper(w);
      tracked.delete(anchor);
    });
  }

  /**
   * Collects paragraphs under `root`. Lazy scans translate them as they scroll into view;
   * a region scan translates the region's own paragraphs right away.
   */
  function scan(root: Element, how: "lazy" | "region" = "lazy"): void {
    // A region is something the user pointed at: only noise is filtered there, not page chrome.
    const units = collectUnits(root, how === "region" ? {} : scopedOpts);
    pruneStale(root, new Map(units.map((u) => [anchorOf(u), u])));

    const byHost = new Map<Element, Unit[]>();
    for (const u of units) {
      const prev = tracked.get(anchorOf(u));
      const unit = prev && sameShape(prev.unit.text, u.text) ? prev.unit : u;
      if (unit === u) tracked.set(anchorOf(u), { unit, requested: false });
      byHost.set(u.host, [...(byHost.get(u.host) ?? []), unit]);
    }
    for (const [host, list] of byHost) {
      hostUnits.set(host, list);
      if (how === "region") {
        if (host === root) list.forEach((u) => void request(u));
      } else if (list.some((u) => !tracked.get(anchorOf(u))?.requested)) {
        visibility?.observe(host);
      }
    }
  }

  function onVisible(hosts: readonly Element[]): void {
    for (const host of hosts) {
      visibility?.unobserve(host);
      (hostUnits.get(host) ?? []).forEach((u) => void request(u));
    }
  }

  async function request(u: Unit): Promise<void> {
    const t = tracked.get(anchorOf(u));
    if (!t || t.unit !== u || t.requested) return;
    if (!stillValid(u)) {
      tracked.delete(anchorOf(u)); // never spend quota on text that is no longer on the page
      return;
    }
    if (!isRendered(u)) return; // stays unrequested: a later rescan may find it shown
    update(u, { requested: true });
    if (await deps.isTargetLanguage(plainText(u.text))) return;
    if (!isCurrent(u)) return;

    const wrapper = createWrapper(u, deps.config.targetLang, deps.config.style);
    showLoading(wrapper);
    insertAfter(u, wrapper);
    wrapperAnchor.set(wrapper, anchorOf(u));
    update(u, { wrapper });
    enqueue(u);
  }

  const labels = deps.config.labels;

  function retryView(message: string) {
    return { message, label: labels.retry, requireTrustedClick };
  }

  const pausedView = {
    message: labels.pausedMessage,
    label: labels.paused,
    requireTrustedClick,
  };

  /** One confirmation resumes every paused paragraph. */
  function resumePaused(): void {
    allowance = spent + allowanceStep;
    const resumed = paused;
    paused = [];
    for (const p of resumed) {
      const w = tracked.get(anchorOf(p))?.wrapper;
      if (!isCurrent(p) || !w?.isConnected) continue;
      showLoading(w);
      enqueue(p);
    }
  }

  function enqueue(u: Unit): void {
    const wrapper = tracked.get(anchorOf(u))?.wrapper;
    if (wrapper && spent + u.text.length > allowance) {
      paused = [...paused, u];
      showError(wrapper, pausedView, resumePaused);
      return;
    }
    spent += u.text.length;
    queue = [...queue, u];
    queueTimer ??= setTimeout(flush, queueDelay);
  }

  function flush(): void {
    const items = queue;
    queue = [];
    queueTimer = undefined;
    const limits = { maxChars: deps.config.maxCharsPerBatch, maxItems: deps.config.maxItemsPerBatch };
    chunkBatches(items, (u) => u.text.length, limits).forEach((batch) => void sendBatch(batch));
  }

  async function sendBatch(batch: readonly Unit[]): Promise<void> {
    let results: readonly TranslateResult[];
    try {
      results = await deps.translate(batch.map((u) => u.text));
    } catch (e) {
      results = batch.map(() => ({ ok: false, error: message(e) }));
    }
    batch.forEach((u, i) => {
      const wrapper = tracked.get(anchorOf(u))?.wrapper;
      if (!isCurrent(u) || !wrapper?.isConnected) return;
      const r = results[i] ?? { ok: false, error: "No result returned" };
      if (r.ok && isUnchanged(u, r.text)) {
        removeWrapper(wrapper);
        update(u, { wrapper: undefined });
        return;
      }
      if (r.ok) {
        showTranslation(wrapper, u, r.text);
        if (mode === "translation-only") hideOriginal(u, wrapper);
        return;
      }
      showError(wrapper, retryView(r.error), () => {
        showLoading(wrapper);
        enqueue(u);
      });
    });
  }

  function onMutations(records: readonly MutationRecord[]): void {
    const roots = new Set(pendingRoots);
    for (const r of records) {
      if (isInsideOwn(r.target)) continue;
      // A class flip on <body> or a page wrapper (scroll state, theme) would rescan everything.
      if (r.type === "attributes" && !isWithinScope(r.target)) continue;
      // The page deleted a translation that stood in for its original: show the original again.
      if ([...r.removedNodes].some(isOwnNode)) restoreOrphanedHost(r.target);
      if (r.type === "childList" && [...r.addedNodes, ...r.removedNodes].every(isOwnNode)) continue;
      roots.add(blockAncestor(r.target));
    }
    pendingRoots = roots;
    if (roots.size > 0) mutationTimer ??= setTimeout(processMutations, mutationDelay);
  }

  /** Strictly inside a content root: changes to the roots themselves or their ancestors do not count. */
  function isWithinScope(node: Node): boolean {
    return currentRoots().some((c) => c !== node && c.contains(node));
  }

  function processMutations(): void {
    const changed = [...pendingRoots].filter((r) => r.isConnected);
    pendingRoots = new Set();
    mutationTimer = undefined;
    if (!wholePage) {
      // Only the regions the user asked for are kept up to date.
      regions = new Set([...regions].filter((r) => r.isConnected));
      [...regions].filter((r) => changed.some((x) => x.contains(r) || r.contains(x))).forEach((r) => scan(r, "region"));
      return;
    }
    // Changes outside the content roots are page chrome; a change that replaced a whole root
    // (SPA navigation) is scanned from the new root.
    const scope = currentRoots();
    const targets = new Set<Element>();
    for (const r of changed) {
      if (scope.some((c) => c.contains(r))) targets.add(r);
      else scope.filter((c) => r.contains(c)).forEach((c) => targets.add(c));
    }
    [...targets]
      .filter((r) => ![...targets].some((other) => other !== r && other.contains(r)))
      .filter((r) => !isInsideSkipped(r, scopedOpts))
      .forEach((r) => scan(r));
  }

  function activate(): void {
    if (active) return;
    active = true;
    visibility = deps.createVisibility(onVisible);
    mutations = new MutationObserver(onMutations);
    mutations.observe(deps.root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
    });
  }

  /** Applies the display mode to every finished translation; no new requests. */
  function setMode(next: DisplayMode): void {
    mode = next;
    deps.root.querySelectorAll<HTMLElement>(`bt-tr[${OWN_ATTR}].bt-done`).forEach((w) => {
      const unit = tracked.get(wrapperAnchor.get(w) ?? w)?.unit;
      if (next === "translation-only" && unit) hideOriginal(unit, w);
      else showOriginal(w);
    });
  }

  return {
    /** True while anything is translated: the whole page or hovered regions. */
    isActive: () => active,
    getMode: () => mode,
    setMode,
    start(): void {
      if (wholePage) return;
      wholePage = true;
      regions = new Set();
      activate();
      currentRoots().forEach((r) => scan(r));
    },
    /** Translates the paragraphs of the block that contains `target` (hover translation). */
    translateRegion(target: Element): void {
      if (!deps.root.contains(target) || isInsideOwn(target) || isInsideSkipped(target)) return;
      const region = blockAncestor(target);
      // Holding the key while moving over a paragraph fires for every element in it.
      if (!wholePage && regions.has(region)) return;
      activate();
      if (!wholePage) regions = new Set([...regions, region]);
      scan(region, "region");
    },
    stop(): void {
      if (!active) return;
      active = false;
      wholePage = false;
      regions = new Set();
      scopeRoots = [];
      mutations?.disconnect();
      visibility?.disconnect();
      clearTimeout(queueTimer);
      clearTimeout(mutationTimer);
      queueTimer = mutationTimer = undefined;
      queue = [];
      paused = [];
      pendingRoots = new Set();
      tracked = new WeakMap();
      wrapperAnchor = new WeakMap();
      hostUnits = new WeakMap();
      removeAllTranslations(deps.root);
    },
  };
}
