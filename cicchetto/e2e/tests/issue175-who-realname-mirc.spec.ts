// #175 — the informational modals (WHO / VERSION / INFO / MOTD) rendered
// mIRC control bytes as RAW bytes instead of styled text. The free-text
// fields — the WHO realname (gecos) and the server-reply MOTD/INFO/VERSION
// lines — must route through the shared mIRC renderer (MircBody) the same
// way scrollback bodies already do (one-renderer invariant).
//
// This e2e drives the WHO surface end-to-end because it is the one modal
// whose mIRC bytes are fully test-controllable: a peer registers with a
// bold-formatted gecos, so the 352 RPL_WHOREPLY carries the \x02 toggles all
// the way through (peer → bahamut → grappa 352 parse → typed who_reply → cic
// WhoModal). The server_reply modal (MOTD/INFO/VERSION) shares the exact same
// fix and is unit-tested in src/__tests__/ServerReplyModal.test.tsx — its MOTD
// content is fixed by the testnet ircd and can't be injected with codes here.
//
// Asserts (the REAL e2e for #175, mirrors cp13-s10-mirc-bold's assertion
// shape on a new surface):
//   - The bold gecos run renders as a `.scrollback-mirc-bold` <span> inside
//     the peer's WHO row (proof the realname routed through MircBody).
//   - The raw \x02 control byte does NOT appear in the row's textContent
//     (proof the bytes were consumed, not dumped raw — the #175 bug).

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("#175 — a peer's bold-formatted WHO realname renders a .scrollback-mirc-bold span, not raw \\x02", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Unique nick per run to dodge a 433 ERR_NICKNAMEINUSE ghost collision
  // (mirror of cp13-s10 / cp15-b6 unique-suffix pattern). Unique bold tag so
  // the row locator can't false-positive off an unrelated peer.
  const suffix = crypto.randomUUID().slice(0, 6);
  const peerNick = `mircwho-${suffix}`;
  const boldTag = `BOLD-${suffix}`;
  // \x02 = bold toggle. gecos = "x" plain, "<boldTag>" bold, "y" plain.
  const peer = await IrcPeer.connect({ nick: peerNick, gecos: `x\x02${boldTag}\x02y` });
  try {
    await peer.join(CHANNEL);

    await composeSend(page, `/who ${CHANNEL}`);

    const modal = page.getByTestId("who-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // The peer's row carries the bold-formatted realname as a styled span —
    // proof the realname routed through MircBody, not a raw `{u.realname}`.
    const peerRow = modal.locator(".who-modal-row", { hasText: peerNick });
    await expect(peerRow).toBeVisible();
    await expect(
      peerRow.locator(".scrollback-mirc-bold", { hasText: boldTag }),
    ).toHaveCount(1, { timeout: 5_000 });

    // The raw \x02 control byte must NOT leak into the DOM (the #175 bug).
    const rowText = (await peerRow.textContent()) ?? "";
    expect(rowText).toContain(boldTag);
    expect(rowText).not.toContain("\x02");
  } finally {
    await peer.disconnect("#175 done");
  }
});
