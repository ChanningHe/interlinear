import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/core/**", "src/content/**", "src/background/**", "src/shared/**", "src/providers/**"],
      // Entry points are thin browser-API glue, exercised by the E2E run instead.
      exclude: ["src/**/index.ts", "src/shared/h.ts"],
      thresholds: { lines: 80, functions: 80, branches: 75 },
    },
  },
});
