// #221 gap (c) — /who <mask> end-to-end. A masked WHO must surface the
// WhoModal (feedback), not the pre-#221 "total silence" (no 352, no 315,
// nothing in cic). This drives the full chain: cic /who <mask> →
// GrappaChannel :who_target validation → Client.send_who (mask forwarded,
// not channel-gated) → upstream → 315 (echoes the mask) → who_fold
// single-in-flight drain → who_reply → WhoModal.
//
// Runs on the shared bahamut leaf: the OUTBOUND fix (mask forwarded, not
// channel-gated) is network-agnostic, and the modal appearing at all is the
// headline proof — pre-#221 the mask was rejected before it left the
// bouncer, so NOTHING came back. NOTE bahamut's WHO-mask matches
// host/server/realname but NOT nick (unlike solanum, m_who.c:334), and it
// cloaks hosts unpredictably, so this spec asserts the modal OPENS (with
// its "End of /WHO" terminator relayed) rather than a specific matched row.
// The row-level mask MATCH proof — where a nick-mask returns the peer — is
// in issue221-solanum-whois.spec.ts, run against the real solanum ircd
// where nick-masks match.

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("#221 — /who <mask> surfaces the WhoModal (feedback, not pre-#221 silence)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // A host-mask WHO. Pre-#221 this returned TOTAL SILENCE — the channel-only
  // outbound gate rejected the mask before it left the bouncer, so no 315
  // ever came back and cic showed nothing. Now the mask forwards, upstream
  // answers 315 (End of /WHO — bahamut always terminates), who_fold drains
  // the single-in-flight accumulator, and the modal renders. The modal
  // appearing is the fix: feedback, not silence.
  await composeSend(page, "/who *!*@*.azzurra.chat");

  const modal = page.getByTestId("who-modal");
  await expect(modal).toBeVisible({ timeout: 8_000 });
});

