// Full mIRC inline formatting — the codes added beyond CP13-S10's bold:
// \x1e strikethrough, \x11 monospace, and \x04 hex color. Sibling to
// cp13-s10-mirc-bold.spec.ts; same end-to-end pipeline (peer wire bytes
// → server preserves verbatim → cic mIRC parser → styled <span>s) but
// exercising the new toggle classes + inline hex color.
//
// Browser-only confidence (feedback_cicchetto_browser_smoke): jsdom is
// blind to CSS, and the underline+strikethrough composition + the hex
// inline-style color are exactly the kind of thing a real engine
// resolves differently. The vitest unit tests pin the parser/classes;
// this pins the rendered visual.

import { test, expect } from "../fixtures/test";
import { loginAs, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const TEST_CHANNEL = "#bofh";

test("full mIRC: peer PRIVMSG renders strikethrough + monospace + hex-color spans", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, TEST_CHANNEL, { awaitWsReady: false });

  // Live per-channel WS gate (see cp13-s10 rationale).
  await expect(page.locator(".members-pane li", { hasText: NETWORK_NICK })).toBeVisible({
    timeout: 10_000,
  });

  const sid = crypto.randomUUID().slice(0, 6);
  const strikeTag = `strike-${sid}`;
  const monoTag = `mono-${sid}`;
  const hexTag = `hex-${sid}`;

  const peer = await IrcPeer.connect({ nick: `fmtpeer-${sid}` });
  try {
    await peer.join(TEST_CHANNEL);
    // \x1e strikethrough toggle, \x11 monospace toggle, \x04RRGGBB hex.
    peer.privmsg(
      TEST_CHANNEL,
      `\x1e${strikeTag}\x1e \x11${monoTag}\x11 \x04ff8800${hexTag}\x04`,
    );

    const lines = scrollbackLines(page);

    // Strikethrough run → .scrollback-mirc-strikethrough span.
    await expect(
      lines.locator(".scrollback-mirc-strikethrough", { hasText: strikeTag }),
    ).toHaveCount(1, { timeout: 10_000 });

    // Monospace run → .scrollback-mirc-monospace span.
    await expect(
      lines.locator(".scrollback-mirc-monospace", { hasText: monoTag }),
    ).toHaveCount(1);

    // Hex color run → the run span's text is exactly hexTag and its
    // computed color is #ff8800 = rgb(255, 136, 0).
    await expect(page.getByText(hexTag, { exact: true })).toHaveCSS("color", "rgb(255, 136, 0)");
  } finally {
    await peer.disconnect("done");
  }
});
