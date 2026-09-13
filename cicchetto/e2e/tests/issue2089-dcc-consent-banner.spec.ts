// issue 2089 — the DCC consent banner, end to end through a real ircd.
//
// A peer's `DCC SEND` is never acted on unprompted: grappa parses the offer,
// dials nothing, and HOLDS it until a human answers. This spec drives that
// whole path with real frames — peer → bahamut → EventRouter → the held set →
// the user topic → the banner — and then exercises BOTH answers.
//
// ## What makes this spec able to fail
//
// The two answers must be told apart by something VISIBLE, not by the banner
// going away: both make it go, so "banner disappeared" discriminates nothing.
// The discriminator is the SCROLLBACK, and it comes straight out of the
// server's own design:
//
//   * REFUSE says nothing. `Grappa.Session.DccOffers.resolve/2`'s three exits
//     differ only in what the caller does next, and for a refusal that is
//     "say nothing" — so the refused file must leave NO row behind, ever.
//   * ACCEPT starts a transfer. The door answers 202, the dial runs detached,
//     and the outcome lands as a row from `Grappa.Dcc.Report` whichever way
//     it goes.
//
// So the assertion pair is: one filename with a row, one filename with none.
// Swap the two verbs in the product and this spec goes red on both halves.
//
// ## The address is chosen, not incidental
//
// `Grappa.Dcc.Policy.admit_offer/1` runs `Ssrf.safe_public_ip?/1` BEFORE the
// offer is held, so an offer advertising a docker-private address is dropped
// and no banner ever appears — the spec would fail for a reason that has
// nothing to do with the banner. `203.0.113.1` is TEST-NET-3 (RFC 5737):
// outside every blocked range in `ssrf.ex`, so it is admitted, and
// guaranteed unroutable, so the accepted transfer fails instead of hanging on
// a real host. The 5s `@connect_timeout_ms` is what bounds the wait for the
// outcome row.
//
// Per `feedback_cicchetto_browser_smoke`: vitest jsdom renders no banner
// region and speaks to no ircd, so the CTCP → hold → user-topic → derivation
// chain is exactly the class of break it cannot see.

import {
  dccOfferBanner,
  dccOfferBannerAccept,
  dccOfferBannerRefuse,
  loginAs,
  scrollbackLines,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const PEER_NICK = "dcc-sender";

// TEST-NET-3 (RFC 5737) as the historical 32-bit unsigned IPv4 integer:
// 203*2^24 + 0*2^16 + 113*2^8 + 1.
const TESTNET3_U32 = 3_405_803_777;
const OFFER_PORT = 59_999;
const OFFER_SIZE = 4096;

const REFUSED_FILE = "refused-holiday.tar.gz";
const ACCEPTED_FILE = "accepted-notes.bin";

test("a stranger's DCC SEND raises a consent banner, and refuse vs accept differ in scrollback", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // Sit on a real channel for the whole test. The banner must be visible from
  // ANY window — the offer is placed in `$server`, which is precisely the
  // window an operator has no reason to be looking at.
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // ---------------------------------------------------------------- refuse
    peer.dccSend(specNick(), REFUSED_FILE, TESTNET3_U32, OFFER_PORT, OFFER_SIZE);

    const refusedBanner = dccOfferBanner(page, REFUSED_FILE);
    await expect(refusedBanner).toBeVisible({ timeout: 15_000 });

    // The copy names the peer, the file, and the size — and it names the size
    // as a CLAIM, because that is all a sender's declared length is.
    await expect(refusedBanner).toContainText(peer.nick);
    await expect(refusedBanner).toContainText("4 KB");
    await expect(refusedBanner).toContainText("claim");
    // And it says where the bytes land. An operator who reads [Accept] as
    // "download to my phone now" has been told the wrong thing.
    await expect(refusedBanner).toContainText("grappa");

    // NO window was minted for the sender. Two contracts in one assertion:
    // the #546 rule (a stranger's CTCP mints no window, so the offer routes
    // to `$server`), and the wire's deliberate absence of a `state` field —
    // had the offer been mirrored into `windowStateByChannel`, a greyed
    // pseudo-row for a file nobody accepted would be sitting right here.
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(0);

    // × is the REFUSAL. The banner leaves because the server resolved the
    // offer and fanned `dcc_offer_resolved` out, not because cic hid it —
    // cic originates nothing here.
    await dccOfferBannerRefuse(page, REFUSED_FILE).click();
    await expect(refusedBanner).toHaveCount(0, { timeout: 15_000 });

    // ---------------------------------------------------------------- accept
    peer.dccSend(specNick(), ACCEPTED_FILE, TESTNET3_U32, OFFER_PORT, OFFER_SIZE);

    const acceptedBanner = dccOfferBanner(page, ACCEPTED_FILE);
    await expect(acceptedBanner).toBeVisible({ timeout: 15_000 });
    await dccOfferBannerAccept(page, ACCEPTED_FILE).click();
    await expect(acceptedBanner).toHaveCount(0, { timeout: 15_000 });

    // ------------------------------------------------- the visible difference
    // Both offers are placed in `$server`, so that is where the outcomes are.
    await selectChannel(page, NETWORK_SLUG, "$server", { awaitWsReady: false });

    // The ACCEPTED file earns a row: the transfer was admitted and dialled,
    // and TEST-NET-3 answers nothing, so it reports why it did not arrive.
    // Budgeted above the server's 5s connect timeout.
    await expect(scrollbackLines(page).filter({ hasText: ACCEPTED_FILE })).toHaveCount(1, {
      timeout: 25_000,
    });

    // The REFUSED file earns NOTHING, and this is the half that carries the
    // spec. It is asserted AFTER the accepted row has landed, so the absence
    // is a measured absence rather than a race won by checking early: the
    // refusal was issued first, and the later offer's outcome has already
    // completed its whole round trip.
    await expect(scrollbackLines(page).filter({ hasText: REFUSED_FILE })).toHaveCount(0);
  } finally {
    await peer.disconnect("2089 done");
  }
});
