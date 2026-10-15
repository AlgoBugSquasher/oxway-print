import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e/ holds Playwright specs (npm run smoke) — a different test
    // runner with its own `test()` global, incompatible with vitest's.
    // Vitest's default include glob (**/*.spec.ts) would otherwise also
    // try to collect them.
    exclude: ["**/node_modules/**", "**/e2e/**"],
  },
});
