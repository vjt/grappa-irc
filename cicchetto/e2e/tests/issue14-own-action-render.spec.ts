// Issue #14 — the operator's OWN `/me` must render as `* nick body`,
// not as a raw `<nick> ACTION body` privmsg line.
//
// cic sends a `/me` as `\x01ACTION text\x01` inside a PRIVMSG body. The
// server self-echo-persists that send; pre-fix `persist_and_send_fragments`
// hardcoded kind=:privmsg, so the row came back as :privmsg and cic's
// privmsg render branch fired (`<nick> ` + the `\x01ACTION ` control
// bytes as invisible "raw text"). The fix classifies the outbound body
// through `Grappa.IRC.CTCP.action?/1` — the same predicate the inbound
// path uses — so an own ACTION persists and broadcasts as :action.
//
// M10 already covers the INBOUND peer-ACTION path; this is the OUTBOUND
// own-send path that issue #14 actually reported (and which M10's green
// status masked — they are different server functions).
//
// e2e shape (per feedback_ux_e2e_mandatory + feedback_cicchetto_browser_smoke
// — jsdom can't prove the real compose → REST → self-echo → WS → render
// round-trip): type `/me <tag>` into the focused #bofh composer, then
// assert BOTH the REST-persisted kind AND the rendered action row, plus
// the negative invariant that no privmsg row carries the same tag.

import { test, expect } from "../fixtures/test";
import {
  composeSend,
  composeTextarea,
  loginAs,
  scrollbackLine,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = "#bofh";

test("issue #14 — operator's own /me renders as '* nick body', not raw privmsg", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { awaitWsReady: false });
  await expect(composeTextarea(page)).toBeVisible();

  // Live per-channel WS subscription gate (mirror cp13-s10): the
  // members-pane own-nick row requires the after-join members_seeded
  // push, which only lands once the Phoenix channel join completed —
  // so the self-echo broadcast for our send won't fire into the void.
  await expect(page.locator(".members-pane li", { hasText: NETWORK_NICK })).toBeVisible({
    timeout: 10_000,
  });

  // Per-run unique tag so the action/privmsg assertions don't trip over
  // rows persisted by an earlier repeat in the shared #bofh scrollback.
  const tag = `mewaves-${crypto.randomUUID().slice(0, 6)}`;
  await composeSend(page, `/me ${tag}`);

  // Server-side: the own send persists with kind=:action and the raw
  // CTCP envelope verbatim (round-trip fidelity).
  await assertMessagePersisted({
    token: vjt.token,
    networkSlug: NETWORK_SLUG,
    channel: CHANNEL,
    sender: NETWORK_NICK,
    body: `\x01ACTION ${tag}\x01`,
    kind: "action",
  });

  // DOM: rendered on the action branch (data-kind=action), envelope
  // stripped, so the visible text is the inner body.
  await expect(scrollbackLine(page, "action", tag)).toBeVisible({ timeout: 10_000 });

  // Regression invariant: pre-fix this exact tag rendered as a
  // data-kind=privmsg row (`<nick> ACTION <tag>`). It must not.
  await expect(scrollbackLine(page, "privmsg", tag)).toHaveCount(0);
});
