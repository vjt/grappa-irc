// issue 2692 — a live `+bo <mask> nick` must op NICK in the members pane.
//
// The defect: cic re-derived the roster from each `:mode` row by walking the
// mode letters with a hardcoded `(ohv)` table that consumed NO argument for
// any other letter. On `+bo *!*@mask alice` the `b` took nothing, so the `o`
// took the MASK: no member is called that, alice stayed plain, and she stayed
// plain until the next `members_seeded` — which on a tab whose socket stays
// up may never come.
//
// The cure: the server, which walks the line against the network's own
// PREFIX and CHANMODES, writes each changed member's absolute modes onto the
// row (`meta.member_modes`), and cic applies that. The client walker is gone.
//
// Shape — the ORDER is load-bearing:
//   1. an op peer founds a fresh per-run channel (the founder auto-ops, @)
//   2. a second peer joins it, plain
//   3. cic joins, so both arrive in the 353 — @ on the op, nothing on alice
//   4. ONLY THEN does the op peer send `+bo <mask> alice`, so the grade
//      reaches cic LIVE, as a `:mode` row on the channel topic: the door the
//      defect lived on. Grading alice before cic joined would deliver `@`
//      inside the 353 instead, a different code path, and prove nothing.
//
// ⚠️ NOT RUN when written: the e2e stack was not granted to this slice. The
// RED-before-cure is still a PREDICTION from the walker's code, not a
// measurement: the spec has only ever run against the cure.
// The premise it depends on — that bahamut's echo keeps the requested letter
// ORDER (`+bo`, not `+ob`) — WAS measured afterwards by CI: this spec passed
// on the merge of 9e419738f into 59bc1ce44 (job 137163255071, "cicchetto +
// grappa + azzurra-testnet (shard 2/4)", log line 6874). `mode()` waits for
// an echo whose raw modes are exactly `+bo` and fails on a timeout, so a
// reordering ircd fails that wait loudly instead of turning this into a
// green that the old walker would also have passed.
//
// Platform note: the grade is a members-pane text node fed by a WS frame —
// no touch, viewport or engine dependency, so desktop chromium IS the
// defect's own platform.
//
// Parity matrix: UI shape contract, subject-shape-agnostic. Registered seed
// (vjt + autojoin) suffices.

import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

test.setTimeout(120_000);

test("issue 2692 — a live +bo <mask> nick ops the nick in the members pane", async ({ page }) => {
  // Per-run unique channel + peer nicks, so the spec stays `--repeat-each`-able.
  const suffix = crypto.randomUUID().slice(0, 5);
  const channel = `#s2692-${suffix}`;
  const opNick = `o2692${suffix}`;
  const aliceNick = `a2692${suffix}`;
  // A mask that matches nobody in the channel: the ban is only there to put a
  // param-taking channel mode AHEAD of the `o` in one token.
  const mask = "*!*@nobody.2692.invalid";

  const vjt = specUser();
  await loginAs(page, vjt);
  // Focus the autojoin channel first to confirm login + WS-ready and mount
  // the compose box before issuing the /join (issue240 boot order).
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  const opPeer = await IrcPeer.connect({ nick: opNick });
  let alicePeer: IrcPeer | null = null;
  try {
    // The founding JOINer auto-ops on the testnet leaf, so this peer can set
    // modes below.
    await opPeer.join(channel);
    alicePeer = await IrcPeer.connect({ nick: aliceNick });
    await alicePeer.join(channel);

    await composeSend(page, `/join ${channel}`);
    await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toBeVisible({ timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });

    const opRow = page.locator(".members-pane .member-name", { hasText: opNick });
    const aliceRow = page.locator(".members-pane .member-name", { hasText: aliceNick });

    // PRE-STATE — the seed landed and alice is plain in it. Without this the
    // assertion below could read an `@` that was already there.
    await expect(opRow.locator(".nick-prefix")).toHaveText("@", { timeout: 15_000 });
    await expect(aliceRow).toBeVisible();
    await expect(aliceRow.locator(".nick-prefix")).toHaveCount(0);

    // THE GESTURE — one token, the ban first. `mode()` resolves on the ircd's
    // echo of exactly `+bo`, so the line cic receives is the defect's vector.
    await opPeer.mode(channel, "+bo", [mask, aliceNick]);

    // The row really arrived live: the scrollback shows it. This separates
    // "the grade was not applied" from "the line never reached cic".
    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="mode"]', { hasText: aliceNick }),
    ).toBeVisible({ timeout: 15_000 });

    // THE OUTCOME — alice is op in the members pane. The old walker gave the
    // `o` the mask and left her plain; nothing reseeds the roster here.
    await expect(aliceRow.locator(".nick-prefix")).toHaveText("@", { timeout: 15_000 });
  } finally {
    if (alicePeer) await alicePeer.disconnect("issue2692 done");
    await opPeer.disconnect("issue2692 done");
    // `/join` persists the channel into vjt's autojoin set; PART restores
    // pre-test state. Idempotent — swallow 404 if the test bailed early.
    await partChannel(vjt.token, NETWORK_SLUG, channel).catch(() => {});
  }
});
