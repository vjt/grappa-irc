// #299 items 7 + 8 — the reworked theme card (tap-to-select-and-apply +
// progressive-disclosure action row) AND visitors as first-class theme
// producers, both proven through the REAL browser UI (jsdom is blind to
// tap-target geometry + the live CSS apply).
//
// Item 7: a card is one whole tap target. Tapping it applies the theme live
// AND reveals its action row (copy + owner/admin manage) — only ONE card's
// actions are open at a time. Action buttons are ≥44px (Apple HIG).
//
// Item 8: a minted anon visitor copies a built-in into their own library and
// gets full manage affordances on the owned copy (edit/delete) — the visitor
// is a first-class producer, not a read-only browser. The copied theme is
// attributed to the fixed "guest" label server-side (author model B); this
// spec exercises the client half.

import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import {
  adminDeleteTheme,
  adminDeleteVisitor,
  copyTheme,
  listGalleryThemes,
  mintVisitor,
  publishTheme,
} from "../fixtures/grappaApi";
import {
  AUTOJOIN_CHANNELS,
  getSeededAdmin,
  getSeededVjt,
  NETWORK_NICK,
  NETWORK_SLUG,
} from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const MIN_TAP_TARGET_PX = 44;

test.setTimeout(60_000);

type PWPage = import("@playwright/test").Page;

// Mobile path to the themes sub-page (mirrors the #75 gallery spec): members
// hamburger → cog (settings) → themes nav row.
async function openThemesSubPageMobile(page: PWPage): Promise<void> {
  await page.getByLabel(/open members sidebar/i).tap();
  const drawer = page.locator(".shell-members.open");
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  await drawer.locator("[data-testid='mobile-panel-settings']").tap();
  await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
  await page.getByTestId("themes-settings-entry").tap();
  await expect(page.getByTestId("theme-gallery")).toBeVisible({ timeout: 5_000 });
}

// Desktop path to the themes sub-page (settings cog → themes nav row).
async function openThemesSubPageDesktop(page: PWPage): Promise<void> {
  await page.getByLabel(/open settings/i).click();
  await page.getByTestId("themes-settings-entry").click();
  await expect(page.getByTestId("theme-gallery")).toBeVisible({ timeout: 5_000 });
}

// Back out of the gallery and re-enter it — the ThemeGallery component
// re-fetches on mount (`load()` in its on-entry effect), so this forces a
// fresh gallery read after a server-side change (e.g. a visitor reap that
// re-homes a published theme) without a full page reload.
async function reopenGalleryDesktop(page: PWPage): Promise<void> {
  await page.getByTestId("themes-back").click();
  await page.getByTestId("themes-settings-entry").click();
  await expect(page.getByTestId("theme-gallery")).toBeVisible({ timeout: 5_000 });
}

test.describe("#299 — theme cards (tap-select + progressive disclosure)", () => {
  test("@webkit tapping a card reveals exactly one ≥44px action row", async ({ page }) => {
    await loginAs(page, getSeededVjt());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    await openThemesSubPageMobile(page);

    const selects = page.locator("[data-testid^='theme-select-']");
    await expect(selects.first()).toBeVisible({ timeout: 5_000 });
    expect(await selects.count()).toBeGreaterThanOrEqual(2);

    // Progressive disclosure: NOTHING is selected on entry, so no action row
    // is rendered yet.
    await expect(page.locator("[data-testid^='theme-actions-']")).toHaveCount(0);

    // Tap the first card → its (and ONLY its) action row appears.
    await selects.first().tap();
    await expect(page.locator("[data-testid^='theme-actions-']")).toHaveCount(1, { timeout: 5_000 });

    // The revealed copy button is a proper ≥44px tap target.
    const copyBtn = page.locator("[data-testid^='theme-copy-']").first();
    await expect(copyBtn).toBeVisible();
    const box = await copyBtn.boundingBox();
    if (box === null) throw new Error("copy action has no bounding box");
    // Round: webkit returns sub-pixel fractional heights for a min-44px box.
    expect(Math.round(box.height)).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);

    // Tapping a DIFFERENT card moves the disclosure — still exactly one row.
    await selects.nth(1).tap();
    await expect(page.locator("[data-testid^='theme-actions-']")).toHaveCount(1, { timeout: 5_000 });
  });

  test("a minted visitor copies a built-in and gets manage actions on the owned copy", async ({
    browser,
  }) => {
    const visitor = await mintVisitor(`e2e299v-${Date.now()}`);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      const subjectJson = JSON.stringify({
        kind: "visitor",
        id: visitor.id,
        nick: visitor.nick,
        network_slug: visitor.network_slug,
        registered: false,
      });
      await page.addInitScript(
        ([token, subject]) => {
          localStorage.setItem("grappa-token", token);
          localStorage.setItem("grappa-subject", subject);
          localStorage.setItem("cic.installChoice", "browser");
        },
        [visitor.token, subjectJson] as const,
      );
      await page.goto("/");

      await openThemesSubPageDesktop(page);

      // Select a built-in card → reveal its actions → copy it. A visitor is a
      // first-class producer, so this succeeds (pre-#299 it 403'd).
      const selects = page.locator("[data-testid^='theme-select-']");
      await expect(selects.first()).toBeVisible({ timeout: 5_000 });
      await selects.first().click();
      const copyBtn = page.locator("[data-testid^='theme-copy-']").first();
      await expect(copyBtn).toBeVisible({ timeout: 5_000 });
      await copyBtn.click();

      // The fresh owned copy is auto-selected → its card now shows the OWNER
      // manage affordances (edit + delete), which a built-in never offered the
      // visitor. Proves `mine` flipped true for the visitor-owned copy.
      await expect(page.locator("[data-testid^='theme-edit-']").first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.locator("[data-testid^='theme-delete-']").first()).toBeVisible();
    } finally {
      await ctx.close();
      // The copy is a private (unpublished) theme, so it CASCADE-dies with the
      // visitor — no gallery residue to clean up.
      await adminDeleteVisitor(getSeededAdmin().token, visitor.id).catch(() => {});
    }
  });

  test("a visitor-published theme credits the publish-time nick and it survives reap", async ({
    page,
  }) => {
    // Author model A (#299 amendment): a visitor-published theme is credited to
    // the publishing visitor's nick, snapshotted at PUBLISH time and PERSISTED
    // — so it survives the visitor being reaped, which re-homes the published
    // theme to the system owner (visitor_id → nil). If attribution read the
    // live owner instead of the snapshot, the card would flip to "system" (or
    // the "guest" fallback) after reap. Set-up runs over REST (the runner talks
    // to grappa directly); the assertion is the cic gallery RENDER.
    const visitor = await mintVisitor(`e2e299n-${Date.now()}`);
    let themeId: number | undefined;

    try {
      // The visitor copies a built-in (a guaranteed-valid payload) into their
      // library, then publishes it → the server snapshots author_nick.
      const gallery = await listGalleryThemes(visitor.token);
      const builtin = gallery.find((t) => t.built_in);
      if (builtin === undefined) throw new Error("no built-in theme in the gallery to copy");
      const copy = await copyTheme(visitor.token, builtin.id);
      themeId = copy.id;
      const published = await publishTheme(visitor.token, copy.id);
      // Server truth: the wire already credits the nick, not the guest label.
      expect(published.author).toBe(visitor.nick);

      // View the gallery as the seeded vjt; the card credits the visitor nick.
      await loginAs(page, getSeededVjt());
      await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
      await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();
      await openThemesSubPageDesktop(page);

      const author = page.locator(`[data-testid="theme-card-${themeId}"] .theme-card-author`);
      await expect(author).toBeVisible({ timeout: 5_000 });
      await expect(author).toContainText(visitor.nick);

      // Reap the publishing visitor → re-homes the published theme to system.
      await adminDeleteVisitor(getSeededAdmin().token, visitor.id);

      // Re-open the gallery (forces a fresh fetch): the nick snapshot STILL
      // shows — NOT "system" (the new owner), NOT the "guest" fallback.
      await reopenGalleryDesktop(page);
      const authorAfter = page.locator(
        `[data-testid="theme-card-${themeId}"] .theme-card-author`,
      );
      await expect(authorAfter).toBeVisible({ timeout: 5_000 });
      await expect(authorAfter).toContainText(visitor.nick);
    } finally {
      // The re-homed theme is a published, system-owned gallery row — clean it
      // up so it doesn't accrete as gallery residue across runs.
      if (themeId !== undefined) {
        await adminDeleteTheme(getSeededAdmin().token, themeId).catch(() => {});
      }
      await adminDeleteVisitor(getSeededAdmin().token, visitor.id).catch(() => {});
    }
  });
});
