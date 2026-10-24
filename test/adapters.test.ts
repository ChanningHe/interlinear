import { afterEach, describe, expect, test, vi } from "vitest";
import { complete, ProviderError } from "../src/core/providers";
import { newProvider, normalizeSettings, requiredOrigins, validateProvider, type Provider } from "../src/core/settings";
import { ADAPTERS, adapterOf, modelsUrl, normalizeOptions, outputOptions } from "../src/providers/adapters";
import {
  REDIRECT_URI,
  SignedOutError,
  authorizeUrl,
  callbackFrom,
  claimsOf,
  codeChallenge,
  exchangeCode,
  hostId,
  newPendingSignIn,
  parseCallback,
  refreshCredential,
} from "../src/providers/chatgpt-auth";
import { parseModels } from "../src/providers/models";

const body = (p: Provider) => adapterOf(p.adapter).body(p.options, p.model);
const svc = (adapter: Provider["adapter"], patch: Partial<Provider> = {}): Provider => ({ ...newProvider(adapter, "x"), ...patch });

describe("adapter catalog", () => {
  test("every adapter has valid defaults and a label", () => {
    for (const a of ADAPTERS) {
      expect(normalizeOptions(a, {})).toEqual(Object.fromEntries(a.options.map((f) => [f.key, f.default])));
      if (!a.editableEndpoint) expect(a.endpoint).toMatch(/^https:\/\//);
    }
  });

  test("normalizeOptions keeps valid values and drops unknown keys and bad values", () => {
    const spec = adapterOf("openrouter");
    const o = normalizeOptions(spec, { reasoning: "high", sort: "bogus", zdr: "yes", order: [" groq ", "groq", 3, ""], evil: "x" });
    expect(o).toMatchObject({ reasoning: "high", sort: "throughput", zdr: false, order: ["groq"] });
    expect(o).not.toHaveProperty("evil");
  });

  test("only output-affecting options join the cache key", () => {
    const spec = adapterOf("openrouter");
    const a = outputOptions(spec, normalizeOptions(spec, { reasoning: "low", sort: "price" }));
    const b = outputOptions(spec, normalizeOptions(spec, { reasoning: "low", sort: "latency" }));
    expect(a).toEqual(b);
    expect(outputOptions(spec, normalizeOptions(spec, { reasoning: "high" }))).not.toEqual(a);
  });
});

describe("request bodies", () => {
  test("OpenRouter: reasoning off, throughput routing and no data collection by default", () => {
    expect(body(svc("openrouter"))).toEqual({ reasoning: { effort: "none" }, provider: { sort: "throughput", data_collection: "deny" } });
    const custom = svc("openrouter", {
      options: { reasoning: "medium", sort: "default", dataCollection: false, order: ["groq"], ignore: ["x"], zdr: true, allowFallbacks: false },
    });
    expect(body(custom)).toEqual({
      reasoning: { effort: "medium" },
      provider: { order: ["groq"], ignore: ["x"], zdr: true, allow_fallbacks: false },
    });
  });

  test("OpenAI: low reasoning by default, nothing for model default, flex tier on request", () => {
    expect(body(svc("openai"))).toEqual({ reasoning_effort: "low" });
    expect(body(svc("openai", { options: { reasoning: "default", serviceTier: "flex" } }))).toEqual({ service_tier: "flex" });
    expect(body(svc("openai", { options: { reasoning: "off", serviceTier: "auto" } }))).toEqual({ reasoning_effort: "none" });
  });

  test("Anthropic: the cheapest valid thinking setting per Claude family", () => {
    const at = (model: string) => body(svc("anthropic", { model }));
    expect(at("claude-haiku-5-5")).toEqual({ output_config: { effort: "low" }, thinking: { type: "disabled" } });
    expect(at("claude-sonnet-5-5")).toEqual({ output_config: { effort: "low" }, thinking: { type: "between_tools" } });
    expect(at("claude-opus-5-5")).toEqual({ output_config: { effort: "low" } });
    expect(at("claude-opus-5")).toEqual({ output_config: { effort: "low" }, thinking: { type: "disabled" } });
    expect(at("claude-haiku-4-5")).toEqual({}); // effort is rejected by older models
  });

  test("ChatGPT, Ollama and plain services", () => {
    expect(body(svc("chatgpt"))).toEqual({ reasoning: { effort: "low" } });
    expect(body(svc("ollama"))).toEqual({ think: false, reasoning_effort: "none" });
    expect(body(svc("ollama", { options: { think: true } }))).toEqual({});
    expect(body(svc("deepseek"))).toEqual({});
  });
});

describe("services in settings", () => {
  test("fixed-endpoint types ignore a stored endpoint; legacy kind entries become custom types", () => {
    const s = normalizeSettings({
      providers: [
        { id: "a", adapter: "openrouter", endpoint: "https://evil.example/v1", model: "m", apiKey: "k" },
        { id: "b", kind: "anthropic", endpoint: "https://proxy.example/v1/messages", model: "m" },
        { id: "c", adapter: "chatgpt", apiKey: "should not be kept", model: "m" },
        { id: "d", adapter: "unknown" },
      ],
    });
    expect(s.providers.map((p) => [p.adapter, p.endpoint])).toEqual([
      ["openrouter", "https://openrouter.ai/api/v1/chat/completions"],
      ["custom-anthropic", "https://proxy.example/v1/messages"],
      ["chatgpt", "https://api.openai.com/v1/responses"],
    ]);
    expect(s.providers[2]!.apiKey).toBe("");
  });

  test("key rules follow the type's sign-in method", () => {
    expect(validateProvider(svc("openrouter", { model: "m" }))).toEqual(["keyRequired"]);
    expect(validateProvider(svc("chatgpt", { model: "m" }))).toEqual([]);
    expect(validateProvider(svc("ollama", { model: "m" }))).toEqual([]);
    expect(validateProvider(svc("custom-openai", { model: "m", endpoint: "https://x.example/v1/chat/completions" }))).toEqual(["keyRequired"]);
  });

  test("ChatGPT services also need access to the sign-in host", () => {
    const s = normalizeSettings({ providers: [{ id: "c", adapter: "chatgpt", model: "m" }] });
    expect(requiredOrigins(s)).toEqual(["https://api.openai.com/*", "https://auth.openai.com/*"]);
  });

  test("model list URLs are derived from the request URL", () => {
    expect(modelsUrl(adapterOf("openrouter"), "https://openrouter.ai/api/v1/chat/completions")).toBe("https://openrouter.ai/api/v1/models");
    expect(modelsUrl(adapterOf("ollama"), "http://localhost:11434/v1/chat/completions")).toBe("http://localhost:11434/api/tags");
    expect(modelsUrl(adapterOf("custom-anthropic"), "https://p.example/v1/messages")).toBe("https://p.example/v1/models");
    expect(modelsUrl(adapterOf("custom-openai"), "https://p.example/odd/path")).toBeUndefined();
  });
});

describe("model lists", () => {
  test("OpenRouter: prices per million, reasoning support and efforts", () => {
    const models = parseModels("openrouter", {
      data: [
        { id: "a/fast", name: "Fast", context_length: 1000000, pricing: { prompt: "0.0000003", completion: "0.0000025" }, supported_parameters: ["reasoning"] },
        { id: "b/think", pricing: {}, reasoning: { mandatory: true, supported_efforts: ["low", "high"] } },
        { id: "c/plain", pricing: { prompt: "0", completion: "0" } },
        { name: "no id" },
        "junk",
      ],
    });
    expect(models).toEqual([
      { id: "a/fast", name: "Fast", context: 1000000, priceIn: 0.3, priceOut: 2.5, reasoning: "optional", efforts: undefined },
      { id: "b/think", name: undefined, context: undefined, priceIn: undefined, priceOut: undefined, reasoning: "mandatory", efforts: ["low", "high"] },
      { id: "c/plain", name: undefined, context: undefined, priceIn: 0, priceOut: 0, reasoning: "none", efforts: undefined },
    ]);
  });

  test("OpenAI-style lists drop models that cannot translate text; Ollama and Anthropic shapes", () => {
    const ids = parseModels("openai", { data: [{ id: "gpt-x" }, { id: "text-embedding-3" }, { id: "whisper-1" }, { id: "a-model" }] }).map((m) => m.id);
    expect(ids).toEqual(["a-model", "gpt-x"]);
    expect(parseModels("ollama", { models: [{ name: "qwen3.5:14b", size: 9_000_000_000 }] })).toEqual([{ id: "qwen3.5:14b", size: 9_000_000_000 }]);
    expect(parseModels("anthropic", { data: [{ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", max_input_tokens: 1000000 }] })).toEqual([
      { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", context: 1000000 },
    ]);
    expect(parseModels("openai", null)).toEqual([]);
  });

  test("ChatGPT plan lists keep only listed models, by slug, in the server's order", () => {
    const models = parseModels("chatgpt", {
      models: [
        { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
        { slug: "internal-x", display_name: "Hidden", visibility: "hide" },
        { slug: "gpt-6.1-mini", display_name: "GPT-6.1 mini", visibility: "list" },
        { display_name: "No slug", visibility: "list" },
      ],
    });
    expect(models).toEqual([
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
      { id: "gpt-6.1-mini", name: "GPT-6.1 mini" },
    ]);
    expect(adapterOf("chatgpt").models).toBe("chatgpt");
  });
});

const sse = (events: readonly unknown[]) =>
  new Response(events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

describe("Responses wire (ChatGPT plan usage)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const chatgpt = svc("chatgpt", { model: "gpt-6.1-sol" });

  test("sends a streamed, unstored request with the bearer token and joins text deltas", async () => {
    const fetchMock = vi.fn(async () =>
      sse([{ type: "response.created" }, { type: "response.output_text.delta", delta: "你好" }, { type: "response.output_text.delta", delta: "，世界" }, { type: "response.completed" }]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const text = await complete(chatgpt, { system: "S", user: "Hello" }, { accessToken: async () => "tok" });
    expect(text).toBe("你好，世界");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt-6.1-sol",
      instructions: "S",
      input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
      stream: true,
      store: false,
      reasoning: { effort: "low" },
    });
  });

  test("a stream sent without an event-stream content type is still read as a stream", async () => {
    const body = (type: string) => {
      const res = sse([{ type: "response.output_text.delta", delta: "你好" }, { type: "response.completed" }]);
      return new Response(res.body, { headers: type ? { "content-type": type } : {} });
    };
    for (const type of ["application/json", "text/plain; charset=utf-8", ""]) {
      vi.stubGlobal("fetch", vi.fn(async () => body(type)));
      expect(await complete(chatgpt, { system: "S", user: "Hello" }, { accessToken: async () => "tok" })).toBe("你好");
    }
  });

  test("a plan usage limit mid-stream is final, not retried", async () => {
    const fetchMock = vi.fn(async () => sse([{ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } }]));
    vi.stubGlobal("fetch", fetchMock);
    const err = await complete(chatgpt, { system: "S", user: "x" }, { accessToken: async () => "t", sleep: async () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
    expect((err as Error).message).toMatch(/usage limit/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("without a token nothing is sent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(complete(chatgpt, { system: "S", user: "x" }, {})).rejects.toThrow(/Not signed in/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const jwt = (claims: Record<string, unknown>) => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.s`;
const NOW = 1_800_000_000_000;

describe("ChatGPT sign-in", () => {
  test("host id is a persisted urn:uuid; a bare UUID from older builds is replaced", async () => {
    const store: Record<string, unknown> = { chatgptHostId: "6f1c2d3e-0000-4000-8000-000000000000" };
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
          set: async (items: Record<string, unknown>) => void Object.assign(store, items),
        },
      },
    });
    const first = await hostId();
    expect(first).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(store.chatgptHostId).toBe(first);
    expect(await hostId()).toBe(first);
    vi.unstubAllGlobals();
  });

  test("authorize URL: first registration uses the dynamic client and names the app", async () => {
    const pending = newPendingSignIn();
    const url = new URL(await authorizeUrl(pending, "host-1"));
    const q = Object.fromEntries(url.searchParams);
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(q).toMatchObject({
      client_id: "dynamic_agent_client",
      agent_name_hint: "interlinear",
      ext_agent_host_id: "host-1",
      redirect_uri: REDIRECT_URI,
      resource: "https://api.openai.com/v1",
      code_challenge_method: "S256",
      state: pending.state,
      nonce: pending.nonce,
    });
    expect(q.scope).toContain("chatgpt.tokens.use.direct");
    expect(q.code_challenge).toBe(await codeChallenge(pending.verifier));
    const again = new URL(await authorizeUrl(newPendingSignIn("oaiapp_1"), "host-1"));
    expect(again.searchParams.get("client_id")).toBe("oaiapp_1");
    expect(again.searchParams.has("agent_name_hint")).toBe(false);
  });

  test("callback: state, code and issued client id are checked", () => {
    const pending = newPendingSignIn();
    const ok = `${REDIRECT_URI}?code=c1&state=${pending.state}&client_id=oaiapp_9`;
    expect(parseCallback(ok, pending)).toEqual({ code: "c1", clientId: "oaiapp_9" });
    expect(() => parseCallback(`${REDIRECT_URI}?code=c1&state=wrong&client_id=oaiapp_9`, pending)).toThrow(/state/);
    expect(() => parseCallback(`${REDIRECT_URI}?error=access_denied`, pending)).toThrow(/cancelled/);
    expect(() => parseCallback(`${REDIRECT_URI}?code=c1&state=${pending.state}`, pending)).toThrow(/client id/);
    const re = newPendingSignIn("oaiapp_1");
    expect(() => parseCallback(`${REDIRECT_URI}?code=c&state=${re.state}&client_id=oaiapp_2`, re)).toThrow(/unexpected client id/);
  });

  test("the callback is recognised directly or inside a browser error page", () => {
    const cb = `${REDIRECT_URI}?code=c&state=s`;
    expect(callbackFrom(cb)).toBe(cb);
    expect(callbackFrom(`about:neterror?e=connectionFailure&u=${encodeURIComponent(cb)}&c=UTF-8`)).toBe(cb);
    expect(callbackFrom("https://auth.openai.com/login")).toBeUndefined();
    expect(callbackFrom(`about:neterror?u=${encodeURIComponent("http://127.0.0.1:1455/elsewhere")}`)).toBeUndefined();
  });

  test("non-ASCII emails survive ID token decoding", () => {
    const claims = { iss: "https://auth.openai.com", aud: "a", exp: NOW / 1000 + 60, sub: "u", email: "张三@例子.中国" };
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(claims)))).replace(/=+$/, "");
    expect(claimsOf(`h.${b64}.s`, "a", NOW).email).toBe("张三@例子.中国");
  });

  test("ID token claims: issuer, audience, expiry and nonce", () => {
    const good = { iss: "https://auth.openai.com", aud: "oaiapp_1", exp: NOW / 1000 + 60, nonce: "n", sub: "u1", email: "a@b.c" };
    expect(claimsOf(jwt(good), "oaiapp_1", NOW, "n")).toEqual({ email: "a@b.c", sub: "u1" });
    expect(() => claimsOf(jwt({ ...good, iss: "https://evil" }), "oaiapp_1", NOW, "n")).toThrow(/issuer/);
    expect(() => claimsOf(jwt({ ...good, aud: "other" }), "oaiapp_1", NOW, "n")).toThrow(/audience/);
    expect(() => claimsOf(jwt({ ...good, exp: NOW / 1000 - 1 }), "oaiapp_1", NOW, "n")).toThrow(/expired/);
    expect(() => claimsOf(jwt(good), "oaiapp_1", NOW, "other")).toThrow(/nonce/);
  });

  test("code exchange posts PKCE fields to the token endpoint", async () => {
    const pending = newPendingSignIn();
    const fetchMock = vi.fn(async (_u: unknown, _i?: RequestInit) =>
      new Response(
        JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          id_token: jwt({ iss: "https://auth.openai.com", aud: "oaiapp_1", exp: NOW / 1000 + 600, nonce: pending.nonce, sub: "u", email: "e@x" }),
        }),
        { status: 200 },
      ),
    );
    const cred = await exchangeCode("code", "oaiapp_1", pending, fetchMock as unknown as typeof fetch, NOW);
    expect(cred).toEqual({ clientId: "oaiapp_1", accessToken: "at", refreshToken: "rt", expiresAt: NOW + 3_600_000, email: "e@x", sub: "u" });
    const form = Object.fromEntries(new URLSearchParams(fetchMock.mock.calls[0]![1]!.body as string));
    expect(form).toMatchObject({ grant_type: "authorization_code", client_id: "oaiapp_1", code_verifier: pending.verifier, redirect_uri: REDIRECT_URI });
    expect(form).not.toHaveProperty("client_secret");
  });

  test("refresh rotates tokens; invalid_grant means signed out", async () => {
    const cred = { clientId: "c", accessToken: "a", refreshToken: "r1", expiresAt: NOW, email: "e", sub: "s" };
    const rotate = vi.fn(async () => new Response(JSON.stringify({ access_token: "a2", refresh_token: "r2", expires_in: 3600 }), { status: 200 }));
    const next = await refreshCredential(cred, rotate as unknown as typeof fetch, NOW);
    expect(next).toMatchObject({ accessToken: "a2", refreshToken: "r2", email: "e" });
    // Once the server has rotated, an odd ID token must not throw the new refresh token away.
    const oddToken = vi.fn(async () => new Response(JSON.stringify({ access_token: "a3", refresh_token: "r3", id_token: jwt({ iss: "x" }) }), { status: 200 }));
    expect(await refreshCredential(cred, oddToken as unknown as typeof fetch, NOW)).toMatchObject({ refreshToken: "r3", sub: "s" });
    const revoked = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    await expect(refreshCredential(cred, revoked as unknown as typeof fetch, NOW)).rejects.toBeInstanceOf(SignedOutError);
  });
});
