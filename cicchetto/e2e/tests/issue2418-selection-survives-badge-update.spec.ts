// issue 2418 — a selection in the scrollback must survive traffic in ANOTHER
// window. The report: select a line, right-click, pick the browser's Copy, and
// sometimes the clipboard keeps its previous content, always when an unread
// badge ticked in between.
//
// The cause was the pane, not the badge. `rows()` read whole-window records,
// so the arrival that bumps another window's badge re-ran it, every run built
// fresh row objects, and the ref-keyed `<For>` replaced every row node of the
// window on screen. A selection whose boundaries sat in those nodes collapsed,
// and Copy over a collapsed selection writes nothing.
//
// Harness + limits:
//   * chromium, DESKTOP viewport, no `hasTouch`: the report is a desktop
//     right-click, and the selection is made with a REAL mouse drag, so what
//     is held is the engine's own selection, not a synthesized Range.
//   * The oracle is the selection itself (its text, and the row node it lives
//     in still being in the document). Whether the OS-drawn menu's Copy then
//     reaches the clipboard is not observable from Playwright; a live
//     selection is the precondition that Copy needs.
//   * The trigger is a peer PRIVMSG into a second channel, the badge the
//     report names, awaited on the sidebar badge itself, so the assertions
//     run after the arrival has been rendered.
import {
  composeTextarea,
  loginAs,
  selectChannel,
  sidebarMessageBadge,
} from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false });
test.setTimeout(90_000);

const READING = AUTOJOIN_CHANNELS[0];
const ELSEWHERE = "#2418-elsewhere";
const PEER_NICK = "i2418-peer";

test("issue2418 — a scrollback selection survives an unread-badge update in another channel", async ({
  page,
}) => {
  if (!READING) throw new Error("AUTOJOIN_CHANNELS empty");
  const user = specUser();
  await loginAs(page, user);
  await selectChannel(page, NETWORK_SLUG, READING, { ownNick: specNick() });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await peer.join(ELSEWHERE);
    await composeTextarea(page).fill(`/join ${ELSEWHERE}`);
    await composeTextarea(page).press("Enter");
    // Visiting it baselines its read cursor to the tail, so the badge below
    // counts the one message this spec sends and nothing else.
    await selectChannel(page, NETWORK_SLUG, ELSEWHERE, { ownNick: specNick() });
    await selectChannel(page, NETWORK_SLUG, READING, { ownNick: specNick() });
    // Pre-state: no badge yet, so the one awaited below is this spec's arrival.
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, ELSEWHERE)).toHaveCount(0);

    // A seeded row of the window being read. Not an own send: the send's
    // resolve re-latches this window's divider, a change of THIS window's
    // rows that would rebuild them for a reason unrelated to the arrival.
    const row = page.locator('[data-testid="scrollback-line"][data-kind="privmsg"]').last();
    await expect(row).toBeVisible({ timeout: 10_000 });
    const rowNode = await row.elementHandle();
    if (rowNode === null) throw new Error("scrollback row has no element");

    // The compose box holds focus on desktop; the operator drags over the
    // scrollback from there.
    await composeTextarea(page).focus();
    const box = await row.boundingBox();
    if (box === null) throw new Error("scrollback row has no box");
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 1, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, y, { steps: 12 });
    await page.mouse.up();

    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    // Pre-state: the drag really selected the row's text, or "unchanged" below
    // would compare two empty strings.
    const body = ((await row.locator(".scrollback-body").textContent()) ?? "").trim();
    expect(body.length).toBeGreaterThan(0);
    expect(selected).toContain(body);

    peer.privmsg(ELSEWHERE, `issue2418 traffic elsewhere ${Date.now()}`);
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, ELSEWHERE)).toBeVisible({
      timeout: 15_000,
    });

    expect(await rowNode.evaluate((el) => el.isConnected)).toBe(true);
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe(selected);
  } finally {
    await peer.disconnect("issue2418 done");
    await partChannel(user.token, NETWORK_SLUG, ELSEWHERE).catch(() => {});
  }
});
