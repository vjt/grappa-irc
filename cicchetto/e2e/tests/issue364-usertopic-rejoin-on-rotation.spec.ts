// #364 cicchetto S1 — user-topic re-join on token rotation with an
// UNCHANGED identity.
//
// The bug: socket.ts REBUILDS the Socket on every token transition (the
// bearer rides the `authToken` subprotocol, captured once at
// construction), so the prior user-topic Channel is orphaned on a dead
// socket. Pre-fix userTopic.ts dedup'd on the derived identity and
// early-returned when the name was unchanged — so a rotation that KEEPS
// the identity never re-joined the rebuilt socket. Two symptoms, one
// root cause: (1) every user-topic push event silently vanished, and
// (2) every user/channel push verb rejected "not connected" (the
// module-level `_userChannel` stayed null) until a logout+reload.
//
// The proof: `/whois <self>` is a user-topic round-trip with NO
// optimistic local render — the WhoisCard appears ONLY if the push verb
// reached the server (pushWhois over `_userChannel`) AND the reply event
// (`whois_bundle`) arrived back on the re-joined user topic. So one
// visible artifact exercises BOTH symptoms end to end, against the REAL
// socket rebuild + WS re-join + upstream WHOIS.
//
// The rotation is driven through the production `setToken` via the
// `__cic_setTokenForTests` seam (sibling of `__cic_dropSocketForTests`):
// there is no in-UI rotation trigger today, but everything downstream of
// setToken — socket rebuild, topic re-join, whois — is production code.
// The fresh bearer is minted with a real second `login()` for the SAME
// user, so the rebuilt socket authenticates as the identical identity.

import type { Page } from "@playwright/test";
import { composeSend, loginAs, selectChannel, waitForUserTopicReady } from "../fixtures/cicchettoPage";
import { login } from "../fixtures/grappaApi";
import {
  AUTOJOIN_CHANNELS,
  getSeededVjt,
  NETWORK_NICK,
  NETWORK_SLUG,
  VJT_IDENTIFIER,
  VJT_PASSWORD,
} from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Self-WHOIS: the querying session is connected upstream, so its own nick
// always resolves (311 + 318) — no peer setup, fully deterministic.
async function whoisSelf(page: Page) {
  await composeSend(page, `/whois ${NETWORK_NICK}`);
  const card = page.locator(".scrollback-overlay").getByTestId("whois-card");
  await expect(card).toBeVisible({ timeout: 8_000 });
  await expect(card.locator(".whois-card-target")).toHaveText(NETWORK_NICK);
  return card;
}

test("#364 — user-topic events + push verbs survive a token rotation with unchanged identity", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Baseline: whois works before the rotation — attributes any later
  // failure to the rotation itself, not to a broken whois path.
  const baseline = await whoisSelf(page);
  await baseline.locator(".whois-card-close").click();
  await expect(baseline).toBeHidden({ timeout: 2_000 });

  // Mint a fresh, server-valid bearer for the SAME user (a second
  // Accounts.create_session — no duplicate Session.Server, keyed by
  // subject+network in the registry), then rotate to it in-context.
  const rotated = await login(VJT_IDENTIFIER, VJT_PASSWORD);
  await page.evaluate((tok) => {
    (window as unknown as { __cic_setTokenForTests?: (t: string | null) => void })
      .__cic_setTokenForTests?.(tok);
  }, rotated.token);

  // Rotation-aware gate: userTopic clears the ready stamp on the
  // rebuild-leave and re-adds it only when the RE-join ack lands, so this
  // awaits the fresh subscription — not a stale pre-rotation positive.
  await waitForUserTopicReady(page, vjt.name);

  // The identity-transition cleanup clears the selected window on any
  // token change; re-select before the post-rotation whois.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // The assertion: whois still round-trips after the rotation. Pre-fix
  // the rebuilt socket had no user-topic subscription — pushWhois no-op'd
  // ("not connected") and no whois_bundle ever arrived, so this card
  // never rendered.
  await whoisSelf(page);
});
