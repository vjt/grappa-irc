// CP13 server-window cluster e2e suite.
//
// Validates the bucket end-to-end:
//   - S5: server-routed numerics persist as :notice rows in the routed
//     window (hand-off to the regular per-channel WS pipeline).
//   - S6: numericInline ephemeral bottom pane is gone (no
//     `.numeric-inline-pane` in the DOM).
//   - S8: $server window surfaces the 3 unread badges.
//   - S9: $server has a ComposeBox; plain-text submit is rejected with
//     a friendly error; slash-commands pass the gate.
//   - S10: bodies render through the mIRC formatter — bold from a peer
//     produces a `.scrollback-mirc-bold` <span>.
//
// Caveat S5 (orchestrator): `/whois nonexistent` should land the 401
// in the queried nick's query window. Cicchetto's /whois isn't wired
// as a client-side command yet, so the equivalent observable trip is
// `/msg <ghost> hi`: cic opens the query window client-side (compose.ts
// /msg handler), sends the PRIVMSG, the server responds with 401 (no
// such nick), NumericRouter resolves to {:query, ghost}, EventRouter
// persists a :notice row on channel=ghost, and the existing per-(slug,
// nick) WS subscription delivers it live to the open query window.
// This spec confirms the loop closes without needing a server-side
// `query_window_opened` push event for first-contact numerics.

import { test, expect } from "@playwright/test";
import {
  composeTextarea,
  loginAs,
  scrollbackLines,
  selectChannel,
  sidebarMessageBadge,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

const SERVER_WINDOW_LABEL = "Server";
const TEST_CHANNEL = "#bofh";

test.describe("CP13 server-window cluster", () => {
  test("S6 — bottom numeric-inline pane is gone (no `.numeric-inline-pane` in DOM)", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, TEST_CHANNEL);
    // The pane was rendered as a sibling of `.scrollback-pane` content
    // pre-CP13. Asserting page-wide ensures no remnant in other layouts.
    await expect(page.locator(".numeric-inline-pane")).toHaveCount(0);
    await expect(page.locator(".numeric-inline-line")).toHaveCount(0);
  });

  test("S9 — ComposeBox renders on $server + slash-only gate rejects plain text", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    const serverEntry = sidebarWindow(page, NETWORK_SLUG, SERVER_WINDOW_LABEL);
    await expect(serverEntry).toHaveCount(1);
    await selectChannel(page, NETWORK_SLUG, SERVER_WINDOW_LABEL, { awaitWsReady: false });

    // CP13 S9: ComposeBox IS in the DOM on the Server window.
    const ta = composeTextarea(page);
    await expect(ta).toHaveCount(1);

    // Plain text submit returns the friendly error. We can't use
    // composeSend (which waits for the textarea to empty on success);
    // on rejection the draft is preserved, so we drive the keys
    // directly and assert the .compose-box-error banner appears.
    await ta.fill("this is not a slash command");
    await ta.press("Enter");
    await expect(page.locator(".compose-box-error")).toContainText(
      "Server window accepts only slash-commands",
    );
    // Draft preserved on rejection.
    await expect(ta).toHaveValue("this is not a slash command");
  });

  test("S8 — $server window surfaces unread message badge after live numeric arrives", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    // Focus a different window so $server is NOT focused — unread
    // accumulates on non-focused windows only.
    await selectChannel(page, NETWORK_SLUG, TEST_CHANNEL);

    // Trigger a routed numeric AFTER login so the WS subscription on
    // the $server topic is already live. /away triggers an upstream
    // AWAY command; the server replies with 306 RPL_NOWAWAY which is
    // in NumericRouter's @active_numerics deny list → routes to
    // {:server, nil} → persists as a :notice row on $server with
    // meta.numeric=306, severity=:ok. The row arrives on the per-
    // channel WS topic and bumps messagesUnread for $server (the
    // currently-focused window is #bofh, not $server).
    //
    // (MOTD lines persist on $server too but they fire DURING session
    // bootstrap, before cicchetto's WS subscription is ready, so they
    // populate the DB but don't bump the live unread counter.)
    const ta = composeTextarea(page);
    await ta.fill("/away gone for tests");
    await ta.press("Enter");
    await expect(ta).toHaveValue("", { timeout: 5_000 });

    const badge = sidebarMessageBadge(page, NETWORK_SLUG, SERVER_WINDOW_LABEL);
    await expect(badge).toBeVisible({ timeout: 10_000 });
    const text = (await badge.textContent()) ?? "0";
    expect(Number(text)).toBeGreaterThan(0);
  });

  test("S10 — peer's bold-formatted PRIVMSG renders with .scrollback-mirc-bold span", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    // awaitWsReady=false: the bootstrap-time JOIN line for #bofh has
    // already arrived in the shared grappa session by the time this
    // test runs in full-suite ordering, so the helper's "wait for a
    // fresh JOIN-self line" probe times out. The selectChannel itself
    // still completes — we just don't need the WS-ready handshake.
    await selectChannel(page, NETWORK_SLUG, TEST_CHANNEL, { awaitWsReady: false });

    const peer = await IrcPeer.connect({ nick: "boldpeer" });
    try {
      await peer.join(TEST_CHANNEL);
      // \x02 = bold toggle. The body has "x" plain, "BOLD" bold, "y" plain.
      peer.privmsg(TEST_CHANNEL, "x\x02BOLD\x02y");

      // The mIRC parser splits the body into 3 runs; the bold run is a
      // <span class="scrollback-mirc-bold">BOLD</span>. Look for that
      // span anywhere in the channel scrollback.
      await expect(
        scrollbackLines(page).locator(".scrollback-mirc-bold", { hasText: "BOLD" }),
      ).toHaveCount(1, { timeout: 10_000 });
    } finally {
      await peer.disconnect("done");
    }
  });

  test("S5 caveat — /msg to nonexistent nick: 401 lands in the query window live", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, TEST_CHANNEL);

    // Pick a nick guaranteed to not exist on the testnet.
    const ghostNick = `ghost-${Date.now().toString(36)}`;

    // Type /msg <ghost> hi via the compose box. compose.ts's /msg
    // handler opens a query window client-side AND switches focus to
    // it AND sends the PRIVMSG upstream. Server tries to deliver, gets
    // 401 ERR_NOSUCHNICK back, NumericRouter resolves to {:query, nick},
    // EventRouter persists a :notice row on channel=nick. The query
    // window's WS subscription (already live since the client-side
    // open) delivers the row.
    //
    // Use composeTextarea + raw fill so we don't depend on
    // composeSend's "textarea empties on success" wait — /msg's outbound
    // PRIVMSG path resolves immediately client-side and clears the
    // draft, but the timing is dependent on the WS join completing
    // for the new query window. Driving keys directly + asserting the
    // notice DOM row decouples the two waits.
    const ta = composeTextarea(page);
    await ta.fill(`/msg ${ghostNick} hi`);
    await ta.press("Enter");

    // After /msg, focus switches to the query window. The 401 :notice
    // row should appear in the scrollback within a few seconds. Wider
    // timeout because the round-trip is grappa→bahamut→401→grappa→
    // persist→broadcast→cicchetto, and the WS subscription on the
    // newly-opened query topic has to settle first.
    await expect(
      page.locator(".scrollback-pane .scrollback-notice-error"),
    ).toHaveCount(1, { timeout: 15_000 });
  });
});
