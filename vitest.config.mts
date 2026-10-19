import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Mirrors tsconfig.json's own "@/*": ["./*"] path alias — without this,
  // vitest can't resolve the "@/..." imports every app/api/*/route.ts file
  // uses, so no route handler could ever be imported from a test at all.
  resolve: {
    alias: {
      "@": rootDir,
    },
  },
  test: {
    // e2e/ holds Playwright specs (npm run smoke) — a different test
    // runner with its own `test()` global, incompatible with vitest's.
    // Vitest's default include glob (**/*.spec.ts) would otherwise also
    // try to collect them.
    exclude: ["**/node_modules/**", "**/e2e/**"],
  },
});
