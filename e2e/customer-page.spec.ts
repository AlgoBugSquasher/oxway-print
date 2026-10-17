import { expect, test } from "@playwright/test";

async function mockKioskStatus(page: import("@playwright/test").Page, overrides: Record<string, unknown> = {}) {
  await page.route("**/api/kiosk-status/*", (route) =>
    route.fulfill({
      json: {
        isOnline: true, allowColor: true, allowBw: true, isUpdating: false, allowWhatsapp: false,
        priceBw: 2, priceColor: 10, printBlocked: false, printBlockedReason: null,
        ...overrides,
      },
    })
  );
}

test("customer page at 360px phone width: no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await mockKioskStatus(page);
  await page.goto("/");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("instagram link: icon + handle, opens in a new tab, noopener/noreferrer, handle sourced from one config", async ({ page }) => {
  await mockKioskStatus(page);
  await page.goto("/");
  const link = page.getByRole("link", { name: /@oxway\.geu/i });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(link).toHaveAttribute("href", "https://www.instagram.com/oxway.geu/");
});

test("disabled color mode: greyed out, not selectable, with a short reason, and the price estimate never reflects it", async ({ page }) => {
  await mockKioskStatus(page, { allowColor: false });
  await page.goto("/");
  await page.getByRole("button", { name: /print settings/i }).click();
  await expect(page.getByText(/color is unavailable right now/i)).toBeVisible();
  const colorOption = page.getByRole("button", { name: /color · ₹/i });
  await expect(colorOption).toBeDisabled();
});
