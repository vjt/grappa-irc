// UX-5 bucket BV (2026-05-20) — mobile virtual-keyboard react via
// VisualViewport + --viewport-height across all `position: fixed` mobile
// overlays, plus members-drawer auto-close on member-tap.
//
// BACKGROUND
//
// UX-3 PENT shipped `lib/viewportHeight.ts` which writes
// `--viewport-height: <visualViewport.height>px` on `<html>` at boot
// AND on every visualViewport `resize`. iOS Safari shrinks
// `visualViewport.height` when the on-screen keyboard opens — unlike
// `100vh` / `100dvh` / `100svh`, which all stay at the layout-viewport
// height (keyboard-absent). So any rule that reads
// `var(--viewport-height, 100dvh)` shrinks in lockstep with the
// keyboard; any rule using `100vh` literally stays full-screen with
// its bottom content rendered UNDER the keyboard.
//
// `.shell-mobile` already reads the var (UX-3 PENT). BV extends the
// same contract to the 4 `position: fixed` mobile overlays that escape
// `.shell-mobile`'s box (and one `position: fixed` modal that's both
// mobile + desktop), so they each shrink under keyboard:
//
//   1. `.shell-members` (mobile drawer, `position: fixed`)
//   2. `.settings-drawer` (mobile + desktop slide-in, `position: fixed`)
//   3. `.archive-modal` (full-modal inside fixed backdrop)
//   4. `.image-upload-modal` (centered modal inside fixed backdrop)
//
// Plus 3 flex-children of `.shell-mobile` that ALREADY inherit the
// right height contract via the parent — capped here with `max-height:
// var(--viewport-height, 100dvh)` as a defensive sweep so a future
// CSS refactor that breaks them out of flex doesn't silently re-break
// the keyboard contract:
//
//   5. `.home-pane`
//   6. `.admin-pane`
//   7. `.admin-tab-panel`
//
// Plus a UX correction: tapping a member nick in the mobile members
// drawer opens a query window AND now auto-closes the drawer (previously
// the drawer stayed open, overlapping the new query's ComposeBox and
// blocking input focus through the keyboard overlay).
//
// WEBKIT LIMITATION
//
// Playwright's webkit emulation does NOT simulate the iOS on-screen
// keyboard. We can't `.focus()` an input and observe `visualViewport`
// shrink. So this spec asserts the SHIPPING SHAPE of the CSS contract
// (every selector reads `var(--viewport-height, 100dvh)`) — the
// mechanical guarantee that the keyboard-react layer is wired
// end-to-end. Real keyboard smoke is vjt's iPhone only (same model as
// `ux-3-oct-keyboard-stack.spec.ts` lines 21-28).
//
// Per `feedback_e2e_user_class_parity_matrix`: CSS-layer shape +
// JS-mounted side-effect bucket. Single visitor login suffices.

import { expect, test } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Walk CSS source for the named selector inside any @media wrapper and
// return the declared `height` / `max-height` value. Mirrors the UX-3
// OCT walker shape (ux-3-oct-keyboard-stack.spec.ts:125-150).
async function readDeclaredHeight(
  page: import("@playwright/test").Page,
  selector: string,
  prop: "height" | "max-height",
): Promise<string | null> {
  return await page.evaluate(
    ({ selector, prop }) => {
      function visit(rules: CSSRuleList): string | null {
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSMediaRule) {
            const inner = visit(rule.cssRules);
            if (inner) return inner;
            continue;
          }
          if (!(rule instanceof CSSStyleRule)) continue;
          const sels = rule.selectorText.split(",").map((s) => s.trim());
          if (!sels.includes(selector)) continue;
          const h = rule.style.getPropertyValue(prop).trim();
          if (h.length > 0) return h;
        }
        return null;
      }
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          const found = visit(sheet.cssRules);
          if (found) return found;
        } catch {
          continue;
        }
      }
      return null;
    },
    { selector, prop },
  );
}

test("@webkit ux-5-bv — .shell-members reads var(--viewport-height) with 100dvh fallback", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  const heightDecl = await readDeclaredHeight(page, ".shell-members", "height");
  expect(heightDecl).not.toBeNull();
  expect(heightDecl).toContain("var(--viewport-height");
  expect(heightDecl).toContain("100dvh");
});

test("@webkit ux-5-bv — .settings-drawer reads var(--viewport-height) with 100dvh fallback", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  const heightDecl = await readDeclaredHeight(page, ".settings-drawer", "height");
  expect(heightDecl).not.toBeNull();
  expect(heightDecl).toContain("var(--viewport-height");
  expect(heightDecl).toContain("100dvh");
});

test("@webkit ux-5-bv — .archive-modal caps max-height to var(--viewport-height)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  const heightDecl = await readDeclaredHeight(page, ".archive-modal", "max-height");
  expect(heightDecl).not.toBeNull();
  expect(heightDecl).toContain("var(--viewport-height");
  expect(heightDecl).toContain("100dvh");
});

test("@webkit ux-5-bv — .image-upload-modal caps max-height to var(--viewport-height)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  const heightDecl = await readDeclaredHeight(page, ".image-upload-modal", "max-height");
  expect(heightDecl).not.toBeNull();
  expect(heightDecl).toContain("var(--viewport-height");
  expect(heightDecl).toContain("100dvh");
});

test("@webkit ux-5-bv — .home-pane caps max-height to var(--viewport-height)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  const heightDecl = await readDeclaredHeight(page, ".home-pane", "max-height");
  expect(heightDecl).not.toBeNull();
  expect(heightDecl).toContain("var(--viewport-height");
  expect(heightDecl).toContain("100dvh");
});

test("@webkit ux-5-bv — .admin-pane caps max-height to var(--viewport-height)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  const heightDecl = await readDeclaredHeight(page, ".admin-pane", "max-height");
  expect(heightDecl).not.toBeNull();
  expect(heightDecl).toContain("var(--viewport-height");
  expect(heightDecl).toContain("100dvh");
});

test("@webkit ux-5-bv — .admin-tab-panel caps max-height to var(--viewport-height)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  const heightDecl = await readDeclaredHeight(page, ".admin-tab-panel", "max-height");
  expect(heightDecl).not.toBeNull();
  expect(heightDecl).toContain("var(--viewport-height");
  expect(heightDecl).toContain("100dvh");
});

test("@webkit ux-5-bv — mobile members drawer auto-closes when operator taps a member nick", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Need a joined channel so MembersPane mounts with non-zero members.
  // Per `feedback_e2e_visitor_members_list` (vjt 2026-05-16) — assert
  // both populated AND own-nick presence as part of the precondition.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Open the mobile members drawer (hamburger in TopicBar).
  await page.getByLabel(/open members sidebar/i).tap();
  const drawer = page.locator(".shell-members.open");
  await expect(drawer).toBeVisible({ timeout: 5_000 });

  // Members list precondition: populated + own-nick present
  // (`feedback_e2e_visitor_members_list` mandate). NETWORK_NICK is the
  // operator's per-network nick on the auto-join channel.
  const memberButtons = drawer.locator(".members-pane li .member-name");
  await expect(memberButtons.first()).toBeVisible({ timeout: 10_000 });
  const memberCount = await memberButtons.count();
  expect(memberCount).toBeGreaterThan(0);
  const ownNickPresent = await drawer
    .locator(`.members-pane li .member-name:has-text("${NETWORK_NICK}")`)
    .count();
  expect(ownNickPresent).toBeGreaterThan(0);

  // Find a member other than self (tapping self would be a no-op).
  // Structured locator — `hasNotText` rejects any row whose text
  // contains NETWORK_NICK as substring (so a "vjt-bot" peer would
  // also be skipped when own-nick is "vjt"). With the seeded
  // auto-join channel there's always at least one non-self peer, so
  // `.first()` resolves; if seeding ever drifts the test fails loud
  // at the tap rather than running a silent off-by-one loop.
  const target = drawer
    .locator(".members-pane li .member-name")
    .filter({ hasNotText: NETWORK_NICK })
    .first();
  await expect(target).toBeVisible({ timeout: 5_000 });
  await target.tap();

  // Post-tap: drawer should be CLOSED (BV auto-close contract). Pre-BV
  // the drawer stayed open over the newly-opened query window's
  // ComposeBox; on iOS the keyboard overlay then sat on top of the
  // drawer's bottom launcher footer (BM) leaving no visible compose
  // surface. Auto-close kills the conflict.
  await expect(page.locator(".shell-members.open")).toBeHidden({ timeout: 5_000 });
});
