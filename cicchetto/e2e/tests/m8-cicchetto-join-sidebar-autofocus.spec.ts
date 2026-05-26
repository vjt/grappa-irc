// M8 — cicchetto-driven /join. Type `/join #newchan` in compose; expected:
//   - server-side persists the JOIN row (sender = NETWORK_NICK)
//   - sidebar gains an entry for the new channel
//   - cicchetto auto-focuses the new channel (compose.ts /join handler
//     calls setSelectedChannel client-side immediately after postJoin —
//     the BUG4 self-JOIN auto-focus path in subscribe.ts races with
//     PubSub late-subscriber drop, so user-intent-driven focus is the
//     reliable path)
//
// UX-5 BJ (2026-05-19): the per-channel "join-banner" splash row was
// killed. Pre-BJ this spec also asserted `[data-testid="join-banner"]`
// presence (pinned RED via test.fixme — BUG8 — banner didn't re-render
// for cic-driven /join). With the banner gone the assertion is gone
// too; banner-absence is asserted directly by `ux-5-bj-no-join-splash`.
//
// `/join` is one of the slash-commands compose.ts dispatches; under
// the hood it sends `JOIN #channel` to grappa, which forwards to the
// leaf, leaf echoes the JOIN back, grappa persists + broadcasts.
//
// CHANNEL NAMING + CLEANUP: server-side `/join` persists the channel
// in `Networks.Credential.autojoin` — across test runs the channel
// would survive into the next session, breaking idempotency
// (`toHaveCount(0)` at the start fails on retry). Each run uses a
// unique random suffix, and `afterEach` PARTs whatever was joined so
// the credential's autojoin set stays clean.

import { test, expect } from "../fixtures/test";
import {
  composeSend,
  loginAs,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted, partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
// Random per-run suffix so /join's autojoin-persistence side-effect
// doesn't bleed into subsequent runs (Playwright retries, parallel
// reruns, dirty-DB cases). 8 hex chars from crypto.randomUUID gives
// ~32 bits — collisions on the same e2e DB session are not a concern.
const NEW_CHANNEL = `#m8-${crypto.randomUUID().slice(0, 8)}`;

test.afterEach(async () => {
  // Even if the test failed mid-flight, attempt to PART the channel
  // server-side so the next run starts clean. The HTTP DELETE is
  // idempotent — 404 if the channel was never joined is fine.
  const vjt = getSeededVjt();
  await partChannel(vjt.token, NETWORK_SLUG, NEW_CHANNEL).catch(() => {});
});

test("M8 — cicchetto /join adds sidebar entry + auto-focuses the new channel", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, NEW_CHANNEL)).toHaveCount(0);

  await composeSend(page, `/join ${NEW_CHANNEL}`);

  // Server-side: own JOIN row persisted at channel = NEW_CHANNEL,
  // sender = NETWORK_NICK, kind = :join. JOIN rows have body=null;
  // match by kind.
  await assertMessagePersisted({
    token: vjt.token,
    networkSlug: NETWORK_SLUG,
    channel: NEW_CHANNEL,
    sender: NETWORK_NICK,
    kind: "join",
  });

  // Sidebar gains the new channel.
  await expect(sidebarWindow(page, NETWORK_SLUG, NEW_CHANNEL)).toHaveCount(1, { timeout: 5_000 });

  // BUG4 auto-focus: the new channel's <li> has the .selected class.
  await expect(sidebarWindow(page, NETWORK_SLUG, NEW_CHANNEL)).toHaveClass(/selected/, {
    timeout: 5_000,
  });
});

