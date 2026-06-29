// Issue #148 (P0) — a VISITOR can /oper.
//
// What this covers (server gate relaxation + visitor UX, end-to-end):
//   1. Boot cic as a VISITOR (mintVisitor → bearer + subject seeded into
//      localStorage, same dance as visitor-session-sharing.spec.ts).
//   2. Focus the visitor's $server window and wait until the upstream
//      handshake has delivered numerics (≥1 :notice row → connected).
//   3. Issue `/oper testoper testoperpass` from the visitor's compose box.
//   4. Assert the VISIBLE SUCCESS: the upstream 381 RPL_YOUREOPER lands as
//      a :notice row in the visitor's $server window, and the
//      `visitor_not_allowed` inline error does NOT appear.
//
// Why this is the e2e that proves the fix: pre-#148 the server short-
// circuits a visitor's "oper" push with `{:error, :visitor_not_allowed}`
// (GrappaChannel routed it through `dispatch_ops_verb/3`, which gates on
// `check_not_visitor/1`) — so NO 381 ever arrives and the success
// assertion goes RED. The fix routes "oper" through `dispatch_subject_verb/3`
// (visitor-eligible, mirror of whois/who/names), letting the visitor oper
// its OWN upstream session. Vitest jsdom can't see the live upstream
// numeric round-trip; the e2e harness is the only place to assert it.
//
// Creds: the testnet O:line `O:*@*:${OPER_PASS_HASH}:${OPER_NICK}:OaARD:3`
// (infra/bahamut/conf.leaf{4,6}.tmpl) is host-unrestricted and its NAME
// field is OPER_NICK=testoper (infra/compose.yaml). The `<name>` arg of
// /oper is that O:line NAME field, NOT the visitor's nick — so any visitor
// nick can oper with `testoper`/`testoperpass`.

import { expect, test } from "../fixtures/test";
import { composeSend, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { adminDeleteVisitor, mintVisitor } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";

// Verbatim trailing text bahamut sends for numeric 381 RPL_YOUREOPER —
// `:%s 381 %s :You are now an IRC Operator` (azzurra/bahamut src/s_err.c).
// grappa's numeric router has no special-case for 381: it falls through
// to :scan routing → `{:server, nil}` → the "$server" window, and persists
// the raw trailing verbatim as the :notice row body. So this literal is
// the upstream wire text, not a cic/grappa-invented label — matched as a
// regex on the stable core phrase to tolerate trivial wording drift.
const RPL_YOUREOPER_TEXT = /you are now an irc operator/i;

test("issue #148 — visitor /oper ships OPER upstream and renders the 381 notice", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const visitorNick = `oper148-${Date.now()}`;
  const visitor = await mintVisitor(visitorNick);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    const visitorSubject = {
      kind: "visitor",
      id: visitor.id,
      nick: visitor.nick,
      network_slug: visitor.network_slug,
    };

    // Seed the visitor's bearer + subject so cic boots straight into Shell
    // (no captcha/anon dance), exactly like the share spec's device A.
    await page.addInitScript(
      ([token, subjectJson]) => {
        localStorage.setItem("grappa-token", token);
        localStorage.setItem("grappa-subject", subjectJson);
        localStorage.setItem("cic.installChoice", "browser");
      },
      [visitor.token, JSON.stringify(visitorSubject)] as const,
    );
    await page.goto("/");
    await expect(page.getByLabel(/open settings/i)).toBeVisible({ timeout: 10_000 });

    // Focus the visitor's $server window. awaitWsReady:false — the server
    // window has no auto-join line to anchor on. compose now resolves to
    // the visitor's network (visitor.network_slug) so /oper targets it.
    await selectChannel(page, visitor.network_slug, "Server", { awaitWsReady: false });

    // Connection gate: the upstream registration numerics (001-005 / LUSER /
    // MOTD) route to $server as :notice rows. Their presence proves the
    // visitor's session is connected upstream AND the $server pane is live
    // and rendering — so the post-/oper 381 push won't race an empty pane.
    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="notice"]').first(),
    ).toBeVisible({ timeout: 20_000 });

    // Issue the oper. `testoper`/`testoperpass` are the testnet O:line
    // creds; the visitor's own nick is irrelevant (O:line is host-*@* and
    // matched by the NAME field "testoper").
    await composeSend(page, "/oper testoper testoperpass");

    // VISIBLE SUCCESS: the 381 RPL_YOUREOPER notice renders in $server.
    // Pre-#148 this never arrives (visitor_not_allowed short-circuit) → RED.
    await expect(
      scrollbackLine(page, "notice", RPL_YOUREOPER_TEXT).first(),
    ).toBeVisible({ timeout: 15_000 });

    // And the visitor_not_allowed rejection is NOT surfaced anywhere (the
    // compose alert renders the raw token for this unmapped channel-error).
    await expect(page.getByText(/visitor_not_allowed/i)).toHaveCount(0);
  } finally {
    await ctx.close();
    await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});
