// GH #1766 — a per-user setting that hides the mobile BottomBar.
//
// vjt, `#grappa` 2026-08-25: *"aggiungiamo setting toggle per disattivare la
// bottom bar su mobile. ora sono su 7 reti ed e' diventata praticamente
// inutile"*. The bar is a flat horizontal strip of EVERY window across EVERY
// network — O(windows), not O(screens) — so past a handful of networks it is
// longer than the useful scroll distance and the picker stops picking.
//
// Default stays ON. #174 closed with the ruling that the bar must NOT be
// deleted, only made opt-in from settings; #71's second ruling reversed "kill
// the mobile bottom bar" outright. This is the opt-out those two asked for.
//
// ## What this file has to prove that the unit tests cannot
//
// The unit suite pins the JSX gate and the child order in jsdom, where there is
// no layout, no service worker, no server and no second page load. Three claims
// need a real browser and a real bouncer:
//
//   1. The bar actually LEAVES the phone. A `<Show>` that renders nothing in
//      jsdom still tells you nothing about a strip that is `position`-ed by a
//      stylesheet jsdom never applies.
//   2. Something navigable replaces it. That is the whole reason the ☰ ships
//      with the toggle: #1041's left-edge swipe is gesture-only with zero
//      affordance, which is the drawer-only navigation #71 refused as a
//      default. So the test does not stop at "the ☰ is in the DOM" — it taps
//      it and CHANGES WINDOW through the drawer it opens. A ☰ that renders and
//      navigates nowhere would pass a presence assertion.
//   3. The preference is ACCOUNT-scoped, not device-scoped. It sits in the
//      #449 synced `display_prefs` and not in localStorage alone, deliberately
//      and against the counter-precedent of its own neighbour in the settings
//      fieldset (#914's per-device `hide_next_active`). Only a round trip
//      through the server can tell the two apart, so the second test wipes the
//      local mirror and reloads: if the bar comes back, the pref was never
//      synced and the "7 networks is an account property" argument was not
//      implemented.
//
// `@webkit` throughout: the bar renders on the mobile branch only, so a
// chromium run would assert the absence of something that was never there.

import {
  hideWindowBar,
  loginAs,
  openSettingsSection,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

const BOTTOM_BAR = ".bottom-bar";
const WINDOWS_OPENER = "open windows sidebar";
// The two localStorage keys that make up the LOCAL half of the preference: the
// owner module's boot mirror and the coordinator's "a PUT never ACKed" marker.
// Both have to go, or the reload below re-pushes the local value instead of
// letting the server answer — which is the #222 re-push arm doing its job, and
// would make the test prove the opposite of what it claims.
const LOCAL_MIRROR_KEYS = ["cicchetto.showBottomBar", "cic.displayPrefs.unsynced"];

test.setTimeout(90_000);

test("@webkit @touch mobile: turning the bar off removes it and leaves a working door", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // Baseline: the bar is there, and there is exactly ONE ☰ — the members door
  // on the right. No left door while the picker is in flow.
  await expect(page.locator(BOTTOM_BAR)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByLabel(WINDOWS_OPENER)).toHaveCount(0);

  await hideWindowBar(page);

  // 1. The bar is GONE from the page, not merely hidden: the gate is a mount
  //    gate, because a CSS-hidden BottomBar would keep running #327's
  //    double-rAF scroll-into-view against a strip nobody can see.
  await expect(page.locator(BOTTOM_BAR)).toHaveCount(0, { timeout: 10_000 });

  // 2. …and the left ☰ has arrived to replace it.
  const opener = page.getByLabel(WINDOWS_OPENER);
  await expect(opener).toBeVisible({ timeout: 10_000 });

  // 3. THE assertion. Tap it, and NAVIGATE — the drawer it opens is the #1041
  //    channel sidebar, and picking the server window from it must actually
  //    move the pane. A door that opens onto nothing would satisfy every
  //    assertion above.
  await opener.tap();
  const sidebar = page.locator(".shell-sidebar");
  await expect(sidebar).toBeVisible({ timeout: 10_000 });

  await sidebar.locator('[data-window-name="$server"]').first().tap();
  // The server window has no topic bar; the scrollback pane retargeting is the
  // observable move. Assert the CHANNEL bar is gone rather than that some pane
  // exists — the latter is true before the tap too.
  await expect(page.locator(".topic-bar-channel")).toHaveCount(0, { timeout: 10_000 });

  // The rail is still reachable with the bar off — settings must not become
  // unreachable as a side effect of hiding the navigation strip.
  await openSettingsSection(page, "display");
  await expect(page.getByTestId("show-bottom-bar-toggle")).not.toBeChecked();
});

test("@webkit @touch mobile: the preference is remembered by the ACCOUNT, not the device", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await expect(page.locator(BOTTOM_BAR)).toBeVisible({ timeout: 10_000 });

  await hideWindowBar(page);
  await expect(page.locator(BOTTOM_BAR)).toHaveCount(0, { timeout: 10_000 });

  // Wipe the LOCAL half only — the bearer stays, so this is the same account
  // arriving on a device that has never seen the preference. (A blanket
  // `localStorage.clear()` would take the session with it and prove nothing.)
  await page.evaluate((keys: string[]) => {
    for (const k of keys) localStorage.removeItem(k);
  }, LOCAL_MIRROR_KEYS);
  await page.reload();

  // On boot the owner module reads its empty mirror and defaults to SHOWN, so
  // the bar may flash in before the login reconcile lands. `toHaveCount(0)`
  // with a timeout is the honest oracle: it polls, and what it settles on is
  // the server's answer.
  await expect(page.locator(BOTTOM_BAR)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByLabel(WINDOWS_OPENER)).toBeVisible({ timeout: 10_000 });
});

// GH #1801 — with the bar off, this spec's end state is the ONLY one where the
// two openers share a band, which is why the third test lives here rather than
// beside #305's floor in `ux-5-bt`: that spec runs with the bar ON, so the left
// door is not mounted and an assertion there would be vacuous.
//
// The claim is rendered geometry, so the oracle is PAINTED PIXELS. Nothing
// cheaper will do, and #1766 paid to learn it twice: `getComputedStyle(el)
// .fontSize` measures the em box, which is exactly the quantity that overstates
// a thin glyph, and it reads 0 on a suppressed character; and the ☰'s ink lives
// in a `::before` + two `box-shadow` copies that no rect API reports at all.
// One screenshot, both doors measured the same way, is the only comparison that
// means "the same size".
//
// Scanned 4px inside each button so the 1px border is out of frame — a
// decoration is not ink (and at 48px box vs ~20px glyph there is 14px of
// clearance a side, so the inset cannot clip what we came to measure). The
// background is taken as the most frequent colour in the scanned region rather
// than sampled from a corner, so a theme background image cannot fake ink.
async function inkOf(
  page: Parameters<typeof loginAs>[0],
  selector: string,
  shot: string,
): Promise<{ w: number; h: number }> {
  const ink = await page.evaluate(
    async ({ selector, shot }: { selector: string; shot: string }) => {
      const el = document.querySelector(selector);
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      const dsf = window.devicePixelRatio;
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = `data:image/png;base64,${shot}`;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (ctx === null) return null;
      ctx.drawImage(img, 0, 0);

      const inset = 4 * dsf;
      const x0 = Math.max(0, Math.floor(r.left * dsf + inset));
      const y0 = Math.max(0, Math.floor(r.top * dsf + inset));
      const w = Math.min(canvas.width - x0, Math.ceil(r.width * dsf - 2 * inset));
      const h = Math.min(canvas.height - y0, Math.ceil(r.height * dsf - 2 * inset));
      if (w <= 0 || h <= 0) return null;
      const data = ctx.getImageData(x0, y0, w, h).data;

      const tally = new Map<number, number>();
      for (let i = 0; i < data.length; i += 4) {
        const key = (data[i] ?? 0) * 65536 + (data[i + 1] ?? 0) * 256 + (data[i + 2] ?? 0);
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      let bgKey = 0;
      let bgCount = -1;
      for (const [key, count] of tally) {
        if (count > bgCount) {
          bgCount = count;
          bgKey = key;
        }
      }
      const bg = [Math.floor(bgKey / 65536), Math.floor(bgKey / 256) % 256, bgKey % 256];

      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const delta =
            Math.abs((data[i] ?? 0) - (bg[0] ?? 0)) +
            Math.abs((data[i + 1] ?? 0) - (bg[1] ?? 0)) +
            Math.abs((data[i + 2] ?? 0) - (bg[2] ?? 0));
          if (delta > 24) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (minX === Number.POSITIVE_INFINITY) return { w: 0, h: 0 };
      return { w: (maxX - minX + 1) / dsf, h: (maxY - minY + 1) / dsf };
    },
    { selector, shot },
  );
  if (ink === null) throw new Error(`no ink measurable for ${selector}`);
  return ink;
}

test("@webkit @touch mobile: the two doors are a `#` and a ☰ at one ink size, and the left one is off the channel name", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await hideWindowBar(page);

  const left = page.locator(".topic-bar .topic-bar-windows-opener");
  const right = page.locator(".topic-bar .topic-bar-hamburger");
  await expect(left).toBeVisible({ timeout: 10_000 });
  await expect(right).toBeVisible({ timeout: 10_000 });

  // The split itself, before any measuring: the left door TYPES its glyph and
  // the right one DRAWS it. Both wearing bars is the reported defect; both
  // painting at once is what the removed `font-size: 0` used to prevent.
  await expect(left).toHaveText("#");
  const pseudo = await left.evaluate((el) => getComputedStyle(el, "::before").content);
  expect(pseudo, "the left door still draws the hamburger's bars under its `#`").toBe("none");
  const rightPseudo = await right.evaluate((el) => getComputedStyle(el, "::before").content);
  expect(rightPseudo, "the rail door stopped drawing its bars").not.toBe("none");

  const shot = (await page.screenshot({ fullPage: false })).toString("base64");
  const hash = await inkOf(page, ".topic-bar .topic-bar-windows-opener", shot);
  const bars = await inkOf(page, ".topic-bar .topic-bar-hamburger", shot);

  // Ruling 3: "che sia stessa dimensione del glifo dell'hamburger". HEIGHT is
  // the axis — a `#` is a narrower shape than a square, so equal width would
  // mean a `#` ~12% TALLER than the twin it was told to match. The tolerance is
  // the sampling grid (dsf 3 quantises each edge to 1/3px), not a slack band:
  // the derivation targets exact parity and the measured pair is 19.67 / 19.33.
  expect(hash.h, `the \`#\` paints ${hash.h}px tall and nothing at all under 1`).toBeGreaterThan(1);
  expect(
    Math.abs(hash.h - bars.h),
    `\`#\` ink ${hash.h}px vs ☰ ink ${bars.h}px — the two doors are not one size`,
  ).toBeLessThanOrEqual(2);
  // #305's floor, on the painted extent for both. The `#`'s ink WIDTH (~16.3px)
  // is deliberately not asserted against 18: see the CSS note — no `#` is as
  // wide as it is tall, and buying that width costs the height parity above.
  expect(hash.h, `#305 — the \`#\` is ${hash.h}px tall; the floor is 18`).toBeGreaterThanOrEqual(
    18,
  );
  expect(bars.h, `#305 — the ☰ is ${bars.h}px tall; the floor is 18`).toBeGreaterThanOrEqual(18);
  expect(bars.w, `#305 — the ☰ is ${bars.w}px wide; the floor is 18`).toBeGreaterThanOrEqual(18);

  // Ruling 4, both halves in one measurement. The leading side gains the
  // clearance (band gap + the new margin, ~14px at root 14px, up from ~7px);
  // the trailing side's inset stays exactly `.topic-bar`'s own padding, which
  // #1039 pinned to `--pane-chrome-inset-inline` so the ☰'s two mobile hosts
  // cannot drift apart. Read from the layout, not from the stylesheet.
  const spacing = await page.evaluate(() => {
    const bar = document.querySelector(".topic-bar");
    const opener = document.querySelector(".topic-bar .topic-bar-windows-opener");
    const header = document.querySelector(".topic-bar .topic-bar-header");
    const rail = document.querySelector(".topic-bar .topic-bar-hamburger");
    if (bar === null || opener === null || header === null || rail === null) return null;
    const cs = getComputedStyle(bar);
    return {
      leading: header.getBoundingClientRect().left - opener.getBoundingClientRect().right,
      bandGap: Number.parseFloat(cs.columnGap),
      trailingInset: bar.getBoundingClientRect().right - rail.getBoundingClientRect().right,
      barPaddingRight: Number.parseFloat(cs.paddingRight),
    };
  });
  if (spacing === null) throw new Error("the band did not render its three children");
  expect(
    spacing.leading,
    `the \`#\` sits ${spacing.leading}px from the channel name — the band gap alone (${spacing.bandGap}px) is the reported defect`,
  ).toBeGreaterThan(spacing.bandGap);
  expect(
    spacing.trailingInset,
    "#1039 — the rail door's inset must stay the band's own padding",
  ).toBeCloseTo(spacing.barPaddingRight, 1);
});
