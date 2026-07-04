// #119 — unified stacked error-banner region. Replaces the pre-#119
// socket-health-banner.spec.ts: the two independent `position: fixed; top: 0`
// banners (WS health + bundle refresh) are folded into ONE owner that stacks
// N active error sources vertically WITHOUT overlap.
//
// Drives the black-box hooks (`window.__cic_socketHealth`,
// `window.__cic_bundleHash`) + the real `online`/`offline` window events. The
// stacking test is the anti-hollow-green regression the issue is about: TWO
// distinct error states are forced simultaneously and asserted to render as
// two non-overlapping slots inside the one container — a spec that only showed
// ONE error would hollow-green the overlap fix.

import { expect, test } from "../fixtures/test";
import { loginAs } from "../fixtures/cicchettoPage";
import { getSeededVjt } from "../fixtures/seedData";

const REGION = ".error-banners";
const WS = '.error-banner[data-source="ws"]';
const CONNECTIVITY = '.error-banner[data-source="connectivity"]';
const SWREG = '.error-banner[data-source="sw-registration"]';
const BUNDLE = '.error-banner[data-source="bundle-refresh"]';

// The socket's onOpen fires recordSocketOpen() which resets errorCount to 0.
// loginAs only awaits the REST networks() resource; the WS handshake completes
// asynchronously after. Gate on state==="open" so the open callback has
// already fired before we mutate the health signal, else it wipes our
// errorCount between evaluate() and the assertion (flakes under CI I/O).
async function tripWsUnhealthy(
  page: Parameters<typeof loginAs>[0],
  code: number,
  reason: string,
): Promise<void> {
  await page.waitForFunction(() => window.__cic_socketHealth?.state().state === "open");
  await page.evaluate(
    ({ code, reason }) => {
      const sh = window.__cic_socketHealth;
      if (!sh) throw new Error("__cic_socketHealth hook missing");
      sh.reset();
      for (let i = 0; i < 5; i++) sh.recordError();
      sh.recordClose({ code, reason });
    },
    { code, reason },
  );
}

test("WS-health source renders the generic close-code entry, auto-dismisses on open", async ({
  page,
}) => {
  await loginAs(page, getSeededVjt());
  await expect(page.locator(WS)).toHaveCount(0);

  await tripWsUnhealthy(page, 1006, "");

  const ws = page.locator(WS);
  await expect(ws).toBeVisible();
  await expect(ws).toContainText("WebSocket connection failing");
  await expect(ws).toContainText("close code 1006");
  // The deleted origin heuristic must NOT reappear.
  await expect(ws).not.toContainText("check_origin");

  await page.evaluate(() => window.__cic_socketHealth?.recordOpen());
  await expect(page.locator(WS)).toHaveCount(0);
});

test("WS-health generic entry surfaces the real close code + reason for non-1006", async ({
  page,
}) => {
  await loginAs(page, getSeededVjt());
  await tripWsUnhealthy(page, 1011, "internal error");

  const ws = page.locator(WS);
  await expect(ws).toBeVisible();
  await expect(ws).toContainText("close code 1011");
  await expect(ws).toContainText("internal error");
});

test("connectivity source appears on the offline event and clears on online", async ({ page }) => {
  await loginAs(page, getSeededVjt());
  await expect(page.locator(CONNECTIVITY)).toHaveCount(0);

  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  const conn = page.locator(CONNECTIVITY);
  await expect(conn).toBeVisible();
  await expect(conn).toContainText("offline");

  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(CONNECTIVITY)).toHaveCount(0);
});

test("sw-registration source surfaces the captured error name + message (#120)", async ({
  page,
}) => {
  await loginAs(page, getSeededVjt());
  await expect(page.locator(SWREG)).toHaveCount(0);

  // A real onRegisterError can't be forced from a black-box browser (it fires
  // from vite-plugin-pwa internals), so drive the same signal via the hook —
  // which is ALSO the #181 read surface for the captured detail.
  await page.evaluate(() => {
    const sw = window.__cic_swRegistration;
    if (!sw) throw new Error("__cic_swRegistration hook missing");
    sw.recordError({
      name: "SecurityError",
      message: "Failed to register a ServiceWorker: origin not allowed",
    });
  });

  const swreg = page.locator(SWREG);
  await expect(swreg).toBeVisible();
  await expect(swreg).toContainText("Service worker registration failed");
  // The captured detail (name AND message) must be visible — the human cause
  // and the greppable #181 lever.
  await expect(swreg).toContainText("SecurityError");
  await expect(swreg).toContainText("origin not allowed");

  // The hook exposes the same captured detail programmatically (the #181 lever).
  const captured = await page.evaluate(() => window.__cic_swRegistration?.state().error);
  expect(captured?.name).toBe("SecurityError");
  expect(captured?.message).toContain("origin not allowed");
});

test("two distinct error sources STACK vertically without overlapping", async ({ page }) => {
  await loginAs(page, getSeededVjt());

  // Force WS-down AND a bundle-refresh mismatch simultaneously.
  await tripWsUnhealthy(page, 1006, "");
  await page.evaluate(() => {
    const bh = window.__cic_bundleHash;
    if (!bh) throw new Error("__cic_bundleHash hook missing");
    if (bh.bootHash() === null) throw new Error("boot hash null — not a built surface");
    bh.setServerHash("synthetic-stack-mismatch-hash-119");
  });

  const ws = page.locator(WS);
  const bundle = page.locator(BUNDLE);
  await expect(ws).toBeVisible();
  await expect(bundle).toBeVisible();

  // Both live inside the ONE stacking container...
  await expect(page.locator(`${REGION} ${WS}`)).toHaveCount(1);
  await expect(page.locator(`${REGION} ${BUNDLE}`)).toHaveCount(1);

  // ...and their bounding boxes do NOT intersect — the WS slot sits entirely
  // above the bundle slot (flex-column order). This is the overlap regression:
  // pre-#119 both were `position: fixed; top: 0` and painted on top of each
  // other.
  const wsBox = await ws.boundingBox();
  const bundleBox = await bundle.boundingBox();
  if (!wsBox || !bundleBox) throw new Error("banner slots have no layout box");
  expect(wsBox.y + wsBox.height).toBeLessThanOrEqual(bundleBox.y + 1);
});

test("sw-registration STACKS below the WS source without overlapping (#120)", async ({ page }) => {
  await loginAs(page, getSeededVjt());

  // Force WS-down AND a SW-registration failure simultaneously — #120's source
  // as one of the two in the anti-hollow-green no-overlap proof.
  await tripWsUnhealthy(page, 1006, "");
  await page.evaluate(() => {
    const sw = window.__cic_swRegistration;
    if (!sw) throw new Error("__cic_swRegistration hook missing");
    sw.recordError({ name: "SecurityError", message: "origin not allowed" });
  });

  const ws = page.locator(WS);
  const swreg = page.locator(SWREG);
  await expect(ws).toBeVisible();
  await expect(swreg).toBeVisible();

  // Both live inside the ONE stacking container.
  await expect(page.locator(`${REGION} ${WS}`)).toHaveCount(1);
  await expect(page.locator(`${REGION} ${SWREG}`)).toHaveCount(1);

  // ...and their bounding boxes do NOT intersect — WS (error) sits entirely
  // above sw-registration (warn) in flex-column severity order.
  const wsBox = await ws.boundingBox();
  const swBox = await swreg.boundingBox();
  if (!wsBox || !swBox) throw new Error("banner slots have no layout box");
  expect(wsBox.y + wsBox.height).toBeLessThanOrEqual(swBox.y + 1);
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
    __cic_bundleHash?: {
      setServerHash: (hash: string) => void;
      reset: () => void;
      bootHash: () => string | null;
    };
    __cic_swRegistration?: {
      recordError: (e: { name: string; message: string }) => void;
      recordRegistered: (reg?: unknown) => void;
      reset: () => void;
      state: () => { state: "unknown" | "registered" | "error"; error: { name: string; message: string } | null };
    };
  }
}
