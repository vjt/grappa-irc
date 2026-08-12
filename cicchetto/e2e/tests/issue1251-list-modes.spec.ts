// #1251 — every type-A (list) channel mode the network advertises must be
// reachable, not just `+b`, proven end-to-end against the live upstream.
//
// The bug: the whole list path was hardcoded to `b`. `MODE #chan z` was never
// sent, 728/729 were never delegated, and nothing rendered — so on Azzurra
// (bahamut, `CHANMODES=bz`) the ircd's own restrict list was invisible, and
// bahamut has no `+e`/`+I` at all, so "add +e and +I" would have left the
// home network exactly as unreachable as before.
//
// The witness is the SECOND list, seen by a user: a `+z` entry set upstream
// renders in the modal after switching to it, and the `+b` entry does not.
// That single assertion exercises the entire chain, and each link is a place
// the pre-fix code was silent:
//
//   * the 005 `CHANMODES=bz` reaching cic as `list_modes_queryable: [b, z]`
//     (the switcher only has a second button if the server published one),
//   * `MODE #chan z` actually leaving the bouncer,
//   * 728 RPL_RESTRICTLIST being DELEGATED (undelegated it persists as a
//     `$server` notice carrying the bare set-timestamp — the #376 leak
//     shape) and folding into the `{channel, z}` accumulator,
//   * the mode letter read OFF THE WIRE rather than assumed — bahamut spends
//     728/729 on `z` and solanum on `q`, so an assumed letter would strand
//     one of the two networks,
//   * the bundle carrying `mode`, which is what stops the previously-fetched
//     `+b` rows from being re-labelled as restrict rows.
//
// jsdom/vitest cannot do this: it needs the live ircd MODE + 728/729 round
// trip. Mirrors #536's shape — vjt creates a fresh per-run channel (→ sole
// op, which bahamut REQUIRES to even read the restrict list, `channel.c`
// `case 'z'`) and PARTs it in `finally`.

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

test("#1251 — the +z restrict list is reachable, and renders as itself", async ({ page }) => {
  const vjt = specUser();
  const stamp = Date.now() % 1_000_000;
  const channel = `#t1251lm-${Date.now()}`;
  // Two literal masks, one per list. They must be DISTINCT: the oracle is
  // that each list shows its own entry and not the other's, which is exactly
  // what a dropped `mode` field would break.
  const banMask = `banned1251-${stamp}!*@*`;
  const restrictMask = `rogue1251-${stamp}!*@*`;

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  try {
    // vjt creates the channel → sole op (@) → both +b and +z are allowed,
    // and the restrict list is readable (bahamut refuses it to non-ops).
    await composeSend(page, `/join ${channel}`);
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: channel }),
    ).toHaveCount(1, { timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });

    // Barrier: the ircd's own MODE echo, rendered as a scrollback row. It
    // serialises "the entry landed upstream" before we query — the list
    // numerics carry no request-id, so racing them re-introduces the #386
    // marker race — and it is a DURABLE pre-state (the row is persisted),
    // not a transient we might miss.
    //
    // A joined peer CANNOT witness this, which is what the first run of this
    // spec measured: bahamut writes `b` into both `mbuf` and `stripped_mbuf`
    // (`channel.c` case 'b') so the ban echo reaches the whole channel, but
    // case 'z' writes `mbuf` ONLY — `stripped_mcount != mcount` then routes
    // the echo through `sendto_chanops_butserv` (`channel.c` ~:1120), i.e.
    // to OPS ALONE. The restrict list is op-private on both the read and the
    // write side; a non-op peer waiting for `MODE +z` waits forever.
    const modeEcho = (modes: string, mask: string) =>
      expect(
        page.locator(".scrollback-body", {
          hasText: `sets mode ${modes} ${mask} on ${channel}`,
        }),
      ).toBeVisible({ timeout: 15_000 });

    await composeSend(page, `/mode ${channel} +b ${banMask}`);
    await modeEcho("+b", banMask);

    await composeSend(page, `/mode ${channel} +z ${restrictMask}`);
    await modeEcho("+z", restrictMask);

    // Baseline: the `b` list is the one that already worked. Asserting it
    // FIRST also proves the two masks are distinguishable in the UI, so the
    // switch below cannot pass by rendering a stale bundle.
    await composeSend(page, `/banlist`);
    const modal = page.getByTestId("banlist-modal");
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal.locator(".banlist-modal-mask")).toContainText(banMask, { timeout: 20_000 });
    await expect(modal).toContainText(`Bans: ${channel}`);
    await expect(modal).not.toContainText(restrictMask);

    // The switcher exists only because the SERVER published `z` as queryable
    // for this network — cic never derives that set.
    const switcher = modal.getByTestId("banlist-mode-switcher");
    await expect(switcher).toBeVisible();
    await switcher.getByTestId("banlist-mode-z").click();

    // THE #1251 WITNESS: the restrict entry renders, under its own heading,
    // and the ban entry is gone. Pre-fix there was no way to ask for this
    // list at all; a hardcoded `z`-vs-`q` or a bundle without `mode` shows
    // the ban rows here instead.
    await expect(modal).toContainText(`Restricted: ${channel}`);
    await expect(modal.locator(".banlist-modal-mask")).toContainText(restrictMask, {
      timeout: 20_000,
    });
    await expect(modal).not.toContainText(banMask);

    // The other lists are a viewer for now — the add/remove controls belong
    // to `+b` only (the ban/unban verbs derive masks and chunk per MODES=).
    await expect(modal.getByTestId("banlist-modal-readonly")).toBeVisible();
    await expect(modal.getByTestId("banlist-add-btn")).toHaveCount(0);

    // Close the modal so the compose textarea is actionable for cleanup.
    await modal.getByRole("button", { name: "close ban list" }).click();
    await expect(modal).toHaveCount(0);
  } finally {
    await composeSend(page, `/part ${channel}`).catch(() => {});
  }
});
