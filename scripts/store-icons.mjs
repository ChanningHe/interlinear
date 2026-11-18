// Writes the extension icon as files for store listings (AMO asks for 32x32 and 64x64; 128x128
// for anything else), from the same renderer the build uses. Usage: node scripts/store-icons.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderIcon } from "./icon.mjs";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "store", "assets");
const SIZES = [32, 64, 128];

await mkdir(out, { recursive: true });
await Promise.all(SIZES.map((s) => writeFile(join(out, `icon-${s}.png`), renderIcon(s))));
console.log(`Wrote ${SIZES.map((s) => `store/assets/icon-${s}.png`).join(", ")}`);
