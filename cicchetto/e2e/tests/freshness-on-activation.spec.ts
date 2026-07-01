// #159 — activation/visibility freshness re-fetch (socket-STAYS-open gap).
//
// P0 regression guard. Distinct from the two socket-DROP specs
// (`message-replay-on-reconnect.spec.ts`, `refresh-on-join-ws-gap-recovery.spec.ts`):
// those drop the WHOLE socket, so phoenix.js auto-rejoins EVERY channel and
// each rejoin's join-ok callback fires `refreshScrollback` — the gap heals
// itself. This spec reproduces the class that has NO such recovery: a SINGLE
// per-channel delivery gap while the socket stays "open" and that one channel
// never re-fires a join "ok". Pre-fix, the only two catch-up triggers were the
// load-once `loadInitialScrollback` (gated — re-select fetches nothing) and the
// join-ok `refreshScrollback` (never fires without a rejoin), so the missed
// rows stayed invisible until a full app reload. Verbatim user report on #159.
//
// The gap is opened with `__cic_suppressChannelDeliveryForTests` (subscribe.ts):
// it silences `phx.on("event")` for #bofh's topic ONLY, leaving the socket and
// every other channel live. Both tests assert the RENDERED message row appears
// after activation (never a fetch spy, never after a reload) — the user-visible
// contract. RED against pre-fix code (row never appears without reload) → GREEN
// once activation/visibility drive `refreshScrollback`.

import { expect, test } from "../fixtures/test";
import { loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Open the per-channel delivery gap: silence live `phx.on("event")` for
// CHANNEL's topic while the socket + every other channel stay live.
async function suppressChannelDelivery(
  page: Parameters<typeof loginAs>[0],
  slug: string,
  name: string,
): Promise<void> {
  await page.evaluate(
    ([s, n]) => {
      if (!window.__cic_suppressChannelDeliveryForTests) {
        throw new Error("__cic_suppressChannelDeliveryForTests hook missing");
      }
      window.__cic_suppressChannelDeliveryForTests(s, n);
    },
    [slug, name] as const,
  );
}

// Flip document visibility deterministically. cicchetto's
// documentVisibility.ts reads BOTH `document.visibilityState` AND
// `document.hasFocus()`, so both must be overridden; dispatch the
// production listeners' events so the Solid signal updates synchronously.
// Same idiom as ux-5-bu-unread-focus.spec.ts's `setTabHidden`.
async function setTabHidden(
  page: Parameters<typeof loginAs>[0],
  hidden: boolean,
): Promise<void> {
  await page.evaluate((isHidden) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (isHidden ? "hidden" : "visible"),
    });
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => !isHidden,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event(isHidden ? "blur" : "focus"));
  }, hidden);
  // Let Solid's reactive graph flush before the next step.
  await page.waitForTimeout(150);
}

test("#159 — tab RE-SELECT after a socket-stays-open gap re-fetches the missed row", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: "fresh-sel-peer" });
  try {
    await peer.join(CHANNEL);

    // Phase 1 — baseline live message. Rendered live sets the high-water
    // mark (recordSeen) that refreshScrollback's resume cursor uses.
    const before = "msg-159-sel-before-gap";
    peer.privmsg(CHANNEL, before);
    await expect(scrollbackLine(page, "privmsg", before)).toBeVisible();

    // Phase 2 — open the gap for #bofh only; the socket stays "open".
    await suppressChannelDelivery(page, NETWORK_SLUG, CHANNEL);

    // Phase 3 — peer posts during the gap. Server persists + broadcasts;
    // this cic drops the push (topic suppressed), so it never renders.
    const during = "msg-159-sel-during-gap";
    peer.privmsg(CHANNEL, during);
    // The gap is real: the row must NOT appear on its own. Settle window
    // long enough to rule out an in-flight push (delivery is deterministically
    // silenced, so this can never flake false-negative into visibility).
    await page.waitForTimeout(750);
    await expect(scrollbackLine(page, "privmsg", during)).toHaveCount(0);

    // Phase 4 — re-activate WITHOUT reload: switch to the server window and
    // back to #bofh. The selection effect fires refreshScrollback for the
    // re-activated channel (#159 item 1); loadInitialScrollback is a no-op
    // (load-once gate). The resume cursor is the Phase-1 high-water mark, so
    // `?after=<that id>` fetches the gap row and appends it (id-deduped).
    await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    // Phase 5 — the missed row is now visible, no reload. This is the bug fix.
    await expect(scrollbackLine(page, "privmsg", during)).toBeVisible({ timeout: 10_000 });
    // Baseline still present + no duplication (id-dedupe holds).
    await expect(scrollbackLine(page, "privmsg", before)).toHaveCount(1);
    await expect(scrollbackLine(page, "privmsg", during)).toHaveCount(1);
  } finally {
    await peer.disconnect("#159 sel test done");
  }
});

test("#159 — tab RE-FOREGROUND (hidden→visible) after a socket-stays-open gap re-fetches the missed row", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: "fresh-vis-peer" });
  try {
    await peer.join(CHANNEL);

    const before = "msg-159-vis-before-gap";
    peer.privmsg(CHANNEL, before);
    await expect(scrollbackLine(page, "privmsg", before)).toBeVisible();

    // Open the gap, then background the tab (visibility hide).
    await suppressChannelDelivery(page, NETWORK_SLUG, CHANNEL);
    await setTabHidden(page, true);

    const during = "msg-159-vis-during-gap";
    peer.privmsg(CHANNEL, during);
    await page.waitForTimeout(750);
    await expect(scrollbackLine(page, "privmsg", during)).toHaveCount(0);

    // Re-foreground WITHOUT reload. The isDocumentVisible false→true
    // transition drives refreshScrollback for the active channel (#159
    // item 2, ScrollbackPane visibility effect) — deliberately NOT folded
    // into scrollToActivation, which early-returns on an empty pane.
    await setTabHidden(page, false);

    await expect(scrollbackLine(page, "privmsg", during)).toBeVisible({ timeout: 10_000 });
    await expect(scrollbackLine(page, "privmsg", during)).toHaveCount(1);
  } finally {
    await peer.disconnect("#159 vis test done");
  }
});

declare global {
  interface Window {
    __cic_suppressChannelDeliveryForTests?: (slug: string, name: string) => void;
    __cic_resumeChannelDeliveryForTests?: (slug: string, name: string) => void;
  }
}
