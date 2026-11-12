# Privacy Policy

Last updated: 2026-11-12

interlinear is a browser extension that translates web pages with a language model you choose. It has no server of its own. The developer does not receive, collect, store or sell any of your data.

## What leaves your device, and where it goes

When you translate something, interlinear sends a request **directly from your browser to the translation service you configured** in its settings (for example OpenRouter, OpenAI, Anthropic, Google Gemini, DeepSeek, a local server such as Ollama or LM Studio, or any other endpoint you enter). Nothing passes through the developer.

A request contains:

- the text being translated: paragraphs of the current page, text you selected, or text you typed into a field and asked to translate;
- the page title, used only as context to resolve ambiguous words;
- your translation settings for that request: target language, model, style, glossary and custom instructions;
- your credential for that service: the API key you entered, or the access token from signing in with ChatGPT.

Text is only sent after you ask for it: by clicking the toolbar button, pressing a shortcut, using the context menu, or turning on automatic translation for a site you picked.

How the service handles that data is governed by that service's own privacy policy and terms. Read them before you configure a service.

## Signing in with ChatGPT

If you choose "Sign in with ChatGPT", the sign-in happens on OpenAI's own page (`auth.openai.com`). interlinear receives an access token, a refresh token and your account email, and stores them on your device. It also creates a random installation identifier that OpenAI uses to show which app is connected to your account. Signing out or removing the service deletes the tokens. You can also disconnect interlinear from your ChatGPT account settings at any time.

## What is stored on your device

- Settings, including API keys, in the extension's local storage. They are not synced to your browser account.
- ChatGPT sign-in tokens, kept apart from settings. They are never included in a settings export.
- A cache of recent translations in the extension's IndexedDB, so the same text is not sent twice. Entries expire after 30 days, and you can clear the cache in settings.

Uninstalling the extension deletes all of this.

## What interlinear does not do

- No analytics, telemetry, crash reporting, advertising or tracking.
- No account with the developer.
- No remote configuration and no remotely hosted code.
- No access to a website until you grant it. Site access is requested one site at a time.
- No selling, sharing or transferring of user data to anyone. Your data only goes to the translation service you configure, for the single purpose of translating.

## Changes

Changes to this policy are published in this file in the [source repository](https://github.com/ChanningHe/interlinear), with the date above updated.

## Contact

Open an issue at <https://github.com/ChanningHe/interlinear/issues>.
