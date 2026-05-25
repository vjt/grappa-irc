// Socket-health banner — verifies the banner appears once the socket
// has logged ERROR_THRESHOLD consecutive failures, classifies a
// 1006 close as the operator-friendly origin-rejected hint, and
// auto-dismisses on a successful connect (errorCount resets to 0).
//
// Drives the socketHealth signal via the `window.__cic_socketHealth`
// black-box hook. Reproducing a real Origin rejection requires
// nginx + Endpoint config tampering that the integration suite
// shouldn't touch — the banner's job is to render the signal
// correctly, and that contract is what this spec validates. The
// lower-level recorder-state contract is covered by the vitest
// unit suite.

import { expect, test } from "../fixtures/test";
import { loginAs } from "../fixtures/cicchettoPage";
import { getSeededVjt } from "../fixtures/seedData";

const BANNER_SELECTOR = ".socket-health-banner";

test("SocketHealthBanner renders origin-rejected hint after 5 errors with close 1006, auto-dismisses on open", async ({
  page,
}) => {
  await loginAs(page, getSeededVjt());

  await expect(page.locator(BANNER_SELECTOR)).toHaveCount(0);

  // Race fix: loginAs only waits for the REST `networks()` resource +
  // sidebar render. The Phoenix WS handshake completes asynchronously
  // AFTER that — and `socket.onOpen` fires `recordSocketOpen()` which
  // resets `errorCount` to 0. If the WS open lands AFTER our reset+5x
  // recordError dance below, it wipes our errorCount before the banner
  // can render. Under CI's slower I/O this regularly fired between the
  // evaluate() and the toBeVisible(). Gate on `state==="open"` here so
  // the open callback has already happened by the time we mutate.
  await page.waitForFunction(() => window.__cic_socketHealth?.state().state === "open");

  await page.evaluate(() => {
    const sh = window.__cic_socketHealth;
    if (!sh) throw new Error("__cic_socketHealth hook missing");
    sh.reset();
    for (let i = 0; i < 5; i++) sh.recordError();
    sh.recordClose({ code: 1006, reason: "" });
  });

  const banner = page.locator(BANNER_SELECTOR);
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("WebSocket connection failing");
  await expect(banner).toContainText("check_origin");
  await expect(banner.locator("code")).toContainText(new URL(page.url()).origin);

  await page.evaluate(() => {
    window.__cic_socketHealth?.recordOpen();
  });
  await expect(page.locator(BANNER_SELECTOR)).toHaveCount(0);
});

test("SocketHealthBanner falls back to generic close-code message for non-1006 closes", async ({
  page,
}) => {
  await loginAs(page, getSeededVjt());

  // Same race-fix gate as the test above — see that comment.
  await page.waitForFunction(() => window.__cic_socketHealth?.state().state === "open");

  await page.evaluate(() => {
    const sh = window.__cic_socketHealth;
    if (!sh) throw new Error("__cic_socketHealth hook missing");
    sh.reset();
    for (let i = 0; i < 5; i++) sh.recordError();
    sh.recordClose({ code: 1011, reason: "internal error" });
  });

  const banner = page.locator(BANNER_SELECTOR);
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("close code 1011");
  await expect(banner).toContainText("internal error");
  await expect(banner).not.toContainText("check_origin");
});

declare global {
  interface Window {
    __cic_socketHealth?: {
      recordOpen: () => void;
      recordError: () => void;
      recordClose: (e: { code: number; reason: string } | undefined) => void;
      reset: () => void;
      state: () => { state: "connecting" | "open" | "error" };
    };
  }
}
