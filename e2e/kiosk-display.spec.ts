import { expect, test } from "@playwright/test";

const VIEWPORTS = [
  { name: "800x480", width: 800, height: 480 },
  { name: "480x320", width: 480, height: 320 },
];

const KIOSK_SCREEN_VIEWPORTS = [
  { name: "800x480", width: 800, height: 480 },
  { name: "1024x600", width: 1024, height: 600 },
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

test("kiosk display: offline shows only the small connectivity pill — no full-screen takeover, QR stays visible", async ({ page }) => {
  await page.route("**/api/kiosk-status/*", (route) => route.abort());
  await page.route("**/api/kiosk-display/*", (route) => route.abort());
  await page.goto("/kiosk-display");
  // The pill itself (ConnectivityLight) still reads "Offline" — that's the
  // one intended indicator. No full-screen "Kiosk Offline" takeover, and
  // the QR (shown via its "Scan to print" label) stays visible either way.
  await expect(page.getByText(/^Offline$/)).toBeVisible();
  await expect(page.getByText(/kiosk offline/i)).not.toBeVisible();
  await expect(page.getByText(/scan to print/i)).toBeVisible();
  await assertNoOverflow(page);
});

test("kiosk display: QR stays visible while a job is printing", async ({ page }) => {
  await mockKioskApis(page, 0);
  await page.goto("/kiosk-display");
  await expect(page.getByText(/printing/i)).toBeVisible();
  await expect(page.getByText(/scan to print/i)).toBeVisible();
  await assertNoOverflow(page);
});

test("kiosk display: QR stays visible once a job is ready to collect", async ({ page }) => {
  await page.route("**/api/kiosk-status/*", (route) =>
    route.fulfill({ json: { isOnline: true, allowColor: true, allowBw: true, isUpdating: false, allowWhatsapp: false, priceBw: 2, priceColor: 10, printBlocked: false, printBlockedReason: null } })
  );
  await page.route("**/api/kiosk-display/*", (route) => route.fulfill({ json: { current: { ticketNumber: 14, status: "printed" }, upcoming: [], trayCount: 0 } }));
  await page.goto("/kiosk-display");
  await expect(page.getByText(/ready, please take your pages/i)).toBeVisible();
  await expect(page.getByText(/scan to print/i)).toBeVisible();
});

test("kiosk display: QR stays visible while a refund is pending", async ({ page }) => {
  await page.route("**/api/kiosk-status/*", (route) =>
    route.fulfill({ json: { isOnline: true, allowColor: true, allowBw: true, isUpdating: false, allowWhatsapp: false, priceBw: 2, priceColor: 10, printBlocked: false, printBlockedReason: null } })
  );
  await page.route("**/api/kiosk-display/*", (route) =>
    route.fulfill({ json: { current: { ticketNumber: 14, status: "print_failed", refundStatus: "pending" }, upcoming: [], trayCount: 0 } })
  );
  await page.goto("/kiosk-display");
  await expect(page.getByText(/refund pending/i)).toBeVisible();
  await expect(page.getByText(/scan to print/i)).toBeVisible();
});

test("kiosk display: interrupted job shows no delay message, just the normal idle copy", async ({ page }) => {
  await page.route("**/api/kiosk-status/*", (route) =>
    route.fulfill({ json: { isOnline: true, allowColor: true, allowBw: true, isUpdating: false, allowWhatsapp: false, priceBw: 2, priceColor: 10, printBlocked: false, printBlockedReason: null } })
  );
  await page.route("**/api/kiosk-display/*", (route) => route.fulfill({ json: { current: { ticketNumber: 14, status: "interrupted" }, upcoming: [], trayCount: 0 } }));
  await page.goto("/kiosk-display");
  await expect(page.getByText(/printing delayed/i)).not.toBeVisible();
  await expect(page.getByText(/upload & print your document here/i)).toBeVisible();
  await expect(page.getByText(/scan to print/i)).toBeVisible();
  await assertNoOverflow(page);
});

async function assertQrAndTextGroupIsCentered(page: import("@playwright/test").Page, viewportHeight: number) {
  const qrGroupBox = await page.getByText(/scan to print/i).locator("..").boundingBox();
  const headerBox = await page.getByText(/^(Online|Unstable|Offline)$/).locator("../..").boundingBox();
  if (!qrGroupBox || !headerBox) throw new Error("Could not measure layout for centering check");

  // The content area is everything below the header row down to the
  // viewport's bottom edge; the QR block's own vertical center should sit
  // close to that area's vertical center (generous tolerance since the
  // status-text column's height varies by state — only the QR block's own
  // position must stay put across states per the "same layout for every
  // state" requirement).
  const contentTop = headerBox.y + headerBox.height;
  const contentCenterY = contentTop + (viewportHeight - contentTop) / 2;
  const qrCenterY = qrGroupBox.y + qrGroupBox.height / 2;
  expect(Math.abs(qrCenterY - contentCenterY)).toBeLessThan(60);
}

for (const viewport of KIOSK_SCREEN_VIEWPORTS) {
  test(`kiosk display at ${viewport.name}: QR+text group stays centered across idle/printing/printed`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.route("**/api/kiosk-status/*", (route) =>
      route.fulfill({ json: { isOnline: true, allowColor: true, allowBw: true, isUpdating: false, allowWhatsapp: false, priceBw: 2, priceColor: 10, printBlocked: false, printBlockedReason: null } })
    );

    await page.route("**/api/kiosk-display/*", (route) => route.fulfill({ json: { current: null, upcoming: [], trayCount: 0 } }));
    await page.goto("/kiosk-display");
    await expect(page.getByText(/upload & print your document here/i)).toBeVisible();
    await assertNoOverflow(page);
    await assertQrAndTextGroupIsCentered(page, viewport.height);

    await page.route("**/api/kiosk-display/*", (route) =>
      route.fulfill({ json: { current: { ticketNumber: 14, status: "printing" }, upcoming: [{ ticketNumber: 15 }], trayCount: 2 } })
    );
    await page.reload();
    await expect(page.getByText(/printing/i)).toBeVisible();
    await assertNoOverflow(page);
    await assertQrAndTextGroupIsCentered(page, viewport.height);

    await page.route("**/api/kiosk-display/*", (route) => route.fulfill({ json: { current: { ticketNumber: 14, status: "printed" }, upcoming: [], trayCount: 0 } }));
    await page.reload();
    await expect(page.getByText(/ready, please take your pages/i)).toBeVisible();
    await assertNoOverflow(page);
    await assertQrAndTextGroupIsCentered(page, viewport.height);
  });
}

test("kiosk display: printer-unavailable overlay wins over the normal printing state", async ({ page }) => {
  await page.route("**/api/kiosk-status/*", (route) =>
    route.fulfill({ json: { isOnline: true, allowColor: true, allowBw: true, isUpdating: false, allowWhatsapp: false, priceBw: 2, priceColor: 10, printBlocked: true, printBlockedReason: "media-empty" } })
  );
  await page.route("**/api/kiosk-display/*", (route) => route.fulfill({ json: { current: { ticketNumber: 14, status: "printing" }, upcoming: [], trayCount: 0 } }));
  await page.goto("/kiosk-display");
  await expect(page.getByText(/printer unavailable/i)).toBeVisible();
  await assertNoOverflow(page);
});
