// #229 — the operator's own user modes (umodes) visible from CONNECT +
// the /mode <nick> (umode) viewer/editor modal, proven end-to-end with the
// live upstream.
//
// The mirror of #216 (channel modes), for umodes. ircds do NOT report the
// user's own umode set unsolicited at registration (only mode CHANGES echo
// back), so grappa never learned the umodes it connected with — the umode
// indicator + modal would stay blank until a mid-session `/umode +x`. The
// fix (GROUP A/B/C): a bare `MODE <selfnick>` query at 001 RPL_WELCOME
// elicits 221 RPL_UMODEIS → the per-session umode set → broadcast +
// user-topic cold-snapshot → cic renders it from connect.
//
// The witness is designed so ONLY the connect-time query + cold-snapshot
// can satisfy it: the operator sets `+i` mid-session (a live echo cic sees),
// THEN RELOADS the page. The reload tears down the WS + the in-memory umode
// store; the upstream Session.Server survives (still holds +i in its umodes
// field). After the reload cic re-subscribes and the ONLY way it can learn
// the operator still holds +i is the user-topic after-join cold-snapshot —
// there is no live MODE echo in the reloaded session. Pre-fix: blank after
// reload (no snapshot) → RED. Post-fix: the modal shows +i active → GREEN.
// Needs the live upstream + a surviving session across a browser reload,
// which jsdom/vitest cannot do.
//
// Anti-hollow-green: `/umode -i` in `finally` restores the seeded vjt's
// umode set so the shared session doesn't leak +i into sibling specs.
//
// #301 — this spec ALSO asserts the corrected Azzurra umode copy (+d DEBUG,
// +g GLOBOPS, +S SSL) renders in the modal. The modal shows the full known
// table, so those toggles are present even though vjt holds none of them.

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

test("#229 — own umodes are visible from connect (cold-snapshot after reload), and tapping opens the umode modal", async ({
  page,
}) => {
  const vjt = getSeededVjt();

  await loginAs(page, vjt);
  // Focus the autojoin channel to confirm login + the upstream session is
  // live (self-JOIN echo present) before issuing the umode change.
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  try {
    // Set +i mid-session. The self-MODE echo folds into the server's umode
    // set AND broadcasts umode_changed → the sidebar indicator shows it live.
    await composeSend(page, "/umode +i");
    const indicator = page.locator(".sidebar-umode-indicator").first();
    await expect(indicator).toBeVisible({ timeout: 15_000 });
    await expect(indicator).toContainText("i");

    // RELOAD: tears down the WS + the in-memory umode store; the upstream
    // Session.Server survives holding +i. The ONLY path that can repopulate
    // the umode set now is the user-topic after-join cold-snapshot — there
    // is no live MODE echo in the reloaded session. This is the P0 witness.
    await page.reload();
    await expect(page.getByLabel(/open settings/i)).toBeVisible({ timeout: 10_000 });

    // HEADLINE (RED pre-fix): the indicator shows +i from connect, WITHOUT
    // any mid-session change in the reloaded session — the cold-snapshot
    // delivered it.
    const indicatorAfter = page.locator(".sidebar-umode-indicator").first();
    await expect(indicatorAfter).toBeVisible({ timeout: 15_000 });
    await expect(indicatorAfter).toContainText("i");

    // Tapping the indicator opens the umode modal, which renders toggle
    // buttons for the known umodes with +i pressed.
    await indicatorAfter.click();
    const modal = page.getByTestId("umode-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(modal.locator(".mode-modal-toggle").first()).toBeVisible();

    // The "invisible" (+i) toggle is ACTIVE (pressed) — the umode we set.
    const invisible = modal.getByLabel(/invisible/i);
    await expect(invisible).toHaveAttribute("aria-pressed", "true");

    // #301 — the modal renders the FULL known umode table (not just the
    // operator's active letters), so the three corrected Azzurra entries
    // render even though vjt holds none of them. Proves the fixed COPY
    // reaches the rendered DOM, not just the static table (the UX-behavior
    // e2e gate). Each toggle's aria-label is `<label> (+<letter>)`; the
    // human copy lives in `.mode-modal-toggle-desc`. Assert on the KEY
    // phrase (DEBUG / GLOBOPS / SSL) so the copy stays tunable.
    const debugDesc = modal.getByLabel(/\(\+d\)/).locator(".mode-modal-toggle-desc");
    await expect(debugDesc).toContainText(/debug/i);
    const globopsDesc = modal.getByLabel(/\(\+g\)/).locator(".mode-modal-toggle-desc");
    await expect(globopsDesc).toContainText(/globops/i);
    const sslDesc = modal.getByLabel(/\(\+S\)/).locator(".mode-modal-toggle-desc");
    await expect(sslDesc).toContainText(/ssl/i);

    // The × close control dismisses the modal (gemello of the /mode modal).
    await modal.getByLabel("close user modes").click();
    await expect(modal).toBeHidden({ timeout: 2_000 });
  } finally {
    // Restore the seeded vjt's umode set for sibling specs on the shared
    // session. `/umode` is per-session (no channel needed) but composeSend
    // needs SOME window with a compose box — re-select the autojoin channel
    // explicitly rather than trusting the post-reload restored selection.
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { awaitWsReady: false }).catch(
      () => {},
    );
    await composeSend(page, "/umode -i").catch(() => {});
  }
});
