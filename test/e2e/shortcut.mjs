// Real keyboard-shortcut test. Playwright's key events are injected into the page renderer
// and never reach the browser's accelerator handling, so this test sends OS-level key presses
// with xdotool to a headed Chromium on an X display (use xvfb-run on headless machines).
// Usage: CHROMIUM=/path/to/chromium xvfb-run -a npm run e2e:shortcut
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = join(root, "dist", "e2e");
const executablePath = process.env.CHROMIUM;
if (!executablePath) throw new Error("Set CHROMIUM to a Chromium binary");
if (!process.env.DISPLAY) throw new Error("Needs an X display: run under xvfb-run -a");
execFileSync("xdotool", ["version"]); // fails early with a clear ENOENT when xdotool is missing

const server = createServer((req, res) => {
  if (req.url === "/page.html") {
    res.writeHead(200, { "content-type": "text/html" }).end("<p>Hello from a page that should be translated.</p>");
    return;
  }
  req.resume();
  req.on("end", () =>
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "[ZH] ok" } }] })),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const userDataDir = await mkdtemp(join(tmpdir(), "bt-shortcut-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath,
  headless: false,
  chromiumSandbox: false,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--ozone-platform=x11"],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const command = (await worker.evaluate(() => chrome.commands.getAll())).find((c) => c.name === "toggle-translation");
  assert.ok(command?.shortcut, "the browser assigned no shortcut to toggle-translation");
  await worker.evaluate(
    (endpoint) =>
      chrome.storage.local.set({
        settings: { activeProviderId: "m", providers: [{ id: "m", name: "M", kind: "openai", endpoint, apiKey: "", model: "x" }] },
      }),
    `http://127.0.0.1:${port}/v1/chat/completions`,
  );

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`http://127.0.0.1:${port}/page.html`);
  await page.bringToFront();
  await page.click("p"); // keyboard focus in the browser window
  const keys = command.shortcut.toLowerCase(); // "Alt+T" -> xdotool "alt+t"

  execFileSync("xdotool", ["key", "--clearmodifiers", keys]);
  await page.waitForSelector("bt-tr.bt-done", { timeout: 5000 });
  execFileSync("xdotool", ["key", "--clearmodifiers", keys]);
  await page.waitForFunction(() => !document.querySelector("bt-tr"), null, { timeout: 5000 });
  console.log(`✓ ${command.shortcut} translates the page and pressing it again restores the original.`);
} finally {
  await context.close();
  server.close();
  await rm(userDataDir, { recursive: true, force: true });
}
