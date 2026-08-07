// #975 — `/mode` on a channel you have LEFT must not answer with the modes
// you saw while you were in it.
//
// Reported by Sonic on #it-opers: `/mode #channel-I-was-in-earlier` printed
// modes, and they were the ones from his last visit. `modesByChannel` had
// one filler (the 324 the server queries on JOIN, pushed on the per-channel
// WS topic) and no emptier, so the entry outlived the PART forever and the
// modal presented it as CURRENT.
//
// The witness needs the live upstream: the whole mechanism is a real JOIN
// eliciting a real 324, then a real PART echo arriving on the per-channel
// topic. jsdom can prove the store drops a key; only this can prove the key
// was ever filled by the round-trip it is supposed to be filled by, and that
// the operator-visible answer changes.
//
// Shape:
//   1. a peer creates a per-run UNIQUE channel (→ op) and sets +m, a mode
//      no bahamut channel carries by default, so its presence in the modal
//      is unambiguously the cached 324 and not a default.
//   2. vjt joins → the modal shows "moderated" PRESSED. This half also
//      guards the #216 join-time query: if it ever stops firing, this fails
//      here rather than making step 4 pass for the wrong reason.
//   3. vjt PARTs.
//   4. `/mode <channel>` again → the modal says the modes are unknown and
//      renders NO toggles. Pre-fix it rendered the same grid as step 2,
//      "moderated" still pressed — the reported symptom, exactly.
//
// Anti-pollution: unique channel per run, peer disconnected in `finally`
// (which drops the channel once vjt has parted).

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

test("#975 — /mode on a parted channel reports unknown, not the modes cached while joined", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  const channel = `#t975-${Date.now()}`;

  await loginAs(page, vjt);
  // Focus the autojoin channel first: confirms login + WS-ready before the
  // /join, and gives the composer a home to return to after the PART (the
  // `/mode <channel>` in step 4 is typed from here, not from the window
  // that no longer exists).
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: `t975peer-${Date.now() % 100000}` });
  try {
    await peer.join(channel);
    await peer.mode(channel, "+m");

    await composeSend(page, `/join ${channel}`);
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: channel }),
    ).toHaveCount(1, { timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });

    // Step 2 — the cache is genuinely populated by the join-time 324.
    const modeIndicator = page.locator(".topic-bar-modes");
    await expect(modeIndicator).toBeVisible({ timeout: 15_000 });
    await expect(modeIndicator).toContainText("m");

    const modal = page.getByTestId("mode-modal");
    await composeSend(page, `/mode ${channel}`);
    await expect(modal).toBeVisible({ timeout: 5_000 });
    // By testid, not by accessible name: bahamut has BOTH +m ("moderated")
    // and +M ("moderated (reg'd)"), so any /moderated/ name locator is
    // ambiguous and asserts on whichever the grid happened to render first.
    await expect(modal.getByTestId("mode-toggle-m")).toHaveAttribute("aria-pressed", "true");
    await expect(modal.getByTestId("mode-modal-unknown")).toHaveCount(0);
    await modal.getByLabel("close modes").click();
    await expect(modal).toBeHidden({ timeout: 5_000 });

    // Step 3 — PART via REST; the own-PART echo on the per-channel topic is
    // what drives the drop. The sidebar row vanishing is that echo having
    // been processed (`setParted` is the projection), so it is the barrier
    // for the drop too — same handler, same event.
    await partChannel(vjt.token, NETWORK_SLUG, channel);
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: channel }),
    ).toHaveCount(0, { timeout: 10_000 });

    // Step 4 — the operator asks again. Selection has moved off the parted
    // window; re-anchor on the autojoin channel so the composer is live and
    // the network slug the verb resolves against is unambiguous.
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });
    await composeSend(page, `/mode ${channel}`);
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(modal.getByTestId("mode-modal-unknown")).toBeVisible();

    // The grid is GONE, not merely all-off: an all-off grid asserts "this
    // channel has no modes set", which is a different (and equally false)
    // claim from "cic does not know".
    await expect(modal.locator(".mode-modal-toggle")).toHaveCount(0);
    await expect(modal.locator('[aria-pressed="true"]')).toHaveCount(0);
    await expect(modal.locator(".mode-modal-param-row")).toHaveCount(0);
  } finally {
    await peer.disconnect("t975 done").catch(() => {});
  }
});
