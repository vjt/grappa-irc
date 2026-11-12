// issue 2091 — one arrow tap, counted in a real browser.
//
// 🔴 READ THIS BEFORE TRUSTING THIS SPEC AS EVIDENCE. It is GREEN with the cure
// and MEASURED GREEN WITHOUT IT. It does not discriminate the fix, and nobody
// should cite it as proof the fix works — the discriminating evidence is the
// frame-replay bench in `src/__tests__/ScrollbackPane.test.tsx`, which counts
// the pane's CALLS to the paging verbs and goes red without the cure.
//
// What this spec IS, then. The issue's acceptance asks for HTTP requests per
// tap, counted in a real browser, before and after. That number is this file's
// output and the answer is ZERO ON BOTH SIDES, on a 3000-row corpus with both
// pagers still armed. The defect is real — the asymmetry is read in the code
// and the bench counts up to 5 pager calls for one tap — but those calls do not
// become requests here: a smooth scroll over tens of thousands of pixels moves
// far enough per frame that no `scroll` event lands inside a 200px band, and
// the verbs' in-flight guard plus exhausted latch absorb what is left. The
// reported "hundreds of requests" is not reproduced in this substrate. That is
// a result, not a gap in the spec, and it is why the number lives here in a
// file that says so rather than in a commit message that implies otherwise.
//
// What it still guards, and can still go red on:
//   * the acceptance property itself — a tap must not fetch. It holds today for
//     reasons partly outside the cure, and a future change that makes the jump
//     anchor lazy, or widens a band, breaks it here first.
//   * the cure's most dangerous failure mode — suppressing the THRESHOLDS
//     rather than the CALLER. The positive control below scrolls the same
//     region with a real wheel and requires paging to happen. A gate written
//     against `distance` instead of against who scrolled turns that red.
//
// ── two fixture findings, both measured, both load-bearing ──────────────────
// (1) It was first written against the shared spec-subject's seeded autojoin
// channel (200 rows, `specSubject.ts:SEED_COUNT`) and that was VACUOUS for a
// second reason: with a 50-row REST page the scroll-to-top that sets the scene
// drains the corpus, both exhausted latches set, and from then on no pager can
// fire for ANY caller. Hence `SEED_ROWS` far above what one gesture can drain —
// the pagers must still be ARMED at the tap, or the zero has two explanations.
// (2) The positive control does NOT wheel until `scrollTop <= 200`. That
// condition is UNREACHABLE while the backfill pager is armed, which is exactly
// the state the control needs: every page it pulls is PREPENDED and
// `applyPrependPreserve` restores the reader's row by the height delta, pushing
// scrollTop back down by a page. Measured: the pane sat around 1048px through
// 80 notches of −600. What proves the wheel landed is that the BUFFER GREW.
//
// Chromium only: the gesture is layout-driven and the assertion is about the
// scroll engine, so this rides the same one-engine precedent as the other
// scroll-geometry specs (#168, #243, #360).

import type { Page, Request } from "@playwright/test";
import { loginAs, scrollbackLine, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { assertMessagePersisted, GRAPPA_BASE_URL, type SeededUser } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { forwardPageDiagnostics } from "../fixtures/pageDiagnostics";
import { getSeededAdmin, NETWORK_SLUG } from "../fixtures/seedData";
import { SEED_GAP_MS } from "../fixtures/specSubject";
import { expect, test } from "../fixtures/test";

const SCROLL_TO_BOTTOM = '[data-testid="scroll-to-bottom"]';
const BADGE = '[data-testid="scroll-to-bottom-badge"]';
// Well past what one gesture can drain at a 50-row REST page: the point is that
// the backfill pager is still ARMED when the tap happens. Seeding cost is
// linear and small (the 200-row baseline provisions in ~200ms).
const SEED_ROWS = 3000;
const PASSWORD = "test-password-not-secret";

// Narrow pane, short viewport: the corpus overflows it many times over, so the
// jump has real distance to animate across. A jump with no travel would sweep
// no threshold band and the spec would pass without exercising the defect.
test.use({ viewport: { width: 900, height: 400 } });

// Both pagers issue GET on the channel's messages collection: `?before=<id>`
// (backfill) and `?after=<id>` (forward). Anything else the pane fetches —
// cursor POSTs, avatars, the WS — is a different verb and must not be counted,
// or the number stops being "pages fetched by this gesture".
function isPagingRequest(req: Request): boolean {
  if (req.method() !== "GET") return false;
  const url = req.url();
  if (!url.includes("/messages")) return false;
  return url.includes("before=") || url.includes("after=");
}

function countPagingRequests(page: Page): { reset: () => void; urls: () => string[] } {
  let seen: string[] = [];
  page.on("request", (req) => {
    if (isPagingRequest(req)) seen.push(req.url());
  });
  return {
    reset: () => {
      seen = [];
    },
    urls: () => [...seen],
  };
}

// The same `/admin/test/subject` provisioning verb `specSubject.ts` uses (dev +
// test only, admin-gated), asked for a much deeper channel. A separate subject
// rather than a deeper shared one: SEED_ROWS would otherwise be paid by every
// spec in the suite for the benefit of this one.
async function provisionDeepSubject(
  name: string,
  channel: string,
): Promise<{ user: SeededUser; nick: string }> {
  const admin = getSeededAdmin();
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/test/subject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({
      name,
      password: PASSWORD,
      network_slug: NETWORK_SLUG,
      nick: name,
      autojoin_channels: [channel],
      seed: [
        { name: channel, seed_count: SEED_ROWS, seed_sender: "seed-bot", seed_gap_ms: SEED_GAP_MS },
      ],
    }),
  });
  if (res.status !== 201) {
    throw new Error(`provisionDeepSubject(${name}) failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string; subject: unknown };
  return {
    user: {
      name,
      password: PASSWORD,
      identifier: `${name}@grappa.test`,
      token: body.token,
      subjectJson: JSON.stringify(body.subject),
    },
    nick: name,
  };
}

async function teardownDeepSubject(name: string): Promise<void> {
  const admin = getSeededAdmin();
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/test/subject/${name}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${admin.token}` },
  });
  if (res.status !== 204) {
    throw new Error(`teardownDeepSubject(${name}) failed: ${res.status} ${await res.text()}`);
  }
}

async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (el === null) return;
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
}

async function scrollTopOf(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    return el === null ? -1 : Math.round(el.scrollTop);
  });
}

// A CONDITION, not a delay: two consecutive reads with the same scrollTop mean
// the smooth jump has stopped moving, so every frame it was ever going to emit
// has already re-entered onScroll and the count is final.
async function waitForScrollToSettle(page: Page): Promise<void> {
  let prev: number | null = null;
  await expect
    .poll(
      async () => {
        const top = await scrollTopOf(page);
        const settled = prev !== null && top === prev;
        prev = top;
        return settled;
      },
      { timeout: 20_000, intervals: [250] },
    )
    .toBe(true);
}

test.describe("issue 2091 — the arrow jumps without downloading the buffer", () => {
  test("a mention-jump tap issues no paging request, while a human scroll over the same region still pages", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    forwardPageDiagnostics(page);

    const stamp = Date.now() % 100000;
    const subjectName = `i91${stamp}`;
    const channel = `#i2091-${stamp}`;
    const peerNick = `i91p${stamp}`;

    const { user, nick } = await provisionDeepSubject(subjectName, channel);
    const mention = `${nick}: i2091 ping below the fold`;
    let peer: IrcPeer | null = null;
    try {
      await loginAs(page, user);
      await selectChannel(page, NETWORK_SLUG, channel, { ownNick: nick });

      peer = await IrcPeer.connect({ nick: peerNick });
      await peer.join(channel);
      // ONE mention, deliberately: it becomes the newest row, so scrolling up
      // puts it below the fold, and a single send keeps the peer well clear of
      // bahamut's flood penalty.
      peer.privmsg(channel, mention);
      await assertMessagePersisted({
        token: user.token,
        networkSlug: NETWORK_SLUG,
        channel,
        sender: peerNick,
        body: mention,
        timeoutMs: 20_000,
      });
      await expect(scrollbackLine(page, "privmsg", "i2091 ping below the fold")).toBeVisible({
        timeout: 20_000,
      });

      const paging = countPagingRequests(page);

      // Setup, not measurement: a direct DOM write that parks the pane at the
      // top of what is loaded, with the mention far below the fold. Its own
      // paging happens before the counter is reset.
      await scrollToTop(page);
      await waitForScrollToSettle(page);

      // Preconditions, asserted rather than assumed: the pane is off the tail
      // and the badge sees the mention below the fold, so the tap takes the
      // mention-jump branch and not the snap-to-tail one.
      await expect(page.locator(SCROLL_TO_BOTTOM)).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(BADGE)).toHaveText("1", { timeout: 15_000 });
      const topBeforeTap = await scrollTopOf(page);

      // ── the measurement ──────────────────────────────────────────────────
      paging.reset();
      await page.locator(SCROLL_TO_BOTTOM).click({ timeout: 15_000 });
      await waitForScrollToSettle(page);
      const duringTap = paging.urls();

      // The gesture's visible outcome still happened. Without this, the count
      // could be satisfied by a tap that did nothing at all.
      expect(
        await scrollTopOf(page),
        "the tap must actually move the pane, or a zero fetch count is meaningless",
      ).toBeGreaterThan(topBeforeTap);
      await expect(page.locator(BADGE)).toHaveCount(0, { timeout: 15_000 });

      expect(
        duringTap,
        `one arrow tap must fetch nothing — the anchor was already rendered. Got: ${duringTap.join(", ")}`,
      ).toEqual([]);

      // ── the positive control, same pane, same state ──────────────────────
      // Deliberately NOT "wheel until scrollTop reaches the backfill band".
      // MEASURED: that condition is unreachable while the backfill pager is
      // armed, which is exactly the state this control needs. Every page
      // `maybeLoadOlder` pulls is PREPENDED, and `applyPrependPreserve` then
      // restores the reader's row by the height delta — pushing scrollTop back
      // DOWN by a page's worth. The pane hovered around 1048px through 80
      // notches of −600 and the assertion failed on a fixture premise that
      // cannot hold, not on the product. What proves the wheel was delivered is
      // that the pane MOVED and the buffer GREW.
      const rowsBeforeWheel = await scrollbackLines(page).count();
      paging.reset();
      await page.locator('[data-testid="scrollback"]').hover();
      for (let i = 0; i < 40; i++) {
        await page.mouse.wheel(0, -600);
      }
      await waitForScrollToSettle(page);

      // Split from the paging assertion so a red names which half broke: this
      // one failing means the wheel never reached the pane (a harness problem,
      // and the count below would be meaningless); it passing with the count
      // still zero means the cure gated the thresholds instead of the caller (a
      // product problem, and the tap's zero above would mean nothing either).
      expect(
        await scrollbackLines(page).count(),
        "the human wheel must actually pull older rows in, or the control below proves nothing",
      ).toBeGreaterThan(rowsBeforeWheel);
      expect(
        paging.urls().length,
        "a human scroll back through the top of the buffer must still page — the suppression is scoped to the programmatic jump, not to the thresholds",
      ).toBeGreaterThan(0);
    } finally {
      if (peer !== null) await peer.disconnect("issue 2091 done");
      await teardownDeepSubject(subjectName);
    }
  });
});
