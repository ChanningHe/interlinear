import { describe, expect, test } from "vitest";
import {
  ALL_SITES,
  DEFAULT_SETTINGS,
  DISPLAY_STYLES,
  GLOSSARY_LIMITS,
  activeProvider,
  exportSettings,
  formatGlossary,
  importSettings,
  normalizeSettings,
  parseGlossary,
  requiredOrigins,
  residentMatches,
  siteFromInput,
  siteOrigin,
  validateProvider,
} from "../src/core/settings";

const provider = {
  id: "p1",
  name: "DeepSeek",
  kind: "openai",
  endpoint: " https://api.deepseek.com/v1/chat/completions ",
  apiKey: "sk-test",
  model: "deepseek-chat",
};

describe("normalizeSettings", () => {
  test("returns defaults for garbage input", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("nope")).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ targetLang: 42, style: "neon" })).toEqual(DEFAULT_SETTINGS);
  });

  test("keeps valid fields and uses the endpoint URL verbatim (trimmed only)", () => {
    const s = normalizeSettings({ targetLang: "ja", providers: [provider], activeProviderId: "p1" });
    expect(s.targetLang).toBe("ja");
    expect(s.providers[0]?.endpoint).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(s.activeProviderId).toBe("p1");
  });

  test("migrates legacy baseUrl settings to full endpoint URLs", () => {
    const s = normalizeSettings({
      providers: [
        { id: "o", kind: "openai", baseUrl: "https://api.deepseek.com/v1/", model: "m" },
        { id: "a", kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "m" },
      ],
    });
    expect(s.providers.map((p) => p.endpoint)).toEqual([
      "https://api.deepseek.com/v1/chat/completions",
      "https://api.anthropic.com/v1/messages",
    ]);
    expect(s.providers[0]).not.toHaveProperty("baseUrl");
  });

  test("clamps numeric limits into safe range", () => {
    const s = normalizeSettings({ maxCharsPerBatch: 10, maxItemsPerBatch: 9999, concurrency: 0 });
    expect(s.maxCharsPerBatch).toBe(200);
    expect(s.maxItemsPerBatch).toBe(100);
    expect(s.concurrency).toBe(1);
    expect(normalizeSettings({ concurrency: 2.5, maxItemsPerBatch: 7.2 })).toMatchObject({ concurrency: 3, maxItemsPerBatch: 7 });
    expect(normalizeSettings({}).concurrency).toBe(6);
  });

  test("drops malformed providers and dangling active id", () => {
    const s = normalizeSettings({
      providers: [{ id: "x", kind: "unknown" }, provider],
      activeProviderId: "x",
    });
    expect(s.providers.map((p) => p.id)).toEqual(["p1"]);
    expect(s.activeProviderId).toBe("p1");
  });

  test("does not mutate input", () => {
    const input = { providers: [{ ...provider }] };
    const snapshot = structuredClone(input);
    normalizeSettings(input);
    expect(input).toEqual(snapshot);
  });
});

describe("validateProvider", () => {
  test("accepts https and local http endpoints", () => {
    expect(validateProvider({ ...provider, adapter: "custom-openai", options: {} })).toEqual([]);
    expect(validateProvider({ ...provider, adapter: "custom-openai", options: {}, endpoint: "http://localhost:11434/v1/chat/completions", apiKey: "" })).toEqual([]);
  });

  test("rejects plaintext remote endpoints and missing fields", () => {
    const errors = validateProvider({ ...provider, adapter: "custom-openai", options: {}, endpoint: "http://example.com/v1/chat/completions", model: "" });
    expect(errors).toContain("endpointInsecure");
    expect(errors).toContain("modelRequired");
  });

  test("requires api key for remote endpoints", () => {
    expect(validateProvider({ ...provider, adapter: "custom-openai", options: {}, apiKey: "" })).toContain("keyRequired");
    expect(validateProvider({ ...provider, adapter: "custom-openai", options: {}, endpoint: "not a url" })).toContain("endpointInvalid");
  });
});

describe("activeProvider", () => {
  test("returns undefined when nothing configured", () => {
    expect(activeProvider(DEFAULT_SETTINGS)).toBeUndefined();
  });
});

describe("new settings fields", () => {
  test("defaults keep helpers on page-local and everything else conservative", () => {
    const s = normalizeSettings({});
    expect(s.displayMode).toBe("bilingual");
    expect(s.everywhere).toBe(false);
    expect(s.autoSites).toEqual([]);
    expect(s.pageContext).toBe(false);
    expect(s.hoverModifier).toBe("alt");
    expect(s.inputTargetLang).toBe("en");
  });

  test("rejects unknown enum values and wrong types", () => {
    const s = normalizeSettings({ displayMode: "both", hoverModifier: "meta", everywhere: "yes", inputTargetLang: "xx", style: "neon" });
    expect(s).toMatchObject({ displayMode: "bilingual", hoverModifier: "alt", everywhere: false, inputTargetLang: "en", style: "plain" });
  });

  test("accepts every documented display style", () => {
    for (const style of DISPLAY_STYLES) expect(normalizeSettings({ style }).style).toBe(style);
  });

  test("auto-translate sites are reduced to unique http(s) origins", () => {
    const s = normalizeSettings({
      autoSites: ["https://a.com/path?q=1", "https://a.com", "http://localhost:3000/x", "chrome://settings", "file:///tmp/x", 42, "junk"],
    });
    expect(s.autoSites).toEqual(["https://a.com", "http://localhost:3000"]);
  });

  test("glossary entries are trimmed, deduplicated case-insensitively and bounded", () => {
    const s = normalizeSettings({
      glossary: [
        { source: " Pod ", target: " Pod\n" },
        { source: "pod", target: "豆荚" },
        { source: "", target: "x" },
        { source: "x".repeat(GLOSSARY_LIMITS.chars + 1), target: "y" },
        "nope",
      ],
    });
    expect(s.glossary).toEqual([{ source: "Pod", target: "Pod" }]);
    const many = Array.from({ length: GLOSSARY_LIMITS.entries + 5 }, (_, i) => ({ source: `t${i}`, target: "x" }));
    expect(normalizeSettings({ glossary: many }).glossary).toHaveLength(GLOSSARY_LIMITS.entries);
  });
});

describe("siteOrigin", () => {
  test.each([
    ["https://example.com/a/b?c", "https://example.com"],
    ["http://localhost:8080/", "http://localhost:8080"],
    ["chrome://extensions", undefined],
    ["about:blank", undefined],
    ["not a url", undefined],
  ])("%s → %s", (url, origin) => {
    expect(siteOrigin(url)).toBe(origin);
  });
});

describe("siteFromInput", () => {
  test.each([
    ["example.com", "https://example.com"],
    ["  www.reddit.com/r/rust/  ", "https://www.reddit.com"],
    ["http://localhost:8080/app", "http://localhost:8080"],
    ["localhost:3000", "https://localhost:3000"],
    ["about:blank", undefined],
    ["HTTPS://News.YCombinator.com", "https://news.ycombinator.com"],
    ["", undefined],
    ["not a site", undefined],
    ["exa%20mple.com", undefined],
    ["例子.中国", "https://xn--fsqu00a.xn--fiqs8s"],
    ["[::1]:8080", "https://[::1]:8080"],
    ["ftp://example.com", undefined],
    ["chrome://extensions", undefined],
  ])("%j → %s", (text, origin) => {
    expect(siteFromInput(text)).toBe(origin);
  });
});

describe("host access derived from settings", () => {
  const base = normalizeSettings({ providers: [provider], activeProviderId: "p1" });

  test("only endpoints by default", () => {
    expect(requiredOrigins(base)).toEqual(["https://api.deepseek.com/*"]);
    expect(residentMatches(base)).toEqual([]);
  });

  test("auto-translate sites add their own origin, ports dropped as match patterns require", () => {
    const s = { ...base, autoSites: ["https://news.example", "http://localhost:3000"] };
    expect(requiredOrigins(s)).toEqual(["https://api.deepseek.com/*", "https://news.example/*", "http://localhost/*"]);
    expect(residentMatches(s)).toEqual(["https://news.example/*", "http://localhost/*"]);
  });

  test("everywhere adds all sites, and sites stay listed in case all-sites access is refused", () => {
    const s = { ...base, everywhere: true, autoSites: ["https://news.example"] };
    expect(requiredOrigins(s)).toEqual(expect.arrayContaining([...ALL_SITES, "https://news.example/*"]));
    expect(residentMatches(s)).toEqual([...ALL_SITES, "https://news.example/*"]);
  });

  test("invalid endpoints are skipped instead of throwing", () => {
    const s = normalizeSettings({ providers: [{ ...provider, endpoint: "::nope" }] });
    expect(requiredOrigins(s)).toEqual([]);
  });
});

describe("export / import", () => {
  const current = normalizeSettings({ providers: [provider], activeProviderId: "p1", targetLang: "ja" });

  test("export leaves API keys out unless asked", () => {
    expect(JSON.parse(exportSettings(current, false)).providers[0].apiKey).toBe("");
    expect(JSON.parse(exportSettings(current, true)).providers[0].apiKey).toBe("sk-test");
  });

  test("import round-trips and keeps the existing key for a key-less provider with the same id", () => {
    const imported = importSettings(exportSettings({ ...current, targetLang: "de" }, false), current);
    expect(imported.targetLang).toBe("de");
    expect(imported.providers[0]?.apiKey).toBe("sk-test");
  });

  test("import never moves a stored key to another endpoint or API format", () => {
    const moved = { ...current, providers: [{ ...current.providers[0]!, endpoint: "https://evil.example/v1/chat/completions" }] };
    expect(importSettings(exportSettings(moved, false), current).providers[0]?.apiKey).toBe("");
    const reformatted = { ...current, providers: [{ ...current.providers[0]!, adapter: "custom-anthropic" as const }] };
    expect(importSettings(exportSettings(reformatted, false), current).providers[0]?.apiKey).toBe("");
  });

  test("import validates like stored data", () => {
    const imported = importSettings(JSON.stringify({ style: "neon", concurrency: 999, autoSites: ["javascript:alert(1)"] }), current);
    expect(imported).toMatchObject({ style: "plain", concurrency: 32, autoSites: [] });
  });

  test("import rejects files that are not JSON", () => {
    expect(() => importSettings("not json", current)).toThrow();
  });
});

describe("glossary text format", () => {
  test("parses one term per line and ignores lines without '='", () => {
    expect(parseGlossary("Pod = Pod\nnoise\n= x\nCI/CD = 持续集成 = 交付\n")).toEqual([
      { source: "Pod", target: "Pod" },
      { source: "CI/CD", target: "持续集成 = 交付" },
    ]);
  });

  test("formats back to the same text", () => {
    const g = [{ source: "a", target: "b" }];
    expect(parseGlossary(formatGlossary(g))).toEqual(g);
  });
});
