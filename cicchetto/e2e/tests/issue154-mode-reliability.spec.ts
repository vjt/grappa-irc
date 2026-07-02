// Issue #154 (P0) — MODE-family reliability + rendering, two independent
// end-to-end proofs (one per bug the issue tracks):
//
// PART 1 — no-silent-drops on state-changing verbs.
//   Pre-fix the pushChannel* ops helpers were fire-and-forget `: void`
//   (socket.ts): compose.ts set `result = {ok:true}` SYNCHRONOUSLY and threw
//   away the server reply, so a `{:error, _}` (invalid_nick / invalid_channel
//   / no_session / upstream_unavailable / body_too_large) painted a green ✓
//   on a DROPPED state-changing frame. The fix converts them to the awaited
//   `pushOper`/`pushRaw` promise shape so a rejection propagates to compose's
//   catch → `friendlyChannelError` inline `.compose-box-error` banner.
//   The witness: a visitor issues `/op bad!nick` in a joined channel. The
//   server's `dispatch_subject_verb/3` rejects `invalid_nick` SYNCHRONOUSLY
//   (validate_args, before any upstream send — no bahamut round-trip, so no
//   timing flake). Pre-fix: the reply is swallowed, NO banner → RED. Post-fix:
//   the friendly copy "That nickname isn't valid." renders inline → GREEN.
//
// PART 2 — inbound own-nick MODE is rendered.
//   The Mez incident: `/umode +a` (and the services-pushed +a at IDENTIFY)
//   produced ZERO visible feedback. EventRouter's user-MODE-on-self branch
//   dropped the echo (no scrollback row). The fix persists every own-nick
//   mode transition to the synthetic "$server" window as a `:mode` row; cic
//   renders it "sets user mode +x". The witness: a visitor issues `/umode +i`
//   and the $server window shows a `data-kind="mode"` row reading "sets user
//   mode". Pre-fix: the server drops the echo, no such row EVER lands → RED.
//   Post-fix: the row renders → GREEN. Anti-hollow-green: asserts the VISIBLE
//   rendered row (kind + text), not the absence of an error.
//
// Both parts need the live upstream + the visitor's own IRC session, which
// jsdom/vitest cannot exercise — the e2e harness is the only place to prove
// them. #154 rides the #153 server de-gate (visitors may send these verbs)
// which the testnet already carries.

import type { Browser } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import {
  composeSend,
  composeTextarea,
  scrollbackLine,
  selectChannel,
  waitForUserTopicReady,
} from "../fixtures/cicchettoPage";
import { adminDeleteVisitor, mintVisitor } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";

// Boot cic straight into Shell as a freshly-minted visitor (no captcha/anon
// dance) — identical seeding to issue148/issue153.
async function bootVisitor(browser: Browser, nick: string) {
  const visitor = await mintVisitor(nick);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [
      visitor.token,
      JSON.stringify({
        kind: "visitor",
        id: visitor.id,
        nick: visitor.nick,
        network_slug: visitor.network_slug,
      }),
    ] as const,
  );
  await page.goto("/");
  await expect(page.getByLabel(/open settings/i)).toBeVisible({ timeout: 10_000 });
  return { visitor, ctx, page };
}

test("issue #154(1) — a rejected ops verb surfaces an inline compose error (no silent green ✓)", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const stamp = Date.now();
  const channel = `#t154a-${stamp}`;
  const { visitor, ctx, page } = await bootVisitor(browser, `v154a-${stamp}`);

  try {
    // Focus $server and wait for the registration numerics → session is
    // connected upstream (same connection gate as issue148/153).
    await selectChannel(page, visitor.network_slug, "Server", { awaitWsReady: false });
    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="notice"]').first(),
    ).toBeVisible({ timeout: 20_000 });

    // JOIN a channel so the active window is a channel (requireChannel) — /op
    // targets the active-window channel. No oper needed: the rejection fires
    // at validate_args (invalid_nick) before any op-privilege or upstream send.
    await waitForUserTopicReady(page, `visitor:${visitor.id}`);
    await composeSend(page, `/join ${channel}`);
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: channel }),
    ).toHaveCount(1, { timeout: 15_000 });
    await selectChannel(page, visitor.network_slug, channel, { ownNick: visitor.nick });
    await expect(page.locator(".members-pane")).toBeVisible({ timeout: 10_000 });

    // `bad!nick` fails Identifier.valid_nick? (`!` is not a nick char) → the
    // server replies `{:error, invalid_nick}`. Pre-fix (fire-and-forget) this
    // is swallowed and NO banner appears; post-fix the awaited rejection maps
    // to friendly copy in the inline `.compose-box-error` alert.
    //
    // NB: NOT `composeSend` — that helper waits for the textarea to EMPTY,
    // which only happens on a SUCCESSFUL submit. A rejected verb correctly
    // PRESERVES the draft (retry-without-retype), so we fill+Enter directly
    // and assert both the banner AND the preserved draft.
    const ta = composeTextarea(page);
    await ta.fill("/op bad!nick");
    await ta.press("Enter");

    const banner = page.locator(".compose-box-error[role='alert']");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toHaveText(/nickname isn't valid/i);
    // The draft survives the rejection so the operator can fix + resend.
    await expect(ta).toHaveValue("/op bad!nick");
  } finally {
    await ctx.close();
    await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});

test("issue #154(2) — an own-nick /umode renders a 'sets user mode' row in $server", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const stamp = Date.now();
  const { visitor, ctx, page } = await bootVisitor(browser, `v154b-${stamp}`);

  try {
    // Focus $server and gate on the registration numerics (session connected).
    await selectChannel(page, visitor.network_slug, "Server", { awaitWsReady: false });
    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="notice"]').first(),
    ).toBeVisible({ timeout: 20_000 });

    // Set an own-nick user-mode. bahamut echoes `:nick MODE nick :+i`, which
    // EventRouter's user-MODE-on-self branch now persists to $server as a
    // `:mode` row. Pre-fix the echo was dropped server-side → no such row.
    await composeSend(page, "/umode +i");

    // VISIBLE outcome: a `data-kind="mode"` row rendered as "sets user mode"
    // (own-nick form — no "on <channel>" suffix). RED pre-fix (nothing lands),
    // GREEN post-fix.
    await expect(
      scrollbackLine(page, "mode", /sets user mode/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await ctx.close();
    await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});
