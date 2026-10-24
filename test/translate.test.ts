import { describe, expect, test, vi } from "vitest";
import { createTranslator, publicError, type Cache } from "../src/background/translate";
import { ProviderError } from "../src/core/providers";
import { DEFAULT_SETTINGS, type Settings } from "../src/core/settings";

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  targetLang: "zh-Hans",
  providers: [{ id: "p", name: "P", adapter: "custom-openai", options: {}, endpoint: "https://x.test/v1/chat/completions", apiKey: "k", model: "m" }],
  activeProviderId: "p",
};

function memoryCache(): Cache & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (keys) => keys.map((k) => store.get(k)),
    set: async (entries) => entries.forEach(([k, v]) => store.set(k, v)),
  };
}

/** Fake model: translates "[[n]]\nfoo" to "[[n]]\nFOO", optionally dropping some ids. */
function fakeModel(drop: string[] = []) {
  return vi.fn(async (_p: unknown, req: { system: string; user: string }) => {
    if (!req.user.startsWith("[[")) return req.user.toUpperCase();
    return req.user
      .split(/\n(?=\[\[)/)
      .filter((chunk) => !drop.some((d) => chunk.endsWith(`\n${d}`)))
      .map((chunk) => chunk.toUpperCase())
      .join("\n");
  });
}

describe("translator", () => {
  test("reports a clear error when no provider is configured", async () => {
    const t = createTranslator({ getSettings: async () => DEFAULT_SETTINGS, cache: memoryCache(), complete: fakeModel() });
    const res = await t.translate(["a"]);
    expect(res).toEqual([{ ok: false, error: expect.stringContaining("No translation service") }]);
  });

  test("translates a batch in one request and caches results", async () => {
    const complete = fakeModel();
    const cache = memoryCache();
    const t = createTranslator({ getSettings: async () => settings, cache, complete });

    expect(await t.translate(["one", "two"])).toEqual([
      { ok: true, text: "ONE" },
      { ok: true, text: "TWO" },
    ]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(cache.store.size).toBe(2);

    await t.translate(["two", "one"]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test("retries segments the model dropped, one by one", async () => {
    const complete = fakeModel(["two"]);
    const t = createTranslator({ getSettings: async () => settings, cache: memoryCache(), complete });
    const res = await t.translate(["one", "two", "three"]);
    expect(res.map((r) => r.ok && r.text)).toEqual(["ONE", "TWO", "THREE"]);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  test("provider errors fail the batch without fan-out retries", async () => {
    const complete = vi.fn().mockRejectedValue(new ProviderError("HTTP 401: bad key", false, 401));
    const t = createTranslator({ getSettings: async () => settings, cache: memoryCache(), complete });
    const res = await t.translate(["a", "b"]);
    expect(res).toEqual([
      { ok: false, error: expect.stringContaining("HTTP 401") },
      { ok: false, error: expect.stringContaining("HTTP 401") },
    ]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(res)).not.toContain("bad key");
  });

  test("retries segments that lost placeholders and never caches lossy output", async () => {
    // Batch reply drops <x2/>; the single retry drops it again.
    const complete = vi.fn(async (_p: unknown, req: { user: string }) =>
      req.user.startsWith("[[") ? "[[1]]\nRUN\n[[2]]\nOK" : "RUN",
    );
    const cache = memoryCache();
    const t = createTranslator({ getSettings: async () => settings, cache, complete });
    const res = await t.translate(["run <x2/>", "ok"]);
    expect(res).toEqual([
      { ok: true, text: "RUN" },
      { ok: true, text: "OK" },
    ]);
    expect(complete).toHaveBeenCalledTimes(2);
    expect([...cache.store.values()]).toEqual(["OK"]);
  });

  test("incognito requests bypass the persistent cache", async () => {
    const complete = fakeModel();
    const cache = memoryCache();
    const t = createTranslator({ getSettings: async () => settings, cache, complete });
    await t.translate(["x"], { useCache: false });
    await t.translate(["x"], { useCache: false });
    expect(cache.store.size).toBe(0);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  test("public errors never echo server-provided text", () => {
    expect(publicError(new ProviderError("HTTP 500: internal gw.corp.local", true, 500))).toBe("The service returned an error (HTTP 500).");
    expect(publicError(new ProviderError("HTTP 429: slow down", true, 429))).toContain("Rate limited");
    expect(publicError(new ProviderError("Model refused to translate this content", false))).toBe("Model refused to translate this content");
    expect(publicError(new Error("secret"))).toBe("Translation failed");
  });

  test("cache keys depend on target language and model", async () => {
    const complete = fakeModel();
    const cache = memoryCache();
    let current = settings;
    const t = createTranslator({ getSettings: async () => current, cache, complete });
    await t.translate(["x"]);
    current = { ...settings, targetLang: "ja" };
    await t.translate(["x"]);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  test("limits concurrent requests", async () => {
    let inFlight = 0;
    let peak = 0;
    const complete = vi.fn(async (_p: unknown, req: { user: string }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return req.user;
    });
    const limited = { ...settings, concurrency: 2, maxItemsPerBatch: 1 };
    const t = createTranslator({ getSettings: async () => limited, cache: memoryCache(), complete });
    await t.translate(["a", "b", "c", "d", "e"]);
    expect(complete).toHaveBeenCalledTimes(5);
    expect(peak).toBe(2);
  });

  test("a target language override (input box) is used in the prompt and the cache key", async () => {
    const complete = fakeModel();
    const cache = memoryCache();
    const t = createTranslator({ getSettings: async () => settings, cache, complete });
    await t.translate(["hallo"]);
    await t.translate(["hallo"], { targetLang: "en" });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]![1]).toMatchObject({ system: expect.stringContaining("into English") });
  });

  test("only glossary terms present in the batch reach the prompt, and they change the cache key", async () => {
    const complete = fakeModel();
    const cache = memoryCache();
    let current: Settings = { ...settings, glossary: [{ source: "pod", target: "Pod" }, { source: "node", target: "节点" }] };
    const t = createTranslator({ getSettings: async () => current, cache, complete });
    await t.translate(["restart the pod"]);
    const system = complete.mock.calls[0]![1].system;
    expect(system).toContain("- pod → Pod");
    expect(system).not.toContain("节点");

    await t.translate(["restart the pod"]);
    expect(complete).toHaveBeenCalledTimes(1);
    current = { ...current, glossary: [{ source: "pod", target: "容器组" }] };
    await t.translate(["restart the pod"]);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  test("page context is ignored unless the setting is on", async () => {
    const complete = fakeModel();
    let current: Settings = settings;
    const t = createTranslator({ getSettings: async () => current, cache: memoryCache(), complete });
    await t.translate(["x"], { context: "Docs" });
    expect(complete.mock.calls[0]![1].system).not.toContain("Docs");
    current = { ...settings, pageContext: true };
    await t.translate(["x"], { context: "Docs" });
    expect(complete.mock.calls[1]![1].system).toContain('titled "Docs"');
  });
});
