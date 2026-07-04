// #176 — the /who modal (WhoModal, #169) was grezzo: a flat single flex-row
// per user (nick, raw flags, user@host, server, hops, realname all inline)
// that overflowed sideways on long host/realname, and the 352 flags string was
// dumped verbatim (e.g. "G"/"H@"). This rework:
//   (1) kills the horizontal scroll — one word-wrapping COLUMN block per user;
//   (2) decodes the flags into human labels (H→here, G→gone, @→chanop, …),
//       client-side, rendered as per-flag colored chips (fork resolution A:
//       cic already reads the raw `modes` string via `whoPrefix`; the server
//       passes the 352 flags field through verbatim — no wire change);
//   (3) puts the realname on its OWN word-wrapping line.
//
// This e2e drives /who end-to-end against the real testnet bahamut. A peer
// joins the channel with a long gecos and sets /away, so its 352 row carries
// a decodable flag (G = gone) AND a realname worth wrapping — proof the decode
// + layout run on real wire data, not just a unit fixture.
//
// Asserts (the REAL e2e for #176, anti-hollow-green):
//   - NO horizontal scroll on the /who surface: the modal body's scrollWidth
//     does not exceed its clientWidth (pattern mirrors ux-6-g's pane check).
//   - Flags DECODED: the away peer's row shows a "gone" label chip, and the
//     bare raw flag token ("G") is NOT rendered as the flag cell text.
//   - Realname ON ITS OWN LINE: the realname line sits visually BELOW the nick
//     (boundingBox().y strictly greater) — not an inline sibling on one row.

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("#176 — /who wraps to a multi-line block per user, decodes flags, no h-scroll", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Unique nick per run to dodge a 433 ghost collision (cp13-s10 pattern). A
  // long gecos forces the realname line to be wrap-worthy on a narrow modal.
  const suffix = crypto.randomUUID().slice(0, 6);
  const peerNick = `who176-${suffix}`;
  const longGecos = `A rather long realname worth wrapping ${suffix}`;
  const peer = await IrcPeer.connect({ nick: peerNick, gecos: longGecos });
  try {
    await peer.join(CHANNEL);
    // /away flips the peer's 352 flag from H (here) to G (gone) — a decodable,
    // test-controllable flag.
    await peer.away("brb");

    await composeSend(page, `/who ${CHANNEL}`);

    const modal = page.getByTestId("who-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    const peerRow = modal.locator(".who-modal-row", { hasText: peerNick });
    await expect(peerRow).toBeVisible();

    // (2) Flags DECODED — the away peer shows a "gone" label chip.
    await expect(peerRow.locator(".who-modal-flag-tag-gone")).toHaveText(/gone/i, {
      timeout: 5_000,
    });
    // The raw flag token is NOT rendered as the flag cell — the chip carries a
    // human label, never a bare "G".
    const flagsText = (await peerRow.locator(".who-modal-flags").textContent()) ?? "";
    expect(flagsText.trim()).not.toBe("G");

    // (1) NO horizontal scroll on the /who surface. scrollWidth may exceed
    // clientWidth by sub-pixel rounding only (small tolerance), never by real
    // sideways-overflowing content.
    const body = modal.locator(".who-modal-body");
    const overflow = await body.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(2);

    // (3) Realname ON ITS OWN LINE — visually below the nick, not inline.
    const nickBox = await peerRow.locator(".who-modal-nick").boundingBox();
    const realnameBox = await peerRow.locator(".who-modal-line-realname").boundingBox();
    expect(nickBox).not.toBeNull();
    expect(realnameBox).not.toBeNull();
    if (nickBox && realnameBox) {
      expect(realnameBox.y).toBeGreaterThan(nickBox.y);
    }
  } finally {
    await peer.disconnect("#176 done");
  }
});
