// #455 — textual emphasis markers (*bold*, _underline_, /italic/) rendered
// client-side, markers kept visible, as a display-only layer over the
// linkified run text.
//
// End-to-end proof of the wire→render pipeline (mirror of
// cp13-s10-mirc-bold.spec.ts, which covers the \x02 WIRE bold path):
//   - a peer PRIVMSGs a body carrying the literal ASCII markers
//   - the server stores/relays the bytes verbatim (no wire formatting here)
//   - cic's display-only emphasis layer styles the marked spans, keeping
//     the marker characters IN the span text
//
// The tokenizer's rules (non-greedy, false positives, cross-type nesting)
// are exhaustively covered by src/__tests__/emphasisMarkers.test.ts; this
// spec locks the browser-integration contract end-to-end, including the
// two properties vjt called out: non-greedy (two independent pairs on one
// line) and the path/identifier false-positive guard.

import { loginAs, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const TEST_CHANNEL = AUTOJOIN_CHANNELS[0];
const tag = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 6)}`;

test("issue455 — *bold* _underline_ /italic/ render client-side with the markers kept", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, TEST_CHANNEL, { awaitWsReady: false });

  // Same live-WS gate as cp13-s10: members-pane rendering of the network
  // nick proves the per-channel Phoenix subscription is up, so the peer's
  // PRIVMSG broadcast is not lost before cic subscribes.
  await expect(page.locator(".members-pane li", { hasText: specNick() })).toBeVisible({
    timeout: 10_000,
  });

  const peer = await IrcPeer.connect({ nick: `emphpeer-${crypto.randomUUID().slice(0, 6)}` });
  try {
    await peer.join(TEST_CHANNEL);
    const lines = scrollbackLines(page);

    // Bold: opener at a word boundary (leading space) so *word* fires;
    // the styled span keeps the asterisks.
    const b = tag("BOLD");
    peer.privmsg(TEST_CHANNEL, `emph *${b}* end`);
    await expect(lines.locator(".scrollback-mirc-bold", { hasText: b })).toHaveText(`*${b}*`, {
      timeout: 10_000,
    });

    // Underline.
    const u = tag("UNDER");
    peer.privmsg(TEST_CHANNEL, `emph _${u}_ end`);
    await expect(lines.locator(".scrollback-mirc-underline", { hasText: u })).toHaveText(`_${u}_`, {
      timeout: 10_000,
    });

    // Italic.
    const i = tag("ITAL");
    peer.privmsg(TEST_CHANNEL, `emph /${i}/ end`);
    await expect(lines.locator(".scrollback-mirc-italic", { hasText: i })).toHaveText(`/${i}/`, {
      timeout: 10_000,
    });

    // Non-greedy: two independent pairs on one line must be TWO spans, not
    // one greedy span from the first marker to the last. Each renders as
    // its own exact-text span (a greedy match would make the P1 span read
    // `*P1* mid *P2*` and fail toHaveText).
    const p1 = tag("P1");
    const p2 = tag("P2");
    peer.privmsg(TEST_CHANNEL, `*${p1}* mid *${p2}*`);
    await expect(lines.locator(".scrollback-mirc-bold", { hasText: p1 })).toHaveText(`*${p1}*`, {
      timeout: 10_000,
    });
    await expect(lines.locator(".scrollback-mirc-bold", { hasText: p2 })).toHaveText(`*${p2}*`);

    // False positive guard: a filesystem path is NOT italicized — the
    // inner slash makes every candidate closer fail, so the whole path
    // stays literal (no .scrollback-mirc-italic span carrying the tag).
    const path = tag("PATH");
    peer.privmsg(TEST_CHANNEL, `see /usr/${path}/bin here`);
    // The plain (unstyled) line must arrive so the negative assertion is
    // not just racing an empty scrollback.
    await expect(lines.locator("*", { hasText: `/usr/${path}/bin` }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(lines.locator(".scrollback-mirc-italic", { hasText: path })).toHaveCount(0);
  } finally {
    await peer.disconnect("done");
  }
});
