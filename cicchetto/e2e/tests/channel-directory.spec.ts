// channel-directory — e2e channel directory browse + join (#84)
//
// What this spec asserts:
//   1. The 📇 channels ($list) sidebar row opens DirectoryPane.
//   2. The server-issued LIST populates the directory; a peer-created
//      channel (PEER_CHANNEL) and the seeded autojoin channel (#bofh)
//      both appear after clicking Refresh.
//   3. Selecting the $list window fires NO GET /messages request
//      (grappa-irc#81: kindHasScrollback("list") === false).
//   4. Typing in the search box filters results to matching channels
//      (server-side query re-GET; server returns only matching entries).
//   5. Clicking a channel's join control adds it to the sidebar AND
//      foregrounds its window (#244 — a user-initiated directory tap now
//      JOINs and selects the new window, amending #125's no-auto-open).
//      The in-row "joined" badge is unit-covered (DirectoryPane.test.tsx);
//      it can't be asserted here because the foreground unmounts the pane.
//
// Why peer stays connected: bahamut only includes non-empty channels in
// LIST replies. The peer must remain joined in PEER_CHANNEL for the
// duration of the LIST cycle, or the channel won't appear in the 322s
// grappa captures.
//
// Cleanup: PART PEER_CHANNEL via REST in afterEach so the
// autojoin-persistence side-effect from the one-click-join step
// doesn't bleed into subsequent runs. The global _vjtReset fixture
// (from fixtures/test) also resets autojoin to AUTOJOIN_CHANNELS
// after every test.

import { test, expect } from "../fixtures/test";
import {
  loginAs,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import {
  AUTOJOIN_CHANNELS,
  getSeededVjt,
  NETWORK_NICK,
  NETWORK_SLUG,
} from "../fixtures/seedData";

// "$list" — LIST_WINDOW_NAME from src/lib/windowKinds.ts. Hardcoded
// here because the e2e tsconfig does not resolve src/ imports. A
// rename of the constant must be propagated to this file manually.
const LIST_WINDOW_NAME = "$list";

// Unique channel per run: avoids persistent state bleed across
// test retries and parallel runs on the same testnet DB.
// crypto.randomUUID() is available in the Node.js e2e context.
const PEER_CHANNEL = `#e2edir-${crypto.randomUUID().slice(0, 8)}`;

test.afterEach(async () => {
  // PART PEER_CHANNEL server-side even on failure so the next run
  // starts clean. Idempotent: 404 if the channel was never joined.
  const vjt = getSeededVjt();
  await partChannel(vjt.token, NETWORK_SLUG, PEER_CHANNEL).catch(() => {});
});

test(
  "channel-directory — browse, no /messages fetch (#81 guard), search filter, one-click join",
  async ({ page }) => {
    const vjt = getSeededVjt();

    // Connect an IRC peer and join PEER_CHANNEL so it exists in bahamut
    // before grappa issues LIST. The peer stays connected for the whole
    // test so the channel is non-empty in bahamut's 322 replies.
    const peer = await IrcPeer.connect({
      nick: `e2edir-${crypto.randomUUID().slice(0, 4)}`,
    });
    try {
      await peer.join(PEER_CHANNEL);

      await loginAs(page, vjt);

      // Focus #bofh and wait for its scrollback to land so the initial
      // GET /messages for the autojoin channel has already fired BEFORE
      // we arm the request collector.
      await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], {
        ownNick: NETWORK_NICK,
      });

      // Arm the /messages request collector from this point forward.
      // Any /messages hit recorded after this point means the $list
      // window selection bypassed the grappa-irc#81 kindHasScrollback
      // guard — a real regression, not a stale initial fetch.
      const messagesRequests: string[] = [];
      page.on("request", (req) => {
        if (/\/messages(\?|$)/.test(req.url())) {
          messagesRequests.push(req.url());
        }
      });

      // Open the 📇 channels directory window for this network.
      // sidebarWindow resolves `li[data-window-name="$list"]` on
      // desktop; .sidebar-window-btn is the clickable button inside it.
      await sidebarWindow(page, NETWORK_SLUG, LIST_WINDOW_NAME)
        .locator(".sidebar-window-btn")
        .click();

      // DirectoryPane is now mounted. The search box and Refresh button
      // render outside the <Show when={page()}> guard and are immediate.
      await expect(page.locator(".directory-search")).toBeVisible({
        timeout: 5_000,
      });
      const refreshBtn = page.locator(".directory-refresh");
      await expect(refreshBtn).toBeVisible({ timeout: 5_000 });

      // (3) Assert NO /messages request was fired for the $list window
      // selection. Checked here — before any join that would legitimately
      // trigger GET /messages for the newly-joined channel window.
      expect(
        messagesRequests,
        "GET /messages must NOT fire when selecting kind=list — grappa-irc#81 guard",
      ).toHaveLength(0);

      // Force a fresh server-side LIST so PEER_CHANNEL (just created
      // above) is captured even if a stale snapshot already exists.
      await refreshBtn.click();

      // (2a) PEER_CHANNEL appears in the directory. Generous timeout:
      // the LIST → Session.Server 322 capture → 323 → progress ping
      // → cic re-GET round-trip is fully async; allow 15 s.
      const peerRow = page
        .locator(".directory-row-join")
        .filter({ hasText: PEER_CHANNEL });
      await expect(peerRow).toBeVisible({ timeout: 15_000 });

      // (2b) The seeded autojoin channel also appears.
      const bofhRow = page
        .locator(".directory-row-join")
        .filter({ hasText: AUTOJOIN_CHANNELS[0] });
      await expect(bofhRow).toBeVisible({ timeout: 5_000 });

      // (4) Search filter: typing the unique fragment ("e2edir") routes a
      // server-side query re-GET. Only PEER_CHANNEL should match;
      // AUTOJOIN_CHANNELS[0] (#bofh) should be absent.
      await page.locator(".directory-search").fill("e2edir");
      await expect(peerRow).toBeVisible({ timeout: 5_000 });
      await expect(bofhRow).toBeHidden({ timeout: 5_000 });

      // Clear the filter so all rows are back before the join step.
      await page.locator(".directory-search").fill("");
      await expect(bofhRow).toBeVisible({ timeout: 5_000 });

      // (5) One-click join: assert PEER_CHANNEL is not yet in the sidebar,
      // click its join control, then assert the sidebar gains an entry
      // (mirrors m8: sidebarWindow toHaveCount(1)).
      await expect(
        sidebarWindow(page, NETWORK_SLUG, PEER_CHANNEL),
      ).toHaveCount(0);
      await peerRow.click();
      await expect(
        sidebarWindow(page, NETWORK_SLUG, PEER_CHANNEL),
      ).toHaveCount(1, { timeout: 10_000 });

      // #244 — a user-initiated directory tap now JOINs *and* foregrounds
      // the new channel's window (amends #125's original no-auto-open). So
      // the tap flips selKind() list → channel, unmounting DirectoryPane;
      // the `.directory-row-badge` (a DirectoryPane-only element) is no
      // longer observable in a mounted pane. Assert the foreground signal
      // instead: the newly-joined channel is the SELECTED sidebar window.
      // The badge itself is unit-covered in DirectoryPane.test.tsx; the
      // foreground behaviour is the #244 P0 fix, covered end-to-end in
      // issue244-directory-tap-foreground.spec.ts.
      await expect(
        sidebarWindow(page, NETWORK_SLUG, PEER_CHANNEL),
      ).toHaveClass(/selected/, { timeout: 10_000 });
    } finally {
      await peer.disconnect("e2e channel-directory done");
    }
  },
);
