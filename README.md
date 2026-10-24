# Browser Translate

English | [简体中文](README.zh-Hans.md) | [日本語](README.ja.md)

A bilingual web page translator for Chrome and Firefox that sends text only to the model you configure.

## Features

- Bilingual or translation-only view. Translations appear under each paragraph and keep links and inline formatting.
- Translates the main content and leaves navigation, ads, tooltips, usernames and timestamps alone.
- Translates as you scroll, picks up content that loads later, and restores the original page exactly.
- Translate one paragraph (tap Ctrl over it), selected text, or what you typed in a text field (press Space three times).
- Works with OpenRouter, OpenAI, Anthropic, Gemini, DeepSeek, Ollama, LM Studio and any OpenAI- or Anthropic-compatible endpoint, or sign in with ChatGPT to use your plan.
- Per-service settings tuned for translation, such as reasoning effort and OpenRouter provider preferences.
- Glossary, custom instructions, 13 translation styles and sites that are always translated.
- No account, telemetry or remote configuration. Requests go straight from the browser to your endpoint, site access is asked for one site at a time, and the shipped code is not minified.
- Interface in English, Simplified Chinese, Traditional Chinese and Japanese.

## Install

Download the zip for your browser from [Releases](../../releases).

- Chrome / Edge: unzip it, open `chrome://extensions`, turn on Developer mode, click Load unpacked and select the folder.
- Firefox 128+: open `about:debugging#/runtime/this-firefox`, click Load Temporary Add-on and select the zip. Firefox removes temporary add-ons when it restarts.

To build from source (Node.js 22.18 or later):

```bash
npm ci
npm run build
```

This writes `dist/chrome` and `dist/firefox`, which you load the same way.

## Getting started

The settings page opens after installing. Add a service, connect it with an API key, a ChatGPT sign-in or a local server, pick a model and run Test.

Press Alt+T to translate a page or show the original again, Alt+O to switch between bilingual and translation-only, and Alt+P to translate the paragraph under the pointer. You can change these keys in the settings.

For Ollama, set `OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*` and restart it if requests are rejected.

## Development

```bash
npm test
npm run typecheck
CHROMIUM=/path/to/chromium npm run e2e
```

To release, run `just release 1.2.3`. It sets the version, runs the checks, commits and tags `v1.2.3`; pushing the tag publishes the release.

## License

[MIT](LICENSE)
