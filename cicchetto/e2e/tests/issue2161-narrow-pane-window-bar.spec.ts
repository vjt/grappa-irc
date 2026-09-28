// issue 2161 — in a narrow pane the window bar stays IN FLOW, whatever the
// #1766 preference says.
//
// ## The bug, and the half of it that is NOT fixed here
//
// On iPadOS Split View the OS claims both horizontal screen edges for the
// window divider, so neither of Shell's edge swipes ever ARMS: #1041's
// left→sidebar and #308's right→members simply never start, with no signal
// telling the user "not supported here" rather than "you swiped wrong".
//
// vjt ruled direction 2 (`#grappa`, 2026-09-18, one word: "2"). **The gesture
// stays lost — that is accepted, not worked around.** What the ruling buys is
// that the DOOR is always in flow where the gesture cannot be: below a width
// threshold the window bar renders regardless of the preference. Direction 1
// (arming a band inboard of the system's own) is not taken, because the width
// iPadOS reserves for the divider is unmeasured and nobody is guessing it.
//
// So there is nothing here about a swipe. A spec that tried to prove the
// gesture works in Split View would be proving the opposite of the ruling.
//
// ## What this file has to prove that the unit tests cannot
//
// `windowBarInFlow.test.ts` drives a fake `matchMedia` against the module's
// real query string, which pins the NUMBER. It cannot say that a real engine
// resolves that query the same way at a real viewport, that the strip is
// PAINTED rather than merely mounted, or that it still navigates. And it
// cannot exercise the live arm at all: a Split View pane is resized by dragging
// the divider, so the regime flips under a page that is already up.
//
// ## The two widths, and why they are these two
//
// Both are measured, and the threshold (383) sits between them. What it is NOT
// is derived: 383 is a tie-break inside [381, 383], and the top of that set is
// pinned by a width this suite cannot drive — issue 2301 measured a Galaxy S
// Ultra in portrait at 384 CSS px, exactly where the threshold shipped in
// 1.5.10, so a flagship phone lost the #1766 preference. See theme.ts.
//
//   * **380 x 650** — #2160's sample from the reporting device: iPad Pro 11,
//     iPadOS 26.7, landscape Split View, installed PWA (`standalone: true`).
//     The configuration the bug was reported in.
//   * **393 x 659** — `devices["iPhone 15"].viewport.width`, the narrowest
//     viewport this suite drives. It must stay OUTSIDE the override, or the
//     bar comes back for every phone the suite runs — which is #1766's own
//     configuration, and its spec would go red for asserting the preference it
//     exists to prove.
//
// `@webkit @touch`: the bar renders on the mobile branch only, so a desktop
// chromium run would assert the absence of something that was never there.
// Not `@webkit`-only despite the iPadOS provenance — nothing here reads
// `html.is-ios` or `navigator.standalone`, which is the line issue 1878 drew.

import {
  closeSettings,
  loginAs,
  openSettingsSection,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

const BOTTOM_BAR = ".bottom-bar";
const WINDOWS_OPENER = "open windows sidebar";
// The owner module's boot mirror (#1766). Read, never written, by this spec:
// it is the evidence that the uncheck below actually TOOK. Without it a
// silently-failed `uncheck()` leaves the bar on screen for the most boring
// reason there is and every assertion in the first test still passes.
const LOCAL_MIRROR = "cicchetto.showBottomBar";

// #2160's measured pane, to the pixel.
const SPLIT_VIEW = { width: 380, height: 650 };
// `devices["iPhone 15"]`, to the pixel.
const PHONE = { width: 393, height: 659 };

test.setTimeout(90_000);

async function hideTheBar(page: Parameters<typeof loginAs>[0]): Promise<void> {
  await openSettingsSection(page, "display");
  const toggle = page.getByTestId("show-bottom-bar-toggle");
  // Checked by DEFAULT: the bar ships shown. An already-unchecked toggle here
  // would mean the rest of this runs against a build whose default is inverted.
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await closeSettings(page);
}

test.describe("issue 2161 — loading straight into a narrow pane", () => {
  test.use({ viewport: SPLIT_VIEW });

  test("@webkit @touch mobile: the window bar overrides the preference and still navigates", async ({
    page,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    await loginAs(page, specUser());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await expect(page.locator(BOTTOM_BAR)).toBeVisible({ timeout: 10_000 });

    await hideTheBar(page);

    // The preference genuinely went to false. Asserted BEFORE the bar, because
    // an uncheck that did not take makes everything below vacuous — the bar
    // would be on screen for the ordinary reason, and this spec would claim a
    // ruling it never exercised.
    await expect
      .poll(async () => await page.evaluate((k: string) => localStorage.getItem(k), LOCAL_MIRROR), {
        timeout: 10_000,
      })
      .toBe("false");

    // THE assertion. `toBeVisible`, not `toHaveCount(1)`: the claim is a door
    // in FLOW, and a mounted strip with zero height would satisfy a count.
    await expect(page.locator(BOTTOM_BAR)).toBeVisible({ timeout: 10_000 });

    // …and exactly ONE door, not two. #1766 mounts the leading ☰ only when no
    // picker is in flow; the override puts one back, so the ☰ must stand down.
    // A cure that flipped only the bar's gate and left the ☰ reading the raw
    // preference would render both and pass every other assertion here.
    await expect(page.getByLabel(WINDOWS_OPENER)).toHaveCount(0);

    // A picker that picks nothing would satisfy every line above. Navigate.
    // The server window's entry in the strip is the NETWORK HEADER chip, keyed
    // by slug — the bar carries no `data-window-name="$server"`, unlike the
    // sidebar (`SERVER_WINDOW_NAME` never reaches an attribute here).
    await page
      .locator(`${BOTTOM_BAR} .bottom-bar-network-header[data-network-slug="${NETWORK_SLUG}"]`)
      .first()
      .tap();
    // The server window has no topic bar; its absence is the observable move
    // (asserting some pane exists is true before the tap too).
    await expect(page.locator(".topic-bar-channel")).toHaveCount(0, { timeout: 10_000 });
  });
});

test("@webkit @touch mobile: the threshold discriminates, and it does so live", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  // Explicit rather than inherited: the two touch projects default to 393 and
  // 412, and this test's first claim is about the width, not about the device.
  await page.setViewportSize(PHONE);
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  await hideTheBar(page);

  // 🔴 The negative control, at the narrowest viewport this suite can drive.
  // (The MEASURED upper bound is issue 2301's 384, nine pixels below — no
  // Playwright device sits there, so the unit suite owns that end.) A cure that
  // forces the bar on unconditionally — the lazy reading of "keep the window
  // bar in flow" — passes every other assertion in this file and fails right
  // here. 393 is a phone, the swipes work there, and the preference is the
  // user's to keep.
  await expect(page.locator(BOTTOM_BAR)).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByLabel(WINDOWS_OPENER)).toBeVisible({ timeout: 10_000 });

  // Drag the divider. This is the arm no unit test reaches and no boot-time
  // width read implements: the pane narrows under a page that is already up.
  await page.setViewportSize(SPLIT_VIEW);
  await expect(page.locator(BOTTOM_BAR)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByLabel(WINDOWS_OPENER)).toHaveCount(0);

  // And back — the override is a REGIME, not a latch. Widening the pane must
  // return the preference to the user rather than leave the bar behind.
  await page.setViewportSize(PHONE);
  await expect(page.locator(BOTTOM_BAR)).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByLabel(WINDOWS_OPENER)).toBeVisible({ timeout: 10_000 });

  // The account never learned about any of it. `show_bottom_bar` is #449-synced
  // and account-scoped, so a viewport that wrote it would wipe the preference
  // on every other device the user owns — the failure mode no screenshot shows.
  await expect
    .poll(async () => await page.evaluate((k: string) => localStorage.getItem(k), LOCAL_MIRROR), {
      timeout: 10_000,
    })
    .toBe("false");
});
