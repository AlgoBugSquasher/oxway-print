import { expect, test } from "@playwright/test";

const VIEWPORTS = [
  { name: "800x480", width: 800, height: 480 },
  { name: "480x320", width: 480, height: 320 },
];

async function mockKioskApis(page: import("@playwright/test").Page, upcomingCount: number) {
  await page.route("**/api/kiosk-status/*", (route) =>
    route.fulfill({ json: { isOnline: true, allowColor: true, allowBw: true, isUpdating: false, allowWhatsapp: false, priceBw: 2, priceColor: 10, printBlocked: false, printBlockedReason: null } })
  );
  await page.route("**/api/kiosk-display/*", (route) =>
    route.fulfill({
      json: {
        current: { ticketNumber: 14, status: "printing" },
        upcoming: Array.from({ length: upcomingCount }, (_, i) => ({ ticketNumber: 15 + i })),
        trayCount: 3,
      },
    })
  );
}

async function assertNoOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight + 1);
}

for (const viewport of VIEWPORTS) {
  for (const upcomingCount of [1, 3, 10]) {
    test(`kiosk display at ${viewport.name} with ${upcomingCount} queued jobs: no scrolling, shows at most 2 upcoming`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await mockKioskApis(page, upcomingCount);
      await page.goto("/kiosk-display");

      await expect(page.getByText(/printing/i)).toBeVisible();
      await assertNoOverflow(page);

      const nextLine = page.getByText(/^Next:/);
      await expect(nextLine).toBeVisible();
      const nextText = await nextLine.textContent();
      const codeCount = (nextText?.match(/#/g) ?? []).length;
      expect(codeCount).toBeLessThanOrEqual(2);
    });
  }
}

test("kiosk display: offline overlay is the largest, most attention-grabbing state", async ({ page }) => {
  await page.route("**/api/kiosk-status/*", (route) => route.abort());
  await page.route("**/api/kiosk-display/*", (route) => route.abort());
  await page.goto("/kiosk-display");
  await expect(page.getByText(/kiosk offline/i)).toBeVisible();
  await assertNoOverflow(page);
});

test("kiosk display: printer-unavailable overlay wins over the normal printing state", async ({ page }) => {
  await page.route("**/api/kiosk-status/*", (route) =>
    route.fulfill({ json: { isOnline: true, allowColor: true, allowBw: true, isUpdating: false, allowWhatsapp: false, priceBw: 2, priceColor: 10, printBlocked: true, printBlockedReason: "media-empty" } })
  );
  await page.route("**/api/kiosk-display/*", (route) => route.fulfill({ json: { current: { ticketNumber: 14, status: "printing" }, upcoming: [], trayCount: 0 } }));
  await page.goto("/kiosk-display");
  await expect(page.getByText(/printer unavailable/i)).toBeVisible();
  await assertNoOverflow(page);
});
