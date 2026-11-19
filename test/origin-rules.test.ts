import { describe, expect, test } from "vitest";
import { originRules } from "../src/background/origin-rules";
import { newProvider, type Provider } from "../src/core/settings";

const EXT_HOST = "abcdefghijklmnop";
const svc = (adapter: Provider["adapter"], endpoint: string, hideOrigin: boolean, id = endpoint): Provider => ({
  ...newProvider(adapter, "x"),
  id,
  endpoint,
  options: { hideOrigin },
});

describe("originRules", () => {
  test("strips Origin only from the extension's own requests to a custom service that asked for it", () => {
    const rules = originRules([svc("custom-openai", "https://api.example.com/v1/chat/completions", true)], EXT_HOST);
    expect(rules).toEqual([
      {
        id: 1,
        priority: 1,
        action: { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "remove" }] },
        condition: { requestDomains: ["api.example.com"], initiatorDomains: [EXT_HOST], resourceTypes: ["xmlhttprequest"] },
      },
    ]);
  });

  test("covers both custom adapters, one rule per host", () => {
    const rules = originRules(
      [
        svc("custom-openai", "https://a.example.com/v1/chat/completions", true, "1"),
        svc("custom-anthropic", "http://127.0.0.1:8080/v1/messages", true, "2"),
        svc("custom-openai", "https://a.example.com/other/chat/completions", true, "3"),
      ],
      EXT_HOST,
    );
    expect(rules.map((r) => [r.id, r.condition.requestDomains])).toEqual([
      [1, ["a.example.com"]],
      [2, ["127.0.0.1"]],
    ]);
  });

  test("skips services with the switch off, other adapters and invalid endpoints", () => {
    const rules = originRules(
      [
        svc("custom-openai", "https://off.example.com/v1/chat/completions", false),
        svc("ollama", "http://localhost:11434/v1/chat/completions", true),
        svc("custom-openai", "not a url", true),
        svc("custom-anthropic", "", true),
      ],
      EXT_HOST,
    );
    expect(rules).toEqual([]);
  });

  test("a non-boolean value never turns it on", () => {
    const p = { ...svc("custom-openai", "https://a.example.com/v1/chat/completions", true), options: { hideOrigin: "true" } };
    expect(originRules([p], EXT_HOST)).toEqual([]);
  });
});
