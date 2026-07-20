// #350 — tapping a link in scrollback dismissed the mobile keyboard.
//
// A linkified URL renders as `<a class="scrollback-link">` INSIDE
// `.scrollback`, which keepKeyboard.ts treats as a duration-gated
// selectable-text surface: a short TAP is let through (focus shifts → iOS
// dismisses the keyboard). But a link is a CONTROL — same category as the
// `.scrollback-invite-join` [Join] CTA. The fix adds `.scrollback-link`
// to keepKeyboard's SELECTABLE_TEXT_EXCLUDE so a link tap hits the
// always-fire mousedown preventDefault (keyboard kept). The URL text
// stays copyable (`.scrollback-link` is NOT re-excluded in CSS — see #250
// / `.nick-clickable`), so this is a keyboard/focus change only.
//
// Why a SYNTHETIC tap and not a page.mouse gesture: webkit emulation
// can't simulate the OS keyboard (same limitation as ux-3-oct /
// text-selection-restored), and a page.mouse drag is non-discriminating
// here for two reasons — it carries no touchstart (so the handler's
// tap-vs-long-press timing degenerates to "long-press" and preventDefault
// would fire even pre-fix), and webkit doesn't move focus to an <a> on
// mousedown anyway. So we drive the EXACT sequence the handler
// classifies: a document touchstart (stamps the clock) immediately
// followed by the mousedown iOS dispatches on release — a genuine SHORT
// tap — on the real, MircText-rendered anchor in the running app, and
// assert the discriminating contract: the mousedown default (the
// focus-shift that dismisses the keyboard) is prevented, and compose
// keeps focus. RED pre-fix (short tap on a selectable surface is let
// through → not prevented). Real-device keyboard smoke stays vjt's iPhone.

import { test, expect } from "../fixtures/test";
import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
// Date.now() suffix (house pattern, see text-selection-restored spec): the
// e2e sqlite scrollback persists across KEEP_STACK=1 re-runs, so a static
// body would match two rows on the second run and trip strict mode. The
// URL has no media extension → plain `.scrollback-link` (the #350 case).
const LINK_URL = `https://example.com/issue350-${Date.now()}`;
const MESSAGE_BODY = `tap target: ${LINK_URL}`;

test("@webkit iOS — a short tap on a scrollback link keeps the keyboard (mousedown focus-shift prevented, compose stays focused)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  await composeSend(page, MESSAGE_BODY);
  const row = scrollbackLine(page, "privmsg", LINK_URL);
  await expect(row).toBeVisible({ timeout: 5_000 });

  const link = row.locator("a.scrollback-link");
  await expect(link).toBeVisible();

  // Drive the tap on the real anchor + real document-level keepKeyboard
  // listeners installed at app boot. All in one evaluate so focus can't
  // drift between steps.
  const result = await link.evaluate((linkEl) => {
    const ta = document.querySelector(".compose-box textarea");
    if (!(ta instanceof HTMLTextAreaElement)) {
      return { error: "no compose textarea" as string | null, prevented: false, activeIsCompose: false };
    }
    // Precondition: compose focused — the bug only bites while an input
    // has focus (that's when keepKeyboard arms its focus-shift prevent).
    ta.focus();
    // A genuine short tap: touchstart stamps keepKeyboard's clock, then
    // the mousedown iOS dispatches on release ~0ms later → classified TAP.
    document.dispatchEvent(new Event("touchstart", { bubbles: true }));
    const md = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    linkEl.dispatchEvent(md);
    return {
      error: null as string | null,
      prevented: md.defaultPrevented,
      activeIsCompose: document.activeElement === ta,
    };
  });

  expect(result.error).toBeNull();
  // The focus-shift default is cancelled → focus never leaves compose →
  // iOS never gets the blur that dismisses the keyboard.
  expect(result.prevented).toBe(true);
  expect(result.activeIsCompose).toBe(true);
});
