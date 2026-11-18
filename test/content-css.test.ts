import { describe, expect, test } from "vitest";

// The project has no Node types; vitest runs from the repository root.
const fs = (await import("node:fs" as string)) as { readFileSync(path: string, encoding: "utf8"): string };

describe("content.css wins over page !important rules", () => {
  /** The stylesheet with every `@layer … { … }` block cut out. */
  function outsideLayers(css: string): string {
    let out = "";
    let i = 0;
    for (let at = css.indexOf("@layer", i); at !== -1; at = css.indexOf("@layer", i)) {
      out += css.slice(i, at);
      let depth = 0;
      let j = css.indexOf("{", at);
      for (; j < css.length; j++) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}" && --depth === 0) break;
      }
      i = j + 1;
    }
    return out + css.slice(i);
  }

  test("every !important rule sits in a cascade layer, which beats unlayered page !important", () => {
    const css = fs.readFileSync("public/content.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toContain("@layer");
    expect(outsideLayers(css)).not.toContain("!important");
  });
});
