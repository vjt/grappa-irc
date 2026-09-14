// issue 2143 — the per-network DCC auto-accept opt-in, restricted to peers
// the subject already talks to.
//
// THREE assertions in one test, because the feature is a conjunction and each
// half needs its own mutant to be worth anything:
//
//   1. opt-in OFF + known peer   → the banner appears. Kills "the query
//      window alone auto-accepts", i.e. an implementation that forgot to read
//      the setting at all.
//   2. opt-in ON  + known peer   → NO banner, and the transfer's outcome row
//      lands in the peer's query anyway. Kills "the offer was silently
//      dropped", which is the failure 2089 forbids and which a pair of
//      refutations on their own would go green on.
//   3. opt-in ON  + STRANGER     → the banner appears. Kills the removal of
//      the query-window conjunct — the WIDE variant of 2143, which is a
//      relaxation of the #546 consent ruling and was not built.
//
// Ordered so each stage's barrier is the next one's precondition, and run in
// ONE test because stages 1 and 2 differ only by the PUT between them: split
// across two tests they would need the seeded subject's flag reset in both,
// and a leaked `true` would make stage 1 fail for a reason that has nothing
// to do with stage 1.
//
// ⚠️ WHAT THIS SPEC DOES NOT ASSERT, and cannot.
//
// The BYTES never arrive. The offer must survive the SSRF gate to be admitted
// at all, so the address is TEST-NET-3 (RFC 5737), which answers nothing —
// the same constraint `issue2089-dcc-consent-banner.spec.ts` documents at
// length. So "the file arrived" is measured here as the server DIALLING on
// its own and REPORTING the outcome into the peer's query, which is the whole
// observable difference between an auto-accept and a dropped offer. A spec
// claiming the tappable download link is covered end to end would be wrong;
// that link's shape is pinned in `Grappa.DccTest` and in cic's own suite.

import {
  dccOfferBanner,
  dccOfferBannerRefuse,
  loginAs,
  scrollbackLines,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { setDccAutoAccept } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const KNOWN_PEER_NICK = "dcc-friend";
const STRANGER_NICK = "dcc-nobody";

// TEST-NET-3 (RFC 5737) as the historical 32-bit unsigned IPv4 integer:
// 203*2^24 + 0*2^16 + 113*2^8 + 1.
const TESTNET3_U32 = 3_405_803_777;
const OFFER_PORT = 59_998;
const OFFER_SIZE = 8192;

const ASKED_FILE = "2143-asked-first.bin";
const AUTO_FILE = "2143-auto-accepted.bin";
const STRANGER_FILE = "2143-from-a-stranger.bin";

// The seeded subject outlives this spec, so a left-on opt-in would arm DCC
// auto-accept for every spec that runs after it on the same user. Disarmed
// unconditionally, including after a failure.
test.afterEach(async () => {
  const vjt = specUser();
  await setDccAutoAccept(vjt.token, NETWORK_SLUG, false).catch(() => {});
});

test("2143 — auto-accept fires only for a known peer on an armed network", async ({ page }) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // Sit on a real channel throughout. A banner must be visible from ANY
  // window, and its ABSENCE has to be measured from the same place its
  // presence was — otherwise stage 2 could be reading a banner that simply
  // rendered somewhere this viewport is not.
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  const friend = await IrcPeer.connect({ nick: KNOWN_PEER_NICK });
  const stranger = await IrcPeer.connect({ nick: STRANGER_NICK });

  try {
    // ------------------------------------------------ the relationship exists
    // An inbound DM is what mints the query window, and the sidebar entry is
    // the correct barrier for it: `QueryWindows.open/4` broadcasts the window
    // list AFTER the row is persisted (#422), so an entry here means the
    // server already holds the relationship the gate will look for.
    friend.privmsg(specNick(), "sending you something in a moment");
    const friendWindow = sidebarWindow(page, NETWORK_SLUG, friend.nick);
    await expect(friendWindow).toHaveCount(1, { timeout: 15_000 });

    // ------------------------------------------- stage 1: opt-in OFF, asks
    friend.dccSend(specNick(), ASKED_FILE, TESTNET3_U32, OFFER_PORT, OFFER_SIZE);

    const askedBanner = dccOfferBanner(page, ASKED_FILE);
    await expect(askedBanner).toBeVisible({ timeout: 15_000 });

    // Refused rather than left standing: a held offer occupies the banner
    // area, and stage 2's `toHaveCount(0)` must not be satisfied by a
    // different file's banner having scrolled this one out of view.
    await dccOfferBannerRefuse(page, ASKED_FILE).click();
    await expect(askedBanner).toHaveCount(0, { timeout: 15_000 });

    // ------------------------------------------ stage 2: opt-in ON, accepts
    // The helper reads the value back, so reaching this line means the server
    // really is armed — without that, everything below would be a negative
    // assertion resting on a write nobody checked.
    await setDccAutoAccept(vjt.token, NETWORK_SLUG, true);

    friend.dccSend(specNick(), AUTO_FILE, TESTNET3_U32, OFFER_PORT, OFFER_SIZE);

    // The POSITIVE half FIRST, and it is what makes the refutation below
    // meaningful. The server dialled on its own and reported the outcome into
    // the query with the peer (issue 2127 files post-accept rows there), so
    // this row existing is proof the offer was ADMITTED, not discarded.
    // Budgeted above the server's 5s connect timeout.
    await selectChannel(page, NETWORK_SLUG, friend.nick, { awaitWsReady: false });
    await expect(scrollbackLines(page).filter({ hasText: AUTO_FILE })).toHaveCount(1, {
      timeout: 25_000,
    });

    // And no banner was ever raised for it. Asserted AFTER the outcome row has
    // landed, so it is a measured absence and not a race won by looking early:
    // the whole round trip is already over by the time this runs.
    await expect(dccOfferBanner(page, AUTO_FILE)).toHaveCount(0);

    // ---------------------------------------- stage 3: a stranger still asks
    // The peer with no query window. This is the #546 half, and the reason the
    // wide variant was declined: with the conjunct gone, this banner never
    // appears and the file lands unasked.
    await expect(sidebarWindow(page, NETWORK_SLUG, stranger.nick)).toHaveCount(0);

    stranger.dccSend(specNick(), STRANGER_FILE, TESTNET3_U32, OFFER_PORT, OFFER_SIZE);

    const strangerBanner = dccOfferBanner(page, STRANGER_FILE);
    await expect(strangerBanner).toBeVisible({ timeout: 15_000 });

    // The armed network did not make the stranger known: still no window for
    // them, exactly as #546 requires of any unanswered offer.
    await expect(sidebarWindow(page, NETWORK_SLUG, stranger.nick)).toHaveCount(0);

    await dccOfferBannerRefuse(page, STRANGER_FILE).click();
    await expect(strangerBanner).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await stranger.disconnect("2143 done");
    await friend.disconnect("2143 done");
  }
});
