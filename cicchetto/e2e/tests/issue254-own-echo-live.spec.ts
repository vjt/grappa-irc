// #254 — own outbound message not rendered LIVE (query AND channels) on iOS.
//
// Single root: cic renders the operator's OWN outbound line ONLY on the
// server's WS echo arrival (no optimistic render — by design, echo is the
// sole source of truth). If the target topic's WS subscription is not LIVE
// when the server broadcasts the echo, the echo fastlanes to zero subscribers
// and is dropped (the row persists → it reappears on a full reload only). The
// existing #159 refresh-on-activation recovery does NOT save an own-send
// because the send advances the read cursor to the own row's id (scrollback.ts
// anti-poison gate passes once the pane holds rows) and, with no prior live
// arrival, `getResumeCursor` resolves to that same id → `?after=<own-id>`
// skips the very row we're trying to recover.
//
// Two ways the subscription isn't live when the echo broadcasts:
//   * QUERY/DM: the (slug,target) topic is joined LAZILY by a reactive effect
//     gated on the server's `query_windows_list` round-trip, while compose's
//     `/msg` fires the POST immediately — so the echo broadcasts before the
//     topic is even joined. FIX: subscribe-before-send (compose awaits the
//     (slug,target) join ACK before the POST).
//   * CHANNEL on iOS: the channel is eagerly subscribed, but an iOS
//     background/foreground kills the socket silently and nothing forced a
//     reconnect on wake (kickReconnect was wired to `online` only, never
//     `visibilitychange`). FIX: a visibilitychange→visible reconnect kick, the
//     twin of the existing `online` handler.
//
// In BOTH cases the fix makes the SUBSCRIPTION ready; the server WS echo stays
// the one and only render path (no optimistic local render, no second source
// of truth — cf. the abolition of `server.source_address` in #251).
//
// Determinism note: the real iOS timing does not reproduce under Playwright
// (query race ~2/4; channel-wake gap not reproducible by wall-clock). Both
// tests force the failure mode via a SEAM, so RED-pre-fix / GREEN-post-fix is
// deterministic, never timing-luck. CI green here is NECESSARY BUT NOT
// SUFFICIENT — the fix still HOLDS for the real-iOS-device verification batch
// (#245/#250/#253/#254/#255).

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// ── QUERY: subscribe-before-send ───────────────────────────────────────────
//
// Deterministic discriminator: at the instant the send POST is ISSUED, the
// (slug,target) query topic MUST already be joined + ACKed — the query-window
// join `onJoinOk` stamps `__cic_queryWindowReady`. We snapshot that seam
// SYNCHRONOUSLY inside a `window.fetch` wrapper, at the exact call frame of the
// POST. (A Node-side `page.route` snapshot is NOT deterministic here: reading
// browser state from Node yields the event loop long enough for the lazy join
// to catch up on fast localhost, masking the race — observed as chromium PASS /
// webkit FAIL on the pre-fix code. The in-page fetch wrapper never yields.)
//   * PRE-FIX: compose fires the POST immediately after `openQueryWindowState`
//     (which only PUSHES `open_query_window` — the reactive query-loop join
//     can't even start until the server's `query_windows_list` round-trip
//     lands, strictly AFTER this POST). Snapshot = false.
//   * POST-FIX: compose awaits `ensureQueryTopicJoined` (a direct join + ACK,
//     no `query_windows_list` dependency) before the POST. Snapshot = true.
// This proves the echo has a live listener the instant it broadcasts, WITHOUT
// adding an optimistic render.
//
// Must run BEFORE loginAs (addInitScript is applied on the next navigation, and
// loginAs performs the goto) so the wrapper is installed before the app bundle.
async function installSendPostReadinessProbe(
  page: Parameters<typeof loginAs>[0],
  readyKey: string,
): Promise<void> {
  await page.addInitScript((key) => {
    const w = window as unknown as {
      __i254_readyAtPost?: boolean | null;
      __cic_queryWindowReady?: Set<string>;
    };
    w.__i254_readyAtPost = null;
    const orig = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      if (method === "POST" && /\/messages$/.test(url) && w.__i254_readyAtPost == null) {
        w.__i254_readyAtPost = w.__cic_queryWindowReady?.has(key) === true;
      }
      return orig(input, init);
    };
  }, readyKey);
}

async function assertSubscribeBeforeSend(
  page: Parameters<typeof loginAs>[0],
  peerNick: string,
  body: string,
): Promise<void> {
  await composeSend(page, `/msg ${peerNick} ${body}`);
  // #268 — `composeSend` resolves the instant the compose textarea reads
  // empty, but a `/msg` SYNCHRONOUSLY switches the selected window to the
  // fresh query window (compose.ts openQueryWindowState +
  // setSelectedChannel), and that new window's textarea is ALREADY empty —
  // so composeSend can return BEFORE the handler's awaited
  // `ensureQueryTopicJoined` + send POST have fired. Reading
  // `__i254_readyAtPost` right then observed a premature `null` ~44% of runs
  // (proven: iso `--repeat-each 25` → 11 null-fails; the DBG dump showed the
  // POST simply hadn't been issued yet, NOT a product race — server-side the
  // join always precedes the send). Gate on the POST actually being OBSERVED
  // (the wrapper flips the seam from null → boolean at the POST call frame).
  // Deterministic wait on the real event, not a fixed sleep; it does NOT
  // mask — a genuinely-missing POST times out (still red), and the value is
  // still asserted === true (topic joined BEFORE the send). See
  // docs/DESIGN_NOTES.md 2026-07-16.
  await page.waitForFunction(
    () => (window as unknown as { __i254_readyAtPost?: boolean | null }).__i254_readyAtPost != null,
    undefined,
    { timeout: 10_000 },
  );
  // The deterministic contract: the topic was joined + ACKed BEFORE the POST.
  const readyAtPost = await page.evaluate(
    () => (window as unknown as { __i254_readyAtPost?: boolean | null }).__i254_readyAtPost,
  );
  expect(readyAtPost).toBe(true);
  // User-visible outcome: the own line renders live (echo-driven), no reload.
  await expect(scrollbackLine(page, "privmsg", body)).toBeVisible({ timeout: 10_000 });
}

test("#254 — /msg to a fresh query window subscribes BEFORE the send POST (own echo has a live listener)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  const peerNick = `i254q-${crypto.randomUUID().slice(0, 8)}`;
  await installSendPostReadinessProbe(page, `${NETWORK_SLUG}/${peerNick}`);
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: peerNick });
  try {
    await assertSubscribeBeforeSend(page, peerNick, `#254 query echo ${peerNick}`);
  } finally {
    await peer.disconnect("#254 query done");
  }
});

test("@webkit #254 — /msg to a fresh query window subscribes BEFORE the send POST on iOS", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  const peerNick = `i254qw-${crypto.randomUUID().slice(0, 8)}`;
  await installSendPostReadinessProbe(page, `${NETWORK_SLUG}/${peerNick}`);
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: peerNick });
  try {
    await assertSubscribeBeforeSend(page, peerNick, `#254 ios query echo ${peerNick}`);
  } finally {
    await peer.disconnect("#254 webkit query done");
  }
});

// ── CHANNEL: iOS suspend/resume re-subscribe ───────────────────────────────
//
// `__cic_dropSocketForTests` performs an EXPLICIT `disconnect()` — phoenix.js
// resets its reconnectTimer, so the socket stays DOWN (no native auto-retry)
// until something explicitly reconnects it. That models the iOS suspend gap
// deterministically. On wake we dispatch a real `visibilitychange`→visible.
//   * PRE-FIX: nothing reconnects on visibility → the socket is held down →
//     the own send's echo has no live socket → the line never renders (RED).
//   * POST-FIX: visibilitychange→visible kicks a reconnect (socket.ts) → the
//     channel rejoins → the echo has a live listener again (and the reconnect
//     self-heal backfills any row missed in the gap) → the line renders (GREEN).

async function dropSocketAndHold(page: Parameters<typeof loginAs>[0]): Promise<void> {
  await page.evaluate(async () => {
    const drop = (window as unknown as { __cic_dropSocketForTests?: () => Promise<void> })
      .__cic_dropSocketForTests;
    if (!drop) throw new Error("__cic_dropSocketForTests hook missing");
    await drop();
  });
  // The socket is now held down, so socketHealth is STABLY non-open — a
  // deterministic gap window (same idiom as message-replay-on-reconnect).
  await page.waitForFunction(
    () =>
      (
        window as unknown as { __cic_socketHealth?: { state: () => { state: string } } }
      ).__cic_socketHealth?.state().state !== "open",
  );
}

// Foreground the tab: override the two signals documentVisibility.ts reads and
// dispatch the production listeners' events (same idiom as
// freshness-on-activation.spec.ts's setTabHidden, visible direction).
async function wakeTab(page: Parameters<typeof loginAs>[0]): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
}

async function assertOwnChannelMsgRendersAfterWake(
  page: Parameters<typeof loginAs>[0],
  peerNick: string,
): Promise<void> {
  const peer = await IrcPeer.connect({ nick: peerNick });
  try {
    await peer.join(CHANNEL);

    // Baseline live row → sets the per-topic high-water mark (recordSeen), so
    // the reconnect self-heal's resume cursor is BELOW the own row's id.
    const before = `#254 chan before ${crypto.randomUUID().slice(0, 8)}`;
    peer.privmsg(CHANNEL, before);
    await expect(scrollbackLine(page, "privmsg", before)).toBeVisible();

    // Suspend: drop + hold the socket down (deterministic non-open window).
    await dropSocketAndHold(page);

    // Wake: foreground the tab.
    await wakeTab(page);

    // Send an own message in the already-open channel.
    const own = `#254 chan own ${crypto.randomUUID().slice(0, 8)}`;
    await composeSend(page, own);

    // The own line must render live WITHOUT a reload. Generous timeout: the
    // visibility kick reconnects (one WS round-trip) then the echo / self-heal
    // lands. Pre-fix the socket is held down forever → this never appears.
    await expect(scrollbackLine(page, "privmsg", own)).toBeVisible({ timeout: 20_000 });
  } finally {
    await peer.disconnect("#254 channel done");
  }
}

test("#254 — own channel message renders live after an iOS-style suspend/resume (no reload)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await assertOwnChannelMsgRendersAfterWake(page, `i254c-${crypto.randomUUID().slice(0, 8)}`);
});

test("@webkit #254 — own channel message renders live after iOS suspend/resume", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await assertOwnChannelMsgRendersAfterWake(page, `i254cw-${crypto.randomUUID().slice(0, 8)}`);
});
