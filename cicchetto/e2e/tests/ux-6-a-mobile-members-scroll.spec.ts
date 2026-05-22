// UX-6 bucket A — scroll-leak universal fix on mobile overlays.
//
// vjt 2026-05-20 dogfood: opening members drawer or archive window on
// iPhone STILL allows the entire app chrome to scroll underneath.
// UX-5 BO (`03a08f5`) added `touch-action: pan-y` +
// `overscroll-behavior: contain` to 6 `.shell-mobile` descendants
// (settings + archive + image-upload + home + admin + admin-tab-panel
// + members WRAPPER). UX-5 BM (`dd01dba`) moved the members drawer's
// scroll authority OFF the `.shell-members` wrapper (now
// `overflow-y: visible`, footer-launcher flex container) ONTO the
// inner `.members-pane` (`overflow-y: auto; flex: 1 1 auto`) — but
// BM did NOT migrate the carve-out pair onto the new scroller. So
// `.shell-mobile .shell-members .members-pane` today: `overflow-y:
// auto` but `touch-action` defaults to the inherited
// `.shell-mobile { touch-action: none }` blanket (UX-3 PENT
// ~:2144) and `overscroll-behavior` defaults to `auto`.
//
// Consequence: vertical pan inside the members list is rejected at
// gesture origin (touch-action: none inherited), iOS escalates to
// the document, `installScrollPin` (`lib/viewportHeight.ts:95-108`)
// snap-yanks `window.scrollTo(0, 0)` producing the visible flicker
// + apparent body-scroll-leak vjt sees.
//
// Fix: mirror `.settings-drawer` / `.archive-modal` — re-assert
// `touch-action: pan-y` + `overscroll-behavior: contain` on the
// ACTUAL scrolling element `.shell-mobile .shell-members .members-pane`,
// not just the wrapper. One-feature-one-code-path: the wrapper rule
// (~:2252) is now decorative-only (no own scroll); the scroller rule
// (~:2273) takes the gesture-routing responsibility.
//
// CSS-source-walker pattern per UX-5 BO + BD: assert via
// `getComputedStyle` against the actual rendered surface. We don't
// drive a real iOS touchmove from Playwright (webkit emulation
// doesn't faithfully reproduce iOS Safari's `installScrollPin`
// escalation chain — BO's caveat). The CSS contract assertion
// catches the regression on every run.
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`:
// subject-shape-agnostic CSS contract — registered vjt suffices.

import { expect, test } from "@playwright/test";
import { closeMembersDrawer, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

async function computedTouchAction(page: import("@playwright/test").Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      touchAction: cs.touchAction,
      overscrollBehaviorY: cs.overscrollBehaviorY,
      overflowY: cs.overflowY,
    };
  });
}

test("@webkit ux-6-a — mobile members pane (the actual scroller) asserts touch-action: pan-y + overscroll-behavior: contain", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Open the members drawer from a channel window (mobile path: the
  // hamburger trio lives in the topic bar on `.shell-mobile`).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await page.getByLabel(/open members sidebar/i).tap();
  await expect(page.locator(".shell-members.open")).toBeVisible({ timeout: 5_000 });

  // The members-pane is the INNER scroll authority post-UX-5 BM:
  // wrapper `.shell-members` is `overflow-y: visible` (a flex column),
  // inner `.members-pane` carries `overflow-y: auto`. Gesture-routing
  // must live on the element that actually scrolls, otherwise the
  // pan is rejected at gesture origin (inherited touch-action: none
  // from `.shell-mobile` blanket) and iOS escalates to document
  // (-> installScrollPin snap-yank -> visible flicker / body-leak).
  const styles = await computedTouchAction(page, ".shell-mobile .shell-members .members-pane");
  expect(styles.overflowY).toBe("auto");
  expect(styles.touchAction).toBe("pan-y");
  expect(styles.overscrollBehaviorY).toBe("contain");
});

test("@webkit ux-6-a — opening members drawer adds html.overlay-open; closing removes it", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Baseline: no overlay open → no class on <html>.
  const hasOverlayClass = () =>
    page.evaluate(() => document.documentElement.classList.contains("overlay-open"));
  expect(await hasOverlayClass()).toBe(false);

  // Open members drawer → class lands.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await page.getByLabel(/open members sidebar/i).tap();
  await expect(page.locator(".shell-members.open")).toBeVisible({ timeout: 5_000 });
  await expect.poll(hasOverlayClass).toBe(true);

  // Close drawer via shared `closeMembersDrawer` helper (see
  // cicchettoPage.ts for the layout why-comment). Identical primitive
  // chosen in UX-7-A's parity migration of this site + ux-4-z journey
  // spec to one shared helper.
  await closeMembersDrawer(page);
  await expect.poll(hasOverlayClass).toBe(false);
});

test("@webkit ux-6-a — html.overlay-open suspends root touch-action so gesture-escalation can't reach installScrollPin", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // UX-6 bucket A v3 (2026-05-20) — the lock chain is `html + body +
  // #root + #root > div` (Solid's anonymous wrapper). touch-action
  // does NOT inherit (CSS UI L4) so each ancestor needs its own
  // declaration. v1+v2 only locked <html> — body + #root were still
  // at `touch-action: auto`, letting iOS pick a non-aside ancestor
  // when keyboard-up made the layout document-tall. v3 locks the
  // whole chain; the overlay's own pan-y carve-out still wins via
  // higher selector specificity inside its subtree.
  await page.evaluate(() => document.documentElement.classList.add("overlay-open"));
  const chain = await page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).touchAction,
    body: getComputedStyle(document.body).touchAction,
    root: getComputedStyle(document.getElementById("root") ?? document.body).touchAction,
    rootChild: getComputedStyle(
      document.querySelector("#root > div") ?? document.body,
    ).touchAction,
  }));
  expect(chain.html).toBe("none");
  expect(chain.body).toBe("none");
  expect(chain.root).toBe("none");
  expect(chain.rootChild).toBe("none");
  await page.evaluate(() => document.documentElement.classList.remove("overlay-open"));
});

test("@webkit ux-6-a v2 — descendants of .members-pane share the scroller's touch-action: pan-y (universal-selector carve-out)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Repro of the keyboard-up scroll-leak: when the operator drags
  // from over an `<li>` or `<button.member-name>` (most of the row
  // surface area), iOS hit-tests that descendant — which inherits
  // `touch-action: auto` (the property does NOT inherit per CSS UI
  // L4) — and routes the gesture to a non-root scroll ancestor
  // (with keyboard up, that's `<body>`). The scroller's own pan-y
  // never fires.
  //
  // Fix: universal-selector descendant carve-out at default.css ~:2273
  // (`.shell-mobile .shell-members .members-pane *`) forces the
  // whole subtree to share the scroller's gesture authority.
  //
  // This assertion pins the contract on the deepest interactive
  // descendant — `.member-name` inside an `<li>` inside the `<ul>`.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await page.getByLabel(/open members sidebar/i).tap();
  await expect(page.locator(".shell-members.open")).toBeVisible({ timeout: 5_000 });
  // Wait for at least one member row to render.
  await expect(
    page.locator(".shell-mobile .shell-members .members-pane li .member-name").first(),
  ).toBeVisible({ timeout: 5_000 });

  const memberNameTouchAction = await page
    .locator(".shell-mobile .shell-members .members-pane li .member-name")
    .first()
    .evaluate((el) => getComputedStyle(el).touchAction);
  expect(memberNameTouchAction).toBe("pan-y");

  const ulTouchAction = await page
    .locator(".shell-mobile .shell-members .members-pane ul")
    .first()
    .evaluate((el) => getComputedStyle(el).touchAction);
  expect(ulTouchAction).toBe("pan-y");
});

test("@webkit ux-6-a v2 — members-pane nick-text renders with no inline color (sigil keeps mode color)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // vjt 2026-05-20: per-nick hash color on every members-pane row
  // made the list visually noisy; only the mode-prefix sigil
  // (op/halfop/voiced) should be colored. NickText now takes a
  // `noColor` prop that skips the inline `style="color: var(...)"`;
  // MembersPane passes it. Assert the `.nick-text` span has NO
  // inline `style` color (the `.nick-prefix-{op|halfop|voiced}`
  // classes on the sigil still apply their dedicated color via
  // CSS class, unaffected).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await page.getByLabel(/open members sidebar/i).tap();
  await expect(page.locator(".shell-members.open")).toBeVisible({ timeout: 5_000 });
  await expect(
    page.locator(".shell-mobile .shell-members .members-pane li .nick-text").first(),
  ).toBeVisible({ timeout: 5_000 });

  // Inline style.color check — the `noColor` opt-out makes the
  // component skip the style prop entirely; the `<span>` reads its
  // color from inherited `--fg`. Empty string from `el.style.color`
  // means no inline color set.
  const inlineColor = await page
    .locator(".shell-mobile .shell-members .members-pane li .nick-text")
    .first()
    .evaluate((el) => (el as HTMLElement).style.color);
  expect(inlineColor).toBe("");
});

test("@webkit ux-6-a v2 — .member-name:hover underline is gated on (hover: hover) — no spurious underline on touch-only viewports", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Mobile Safari synthesizes :hover on tap-release that PERSISTS.
  // Pre-fix: `.members-pane li .member-name:hover { text-decoration:
  // underline }` fired on tap-release, leaving the underline on the
  // nick under the finger after a drag. Fix: wrap the rule in
  // `@media (hover: hover)` so it only applies on hover-capable
  // input (mouse/trackpad). On webkit-iphone-15 emulation (touch-
  // primary), the media query evaluates false → rule doesn't apply
  // → no underline regardless of synthetic hover state.
  //
  // Asserted via getComputedStyle: matchMedia("(hover: hover)")
  // should be false on the iPhone profile; the rule should not
  // apply. We can't synthesize a hover via Playwright (would
  // bypass the media query); the deterministic guard is "the rule
  // is gated correctly so the media query controls it."
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await page.getByLabel(/open members sidebar/i).tap();
  await expect(page.locator(".shell-members.open")).toBeVisible({ timeout: 5_000 });
  await expect(
    page.locator(".shell-mobile .shell-members .members-pane li .member-name").first(),
  ).toBeVisible({ timeout: 5_000 });

  // The iPhone 15 webkit profile has touch-primary; hover-capable
  // is false. Assert the media query state matches.
  const hoverCapable = await page.evaluate(() => matchMedia("(hover: hover)").matches);
  expect(hoverCapable).toBe(false);

  // Hover the locator via Playwright; on a touch-primary device the
  // :hover rule MUST NOT apply, so text-decoration stays "none".
  const memberName = page
    .locator(".shell-mobile .shell-members .members-pane li .member-name")
    .first();
  await memberName.hover();
  const decoration = await memberName.evaluate(
    (el) => getComputedStyle(el).textDecorationLine,
  );
  expect(decoration).toBe("none");
});
