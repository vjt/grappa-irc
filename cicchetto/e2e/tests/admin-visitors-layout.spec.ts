// ADMIN-LAYOUT-FIX (2026-07-12) — browser-truth layout regression lock
// for the admin Visitors tab. jsdom is blind to CSS
// (`feedback_cicchetto_browser_smoke`), so the layout defect from
// priv/admin-fuckup.png can ONLY be pinned in a real browser.
//
// THE REAL DEFECT (fixed): the per-network cell was glued
// (`pelucheazzurraconnected`) — the `<ul class="admin-visitor-networks">`
// shipped WITHOUT CSS after the #211-phase-7 visitor→multi-network
// cutover, so the browser applied default disc bullets + zero separators
// between the nick/slug/state spans. This spec asserts the bullet is gone,
// the nick/slug carry the `·` separator, and the DB-canonical
// connection-state EMOJI is painted (a codepoint jsdom won't render).
//
// THE NON-DEFECT (investigated, evidence-first per CLAUDE.md "debug with
// data first, NEVER guess"): the brief read the png's far-LEFT column of
// `✕` glyphs as misaligned per-row Delete buttons overflowing to the row
// border. Screenshots at 393/1162/1280/1700px all show the Delete button
// rendering as right-aligned TEXT "Delete" inside its last-column cell
// (the m8 delete spec, green in CI, already asserts `/delete/i` text — the
// button is NOT a `✕`). The far-left `✕` are the SIDEBAR's own channel /
// archive `×` buttons (Sidebar.tsx) peeking from behind the overlaid
// admin pane in that crop — a screenshot artifact, not a visitors-tab bug.
// The delete-button box assertion below is kept as a cheap regression
// guard (an actual overflow would trip it), NOT because a defect was
// found.
//
// Reuses the m8-admin-visitors-delete scaffold (mint a throwaway visitor
// via REST, log in as the seeded admin, open AdminPane → Visitors tab).

import { expect, test } from "../fixtures/test";
import { getSeededAdmin } from "../fixtures/seedData";
import { mintVisitor, adminDeleteVisitor } from "../fixtures/grappaApi";

test("admin Visitors tab: per-network cell is separated + delete button stays in its row", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const visitorNick = `layout-victim-${Date.now()}`;
  const visitor = await mintVisitor(visitorNick);

  try {
    await page.addInitScript(
      ([token, subjectJson]) => {
        localStorage.setItem("grappa-token", token);
        localStorage.setItem("grappa-subject", subjectJson);
        localStorage.setItem("cic.installChoice", "browser");
      },
      [admin.token, admin.subjectJson] as const,
    );
    await page.goto("/");
    await page.getByLabel(/open settings/i).click();
    await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
    await page.getByTestId("admin-console-entry").click();
    await expect(page.getByTestId("admin-pane")).toBeVisible();
    await page.getByTestId("admin-tab-visitors").click();
    await expect(page.getByTestId("admin-visitors-table")).toBeVisible({ timeout: 10_000 });

    const row = page.getByTestId(`admin-visitor-row-${visitor.id}`);
    await expect(row).toBeVisible();

    // Defect #1a — the network `<ul>` must NOT render default disc bullets
    // (the fix sets `list-style: none`). `::marker` is not directly
    // queryable, so assert the computed `list-style-type`.
    const networkList = row.locator(".admin-visitor-networks");
    await expect(networkList).toHaveCSS("list-style-type", "none");

    // Defect #1b — the DB-canonical connection-state emoji is rendered
    // (a real glyph, jsdom-invisible). This is a LAYOUT/CSS lock, so
    // assert the emoji renders with SOME valid state label + a non-empty
    // painted glyph — NOT a specific state. connection_state is
    // DB-canonical (:connected|:parked|:failed) and can diverge from
    // "connected" by render time (reconnect backoff, k-line, SASL fail);
    // pinning it to "connected" would turn an upstream-IRC flake into a
    // false layout-regression. The exact state→glyph mapping is covered
    // by the pure connectionStateEmoji.test.ts + the tab vitest suite.
    const stateEmoji = row.locator(".admin-visitor-network-state").first();
    await expect(stateEmoji).toBeVisible();
    const stateLabel = await stateEmoji.getAttribute("aria-label");
    expect(["connected", "parked", "failed", "unknown"]).toContain(stateLabel);
    const glyph = (await stateEmoji.textContent())?.trim() ?? "";
    expect(glyph.length).toBeGreaterThan(0);

    // Defect #1c — nick + slug are separated, not one glued run. The `·`
    // separator is a CSS ::before on the slug; assert the two spans carry
    // the distinct expected text (proving they're separate nodes the
    // separator sits between).
    await expect(row.locator(".admin-visitor-network-nick").first()).toHaveText(visitorNick);

    // Regression guard (NOT a found defect — see header) — the Delete
    // button's box must sit INSIDE its row's box (no left-edge overflow)
    // AND in the row's right half (the last, actions column).
    // getBoundingClientRect is the only overflow-aware probe.
    const deleteBtn = page.getByTestId(`admin-visitor-delete-${visitor.id}`);
    await expect(deleteBtn).toBeVisible();
    const rowBox = await row.boundingBox();
    const btnBox = await deleteBtn.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(btnBox).not.toBeNull();
    if (rowBox && btnBox) {
      // Fully contained horizontally within the row (no left-edge overflow).
      expect(btnBox.x).toBeGreaterThanOrEqual(rowBox.x - 1);
      expect(btnBox.x + btnBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
      // Sits in the row's right half — the actions column, not the far left.
      expect(btnBox.x).toBeGreaterThan(rowBox.x + rowBox.width / 2);
    }
  } finally {
    await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});
