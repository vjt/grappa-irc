// Issue #142 — mIRC formatting on a PREVIOUSLY-RAW render surface.
//
// The channel buffer (PRIVMSG/NOTICE/ACTION) already routes user text
// through the shared mIRC renderer (`MircBody`) — see cp13-s10-mirc-bold
// + mirc-full-format-render. But the presence/system lines (QUIT/PART/
// KICK reasons, TOPIC body, whois/whowas realname+away) dropped their raw
// text straight into the DOM, so a `\x02`/`\x03…` in a QUIT reason showed
// as unprintable garbage instead of rendering.
//
// This pins the QUIT reason — the surface the issue names explicitly — as
// the representative case for the whole sweep. Same end-to-end pipeline as
// the PRIVMSG format specs (peer wire bytes → server preserves verbatim in
// the scrollback `:quit` body → cic mIRC parser → styled <span>s), but on
// the system line where the bytes used to leak raw.
//
// Browser-only confidence (feedback_cicchetto_browser_smoke): jsdom is
// blind to CSS, and the resolved palette color is exactly what a real
// engine computes. The vitest unit tests pin the parser; this pins the
// rendered visual on the quit line.

import { test, expect } from "../fixtures/test";
import { loginAs, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const TEST_CHANNEL = "#bofh";

test("issue142 — QUIT reason renders mIRC bold+color spans (not raw control bytes)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, TEST_CHANNEL, { awaitWsReady: false });

  // Live per-channel WS gate: the QUIT PubSub broadcast must land after
  // cic has joined the `grappa:user:.../channel:#bofh` Phoenix topic, or
  // the row never renders. members-pane rendering vjt-grappa is the
  // cheapest live-WS signal (see cp13-s10 rationale).
  await expect(page.locator(".members-pane li", { hasText: NETWORK_NICK })).toBeVisible({
    timeout: 10_000,
  });

  const sid = crypto.randomUUID().slice(0, 6);
  const boldTag = `bye-142-${sid}`;
  const tailTag = `tail-${sid}`;

  // \x02 bold ON, \x03 04 = red fg, then reset \x0f, then a plain tail.
  // The reason proves both render (bold+red on boldTag) AND reset honored
  // (tailTag is neither bold nor red).
  const reason = `\x02\x0304${boldTag}\x0f ${tailTag}`;

  const peer = await IrcPeer.connect({ nick: `quitpeer-${sid}` });
  // No try/finally: the QUIT *is* the disconnect — peer is gone after it.
  await peer.join(TEST_CHANNEL);
  await peer.disconnect(reason);

  const lines = scrollbackLines(page);

  // The quit reason's bold+red run renders as a .scrollback-mirc-bold span
  // carrying exactly boldTag. On the UNFIXED cic the reason is dropped raw
  // (literal \x02/\x03 bytes in the text node, no span) → this is RED.
  await expect(lines.locator(".scrollback-mirc-bold", { hasText: boldTag })).toHaveCount(1, {
    timeout: 10_000,
  });

  // Red = MIRC_PALETTE[4] = #ff0000 = rgb(255, 0, 0). The run span's text
  // is exactly boldTag; its computed color is the resolved palette color.
  await expect(page.getByText(boldTag, { exact: true })).toHaveCSS("color", "rgb(255, 0, 0)");

  // Reset honored: the post-\x0f tail is a separate plain run — NOT bold.
  await expect(lines.locator(".scrollback-mirc-bold", { hasText: tailTag })).toHaveCount(0);
});
