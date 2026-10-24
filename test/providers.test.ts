import { afterEach, describe, expect, test, vi } from "vitest";
import { ProviderError, complete } from "../src/core/providers";
import type { Provider } from "../src/core/settings";

const openai: Provider = {
  id: "o",
  name: "OpenAI",
  adapter: "custom-openai",
  options: {},
  endpoint: "https://api.example.com/v1/chat/completions",
  apiKey: "sk-test",
  model: "m1",
};
const anthropic: Provider = { ...openai, id: "a", adapter: "custom-anthropic", endpoint: "https://api.anthropic.com/v1/messages" };
const req = { system: "sys", user: "hello" };
const noSleep = { sleep: async () => {} };

function mockFetch(...responses: Array<Response | Error>) {
  const fn = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) fn.mockRejectedValueOnce(r);
    else fn.mockResolvedValueOnce(r);
  }
  vi.stubGlobal("fetch", fn);
  return fn;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

afterEach(() => vi.unstubAllGlobals());

describe("openai-compatible", () => {
  test("posts chat completion and returns content", async () => {
    const fetchFn = mockFetch(json({ choices: [{ message: { content: "你好" } }] }));
    await expect(complete(openai, req, noSleep)).resolves.toBe("你好");

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      model: "m1",
      stream: true,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
      ],
    });
  });

  test("posts to the endpoint URL exactly as configured, without appending a path", async () => {
    const fetchFn = mockFetch(json({ choices: [{ message: { content: "ok" } }] }));
    await complete({ ...openai, endpoint: "https://proxy.test/openai/deployments/x/chat?api-version=1" }, req, noSleep);
    expect(fetchFn.mock.calls[0]![0]).toBe("https://proxy.test/openai/deployments/x/chat?api-version=1");
  });

  test("omits Authorization header when no key (local endpoints)", async () => {
    const fetchFn = mockFetch(json({ choices: [{ message: { content: "ok" } }] }));
    await complete({ ...openai, apiKey: "" }, req, noSleep);
    expect(fetchFn.mock.calls[0]![1].headers.Authorization).toBeUndefined();
  });

  test("rejects malformed response body", async () => {
    mockFetch(json({ nope: true }));
    await expect(complete(openai, req, noSleep)).rejects.toThrow("Unexpected response shape");
  });
});

describe("anthropic", () => {
  test("sends required headers and joins text blocks", async () => {
    const fetchFn = mockFetch(
      json({
        stop_reason: "end_turn",
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "Bon" },
          { type: "text", text: "jour" },
        ],
      }),
    );
    await expect(complete(anthropic, req, noSleep)).resolves.toBe("Bonjour");

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("sk-test");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(init.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    const body = JSON.parse(init.body);
    expect(body.system).toBe("sys");
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(body).not.toHaveProperty("temperature");
  });

  test("surfaces refusal and truncation as non-retryable errors", async () => {
    mockFetch(json({ stop_reason: "refusal", content: [] }));
    await expect(complete(anthropic, req, noSleep)).rejects.toMatchObject({ retryable: false });
    mockFetch(json({ stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }] }));
    await expect(complete(anthropic, req, noSleep)).rejects.toThrow("truncated");
  });
});

const sse = (events: unknown[], tail = "") =>
  new Response(events.map((e) => (typeof e === "string" ? e : "data: " + JSON.stringify(e))).join("\n\n") + tail, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

describe("streaming", () => {
  test("assembles OpenAI deltas until [DONE]", async () => {
    mockFetch(
      sse(
        [
          ": keep-alive",
          { choices: [{ delta: { role: "assistant" } }] },
          { choices: [{ delta: { content: "你" } }] },
          { choices: [{ delta: { content: "好" }, finish_reason: "stop" }] },
          "data: [DONE]",
        ],
        "\n\n",
      ),
    );
    await expect(complete(openai, req, noSleep)).resolves.toBe("你好");
  });

  test("reports the text received so far after every delta", async () => {
    mockFetch(sse([{ choices: [{ delta: { content: "你" } }] }, { choices: [{ delta: { role: "assistant" } }] }, { choices: [{ delta: { content: "好" } }] }, "data: [DONE]"], "\n\n"));
    const seen: string[] = [];
    await expect(complete(openai, req, { ...noSleep, onText: (t) => seen.push(t) })).resolves.toBe("你好");
    expect(seen).toEqual(["你", "你好"]);
  });

  test("assembles Anthropic text deltas and ignores other events", async () => {
    mockFetch(
      sse([
        { type: "message_start", message: {} },
        { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "Bon" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "jour" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ]),
    );
    await expect(complete(anthropic, req, noSleep)).resolves.toBe("Bonjour");
  });

  test("a stream that ends on max_tokens is a truncation error", async () => {
    mockFetch(sse([{ choices: [{ delta: { content: "part" }, finish_reason: "length" }] }, "data: [DONE]"]));
    await expect(complete(openai, req, noSleep)).rejects.toThrow("truncated");
  });

  test("mid-stream errors are retried and never echo server text", async () => {
    const fetchFn = mockFetch(
      sse([{ type: "error", error: { type: "overloaded_error", message: "internal gw-7.corp" } }]),
      sse([{ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } }]),
    );
    await expect(complete(anthropic, req, noSleep)).resolves.toBe("ok");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("handles events split across network chunks", async () => {
    const enc = new TextEncoder();
    const parts = ["data: {\"choices\":[{\"delta\":{\"content\":\"Hel", "lo\"}}]}\n\ndata: [DONE]\n\n"];
    const body = new ReadableStream({
      start(c) {
        parts.forEach((p) => c.enqueue(enc.encode(p)));
        c.close();
      },
    });
    mockFetch(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    await expect(complete(openai, req, noSleep)).resolves.toBe("Hello");
  });
});

describe("retry policy", () => {
  test("retries 429 and 5xx then succeeds", async () => {
    const ok = json({ choices: [{ message: { content: "ok" } }] });
    const fetchFn = mockFetch(json({}, 429, { "retry-after": "1" }), json({}, 503), ok);
    await expect(complete(openai, req, noSleep)).resolves.toBe("ok");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  test("a stream cut short by an abort is not retried", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
        controller.abort();
        c.error(new DOMException("aborted", "AbortError"));
      },
    });
    const sleep = vi.fn(async () => {});
    const fetchFn = mockFetch(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    await expect(complete(openai, req, { sleep, signal: controller.signal })).rejects.toMatchObject({ retryable: false });
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("retries network errors", async () => {
    const fetchFn = mockFetch(new TypeError("Failed to fetch"), json({ choices: [{ message: { content: "ok" } }] }));
    await expect(complete(openai, req, noSleep)).resolves.toBe("ok");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("does not retry 401 and reports API error message", async () => {
    const fetchFn = mockFetch(json({ error: { message: "Invalid key" } }, 401));
    const err = await complete(openai, req, noSleep).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toBe("HTTP 401: Invalid key");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("gives up after max attempts", async () => {
    const fetchFn = mockFetch(json({}, 500), json({}, 500), json({}, 500));
    await expect(complete(openai, req, noSleep)).rejects.toMatchObject({ status: 500 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});
