// Notification-tap → focus (issue #146, P0 regression).
//
// Tapping an OS push notification — for a CHANNEL highlight/mention OR
// a nick/query PM — must open & focus the corresponding cicchetto
// window so the operator lands directly on the conversation that fired
// the notification.
//
// Why this spec exists on top of `ux-6-j-push-deep-link.spec.ts`: that
// gate only ever exercised a CHANNEL deep-link (warm + cold) and stayed
// green while the DM/query branch was broken — the same hollow-green
// trap as #78. This spec covers BOTH a channel and a DM, on BOTH the
// cold and warm drives, asserting the USER-VISIBLE outcome: the matching
// sidebar row carries `.selected`.
//
// Drives (fidelity order; see fixtures/pushTap.ts for the proven
// harness ceiling on driving the real SW `notificationclick`):
//   * COLD path — `page.goto(deepLink)`: a fresh document booted at the
//     deep-link, exactly what the SW's `clients.openWindow(url)` branch
//     produces. Runs the real `applyPushTargetFromUrl`. NOT a MessageEvent
//     shortcut — this is the primary gate, and it covers both cases.
//   * WARM path — `dispatchNavigateMessage`: replays the SW→page
//     `{type:"navigate", url}` contract onto the real
//     `installPushTargetListener`, exercising the real `applyPushTarget`.
//
// The DM cases are the regression's prime suspect: every other DM-open
// site (compose `/msg` `/query`, NamesModal, UserContextMenu,
// subscribe.ts inbound-DM) opens the query window via
// `openQueryWindowState` BEFORE selecting it; the push-target path did
// not, so a DM notification tapped when no query window exists yet
// (cold load after a DM-while-closed — the server never auto-creates the
// `query_windows` row) selected a window that was never opened: dead
// selection, no sidebar row.

import { expect, test } from "../fixtures/test";
import { loginAs, sidebarWindow } from "../fixtures/cicchettoPage";
import { buildPushDeepLink, dispatchNavigateMessage } from "../fixtures/pushTap";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

// Peer nicks with NO query window open in cic — the deep-link targets a
// DM whose window must be created by the tap itself (the
// cold-load-after-DM-while-closed scenario). Distinct nicks per test so
// a prior test's opened window can't satisfy a later assertion.
const DM_PEER_COLD = "notif146-cold";
const DM_PEER_WARM = "notif146-warm";

// Seeds auth the same way loginAs does, then boots straight at the
// deep-link — mirrors the SW's `openWindow(url)` on a closed PWA.
async function coldBootAt(page: Parameters<typeof loginAs>[0], vjt: ReturnType<typeof getSeededVjt>, url: string): Promise<void> {
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [vjt.token, vjt.subjectJson] as const,
  );
  await page.goto(url);
}

test.describe("#146 — notification tap opens & focuses the matching window", () => {
  test("channel highlight tap focuses the channel window (cold path / openWindow)", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    const channel = AUTOJOIN_CHANNELS[0];
    await coldBootAt(page, vjt, buildPushDeepLink(NETWORK_SLUG, channel));

    await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toHaveClass(/selected/, {
      timeout: 15_000,
    });
  });

  test("DM tap opens AND focuses the query window (cold path / openWindow)", async ({ page }) => {
    const vjt = getSeededVjt();
    await coldBootAt(page, vjt, buildPushDeepLink(NETWORK_SLUG, DM_PEER_COLD));

    // User-visible outcome: the DM window is now PRESENT in the sidebar
    // AND it is the focused/selected window. Pre-fix this row never
    // rendered (selection pointed at a window that was never opened).
    await expect(sidebarWindow(page, NETWORK_SLUG, DM_PEER_COLD)).toHaveClass(/selected/, {
      timeout: 15_000,
    });
  });

  test("channel highlight tap focuses the channel window (warm path / SW→page navigate)", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    const channel = AUTOJOIN_CHANNELS[0];
    // Baseline: the channel is NOT the focused window before the tap, so
    // a post-tap `.selected` proves the navigate drove the flip.
    await expect(sidebarWindow(page, NETWORK_SLUG, channel)).not.toHaveClass(/selected/);

    await dispatchNavigateMessage(page, buildPushDeepLink(NETWORK_SLUG, channel));

    await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toHaveClass(/selected/, {
      timeout: 10_000,
    });
  });

  test("DM tap opens AND focuses the query window (warm path / SW→page navigate)", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    // The query window must NOT pre-exist. We deliberately do not send a
    // DM (that would auto-open it via subscribe.ts) — the deep-link is
    // the production scenario where the DM arrived while cic was closed
    // and no `query_windows` row exists server-side.
    await expect(sidebarWindow(page, NETWORK_SLUG, DM_PEER_WARM)).toHaveCount(0);

    await dispatchNavigateMessage(page, buildPushDeepLink(NETWORK_SLUG, DM_PEER_WARM));

    await expect(sidebarWindow(page, NETWORK_SLUG, DM_PEER_WARM)).toHaveClass(/selected/, {
      timeout: 10_000,
    });
  });
});
