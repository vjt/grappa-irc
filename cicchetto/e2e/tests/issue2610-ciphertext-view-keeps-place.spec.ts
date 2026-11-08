// issue 2610 — switching an encrypted chat between its plaintext and its
// ciphertext (issue 2513, through either door: the window list row's menu, or
// since issue 2583 the right rail's `ciphertext` entry) keeps the reader where
// they were. A payload is longer than the words it carries, so every line
// changes height at once and a scroll offset kept in pixels shows other lines:
// the place is held in lines instead. At the bottom stays at the bottom, and
// anywhere else the line at the top of the view stays at the top. Two
// browsers (the peer only answers for its keys), two grappa users, two real
// vodozemac engines, one real ircd.
//
// ## What makes this spec able to fail
//
//   * Mid-chat, after a flip, the line at the top of the view is another line,
//     or the same line sits elsewhere: either door, either way, and with the
//     rail's menu still open around its entry (the menu holds the overlay lock
//     that freezes the pane) as well as once it closes.
//   * At the bottom, a flip leaves the view above the last line, or the pane no
//     longer follows: read in raw pixels, never through the pane's 50px band.
//   * The premises: the chat overflows, the line chosen for the middle is
//     neither at the top of the chat nor within reach of its bottom, and the
//     ciphertext really is taller than the plaintext (or nothing would move).
//
// Desktop only: both doors are there, and the phone reaches the rail's entry
// the way it reaches every rail entry (openRailMenu, the right drawer).

import type { Browser, Page, TestInfo } from "@playwright/test";
import {
  boot,
  chatLines,
  equery,
  FRAME,
  flip,
  flipFromRail,
  KEYS_TIMEOUT,
  peerPage,
  send,
} from "../fixtures/encryptedQuery";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

/** How many messages the chat holds: enough to overflow the desktop pane with room to spare. */
const LINES = 20;

// Long enough to take two lines in the desktop pane beside the rail.
const FILLER =
  "una riga cifrata lunga quanto basta per andare a capo nel pannello di un desktop, così che la chat trabocchi e resti un punto a metà dove fermarsi a leggere";

/** Sub-pixel rounding of a restored offset; far below any line's height. */
const EPS = 2;

// The pane's scroll list and what it shows: the line at the top of the view
// (the first one whose bottom is below the view's top edge), how far its top
// sits from that edge, its height, how far the view is above the last line,
// and whether the pane follows new lines.
type Place = { id: string; offset: number; height: number; belowTail: number; follow: string };

const place = (page: Page): Promise<Place> =>
  page
    .getByTestId("e2e-pane")
    .getByTestId("scrollback")
    .evaluate((list) => {
      const top = list.getBoundingClientRect().top;
      const lines = Array.from(
        list.querySelectorAll<HTMLElement>('[data-testid="scrollback-line"]'),
      );
      const first = lines.find((l) => l.getBoundingClientRect().bottom > top + 1);
      if (first === undefined) throw new Error("no line in view");
      const box = first.getBoundingClientRect();
      return {
        id: first.dataset.msgId ?? "",
        offset: box.top - top,
        height: box.height,
        belowTail: list.scrollHeight - list.scrollTop - list.clientHeight,
        follow: list.dataset.follow ?? "",
      };
    });

// The view is the same place as `before`: the same line at its top, as far
// from the top edge as it was. Polled, then read again a moment later, so a
// late write that moves it is caught too.
async function expectSameLine(page: Page, before: Place): Promise<void> {
  const same = async () => {
    const now = await place(page);
    return now.id === before.id && Math.abs(now.offset - before.offset) <= EPS;
  };
  await expect.poll(same).toBe(true);
  await page.waitForTimeout(600);
  const now = await place(page);
  const seen = `line ${now.id} at ${now.offset}px, was line ${before.id} at ${before.offset}px`;
  expect(now.id, seen).toBe(before.id);
  expect(Math.abs(now.offset - before.offset), seen).toBeLessThanOrEqual(EPS);
}

async function expectAtBottom(page: Page): Promise<void> {
  await expect.poll(async () => (await place(page)).belowTail).toBeLessThanOrEqual(EPS);
  await page.waitForTimeout(600);
  const now = await place(page);
  expect(now.belowTail, `${now.belowTail}px above the last line`).toBeLessThanOrEqual(EPS);
  expect(now.follow).toBe("on");
}

/** The lines read as their ciphertext (`showing`) or as their plaintext. */
async function expectShowing(page: Page, showing: "ciphertext" | "plaintext"): Promise<void> {
  const body = chatLines(page).last().locator(".scrollback-body");
  if (showing === "ciphertext") await expect(body).toHaveText(FRAME);
  else await expect(body).toHaveText(new RegExp(`^${LINES} `));
}

/** The rail's actions menu, closed the way a reader closes it, with Escape. */
async function closeRailMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("rail-actions-launcher")).toHaveAttribute("aria-expanded", "false");
}

// A real wheel over the pane: the reader's own scroll, the input the pane
// reads as theirs (it stops following and drops the window's activation).
async function wheelBy(page: Page, deltaY: number): Promise<void> {
  const box = await page.getByTestId("e2e-pane").getByTestId("scrollback").boundingBox();
  if (!box) throw new Error("scrollback bounding box null");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

// Alice's window holds a message from the moment grappa takes it (the line
// reads "sent" and changes no more). The first one waits for Bob's keys; every
// later one finds the session. Bob's copies trail by minutes (grappa's E2E
// pacer), on purpose not waited for: see issue2512-encrypted-scrollback.
async function longChat(
  page: Page,
  browser: Browser,
  testInfo: TestInfo,
  then: (bobNick: string) => Promise<void>,
): Promise<void> {
  test.slow();
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  const peer = await peerPage(browser);
  try {
    await boot(page, alice);
    await boot(peer.page, bob.user);
    await equery(page, aliceNick, bob.nick);
    await equery(peer.page, bob.nick, aliceNick);

    const sent = page
      .getByTestId("e2e-pane")
      .locator('[data-testid="e2e-row-state"][data-state="sent"]');
    await send(page, `1 ${FILLER}`);
    await expect(sent).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    for (let i = 2; i <= LINES; i++) await send(page, `${i} ${FILLER}`);
    await expect(chatLines(page)).toHaveCount(LINES);
    await expect(sent).toHaveCount(LINES);

    await then(bob.nick);
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
}

test("flipping an encrypted chat to its ciphertext and back keeps the reader's place: at the bottom, and on the line at the top of the view, from either door", async ({
  page,
  browser,
}, testInfo) => {
  await longChat(page, browser, testInfo, async (bobNick) => {
    // At the bottom, where the last send left the pane. The rail's door: the
    // menu stays open around the entry, holding the overlay lock.
    await expectAtBottom(page);
    await flipFromRail(page, "ciphertext");
    await expectShowing(page, "ciphertext");
    await expectAtBottom(page);
    await closeRailMenu(page);
    await expectAtBottom(page);
    await flip(page, bobNick, "Show plaintext");
    await expectShowing(page, "plaintext");
    await expectAtBottom(page);

    // In the middle: the reader scrolls up, and stops with a line at the top
    // of the view, far enough from the bottom that the pane is not at it in
    // either view. Chosen by measuring, so the premise holds on any pane size.
    await wheelBy(page, -200);
    await expect.poll(async () => (await place(page)).follow).toBe("off");
    const chosen = await page
      .getByTestId("e2e-pane")
      .getByTestId("scrollback")
      .evaluate((list) => {
        const lines = Array.from(
          list.querySelectorAll<HTMLElement>('[data-testid="scrollback-line"]'),
        );
        const listTop = list.getBoundingClientRect().top - list.scrollTop;
        const maxTop = list.scrollHeight - list.clientHeight;
        // The furthest line whose top can sit at the view's top 100px clear of
        // the bottom, and never the chat's first line.
        let index = -1;
        lines.forEach((l, i) => {
          if (i > 0 && l.getBoundingClientRect().top - listTop <= maxTop - 100) index = i;
        });
        lines[index]?.scrollIntoView({ block: "start" });
        return index;
      });
    expect(chosen).toBeGreaterThan(0);
    await page.waitForTimeout(600);
    const middle = await place(page);
    expect(middle.follow).toBe("off");
    expect(middle.belowTail).toBeGreaterThan(50);
    expect(Math.abs(middle.offset)).toBeLessThanOrEqual(EPS);

    // The window list row's door, both ways.
    await flip(page, bobNick, "Show ciphertext");
    await expectShowing(page, "ciphertext");
    // The premise: the line did grow, so the same pixels would show others.
    expect((await place(page)).height).toBeGreaterThan(middle.height);
    await expectSameLine(page, middle);
    await flip(page, bobNick, "Show plaintext");
    await expectShowing(page, "plaintext");
    await expectSameLine(page, middle);

    // The rail's door, both ways: under its open menu, and once it closes.
    await flipFromRail(page, "ciphertext");
    await expectShowing(page, "ciphertext");
    await expectSameLine(page, middle);
    await closeRailMenu(page);
    await expectSameLine(page, middle);
    await flipFromRail(page, "plaintext");
    await expectShowing(page, "plaintext");
    await expectSameLine(page, middle);
    await closeRailMenu(page);
    await expectSameLine(page, middle);
    expect((await place(page)).follow).toBe("off");
  });
});
