// #333 (P0, vjt) — themes gallery UX: personal / gallery sections + copy
// scroll-to-personal + save-error above Save + delete confirm.
//
// The confusion #333 fixes: the old flat, apply_count-ordered list buried a
// fresh copy AND bumped the copied base to the top, reading as "the copy
// vanished / the base disappeared". The fixes, all client-side:
//   1. Two sections — "your themes" (owned, mine === true) FIRST, then the
//      "gallery" (published + built-in) — reusing the .settings-section card.
//   2. After a copy, scroll to the personal section so the new copy is seen.
//   3. The editor's save-error renders directly above the Save button (was at
//      the modal top, off-screen on a long editor).
//   4. A duplicate name gets an explicit message (the (user_id, name) unique
//      index → validation_failed with a `name` field-error → friendly copy).
//   5. Delete goes through the shared confirm modal (was a bare first-tap).
//
// A fresh minted visitor is the clean fixture: no owned themes at start, so
// the personal section is absent until the copy creates one — the exact
// before/after the fix targets. Desktop chromium: the sections + scroll are
// layout-agnostic and the editor is a JS flow.

import { adminDeleteVisitor, mintVisitor } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

type VisitorSeed = Awaited<ReturnType<typeof mintVisitor>>;

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

async function openThemes(page: import("@playwright/test").Page) {
  await page.getByLabel(/open settings/i).click();
  await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
  await page.getByTestId("themes-settings-entry").click();
  await expect(page.getByTestId("theme-gallery")).toBeVisible({ timeout: 5_000 });
}

test.describe("#333 — themes personal/gallery + copy UX + delete confirm", () => {
  test("copy creates a personal section (before gallery) and scrolls to it", async ({ page }) => {
    const admin = getSeededAdmin();
    const visitor = await mintVisitor(`t333a-${Date.now()}`);
    try {
      await seedVisitor(page, visitor);
      await page.goto("/");
      await openThemes(page);

      // Fresh visitor: no owned themes → only the gallery section is present.
      await expect(page.getByTestId("theme-section-gallery")).toBeVisible();
      await expect(page.getByTestId("theme-section-personal")).toHaveCount(0);

      // Select the first gallery theme → reveal actions → copy.
      const selects = page.locator("[data-testid^='theme-select-']");
      await expect(selects.first()).toBeVisible({ timeout: 5_000 });
      await selects.first().click();
      const copyBtn = page.locator("[data-testid^='theme-copy-']").first();
      await expect(copyBtn).toBeVisible({ timeout: 5_000 });
      await copyBtn.click();

      // The copy lands in a now-present "your themes" section, which sits
      // BEFORE the gallery and is scrolled into view (#333.1 + #333.2).
      const personal = page.getByTestId("theme-section-personal");
      const gallery = page.getByTestId("theme-section-gallery");
      await expect(personal).toBeVisible({ timeout: 5_000 });
      await expect(personal).toBeInViewport();
      const personalBox = await personal.boundingBox();
      const galleryBox = await gallery.boundingBox();
      if (personalBox === null || galleryBox === null) throw new Error("section has no box");
      expect(personalBox.y).toBeLessThan(galleryBox.y);
      // The personal section holds at least one card (the copy).
      await expect(personal.locator("[data-testid^='theme-card-']")).not.toHaveCount(0);
    } finally {
      await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
    }
  });

  test("deleting an owned theme goes through the confirm modal (cancel keeps, confirm removes)", async ({
    page,
  }) => {
    const admin = getSeededAdmin();
    const visitor = await mintVisitor(`t333b-${Date.now()}`);
    try {
      await seedVisitor(page, visitor);
      await page.goto("/");
      await openThemes(page);

      // Make an owned theme to delete.
      const selects = page.locator("[data-testid^='theme-select-']");
      await expect(selects.first()).toBeVisible({ timeout: 5_000 });
      await selects.first().click();
      await page.locator("[data-testid^='theme-copy-']").first().click();
      const personal = page.getByTestId("theme-section-personal");
      await expect(personal).toBeVisible({ timeout: 5_000 });

      // Select the owned copy → tap delete → the confirm modal opens; the
      // theme is NOT gone yet.
      const ownedCard = personal.locator("[data-testid^='theme-card-']").first();
      const cardId = await ownedCard.getAttribute("data-testid");
      await personal.locator("[data-testid^='theme-select-']").first().click();
      await personal.locator("[data-testid^='theme-delete-']").first().click();
      await expect(page.getByTestId("confirm-modal")).toBeVisible({ timeout: 5_000 });

      // Cancel is the safe default — the theme survives.
      await page.getByTestId("confirm-modal-cancel").click();
      await expect(page.getByTestId("confirm-modal")).toHaveCount(0);
      await expect(personal.locator(`[data-testid='${cardId}']`)).toBeVisible();

      // Delete again → confirm → the theme is removed.
      await personal.locator("[data-testid^='theme-delete-']").first().click();
      await expect(page.getByTestId("confirm-modal")).toBeVisible({ timeout: 5_000 });
      await page.getByTestId("confirm-modal-confirm").click();
      await expect(page.getByTestId("confirm-modal")).toHaveCount(0);
      // The owned copy is gone → personal section empties + hides again.
      await expect(page.getByTestId("theme-section-personal")).toHaveCount(0, { timeout: 5_000 });
    } finally {
      await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
    }
  });

  test("saving a duplicate name shows an explicit error directly above Save", async ({ page }) => {
    const admin = getSeededAdmin();
    const visitor = await mintVisitor(`t333c-${Date.now()}`);
    try {
      await seedVisitor(page, visitor);
      await page.goto("/");
      await openThemes(page);

      // Copy a gallery theme → owned copy with the base's name.
      const firstCardName = await page.locator("[data-testid^='theme-select-'] .theme-card-name")
        .first()
        .innerText();
      const selects = page.locator("[data-testid^='theme-select-']");
      await selects.first().click();
      await page.locator("[data-testid^='theme-copy-']").first().click();
      await expect(page.getByTestId("theme-section-personal")).toBeVisible({ timeout: 5_000 });

      // New theme with the SAME name as the owned copy → save collides on the
      // (user_id, name) unique index.
      await page.getByTestId("theme-new").click();
      await expect(page.getByTestId("theme-editor")).toBeVisible({ timeout: 5_000 });
      const nameInput = page.getByTestId("theme-editor-name");
      await nameInput.fill(firstCardName);
      const saveBtn = page.getByTestId("theme-editor-save");
      await saveBtn.click();

      // Explicit, friendly message (#333.4) — not a mute failure — rendered
      // directly ABOVE the Save button (#333.3).
      const err = page.getByTestId("theme-editor-error");
      await expect(err).toBeVisible({ timeout: 5_000 });
      await expect(err).toContainText(/already own a theme with this name/i);
      const errBox = await err.boundingBox();
      const saveBox = await saveBtn.boundingBox();
      if (errBox === null || saveBox === null) throw new Error("no box");
      expect(errBox.y).toBeLessThan(saveBox.y);
    } finally {
      await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
    }
  });
});
