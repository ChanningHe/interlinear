// Builds dist/chrome and dist/firefox. Usage: node scripts/build.mjs [--watch] [--e2e]
// --e2e builds dist/e2e only: a Chrome build that is pre-granted access to 127.0.0.1 so the
// automated test can call a local mock API without clicking a permission prompt.
import { context } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderIcon } from "./icon.mjs";
// The UI dictionaries are TypeScript with type-only imports, which Node strips natively.
import { en } from "../src/shared/i18n/en.ts";
import { ja } from "../src/shared/i18n/ja.ts";
import { zhHans } from "../src/shared/i18n/zh-Hans.ts";
import { zhHant } from "../src/shared/i18n/zh-Hant.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const watch = process.argv.includes("--watch");
const ICON_SIZES = [16, 32, 48, 128];
const TARGETS = process.argv.includes("--e2e") ? ["e2e"] : ["chrome", "firefox"];

const icons = Object.fromEntries(ICON_SIZES.map((s) => [s, `icons/${s}.png`]));

// Browsers only accept their own locale folder names (zh_CN / zh_TW, not zh_Hans / zh_Hant);
// the dictionaries themselves are named by script.
const LOCALES = { en, ja, zh_CN: zhHans, zh_TW: zhHant };
const MANIFEST_KEYS = ["extDescription", "cmdToggle", "cmdMode", "cmdHover"];
const msg = (key) => `__MSG_${key}__`;

function manifest(target) {
  const background =
    target !== "firefox"
      ? { service_worker: "background.js", type: "module" }
      : { scripts: ["background.js"], type: "module" };
  return {
    manifest_version: 3,
    name: "Browser Translate",
    version: pkg.version,
    description: msg("extDescription"),
    default_locale: "en",
    // activeTab + scripting: we only touch a page after the user clicks, presses a shortcut or
    // picks a context menu item. contextMenus shows no install warning.
    permissions: ["storage", "activeTab", "scripting", "contextMenus"],
    // Requested at runtime, per origin: API endpoints the user configures, sites they choose to
    // always translate, and every site only if they turn on the page helpers everywhere.
    optional_host_permissions: ["https://*/*", "http://*/*", "http://localhost/*", "http://127.0.0.1/*"],
    background,
    action: { default_popup: "popup.html", default_icon: icons },
    options_ui: { page: "options.html", open_in_tab: true },
    icons,
    commands: {
      // Ids must match the *_COMMAND constants in src/shared/messages.ts. Browsers silently leave
      // a command without a shortcut when its default is taken: Alt+A/W/I/S are common in other
      // translation extensions, and Alt+Shift+T / Alt+Shift+A are reserved by Chrome itself.
      "toggle-translation": {
        suggested_key: { default: "Alt+T" },
        description: msg("cmdToggle"),
      },
      "toggle-display-mode": {
        suggested_key: { default: "Alt+O" },
        description: msg("cmdMode"),
      },
      "translate-hovered": {
        suggested_key: { default: "Alt+P" },
        description: msg("cmdHover"),
      },
    },
    ...(target === "e2e" && { host_permissions: ["http://127.0.0.1/*"] }),
    ...(target === "firefox" && {
      browser_specific_settings: {
        gecko: {
          id: "browser-translate@localhost",
          strict_min_version: "128.0",
          // Page text leaves the device, but only to the endpoint the user configures.
          data_collection_permissions: { required: ["websiteContent"] },
        },
      },
    }),
  };
}

async function writeStatic(outdir, target) {
  if (target !== "e2e" && "host_permissions" in manifest(target)) {
    throw new Error(`Release build "${target}" must not ship standing host permissions`);
  }
  await mkdir(join(outdir, "icons"), { recursive: true });
  await cp(join(root, "public"), outdir, { recursive: true });
  await Promise.all(ICON_SIZES.map((s) => writeFile(join(outdir, icons[s]), renderIcon(s))));
  await writeFile(join(outdir, "manifest.json"), JSON.stringify(manifest(target), null, 2));
  await Promise.all(
    Object.entries(LOCALES).map(async ([folder, dict]) => {
      const messages = Object.fromEntries(MANIFEST_KEYS.map((k) => [k, { message: dict[k] }]));
      await mkdir(join(outdir, "_locales", folder), { recursive: true });
      await writeFile(join(outdir, "_locales", folder, "messages.json"), JSON.stringify(messages, null, 2));
    }),
  );
}

const ENTRIES = [
  { in: "src/background/index.ts", out: "background", format: "esm" },
  // Injected with scripting.executeScript, which requires a classic script.
  { in: "src/content/index.ts", out: "content", format: "iife" },
  { in: "src/popup/index.ts", out: "popup", format: "iife" },
  { in: "src/options/index.ts", out: "options", format: "iife" },
];

async function buildTarget(target) {
  const outdir = join(root, "dist", target);
  await rm(outdir, { recursive: true, force: true });
  await writeStatic(outdir, target);
  const contexts = await Promise.all(
    ENTRIES.map((e) =>
      context({
        entryPoints: { [e.out]: join(root, e.in) },
        outdir,
        bundle: true,
        format: e.format,
        target: ["chrome120", "firefox128"],
        // Readable output on purpose: anyone can audit what ships.
        minify: false,
        sourcemap: watch ? "inline" : false,
        legalComments: "none",
        logLevel: "warning",
      }),
    ),
  );
  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
    return;
  }
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}

await Promise.all(TARGETS.map(buildTarget));
console.log(watch ? "Watching for changes…" : `Built ${TARGETS.map((t) => `dist/${t}`).join(", ")}`);
