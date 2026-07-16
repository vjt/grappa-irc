// #74 — edit a channel topic INLINE from the topic bar.
//
// The bar's topic strip, on an editable window, swaps in place for an
// inline <input> (no separate dialog). Submitting sends the IRC TOPIC via
// the EXISTING `postTopic` REST door → the session relays it upstream →
// bahamut echoes `topic_changed` → the bar repaints. cic mirrors the
// server: there is NO optimistic client write, so the bar reflecting the
// new topic PROVES the server round-trip, and a second in-channel peer
// witnessing the raw `TOPIC` line proves the real upstream send (not a
// client-side paint).
//
// vjt founds a fresh per-run channel (creator → chanop, which beats the
// default +t topic-lock so the inline editor is offered), NOT the shared
// autojoin #bofh — mutating a shared topic leaks into later specs
// (seed-expansion cascade hazard; the vjt-reset fixture restores autojoin
// + scrollback but NOT channel topics). The channel is PARTed in the
// finally. Model: issue220-link-double-fire.spec.ts (bar read + peer topic)
// + s21-topic-clear-error-surface.spec.ts (awaited send, no false success).
//
// This needs the live user-level session + upstream round-trip, which
// jsdom/vitest cannot exercise — the 2-line clamp is likewise CSS the
// component test is blind to (feedback_cicchetto_browser_smoke). The e2e
// harness is the only place to prove the end-to-end edit.

import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

test.describe("#74 inline topic edit from the topic bar", () => {
  test("editing the topic in the bar sends TOPIC upstream and the bar reflects it", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    const channel = `#e2e74-${crypto.randomUUID().slice(0, 8)}`;
    const newTopic = `inline edit works ${crypto.randomUUID().slice(0, 6)}`;

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

    // A second peer joins the fresh channel to witness the relayed TOPIC.
    const peer = await IrcPeer.connect({ nick: `e2e74-${crypto.randomUUID().slice(0, 4)}` });
    try {
      // vjt founds + joins the fresh channel (→ chanop), then selects it.
      await composeSend(page, `/join ${channel}`);
      await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toBeVisible({ timeout: 10_000 });
      await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });
      await peer.join(channel);

      // Open the inline editor by clicking the topic strip. Retry to absorb
      // the members/modes seed race: until vjt's op sigil is cached, an
      // early click on a +t channel opens the read-only modal instead —
      // close it (backdrop click) and retry until the editor appears.
      const strip = page.locator('[data-testid="topic-strip"]');
      const editor = page.locator('[data-testid="topic-editor"]');
      await expect(async () => {
        const backdrop = page.locator(".topic-modal-backdrop");
        if (await backdrop.isVisible().catch(() => false)) {
          await backdrop.click({ force: true });
        }
        await strip.click();
        await expect(editor).toBeVisible({ timeout: 500 });
      }).toPass({ timeout: 20_000 });

      // Editor seeded with the raw (empty here — fresh channel) topic.
      await expect(editor).toHaveValue("");

      // Arm the upstream witness BEFORE submitting — the listener attaches
      // synchronously on this call, so the TOPIC can't slip past it.
      const witnessed = peer.waitForTopic(channel, newTopic);

      await editor.fill(newTopic);
      await editor.press("Enter");

      // Real upstream send proven: the in-channel peer saw `TOPIC #chan :…`.
      await witnessed;

      // The bar reflects the new topic — via the server's relayed
      // topic_changed → topicByChannel (NO optimistic client write).
      await expect(page.locator(".topic-bar-topic")).toContainText(newTopic, { timeout: 10_000 });
      // Editor closed on success.
      await expect(editor).toHaveCount(0);
    } finally {
      await peer.disconnect("e2e74 done");
      await partChannel(vjt.token, NETWORK_SLUG, channel).catch(() => {});
    }
  });
});
