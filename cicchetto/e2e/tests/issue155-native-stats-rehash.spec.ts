// Issue #155 (P1) — native /stats and /rehash slash commands.
//
// #155 adds /stats and /rehash as NATIVE cic parser commands. They are
// native-parser sugar over the EXISTING de-gated raw transport (#153): the
// compose dispatch builds the raw STATS/REHASH frame and ships it via
// `pushRaw` (the same `handle_in("raw", …)` #153 de-gated for visitors,
// with the .receive(ok/error) no-silent-drop contract). NO server change:
// grappa's numeric_router scan-then-server fallback already routes the STATS
// reply numerics (211-219, 240-250) and the REHASH/permission numerics to
// the `$server` synthetic window as :notice rows — the same mechanism that
// renders #148's 381 RPL_YOUREOPER and #153's raw-path replies.
//
// This e2e proves the ride ON A VISITOR (the whole point of #155 riding
// #153): a visitor issues the NATIVE /stats + /rehash slashes and the
// upstream reply numerics are WITNESSED rendering in the visitor's own
// $server window (STATS/REHASH replies come back to the ISSUER only — no
// peer client needed).
//
// The visitor is NOT opered. This is deliberate — it is both the realistic
// path (≈every cic user is a non-oper) AND it keeps the e2e crash-free:
//   * /stats u → bahamut m_stats `case 'u'` (s_serv.c:1909) is un-gated
//     (public) → 242 RPL_STATSUPTIME renders regardless of oper status.
//   * /rehash → a non-oper hits m_rehash's `!OPCanRehash` guard → 481
//     ERR_NOPRIVILEGES (Permission Denied). 481 is still the upstream
//     server's REPLY to the REHASH frame we shipped, so it witnesses the
//     native /rehash reaching upstream, AND it is the true production UX for
//     a non-oper. (An OPER'd /rehash triggers the real config reload, which
//     SIGSEGVs THIS testnet bahamut build — tracked separately in #164 as an
//     e2e-infra hazard; #155's e2e must never oper-then-rehash or it poisons
//     the whole suite.)
//
// RED pre-fix: /stats and /rehash are UNKNOWN cic commands → the parser
// returns {kind:"error", …} → compose surfaces "unknown command: /stats" and
// NOTHING is sent upstream → no reply numeric ever renders → both success
// assertions time out.
// GREEN post-fix: the native slash builds the raw frame, pushRaw ships it,
// and the reply numerics render as :notice rows in $server.

import { expect, test } from "../fixtures/test";
import { composeSend, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { adminDeleteVisitor, mintVisitor } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";

// Verbatim trailing text bahamut-azzurra sends (src/s_err.c):
//   242 RPL_STATSUPTIME   `:%s 242 %s :Server Up %d days, %d:%02d:%02d`
//   481 ERR_NOPRIVILEGES  `:%s 481 %s :Permission Denied, You do not have
//                          the correct irc operator privileges`
// Both carry only own_nick as a routable param → numeric_router :scan
// fallback lands them on `$server`, persisting the raw trailing verbatim as
// the :notice body. Matched as a regex on the stable core phrase to tolerate
// wording drift — these are the upstream wire strings, not cic-invented.
const RPL_STATSUPTIME_TEXT = /server up \d+ day/i;
const ERR_NOPRIVILEGES_TEXT = /permission denied/i;

test("issue #155 — native /stats and /rehash ship upstream and render reply numerics in $server", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const visitorNick = `v155-${Date.now()}`;
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

    // Boot cic straight into Shell as the visitor (no captcha/anon dance),
    // exactly like issue148/issue153.
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

    // Focus the visitor's $server window and wait for the upstream
    // registration numerics (001-005 / LUSER / MOTD → :notice rows). Their
    // presence proves the visitor's session is connected AND the $server
    // pane is live and rendering — so the reply numerics won't race an
    // empty pane.
    await selectChannel(page, visitor.network_slug, "Server", { awaitWsReady: false });
    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="notice"]').first(),
    ).toBeVisible({ timeout: 20_000 });

    // (1) NATIVE /stats u (uptime). RED pre-fix: unknown command → nothing
    // sent → no 242. GREEN: pushRaw ships "STATS u", 242 RPL_STATSUPTIME
    // renders as a :notice in $server.
    await composeSend(page, "/stats u");
    await expect(
      scrollbackLine(page, "notice", RPL_STATSUPTIME_TEXT).first(),
    ).toBeVisible({ timeout: 15_000 });

    // (2) NATIVE /rehash. RED pre-fix: unknown command → nothing sent → no
    // reply. GREEN: pushRaw ships "REHASH"; the non-oper visitor gets 481
    // ERR_NOPRIVILEGES back — the server's reply to our frame — rendered as
    // a :notice in $server.
    await composeSend(page, "/rehash");
    await expect(
      scrollbackLine(page, "notice", ERR_NOPRIVILEGES_TEXT).first(),
    ).toBeVisible({ timeout: 15_000 });

    // The native verbs never surface the parser's unknown-command error.
    await expect(page.getByText(/unknown command/i)).toHaveCount(0);
  } finally {
    await ctx.close();
    await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});
