// S21 (codebase review 2026-07-08) — /topic -delete was fire-and-forget:
// `pushChannelTopicClear` returned void and compose.ts painted { ok: true }
// SYNCHRONOUSLY, throwing away the server reply. A WS-down / server
// {:error,_} was swallowed and the compose box showed a false success. The
// fix gives it the awaited `pushUserChannelVerb` ack shape (#154) so a
// rejection propagates to compose's catch → `friendlyChannelError` inline
// `.compose-box-error` banner.
//
// Witness (mirrors issue154's synchronous-reject strategy): clear the topic
// of a SYNTACTICALLY INVALID channel — its body exceeds the 49-char limit in
// `Identifier`'s @channel_regex, so `validate_args` in `dispatch_subject_verb`
// rejects `{:error, invalid_channel}` SYNCHRONOUSLY, before `resolve_subject`
// / any bahamut round-trip (no connection-timing flake). Pre-fix: the reply
// is swallowed, the draft clears, NO banner → RED. Post-fix: the awaited
// rejection maps to "That channel name isn't valid." inline and the draft
// survives → GREEN. Anti-hollow-green: asserts the VISIBLE banner + the
// preserved draft, not the absence of a success marker.
//
// This needs the live user-level channel + server dispatch, which
// jsdom/vitest cannot exercise — the e2e harness is the only place to prove
// the end-to-end verb-ack round-trip.

import { expect, test } from "../fixtures/test";
import { composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
// Body (55 z's) > 49 → fails @channel_regex `^[#&+!][^\s,\x07]{1,49}$`.
const INVALID_CHANNEL = `#${"z".repeat(55)}`;

test("S21 — /topic -delete surfaces an inline error on a server rejection (no false success)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Fill + Enter directly (NOT composeSend — that helper waits for the
  // textarea to EMPTY, which only happens on a SUCCESSFUL submit; a rejected
  // verb correctly PRESERVES the draft for retry-without-retype).
  const ta = composeTextarea(page);
  await ta.fill(`/topic ${INVALID_CHANNEL} -delete`);
  await ta.press("Enter");

  const banner = page.locator(".compose-box-error[role='alert']");
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toHaveText(/channel name isn't valid/i);
  // Draft survives the rejection so the operator can fix + resend.
  await expect(ta).toHaveValue(`/topic ${INVALID_CHANNEL} -delete`);
});
