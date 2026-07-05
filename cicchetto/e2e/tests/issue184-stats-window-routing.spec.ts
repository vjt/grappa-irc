// Issue #184 (P0) — /stats output must render in the $server window, NOT a
// query window named after the stats letter.
//
// Root cause was SERVER-side (Grappa.Session.NumericRouter): the STATS reply
// family (211-219 RPL_STATS* + RPL_ENDOFSTATS, 240-250) fell through to the
// param-scan fallback. Every /stats query terminates with 219 RPL_ENDOFSTATS
// `[own_nick, <letter>, "End of /STATS report"]`; the bare letter is
// nick-shaped (`Identifier.valid_nick?("u") == true`), so the scan resolved
// `{:query, "u"}` and grappa persisted the stats reply as a :notice row on
// channel="u" — spawning a bogus query window "u" that even leaked into
// Archive. The fix folds the STATS family into NumericRouter's @active_numerics
// deny list → `{:server, nil}` unconditionally.
//
// This spec is the twin of the #155 native-/stats e2e, which MASKED this bug:
// #155 drives `/stats u` and only asserts the 242 RPL_STATSUPTIME lands in
// $server. 242 is trailing-only (no middle param) so it routed to $server by
// ACCIDENT even pre-fix — while the sibling 219 (same query) silently forked a
// "u" query window that #155 never looked for. (The #78 lesson: a green spec
// that never asserts the bug's signature lets the bug ship.)
//
// RED pre-fix:
//   * 219 "End of /STATS report" does NOT appear in $server (it went to
//     query "u") → the positive assertion times out; AND
//   * a `[data-window-name="u"]` sidebar tab IS created → the negative
//     assertions fail.
// GREEN post-fix: 219 renders as a :notice in $server; no "u" window exists,
// server-side or client-side.

import { expect, test } from "../fixtures/test";
import {
  composeSend,
  scrollbackLine,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import {
  adminDeleteVisitor,
  GRAPPA_BASE_URL,
  mintVisitor,
} from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";

// The stats letter we query. `u` (uptime) is deliberately reused from #155:
// bahamut's `m_stats case 'u'` is un-gated (public, no oper) and does NOT
// SIGSEGV the testnet the way an oper'd /rehash does (#164). Its terminating
// 219 RPL_ENDOFSTATS carries `u` as the mis-routing param.
const STATS_LETTER = "u";

// Verbatim trailing bahamut sends for 219 (src/s_err.c):
//   `:%s 219 %s %c :End of /STATS report`
// Matched as a lenient regex on the stable phrase — it's the upstream wire
// string, not cic-invented.
const RPL_ENDOFSTATS_TEXT = /end of \/stats report/i;

test("issue #184 — /stats reply renders in $server, never a query window named after the letter", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const visitorNick = `v184-${Date.now()}`;
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
    // exactly like issue155.
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

    // Focus the $server window and wait for the registration numerics
    // (:notice rows) so the pane is live and the STATS reply won't race an
    // empty pane.
    await selectChannel(page, visitor.network_slug, "Server", { awaitWsReady: false });
    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="notice"]').first(),
    ).toBeVisible({ timeout: 20_000 });

    // Fire the native /stats <letter>. compose builds the raw `STATS u`
    // frame and ships it via pushRaw; upstream replies with 242 + the
    // terminating 219 RPL_ENDOFSTATS carrying the letter.
    await composeSend(page, `/stats ${STATS_LETTER}`);

    // POSITIVE (RED pre-fix): the letter-carrying 219 renders as a :notice
    // in the $server pane (still focused). Pre-fix it was routed to query
    // "u" and this pane never saw it.
    await expect(
      scrollbackLine(page, "notice", RPL_ENDOFSTATS_TEXT).first(),
    ).toBeVisible({ timeout: 15_000 });

    // NEGATIVE, client-side (RED pre-fix): NO sidebar window/tab named after
    // the stats letter. `sidebarWindow` matches on the production
    // `data-window-name` attribute, so a bogus `data-window-name="u"` query
    // tab would make this non-zero.
    await expect(sidebarWindow(page, visitor.network_slug, STATS_LETTER)).toHaveCount(0);

    // NEGATIVE, server-side (decisive): grappa persisted ZERO rows under
    // channel="u". Ordered AFTER the positive assertion — once the 219 has
    // landed in $server the STATS reply is fully drained, so if it were
    // going to mis-persist onto "u" it already would have. This is the
    // direct #184 signature: pre-fix, `/channels/u/messages` holds the
    // stats dump; post-fix it is empty.
    const url = `${GRAPPA_BASE_URL}/networks/${encodeURIComponent(
      visitor.network_slug,
    )}/channels/${encodeURIComponent(STATS_LETTER)}/messages`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${visitor.token}` },
    });
    expect(res.ok).toBe(true);
    const rows = (await res.json()) as unknown[];
    expect(rows).toHaveLength(0);
  } finally {
    await ctx.close();
    await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});
