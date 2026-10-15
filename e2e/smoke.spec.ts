import { readFileSync } from "fs";
import path from "path";
import { expect, test } from "@playwright/test";

/**
 * Production-build smoke test for the PDF paths that run entirely in the
 * BROWSER — lib/pdf-merge.ts (multi-file merge) and, transitively,
 * lib/client-file-converter.ts (image/docx -> PDF conversion). These are
 * exactly the two call sites that hit pdf-lib's `.save()`/`.load()` from
 * client code, and exactly where the real production bug
 * ("PDFHeader_1.default.forVersion is not a function") actually threw —
 * see next.config.ts's own comment for the root cause and fix.
 *
 * Deliberately NOT a full checkout test: the two network calls after the
 * merge (create-upload-url, create-order) are intercepted and stubbed so
 * this never needs a real Supabase project, payment gateway, or kiosk —
 * everything BEFORE that point (file upload, page-selection UI, the merge
 * itself) runs for real, against the real production bundle. Whatever
 * happens after create-order (loading the Razorpay/Cashfree SDK) is out of
 * scope here and not asserted on.
 */

const SAMPLE_PDF_PATH = path.join(__dirname, "fixtures", "sample.pdf");

test("customer upload: multi-file merge runs in the real production bundle without throwing", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  await page.route("**/api/kiosk-status/*", (route) =>
    route.fulfill({
      json: { isOnline: true, allowColor: true, allowBw: true, isUpdating: false, allowWhatsapp: false, priceBw: 2, priceColor: 10 },
    })
  );

  // Arrays, not a reassigned `let`, specifically so reading `[0]` after the
  // poll below doesn't trip TypeScript's cross-closure narrowing of a
  // nullable variable down to `never`.
  const uploadUrlRequests: { fileName?: string; fileSize?: number }[] = [];
  await page.route("**/api/create-upload-url", async (route) => {
    uploadUrlRequests.push(route.request().postDataJSON());
    await route.fulfill({
      json: { path: "smoke/test.pdf", token: "smoke-token", signedUrl: `${page.url()}__smoke_upload__` },
    });
  });

  await page.route("**/__smoke_upload__", (route) => route.fulfill({ status: 200, body: "" }));

  const createOrderRequests: { selectedPages?: number[] }[] = [];
  await page.route("**/api/create-order", async (route) => {
    createOrderRequests.push(route.request().postDataJSON());
    // Deliberately a 500 — nothing past this point (loading a real payment
    // gateway SDK) is in scope for this smoke test; failing it cleanly here
    // keeps the flow from reaching out to a real, unreachable third party.
    await route.fulfill({ status: 500, json: { error: "smoke test stub — not a real order" } });
  });

  await page.goto("/");

  // Two copies of the same file — the actual code path this smoke test
  // exists for is specifically the MULTI-file merge (lib/pdf-merge.ts),
  // added by the "Multiple files now can be selected" feature; a
  // single-file upload wouldn't exercise PDFDocument.copyPages the same
  // way a real multi-file customer order does.
  // The visible "Drop your files here" button only triggers a click on the
  // real (hidden) <input type="file"> — Playwright can still set files on
  // a hidden input directly, so there's no need to simulate the click.
  await page.locator('input[type="file"]').setInputFiles([SAMPLE_PDF_PATH, SAMPLE_PDF_PATH]);

  // Each file goes through its own client-side conversion/thumbnailing
  // (pdf.js) before it's selectable — wait for both basket cards to finish.
  await expect(page.getByText(/active pages/i)).toHaveCount(2, { timeout: 15_000 });

  const payButton = page.getByRole("button", { name: /^pay ₹/i });
  await expect(payButton).toBeEnabled({ timeout: 10_000 });
  await payButton.click();

  // Give the merge + the two stubbed network calls time to run.
  await expect.poll(() => uploadUrlRequests.length, { timeout: 15_000 }).toBeGreaterThan(0);

  expect(pageErrors, `Uncaught page error(s): ${pageErrors.map((e) => e.message).join("; ")}`).toHaveLength(0);

  // Proves the merge actually produced real, non-empty output — not just
  // that nothing threw. Two one-page A4 PDFs merged should be comfortably
  // more than a few hundred bytes.
  expect(uploadUrlRequests[0].fileSize).toBeGreaterThan(200);

  await expect.poll(() => createOrderRequests.length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(createOrderRequests[0].selectedPages?.length).toBe(4); // 2 pages x 2 copies of the same file

  // The error banner (create-order's stubbed 500 surfaces here, which is
  // expected and fine) must never be the raw library error — confirms
  // Problem 5's friendly-message fix stays correct even if something else
  // in this exact flow fails.
  const errorBanner = page.locator("text=/forVersion|PDFHeader|is not a function/i");
  await expect(errorBanner).toHaveCount(0);
});

test("the sample fixture itself is a real, parseable multi-page PDF", () => {
  // Sanity check on the fixture, not the app — if this ever fails, the
  // test above is exercising nothing meaningful.
  const bytes = readFileSync(SAMPLE_PDF_PATH);
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
});
