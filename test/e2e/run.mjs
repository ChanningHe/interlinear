// End-to-end test: loads dist/e2e into a real Chromium, serves a test page plus a mock
// OpenAI-compatible API on 127.0.0.1, and drives the full translate / restore flow.
// Usage: CHROMIUM=/path/to/chromium npm run e2e
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = join(root, "dist", "e2e");
const executablePath = process.env.CHROMIUM;
const screenshotDir = process.env.SCREENSHOT_DIR;
if (!executablePath) {
  throw new Error("Set CHROMIUM to a Chromium binary (branded Chrome no longer loads unpacked extensions from the CLI)");
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>E2E</title></head>
<body style="font:16px/1.5 sans-serif;max-width:640px;margin:24px auto">
  <h1>Hello World Title</h1>
  <p id="p1">This is a <a href="/target">simple link</a> inside a paragraph with <code>npm install</code> code.</p>
  <ul><li>First list item</li><li>Second list item</li></ul>
  <p id="zh">这是一段很长的中文内容，用于测试同语言跳过的功能是否正常工作，它不应该被翻译。浏览器内置的语言检测需要足够长的文本才能可靠识别语言。</p>
  <form id="f"><input name="q"> <button type="submit">Search now</button></form>
  <p id="icon"><a href="/x"><svg width="12" height="12"><circle cx="6" cy="6" r="5"/></svg> Icon link text</a></p>
  <span id="sr" style="position:absolute;width:1px;height:1px;overflow:hidden">Screen reader label</span>
  <div style="height:4000px"></div>
  <p id="far">Paragraph far below the fold.</p>
  <div id="tabs"><div id="panel" hidden>Hidden tab panel content.</div></div>
  <div id="dyn"></div>
</body></html>`;

/** Layouts that hide or move translations: a clamped preview, a fallback <object>, a component. */
const LAYOUT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Layout</title>
<style>.clamped { width: 300px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden } .clamped p { display: inline }</style>
</head><body style="font:16px/1.5 sans-serif;max-width:640px;margin:24px auto">
  <div id="feed"><div id="clamp" class="clamped"><p>A long preview of a forum post that the site cuts off after two lines, so anything appended after it would never be seen by the reader at all.</p></div></div>
  <div id="feed2"><div id="clamp2" class="clamped"><p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="12" height="12" alt=""> A preview with a picture in it, long enough that the site cuts it off after two lines of text for every reader.</p></div></div>
  <div style="display: flex; width: 300px"><a id="oneline" href="/c" style="display: block; height: 1.5em; overflow: hidden; white-space: nowrap; text-overflow: ellipsis">Merge branch with a long commit message that cannot fit in one line</a></div>
  <div id="pane" style="height: 60px; overflow: auto; width: 300px"><p>A paragraph in a scrolling pane that runs past the bottom edge of the pane, which the reader can scroll to and read in full.</p></div>
  <p id="obj">See <object role="none"><a href="/guide">the setup guide</a></object> for every detail.</p>
  <x-card id="card"><span slot="title">Slotted card title words</span>Unslotted counter words here</x-card>
  <div id="live"><p id="tick">Posted by <a href="/u">someone</a> about the next release</p></div>
  <script>
    customElements.define("x-card", class extends HTMLElement {
      constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<b><slot name=title></slot></b>"; }
    });
    setInterval(() => document.getElementById("live").classList.toggle("on"), 150);
  </script>
</body></html>`;

const MARKER = /^\[\[(\d+)\]\]$/;

/** Mock model: prefixes every segment with [ZH], keeping placeholders intact. */
function fakeTranslate(user) {
  if (!user.startsWith("[[")) return `[ZH] ${user}`;
  return user
    .split("\n")
    .map((line) => (MARKER.test(line) ? line : `[ZH] ${line}`))
    .join("\n");
}

function startServer() {
  const requests = [];
  const server = createServer((req, res) => {
    const path = req.method === "GET" ? new URL(req.url, "http://x").pathname : "";
    if (path === "/page.html" || path === "/layout.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(path === "/page.html" ? PAGE : LAYOUT_PAGE);
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        requests.push(parsed);
        const content = fakeTranslate(parsed.messages.at(-1).content);
        if (!parsed.stream) {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content } }] }));
          return;
        }
        // Stream in small chunks, deliberately splitting events across writes.
        res.writeHead(200, { "content-type": "text/event-stream" });
        const events = content.match(/[\s\S]{1,7}/g).map((c) => "data: " + JSON.stringify({ choices: [{ delta: { content: c } }] }) + "\n\n");
        const wire = events.join("") + "data: [DONE]\n\n";
        let i = 0;
        const tick = setInterval(() => {
          res.write(wire.slice(i, i + 40));
          i += 40;
          if (i >= wire.length) {
            clearInterval(tick);
            res.end();
          }
        }, 2);
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port })));
}

async function step(name, fn) {
  process.stdout.write(`• ${name} … `);
  await fn();
  console.log("ok");
}

const { server, requests, port } = await startServer();
const userDataDir = await mkdtemp(join(tmpdir(), "bt-e2e-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath,
  headless: true,
  chromiumSandbox: false,
  // The UI follows the browser language ("auto"); assertions below use the English strings.
  locale: "en-US",
  viewport: { width: 1000, height: 720 },
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  const pageUrl = `http://127.0.0.1:${port}/page.html`;

  await step("configure provider", () =>
    worker.evaluate(
      (endpoint) =>
        chrome.storage.local.set({
          settings: {
            targetLang: "zh-Hans",
            activeProviderId: "mock",
            providers: [{ id: "mock", name: "Mock", kind: "openai", endpoint, apiKey: "", model: "mock-1" }],
          },
        }),
      `http://127.0.0.1:${port}/v1/chat/completions`,
    ),
  );

  const page = await context.newPage();
  await page.goto(pageUrl);
  const originalBody = await page.evaluate(() => document.body.innerHTML);
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const toggle = () =>
    options.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return chrome.runtime.sendMessage({ type: "toggle-tab", tabId: tab.id });
    }, pageUrl);

  await step("translate visible paragraphs in batched requests (concurrent toggles collapse)", async () => {
    const [first, second] = await Promise.all([toggle(), toggle()]);
    assert.deepEqual(first, { active: true, mode: "bilingual" });
    assert.deepEqual(second, { active: true, mode: "bilingual" });
    await page.bringToFront();
    await page.waitForSelector("#p1 bt-tr.bt-done", { timeout: 10_000 });
    const p1 = await page.$eval("#p1 bt-tr", (el) => ({
      text: el.textContent,
      href: el.querySelector("a")?.getAttribute("href"),
      code: el.querySelector("code")?.textContent,
    }));
    assert.match(p1.text, /^\[ZH\] This is a simple link/);
    assert.equal(p1.href, "/target");
    assert.equal(p1.code, "npm install");
    assert.match(await page.$eval("h1 bt-tr", (el) => el.textContent), /\[ZH\] Hello World Title/);
    assert.equal(await page.$$eval("li bt-tr.bt-done", (els) => els.length), 2);
    assert.ok(requests.length <= 2, `expected batching, got ${requests.length} requests`);
  });

  await step("keep controls, icons and screen-reader text out of translations", async () => {
    await page.waitForSelector("#icon bt-tr.bt-done", { timeout: 10_000 });
    assert.equal(await page.$$eval("bt-tr input, bt-tr button, bt-tr svg", (els) => els.length), 0);
    // Main-content scope (the default) leaves control labels alone.
    assert.equal(await page.$("#f bt-tr"), null);
    assert.equal(await page.$("#sr bt-tr"), null);
    assert.ok(!requests.some((r) => JSON.stringify(r).includes("Screen reader label")), "never sent");
  });

  await step("skip text already in the target language", async () => {
    assert.equal(await page.$("#zh bt-tr"), null);
  });

  await step("translate lazily on scroll", async () => {
    assert.equal(await page.$("#far bt-tr"), null);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForSelector("#far bt-tr.bt-done", { timeout: 10_000 });
  });

  await step("translate hidden content once it is shown", async () => {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    assert.equal(await page.$("#panel bt-tr"), null);
    await page.evaluate(() => (document.getElementById("panel").hidden = false));
    await page.waitForSelector("#panel bt-tr.bt-done", { timeout: 10_000 });
    assert.equal(await page.$$eval("#p1 bt-tr", (els) => els.length), 1, "exactly one translation per paragraph");
  });

  await step("translate content added later", async () => {
    await page.evaluate(() => {
      const p = document.createElement("p");
      p.id = "late";
      p.textContent = "Content loaded dynamically by the page.";
      document.getElementById("dyn").append(p);
    });
    await page.waitForSelector("#late bt-tr.bt-done", { timeout: 10_000 });
  });

  if (screenshotDir) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(screenshotDir, "e2e-page.png") });
  }

  const setMode = (mode) =>
    options.evaluate(
      async ([url, mode]) => {
        const [tab] = await chrome.tabs.query({ url });
        return chrome.runtime.sendMessage({ type: "set-mode", tabId: tab.id, mode });
      },
      [pageUrl, mode],
    );

  await step("translation only hides originals and switches back without new requests", async () => {
    const before = requests.length;
    const margins = () => page.$eval("h1", (el) => [getComputedStyle(el).marginTop, getComputedStyle(el).marginBottom]);
    const bilingualMargins = await margins();
    assert.deepEqual(await setMode("translation-only"), { active: true, mode: "translation-only" });
    assert.deepEqual(await margins(), bilingualMargins, "em-based margins survive font-size 0");
    const p1 = await page.$eval("#p1", (el) => ({
      only: el.hasAttribute("data-bt-only"),
      hostSize: getComputedStyle(el).fontSize,
      translationSize: getComputedStyle(el.querySelector("bt-tr")).fontSize,
      linkHidden: getComputedStyle(el.querySelector(":scope > a")).display === "none",
    }));
    assert.deepEqual(p1, { only: true, hostSize: "0px", translationSize: "16px", linkHidden: true });
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "e2e-translation-only.png") });
    await setMode("bilingual");
    assert.equal(await page.$("[data-bt-only]"), null);
    assert.equal(requests.length, before);
  });

  await step("restore the original page exactly", async () => {
    // The page itself changed since load (dynamic paragraph, browser-added attributes), so the
    // expectation is "current page minus our <bt-tr> nodes": nothing else may differ.
    const expected = await page.evaluate(() => {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("bt-tr[data-bt]").forEach((n) => n.remove());
      return clone.innerHTML;
    });
    assert.notEqual(expected, originalBody.replace('<div id="dyn"></div>', ""), "sanity: page changed during test");
    assert.deepEqual(await toggle(), { active: false, mode: "bilingual" });
    assert.equal(await page.evaluate(() => document.body.innerHTML), expected);
    assert.equal(await page.$("bt-tr"), null);
  });

  await step("re-translate from cache without new API calls", async () => {
    const before = requests.length;
    await page.evaluate(() => window.scrollTo(0, 0)); // #p1 must be near the viewport to be translated
    await toggle();
    await page.waitForSelector("#p1 bt-tr.bt-done", { timeout: 10_000 });
    assert.equal(requests.length, before);
  });

  await step("translations stay visible and steady in clamped, wrapped and live layouts", async () => {
    const layoutUrl = `http://127.0.0.1:${port}/layout.html`;
    const layout = await context.newPage();
    await layout.goto(layoutUrl);
    const send = (message) =>
      options.evaluate(
        async ([url, message]) => {
          const [tab] = await chrome.tabs.query({ url });
          return chrome.runtime.sendMessage({ ...message, tabId: tab.id });
        },
        [layoutUrl, message],
      );
    await layout.bringToFront();
    await send({ type: "toggle-tab" });
    await layout.waitForFunction(() => document.querySelectorAll("bt-tr.bt-done").length >= 7, null, { timeout: 10_000 });
    await layout.waitForTimeout(300); // translations are measured for clipping on the next frame

    // A translation the clamped preview would cut off is moved after it, clamped to two lines.
    const clamp = await layout.evaluate(() => {
      const box = document.getElementById("clamp");
      const tr = box.nextElementSibling;
      const r = tr?.getBoundingClientRect();
      return { moved: tr?.matches("bt-tr.bt-moved.bt-done") ?? false, shown: (r?.height ?? 0) > 0, below: (r?.top ?? 0) >= box.getBoundingClientRect().bottom - 1, lines: tr ? getComputedStyle(tr).webkitLineClamp : "" };
    });
    assert.deepEqual(clamp, { moved: true, shown: true, below: true, lines: "2" });
    // A one-line box in a flex row has no room for both and nowhere to move the translation to:
    // the translation takes the original's place.
    assert.equal(await layout.evaluate(() => { const a = document.getElementById("oneline"); return a.hasAttribute("data-bt-only") && (a.querySelector("bt-tr")?.getBoundingClientRect().height ?? 0) > 0; }), true);
    // A scrolling pane does not clip: its translation stays with its paragraph.
    assert.deepEqual(await layout.evaluate(() => ({ inside: document.querySelector("#pane bt-tr")?.matches(".bt-done:not(.bt-moved)") ?? false, after: document.querySelector("#pane + bt-tr") !== null })), { inside: true, after: false });
    assert.equal(await layout.evaluate(() => document.querySelector("#clamp2 + bt-tr")?.matches(".bt-moved.bt-done") ?? false), true);
    // The page rewrites a preview whose translation was moved out: no stale or second translation.
    await layout.evaluate(() => {
      document.getElementById("clamp").innerHTML = "<p>Rewritten preview text that is long enough to fill both lines of the clamped box and push its translation out of sight again.</p>";
    });
    await layout.waitForFunction(() => /Rewritten/.test(document.querySelector("#clamp + bt-tr.bt-done")?.textContent ?? ""), null, { timeout: 10_000 });
    assert.equal(await layout.evaluate(() => [...document.querySelectorAll("#feed > bt-tr, #clamp bt-tr")].length), 1);
    // A link wrapped in an <object> without data stays part of the sentence.
    assert.match(await layout.$eval("#obj bt-tr", (el) => el.textContent), /the setup guide/);
    // Slotted text is translated in its slot; text the component does not render is not.
    const card = await layout.evaluate(() => [...document.querySelectorAll("#card > bt-tr")].map((t) => ({ slot: t.getAttribute("slot"), text: t.textContent })));
    assert.deepEqual(card.map((c) => c.slot), ["title"], await layout.$eval("#card", (el) => el.outerHTML));
    assert.ok(card.every((c) => !/Unslotted/.test(c.text)));

    // Translation only: the translation goes back into the preview box, and the paragraph inside
    // a container the page keeps restyling does not flip back to the original.
    const before = requests.length;
    await send({ type: "set-mode", mode: "translation-only" });
    assert.equal(await layout.$eval("#clamp", (box) => box.querySelector(":scope > bt-tr") !== null && box.hasAttribute("data-bt-only")), true);
    // A preview holding a picture cannot hide its original: its translation stays out of the clip.
    assert.equal(await layout.evaluate(() => { const t = document.querySelector("#clamp2 + bt-tr.bt-moved"); return (t?.getBoundingClientRect().height ?? 0) > 0; }), true);
    // Sampled every frame: what the reader sees, not the attribute churn of a synchronous rescan.
    const flips = await layout.evaluate(
      () =>
        new Promise((resolve) => {
          const tick = document.getElementById("tick");
          let frames = 0;
          let showedOriginal = 0;
          let replaced = 0;
          new MutationObserver((records) => (replaced += records.filter((r) => [...r.removedNodes].some((n) => n.localName === "bt-tr")).length)).observe(tick, { childList: true });
          const sample = () => {
            frames++;
            if (getComputedStyle(tick.querySelector(":scope > a")).display !== "none" || !tick.querySelector(":scope > bt-tr.bt-done")) showedOriginal++;
            if (frames < 60) requestAnimationFrame(sample);
            else resolve({ showedOriginal, replaced });
          };
          requestAnimationFrame(sample);
        }),
    );
    assert.deepEqual(flips, { showedOriginal: 0, replaced: 0 });
    assert.equal(requests.length, before);

    await send({ type: "set-mode", mode: "bilingual" });
    await send({ type: "toggle-tab" });
    assert.equal(await layout.$("bt-tr, [data-bt-only]"), null);
    await layout.close();
    await page.bringToFront();
  });

  await step("options page lists the provider and its test succeeds", async () => {
    await options.reload();
    await options.bringToFront();
    // The list shows the service's own name; settings live in the setup drawer.
    assert.equal(await options.$eval(".svc-name", (el) => el.textContent), "Mock");
    await options.getByRole("button", { name: "Edit", exact: true }).click();
    await options.getByRole("button", { name: "Test", exact: true }).click();
    await options.waitForSelector(".drawer-foot .status.ok", { timeout: 10_000 });
    assert.match(await options.$eval(".drawer-foot .status", (el) => el.textContent), /^✓ .*— \[ZH\]/);
    if (screenshotDir) await options.screenshot({ path: join(screenshotDir, "e2e-options.png"), fullPage: true });
  });

  await step("options page shows the shortcut the browser assigned", async () => {
    // macOS reports Alt shortcuts with the Option symbol.
    await options.waitForFunction(() => ["Alt+T", "⌥T"].includes(document.querySelector("kbd")?.textContent));
    assert.ok(await options.getByRole("button", { name: "Change shortcut…" }).isVisible());
  });

  await step("options page picks the active service from the list and its menu dismisses", async () => {
    const stored = () => worker.evaluate(async () => (await chrome.storage.local.get("settings")).settings);
    const before = await stored();
    await worker.evaluate((s) => chrome.storage.local.set({ settings: { ...s, providers: [...s.providers, { ...s.providers[0], id: "mock2", name: "Mock 2" }] } }), before);
    await options.reload();
    assert.ok(await options.isChecked("#svc-mock"));
    // The whole row is the radio's label: clicking the name picks the service.
    await options.click(".svc:has(#svc-mock2) .svc-name");
    await options.waitForFunction(() => document.querySelector("#svc-mock2")?.checked && !document.querySelector("#svc-mock").checked);
    assert.equal((await stored()).activeProviderId, "mock2");
    await options.click(".svc:has(#svc-mock) .svc-name");
    await options.waitForFunction(() => document.querySelector("#svc-mock")?.checked);
    assert.equal((await stored()).activeProviderId, "mock");

    const menu = ".svc:has(#svc-mock2) details.menu";
    const isOpen = () => options.$eval(menu, (el) => el.open);
    await options.click(`${menu} > summary`);
    assert.ok(await isOpen());
    await options.click("#services h2"); // outside
    assert.equal(await isOpen(), false);
    await options.click(`${menu} > summary`);
    await options.keyboard.press("Escape");
    assert.equal(await isOpen(), false);
    await options.click(`${menu} > summary`);
    await options.click(`${menu} button.danger`);
    await options.waitForFunction(() => !document.querySelector("#svc-mock2"));
    assert.deepEqual((await stored()).providers.map((p) => p.id), ["mock"]);
  });

  // Page helpers: a second tab where the extension was used once and then turned off.
  const helperUrl = `${pageUrl}?helpers`;
  const helper = await context.newPage();
  await helper.goto(helperUrl);
  await options.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.runtime.sendMessage({ type: "toggle-tab", tabId: tab.id });
    await chrome.runtime.sendMessage({ type: "toggle-tab", tabId: tab.id });
  }, helperUrl);
  await helper.bringToFront();

  await step("tap Ctrl over a paragraph to translate just that paragraph", async () => {
    assert.equal(await helper.$("bt-tr"), null);
    const box = await helper.locator("#p1").boundingBox();
    await helper.mouse.move(box.x + 20, box.y + box.height / 2);
    await helper.keyboard.down("Control");
    await helper.keyboard.up("Control");
    await helper.waitForSelector("#p1 bt-tr.bt-done", { timeout: 10_000 });
    assert.equal(await helper.$$eval("bt-tr", (els) => els.length), 1);
  });

  await step("press Space three times in a text field to translate it", async () => {
    const before = requests.length;
    await helper.click("#f input");
    await helper.keyboard.type("hello there");
    await helper.keyboard.press("Space");
    await helper.keyboard.press("Space");
    await helper.keyboard.press("Space");
    await helper.waitForFunction(() => document.querySelector("#f input").value === "[ZH] hello there", null, { timeout: 10_000 });
    assert.equal(requests.length, before + 1);
    assert.equal(requests.at(-1).messages.at(-1).content, "hello there");
    assert.match(requests.at(-1).messages[0].content, /into English/);
  });

  await step("select text with the mouse to get a translate button", async () => {
    const box = await helper.locator("h1").boundingBox();
    await helper.mouse.move(box.x + 2, box.y + box.height / 2);
    await helper.mouse.down();
    await helper.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 5 });
    await helper.mouse.up();
    await helper.waitForSelector("bt-popover", { state: "attached", timeout: 5_000 });
    assert.equal(await helper.$eval("bt-popover", (el) => el.shadowRoot), null, "closed shadow root");
  });

  await step("context menu selection translation shows a result popover", async () => {
    const before = requests.length;
    await options.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.tabs.sendMessage(tab.id, { type: "translate-selection", text: "A brand new selection" });
    }, helperUrl);
    assert.equal(requests.length, before + 1);
    assert.equal(requests.at(-1).messages.at(-1).content, "A brand new selection");
    assert.ok(await helper.$("bt-popover"));
  });

  await step("always-translate sites are translated on load", async () => {
    const origin = new URL(pageUrl).origin;
    await worker.evaluate(async (origin) => {
      const { settings } = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({ settings: { ...settings, autoSites: [origin] } });
    }, origin);
    await worker.evaluate(async () => {
      for (let i = 0; i < 50; i++) {
        if ((await chrome.scripting.getRegisteredContentScripts()).length > 0) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("content script was not registered");
    });
    const auto = await context.newPage();
    await auto.goto(`${pageUrl}?auto`);
    await auto.waitForSelector("#p1 bt-tr.bt-done", { timeout: 10_000 });
    await worker.evaluate(async () => {
      const { settings } = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({ settings: { ...settings, autoSites: [] } });
    });
    await worker.evaluate(async () => {
      for (let i = 0; i < 50; i++) {
        if ((await chrome.scripting.getRegisteredContentScripts()).length === 0) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("content script was not unregistered");
    });
  });
} finally {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
}

// Phase 2: another extension installed first already owns our default key. Browsers then
// leave our command unassigned without telling anyone, so the options page must say so.
const conflictDir = await mkdtemp(join(tmpdir(), "bt-e2e-conflict-"));
const fixture = join(root, "test", "e2e", "fixtures", "conflicting-shortcut");
const conflicted = await chromium.launchPersistentContext(conflictDir, {
  executablePath,
  headless: true,
  chromiumSandbox: false,
  // The UI follows the browser language ("auto"); assertions below use the English strings.
  locale: "en-US",
  args: [`--disable-extensions-except=${fixture},${extensionPath}`, `--load-extension=${fixture},${extensionPath}`],
});
try {
  await step("warn when the default shortcut is taken by another extension", async () => {
    let worker = conflicted.serviceWorkers().find((w) => w.url().endsWith("/background.js"));
    while (!worker) {
      const next = await conflicted.waitForEvent("serviceworker");
      if (next.url().endsWith("/background.js")) worker = next;
    }
    const options = await conflicted.newPage();
    await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    await options.waitForFunction(() => document.querySelector("kbd")?.textContent === "Not set");
    assert.match(await options.textContent("body"), /No shortcut is assigned/);
  });
  console.log(`\nAll E2E checks passed (${requests.length} API requests).`);
} finally {
  await conflicted.close();
  server.close();
  await rm(conflictDir, { recursive: true, force: true });
}
