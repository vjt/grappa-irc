// #335 (P0, vjt) — settings-panel refinements for the visitor surface:
//   1. The "identity" block sits in a titled .settings-section card (was a
//      bare, unwrapped block).
//   2. A new "share session" section-button (same nav-row pattern as
//      vhost/themes) pushes into the share SUB-PAGE (was a modal) and mints
//      a share link on entry.
//   3. Inside the sub-page, a native-share button invokes the Web Share API
//      (navigator.share), falling back to hidden where it's unavailable
//      (the copy button always remains).
//
// All three surfaces are visitor-only (the mint endpoint 403s for users and
// the drawer gates identity + share on isVisitor()). This spec mints a
// throwaway visitor, loads its bearer, and drives the settings drawer.
//
// The cross-device mint→consume→both-connected flow is owned by
// visitor-session-sharing.spec.ts; here we assert the #335 UI refinements +
// the native-share branch/contract. The Web Share API branch is verified by
// stubbing navigator.share (per TESTING.md — assert the branch, not device
// share-sheet pixels): a recording stub for the positive case, an explicit
// deletion for the fallback case, so neither depends on the browser default.
//
// Desktop chromium (untagged): the drawer + sub-page are layout-agnostic and
// navigator.share is a JS API, not a touch gesture.

import { adminDeleteVisitor, mintVisitor } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

type VisitorSeed = Awaited<ReturnType<typeof mintVisitor>>;

// Seed a visitor bearer + subject into localStorage before the SPA boots.
async function seedVisitor(page: import("@playwright/test").Page, visitor: VisitorSeed) {
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [visitor.token, JSON.stringify({ kind: "visitor", id: visitor.id })] as const,
  );
}

// Open Settings → tap the share section-button → land on the share sub-page,
// waiting for the mint to resolve into a /share/ URL.
async function openShareSubPage(page: import("@playwright/test").Page) {
  await page.getByLabel(/open settings/i).click();
  await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
  await page.getByTestId("share-session-entry").click();
  await expect(page.getByTestId("share-subpage")).toBeVisible();
  const url = page.getByTestId("share-url");
  await expect(url).toBeVisible();
  await expect(url).not.toHaveValue("", { timeout: 10_000 });
  return url;
}

test.describe("#335 — visitor identity card + share section + native share", () => {
  test("identity and share sit in titled .settings-section cards", async ({ page }) => {
    const admin = getSeededAdmin();
    const visitor = await mintVisitor(`i335-${Date.now()}`);
    try {
      await seedVisitor(page, visitor);
      await page.goto("/");
      await page.getByLabel(/open settings/i).click();
      await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();

      // #335.1 identity carded; #335.2 share carded with its section-button.
      await expect(page.getByTestId("settings-section-identity")).toBeVisible();
      await expect(page.getByTestId("settings-section-share")).toBeVisible();
      await expect(page.getByTestId("share-session-entry")).toBeVisible();
      // The identity inputs live inside the carded section.
      await expect(
        page.locator("[data-testid='settings-section-identity'] #settings-nick"),
      ).toBeVisible();
    } finally {
      await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
    }
  });

  test("native share invokes navigator.share with the /share/ URL", async ({ page }) => {
    const admin = getSeededAdmin();
    const visitor = await mintVisitor(`n335-${Date.now()}`);
    try {
      // Recording stub — captures the payload navigator.share was called with.
      await page.addInitScript(() => {
        (window as unknown as { __sharedPayload: unknown }).__sharedPayload = null;
        Object.defineProperty(navigator, "share", {
          configurable: true,
          value: (data: unknown) => {
            (window as unknown as { __sharedPayload: unknown }).__sharedPayload = data;
            return Promise.resolve();
          },
        });
      });
      await seedVisitor(page, visitor);
      await page.goto("/");

      const url = await openShareSubPage(page);
      const shareUrl = await url.inputValue();

      const nativeBtn = page.getByTestId("share-native");
      await expect(nativeBtn).toBeVisible();
      await nativeBtn.click();

      const payload = await page.evaluate(
        () => (window as unknown as { __sharedPayload: { url?: string } | null }).__sharedPayload,
      );
      expect(payload).not.toBeNull();
      expect(payload?.url).toBe(shareUrl);
      expect(payload?.url).toMatch(/\/share\//);
    } finally {
      await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
    }
  });

  test("native-share button is hidden when the Web Share API is unavailable", async ({ page }) => {
    const admin = getSeededAdmin();
    const visitor = await mintVisitor(`f335-${Date.now()}`);
    try {
      // Force the fallback: remove navigator.share so the feature-detect fails
      // regardless of the browser's default.
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "share", {
          configurable: true,
          value: undefined,
        });
      });
      await seedVisitor(page, visitor);
      await page.goto("/");

      await openShareSubPage(page);
      // Native button gone; copy remains as the fallback affordance.
      await expect(page.getByTestId("share-native")).toHaveCount(0);
      await expect(page.getByTestId("share-copy")).toBeVisible();
    } finally {
      await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
    }
  });
});
