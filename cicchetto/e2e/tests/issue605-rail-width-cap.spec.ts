// #605 — cap the server-window rail width so the ServerInfoCard can't
// starve the message area on small desktop-class viewports (morph's
// iPad Pro 11" report, 2026-08-01).
//
// The mechanism the fix targets (verified against origin/main, NOT the
// issue's suggested direction — see below):
//   * A SERVER window has kind !== "channel", so isActiveChannelJoined()
//     is false (windowState.ts) and Shell.tsx tags `.shell-no-members`.
//   * `.shell-no-members` sizes the RIGHT rail track as `max-content`
//     (default.css) — it does NOT reference `--members-width`. So the
//     rail sizes to the ServerInfoCard's widest UNWRAPPED line.
//   * The card's `server` row renders `connection.server:port`. A long
//     value — a real IPv6 peer (the #609 cutover), or a long disconnect
//     reason — has no wrap point under `max-content`, so the track
//     balloons and the centre scrollback becomes a sliver.
// The issue's suggested `min(--members-width, Nvw)` cap would miss this
// entirely: `--members-width` is not in the `.shell-no-members` track.
// The fix caps the track itself with `fit-content(14rem)` (grows with
// content, never past the members-rail's declared width).
//
// This is the WIRING proof (feedback_ux_e2e_mandatory): vitest/jsdom is
// blind to grid track sizing, so only real chromium layout can assert
// the cap. We reproduce morph's condition deterministically by rewriting
// the seeded network's `connection.server` to a long IPv6 at the
// `GET /networks` boundary — the same store hydration path #474 asserts
// against — then measure the rail's real bounding box.
//
// iPad Pro 11" portrait is 834×1194: WIDER than the 768px mobile
// breakpoint, so Shell renders the desktop three-pane shell (not the
// mobile drawer) — exactly where morph saw the starve.

import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

const SERVER_WINDOW_LABEL = "Server";

// A full-length IPv6 literal — no wrap point under `max-content`, so it
// balloons the uncapped rail. Ties to the #609 IPv6 cutover that surfaced
// morph's report. 39 chars + `:6697` → ~380px of unbreakable text.
const LONG_IPV6 = "2001:1418:1000:2000:3000:4000:5000:6000";

// iPad Pro 11" portrait. > 768 → desktop shell (the starve viewport).
test.use({ viewport: { width: 834, height: 1194 } });

// 14rem at the app's 14px root (--font-size) = 196px; allow a few px for
// the aside's 1px left border + sub-pixel rounding.
const RAIL_CAP_PX = 196;
const RAIL_CAP_TOLERANCE_PX = 18;
// Centre floor: 834 − left rail (256px, --sidebar-width default) − capped
// right rail (≤196px) = ≥382px. Assert a hair under to absorb rounding.
const CENTRE_FLOOR_PX = 375;

async function boxWidth(
  page: import("@playwright/test").Page,
  selector: string,
): Promise<number> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no bounding box`);
  return Math.round(box.width);
}

test.describe("#605 server-window rail width cap", () => {
  test("a long connection.server can't starve the centre on an 834px viewport", async ({
    page,
  }) => {
    // Rewrite the seeded network's dialled server to a long IPv6 BEFORE
    // the SPA fetches /networks, so the store hydrates the wide-content
    // card. Registered before loginAs (which goto's "/") so the first
    // fetch — and any connection_state_changed refetch — is patched.
    await page.route(
      (url) => url.pathname === "/networks",
      async (route) => {
        const res = await route.fetch();
        const rows = (await res.json()) as Array<{
          connection?: { server?: string } | null;
        }>;
        const patched = rows.map((n) =>
          n.connection
            ? { ...n, connection: { ...n.connection, server: LONG_IPV6 } }
            : n,
        );
        await route.fulfill({ response: res, json: patched });
      },
    );

    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    // Focus the server window (no WS-ready dance — server windows have no
    // channel join / self-JOIN line).
    await expect(sidebarWindow(page, NETWORK_SLUG, SERVER_WINDOW_LABEL)).toHaveCount(1);
    await selectChannel(page, NETWORK_SLUG, SERVER_WINDOW_LABEL, { awaitWsReady: false });

    // The card renders the long IPv6 — proves the injection landed AND
    // that this is the wide-content path (the exact starve trigger).
    const card = page.locator("[data-testid=rail-server-info]");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator('dt:text-is("server") + dd')).toContainText(LONG_IPV6);

    // The rail is capped: without the fix the `max-content` track balloons
    // to the IPv6's ~380px; with it, `fit-content(14rem)` clamps to ≤196px
    // and the IPv6 wraps inside the card.
    const railWidth = await boxWidth(page, ".shell-members");
    expect(railWidth).toBeLessThanOrEqual(RAIL_CAP_PX + RAIL_CAP_TOLERANCE_PX);

    // …and the centre keeps a usable share (the acceptance criterion).
    const centreWidth = await boxWidth(page, ".shell-main");
    expect(centreWidth).toBeGreaterThanOrEqual(CENTRE_FLOOR_PX);
  });
});
