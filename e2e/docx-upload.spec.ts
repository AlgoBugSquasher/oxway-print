import path from "path";
import { expect, test } from "@playwright/test";

const SIMPLE_DOCX_PATH = path.join(__dirname, "fixtures", "simple.docx");
const TABLE_DOCX_PATH = path.join(__dirname, "fixtures", "table.docx");

test("uploading a simple .docx: shows the Word-layout notice and converts to a previewable PDF", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.route("**/api/kiosk-status/*", (route) =>
    route.fulfill({ json: { isOnline: true, allowColor: true, allowBw: true, isUpdating: false, allowWhatsapp: false, priceBw: 2, priceColor: 10, printBlocked: false, printBlockedReason: null } })
  );

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(SIMPLE_DOCX_PATH);

  await expect(page.getByText(/word files can change layout/i)).toBeVisible();
  await expect(page.getByText(/active pages/i)).toBeVisible({ timeout: 15_000 });
  expect(pageErrors, `Uncaught page error(s): ${pageErrors.map((e) => e.message).join("; ")}`).toHaveLength(0);
});

test("uploading a .docx with a table: still converts and previews without throwing", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.route("**/api/kiosk-status/*", (route) =>
    route.fulfill({ json: { isOnline: true, allowColor: true, allowBw: true, isUpdating: false, allowWhatsapp: false, priceBw: 2, priceColor: 10, printBlocked: false, printBlockedReason: null } })
  );

  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(TABLE_DOCX_PATH);

  await expect(page.getByText(/word files can change layout/i)).toBeVisible();
  await expect(page.getByText(/active pages/i)).toBeVisible({ timeout: 15_000 });
  expect(pageErrors, `Uncaught page error(s): ${pageErrors.map((e) => e.message).join("; ")}`).toHaveLength(0);

  await page.getByRole("button", { name: /preview print/i }).click();
  await expect(page.getByText(/row1col1/i).or(page.locator("canvas, img").first())).toBeVisible({ timeout: 10_000 });
});
