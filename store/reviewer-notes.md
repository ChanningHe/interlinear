# Store submission notes

Text to paste into the store dashboards. Keep it in sync with the code when permissions or
services change.

## Firefox AMO: Notes to reviewer

```text
interlinear is a bilingual page translator. It has no server: text is sent only to the
translation API the user configures (OpenRouter, OpenAI, Anthropic, Gemini, DeepSeek, Ollama,
LM Studio or a custom OpenAI/Anthropic-compatible endpoint). Source: https://github.com/ChanningHe/interlinear

BUILD (the uploaded source zip is `git archive` of the release tag)
- Requirements: Node.js 22.18 or later (the build script imports .ts files using Node's
  built-in type stripping) and npm. Tested with Node 24 on Linux and macOS.
- Commands:
    npm ci
    npm run build
- Output: dist/firefox is byte-identical to the submitted package. esbuild bundles each entry
  point; the output is intentionally NOT minified. Icons are rendered by scripts/icon.mjs and
  locale files are generated from src/shared/i18n by scripts/build.mjs.

PERMISSIONS
- storage, activeTab, scripting, contextMenus. No host permission at install time.
- optional_host_permissions are requested at runtime, one origin at a time: the API endpoint
  the user configures, sites the user chooses to always translate, and all sites only if the
  user turns on the page helpers everywhere.

SIGN IN WITH CHATGPT (optional service)
- Uses OpenAI's "Sign in with ChatGPT" for apps: OAuth 2.0 authorization code + PKCE as a
  public client, no client secret, dynamic client registration (no borrowed client id).
- OpenAI only accepts the loopback redirect http://127.0.0.1:1455/auth/callback. Nothing
  listens there: the options page watches the sign-in tab (tabs.onUpdated, with runtime host
  access to http://127.0.0.1/*) and reads the code from the tab URL, then closes the tab.
  state, nonce and the PKCE verifier are checked. See src/providers/chatgpt-auth.ts and
  src/options/chatgpt-signin.ts.
- Tokens stay in storage.local (access level TRUSTED_CONTEXTS), are never synced or exported,
  and are only sent to auth.openai.com and api.openai.com.

HOW TO TEST
<paste "Test instructions" below>
```

## Chrome Web Store: Privacy practices

**Single purpose**

```text
Translate web page text, selected text and typed text into the user's language with a
language model service that the user configures, showing the translation next to the original.
```

**Permission justifications**

| Permission | Justification |
|---|---|
| `storage` | Saves the user's settings (services, target language, shortcuts, site rules) locally. |
| `activeTab` | Translates the current tab only after the user clicks the toolbar button, presses a shortcut or uses the context menu. |
| `scripting` | Injects the translation script into the active tab after that user action, instead of running on every page. |
| `contextMenus` | Adds "Translate page / show original" and "Translate selection" items to the right-click menu. |
| Host permissions (optional) | Requested at runtime per origin: the API endpoint the user configures (so requests can reach it), sites the user chooses to always translate, and all sites only if the user turns on the page helpers everywhere. Nothing is granted at install. |

**Remote code**: No, I am not using remote code. All JavaScript is in the package; network
requests only exchange JSON with the user's configured translation API.

**Data usage**: check
- Website content (the text being translated is sent to the user's chosen API)
- Authentication information (the user's own API key / ChatGPT token is sent to that same API)

and certify all three: not sold, not used for unrelated purposes, not used for creditworthiness.

**Privacy policy URL**: https://github.com/ChanningHe/interlinear/blob/main/PRIVACY.md

## Test instructions (both stores)

ch.at is a free community service with no SLA. Check it still answers right before submitting:
`curl -s https://ch.at/v1/chat/completions -H 'content-type: application/json' -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Translate into Japanese: Hello"}]}'`

```text
interlinear needs a translation service to work. It does not include one.

1. After installing, the settings page opens. Click "Add service".
2. Pick "OpenAI-compatible". It can be tested for free, without an account or API key,
   through ch.at (an open-source public LLM gateway, https://github.com/Deep-ai-inc/ch.at):
   - Endpoint URL: https://ch.at/v1/chat/completions
   - API key: leave empty
   - Click Connect and allow access to ch.at when asked.
   - Model ID: gpt-4o (ch.at has no model list, so type it in)
   Backup, limited to 2 requests per minute (enough for a paragraph, not a full page):
   https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions with model
   Meta-Llama-3_3-70B-Instruct (OVHcloud AI Endpoints, anonymous tier).
3. Click Test. A sample translation appears.
4. Open any article (for example https://en.wikipedia.org/wiki/Translation), click the
   toolbar icon and click "Translate this page", or press Alt+Q. Allow access to the site when asked.
   Translations appear under each paragraph; press Alt+Q again to restore the page.
5. Hover a paragraph and tap Alt (Option on macOS) to translate only that paragraph.
```
