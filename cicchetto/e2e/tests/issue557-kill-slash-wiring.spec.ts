// Issue #557 — /kill <nick> [reason] first-class operator KILL (cicchetto-ONLY).
//
// The TWIN of #375 (/rehash <option>) and #155 (/stats): the grappa side is a
// clean raw passthrough — `/kill` rides the `pushRaw` transport and grappa's
// `handle_in("raw", …)` ships the line VERBATIM via `Session.send_raw`
// (grappa_channel.ex). All of #557 lives in cic: the slash parser gains a
// `kill` verb and compose composes `KILL <nick> :<reason>`, composing the
// trailing colon DOWNSTREAM so a multi-word reason stays one param instead of
// truncating at the first space (the `/quote KILL nick reason` foot-gun where a
// forgotten colon silently drops everything after the first word).
//
// OBSERVABLE — the raw outbound frame. As #375 established, the unforgeable
// evidence is the raw frame cic SENDS: `pushRaw` ships `["raw",{network_id,
// line}]` over the Phoenix WS, and `line` is exactly what grappa forwards to
// the ircd. We capture every `framesent` and assert the reason rides `line`
// behind the trailing colon. We do NOT oper (and MUST NOT — an OPER'd KILL
// would actually disconnect a session): a non-oper's KILL gets 481 back, kept
// as a belt-and-suspenders witness that the frame genuinely reached upstream
// (matched leniently to tolerate whichever check bahamut's m_kill runs first).
//
// RED pre-fix: no `kill` verb → `/kill …` is an unknown command → NO raw frame
// is ever sent → the "KILL spammer :flooding the channel" assertion times out.
// GREEN post-fix: `/kill spammer flooding the channel` sends
// `line: "KILL spammer :flooding the channel"`; bare `/kill spammer` sends
// exactly `"KILL spammer"` (no trailing colon, no stray null/space).

import { expect, test } from "../fixtures/test";
import {
  composeSend,
  expectShellReady,
  scrollbackLine,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { adminDeleteVisitor, mintVisitor } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";

// A non-oper KILL reply. bahamut's m_kill rejects a non-oper (481
// ERR_NOPRIVILEGES) — routed to `$server` by the numeric_router :scan
// fallback, same path #375 relies on. Matched leniently (permission-denied OR
// no-such-nick) so the witness holds regardless of whether bahamut checks the
// oper privilege or the target's existence first — the frame capture below is
// the primary, order-independent proof; this only witnesses upstream delivery.
const UPSTREAM_REPLY_TEXT = /permission denied|no such nick|isn't on your screen/i;

test("issue #557 — /kill <nick> <reason> ships KILL nick :reason on the raw wire, bare /kill has no colon", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const visitorNick = `v557-${Date.now()}`;
  const visitor = await mintVisitor(visitorNick);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Every raw `line` cic ships upstream via pushRaw. Phoenix v2 frames are
  // JSON arrays `[join_ref, ref, topic, "raw", {network_id, line}]`; guard on
  // `"raw"` then pull out `line`. Attached BEFORE goto so we catch the app WS
  // from the moment it opens (and any reconnect). Mirrors #375.
  const sentRawLines: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", ({ payload }) => {
      if (typeof payload !== "string" || !payload.includes('"raw"')) return;
      const m = payload.match(/"line":"([^"]*)"/);
      if (m) sentRawLines.push(m[1]);
    });
  });

  try {
    const visitorSubject = {
      kind: "visitor",
      id: visitor.id,
      nick: visitor.nick,
      network_slug: visitor.network_slug,
    };

    // Boot cic straight into Shell as the visitor (no captcha/anon dance),
    // exactly like #375/#155/#148.
    await page.addInitScript(
      ([token, subjectJson]) => {
        localStorage.setItem("grappa-token", token);
        localStorage.setItem("grappa-subject", subjectJson);
        localStorage.setItem("cic.installChoice", "browser");
      },
      [visitor.token, JSON.stringify(visitorSubject)] as const,
    );
    await page.goto("/");
    await expectShellReady(page);

    // Focus the visitor's $server window and wait for the upstream registration
    // numerics (:notice rows) — proves the session is connected and the pane is
    // live, so the reply numeric won't race an empty pane.
    await selectChannel(page, visitor.network_slug, "Server", { awaitWsReady: false });
    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="notice"]').first(),
    ).toBeVisible({ timeout: 20_000 });

    // (1) THE FIX — /kill <nick> <multi-word reason> must ship
    // `KILL spammer :flooding the channel` on the raw wire. The trailing colon
    // (composed downstream) keeps the whole reason as one param. Pre-fix `kill`
    // is an unknown command → no raw frame at all → this times out.
    await composeSend(page, "/kill spammer flooding the channel");
    await expect
      .poll(() => sentRawLines, {
        timeout: 15_000,
        message: "raw frame 'KILL spammer :flooding the channel' not sent",
      })
      .toContain("KILL spammer :flooding the channel");

    // …and it genuinely reached upstream: the non-oper gets a reply back, the
    // server's response to the frame we shipped, rendered as a :notice in
    // $server. (A non-oper KILL is harmless — the ircd rejects it.)
    await expect(scrollbackLine(page, "notice", UPSTREAM_REPLY_TEXT).first()).toBeVisible({
      timeout: 15_000,
    });

    // (2) REGRESSION GUARD — bare /kill (no reason) ships EXACTLY `KILL spammer`
    // (no trailing colon, no stray null/space). The empty-reason branch must
    // not leak a `KILL spammer :` or a stringified null into the frame.
    await composeSend(page, "/kill spammer");
    await expect
      .poll(() => sentRawLines, { timeout: 15_000, message: "raw frame 'KILL spammer' not sent" })
      .toContain("KILL spammer");
    expect(
      sentRawLines.some((l) => l === "KILL spammer :" || l.toLowerCase().includes("null")),
    ).toBe(false);

    // The native verb never surfaces the parser's unknown-command error.
    await expect(page.getByText(/unknown command/i)).toHaveCount(0);
  } finally {
    await ctx.close();
    await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});
