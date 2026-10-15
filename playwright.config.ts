import { defineConfig } from "@playwright/test";

// Smoke tests for the PDF paths that run in the BROWSER (the merge/convert
// code in lib/pdf-merge.ts and lib/client-file-converter.ts). These are
// deliberately run against a real `next start` production server, never
// `next dev` — the bug this guards against ("PDFHeader_1.default.forVersion
// is not a function") only ever showed up in how the production bundler
// resolves pdf-lib, which a unit test (vitest, running raw TS source, no
// bundler involved at all) can never see regardless of how thorough it is.
//
// `npm run smoke` runs `next build` + this suite end to end — see that
// script and e2e/smoke.spec.ts's own comment for the full picture. Not
// wired into `npm test` (vitest): a full production build plus a real
// Chromium launch is much heavier than that command is meant to cost on
// every run. There is no CI workflow file in this repo yet to wire this
// into automatically — see the task's final report for what to add.
const PORT = 3100;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
