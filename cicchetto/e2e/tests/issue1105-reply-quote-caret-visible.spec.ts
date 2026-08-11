// #1105 — replying to a message that does not fit on one line left the caret
// BELOW the visible area of the compose box: the quote was inserted and the
// caret placed at the end, but the textarea was never scrolled, so you typed
// blind. Reported on IRC right after the #1067 reply gesture shipped.
//
// The compose textarea is `rows={1}` with `resize: none`, so any draft that
// wraps turns it into an internal scroll container, and `setSelectionRange`
// does not scroll. #173 had already met and fixed exactly this on history
// recall — inside `ComposeBox`. `appendToCompose` carried its own, incomplete
// copy of "caret at end", which is precisely why the reply door shipped
// broken. The fix converges both on `lib/composeCaret.placeCaretAtEndInView`,
// so this spec and the #173 one share ONE oracle (`expectEndCaretVisible`) —
// a second copy of the assertion would repeat, on the test side, the mistake
// the production code just stopped making.
//
// WHY e2e and not a unit test: jsdom does no layout, so `scrollHeight` is 0
// on every element and any assertion about the caret being "in view" passes
// vacuously there. The unit test in `src/__tests__/replyQuote.test.ts` stubs
// the overflow and can therefore only pin the ASSIGNMENT; that a real engine
// then puts the caret inside the client box is what this spec measures.
//
// GATE REALITY (feedback_playwright_webkit_not_ios_scroll): chromium, untagged
// — Playwright webkit is not real iOS, and the gesture is synthesized in-page
// on the row, reaching the production listener by bubbling to `.scrollback`
// exactly as a finger does. The FEEL on a real phone stays vjt's dogfood; what
// is asserted here is the GEOMETRY.
import type { Page } from "@playwright/test";
import {
  composeCaretGeometry,
  composeSend,
  composeTextarea,
  expectEndCaretVisible,
  loginAs,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
test.setTimeout(90_000);

const CHANNEL = AUTOJOIN_CHANNELS[0];

// The issue measured the threshold at a 390px viewport: a 46-char quote
// already wraps and already hides the caret. This body is far past it, so the
// ROW wraps and the quote it produces is a capped one, while staying well
// inside one PRIVMSG so the server-side split budget (#246) never turns it
// into two scrollback rows.
const FILLER =
  "che va a capo parecchie volte perche' il textarea e' rows=1 e non cresce, " +
  "quindi il caret finisce sotto la piega e non si vede piu' nulla";

// #1235 capped the quoted body at 42 characters plus a literal `...`, so a
// single reply can no longer BE six wrapped lines: the longest quote the
// gesture can now produce is `<nick> ` + 45 + ` << `, about two. The overflow
// this spec needs is therefore built the way an operator builds it — the reply
// verb APPENDS, so three replies to the same row stack into a draft that wraps
// well past the fold, with the caret at the very end of the third. What is
// measured is unchanged: the caret's geometry after an append.
//
// Hardcoded in lockstep with `REPLY_QUOTE_BODY_LIMIT` / `REPLY_QUOTE_ELLIPSIS`
// in `src/lib/replyQuote.ts` — the e2e package does not import from `src`, and
// the house convention here is a mirrored constant with a lockstep comment.
const QUOTED_BODY_LIMIT = 42;
const QUOTED_ELLIPSIS = "...";
const REPLIES = 3;

function cappedQuotedBody(body: string): string {
  const chars = [...body];
  return chars.length <= QUOTED_BODY_LIMIT
    ? body
    : chars.slice(0, QUOTED_BODY_LIMIT).join("") + QUOTED_ELLIPSIS;
}

// A body unique per run: the e2e sqlite scrollback persists across
// KEEP_STACK=1 re-runs, and a static string would match two rows on the
// second run and trip Playwright strict mode.
function uniqueBody(): string {
  return `issue1105 ${Date.now()} ${FILLER}`;
}

// Six-ish wrapped lines minus generous slack — three stacked quotes come to
// about what the single uncapped one used to be. Its job is to fail loudly if
// the fixture ever stops overflowing, because then "the caret is in view" would
// be true for the wrong reason.
const MIN_OVERFLOW_PX = 40;

// A left→right drag on the message row whose text contains `body`. Touch
// synthesis is per-spec throughout this suite (#123, #308, #1041, #1067, …)
// because each spec samples something different mid-drag; only the ORACLE is
// shared. Here nothing mid-drag matters — just that the reply fires.
async function swipeRowRight(page: Page, body: string): Promise<void> {
  await page.evaluate((text: string) => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="scrollback-line"]'),
    );
    const row = rows.find((r) => r.textContent?.includes(text));
    if (row === undefined) throw new Error(`no scrollback row containing ${text}`);
    const fire = (type: "touchstart" | "touchmove" | "touchend", x: number, y: number): void => {
      const t = new Touch({ identifier: 1, target: row, clientX: x, clientY: y });
      const active = type === "touchend" ? [] : [t];
      row.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: active,
          targetTouches: active,
          changedTouches: [t],
        }),
      );
    };
    // Starts well clear of the left edge: #1041 gave the edge the same
    // right-swipe (it opens the sidebar), and zone separation is what keeps
    // one finger from doing both.
    fire("touchstart", 120, 400);
    fire("touchmove", 175, 404);
    fire("touchmove", 235, 407);
    fire("touchend", 280, 408);
  }, body);
}

test("issue1105 — replying to a wrapping message scrolls the compose caret into view", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const body = uniqueBody();

  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await composeSend(page, body);
  await expect(page.locator('[data-testid="scrollback-line"]', { hasText: body })).toBeVisible({
    timeout: 5_000,
  });

  // Pre-state: an already-scrolled compose would make the outcome true for the
  // wrong reason.
  const ta = composeTextarea(page);
  await expect(ta).toHaveValue("");
  expect((await composeCaretGeometry(page)).scrollTop).toBe(0);

  // Each reply is awaited before the next is fired: the value IS the barrier
  // proving the previous append landed, so the swipes cannot overlap.
  const quote = `<${specNick()}> ${cappedQuotedBody(body)} << `;
  for (let i = 1; i <= REPLIES; i++) {
    await swipeRowRight(page, body);
    await expect(ta).toHaveValue(quote.repeat(i), { timeout: 5_000 });
  }

  // THE regression: caret at the end of the quote AND that line inside the
  // client box. Before the fix scrollTop stayed 0 with the caret below it.
  expectEndCaretVisible(await composeCaretGeometry(page), MIN_OVERFLOW_PX);
});
