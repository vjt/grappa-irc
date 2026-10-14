// #160 — selecting a virtual/synthetic tab must NOT emit a read-cursor
// POST for a pseudo-window that has no server-side channel row.
//
// The Home tab ($home), admin tab ($admin) and channel-directory ($list)
// are pseudo-windows. A `POST .../channels/$home/read-cursor` 404s (unknown
// network slug) or 400s ($list — invalid target name). In production nginx
// feeds those 4xx to fail2ban's http-4xx jail; a normal user idling on the
// Home tab accumulates 404s and gets escalated into the `recidive` pf block
// — cut off from web AND IRC at the network layer. This already hard-banned
// a legit beta user.
//
// Root-cause leak: ScrollbackPane is one shared instance whose props are
// reactive getters bound to selectedChannel(). Selecting Home disposes the
// pane; its onCleanup reads props.channelName — by then already "$home" —
// and POSTed the cursor there. So the repro requires being on a REAL
// channel (pane mounted, visible tail row) BEFORE switching to Home.
//
// This guard watches the network: after real-channel → Home it asserts that
// (a) no read-cursor POST targeted a virtual pseudo-window name, and (b) no
// read-cursor POST returned 4xx (the fail2ban trigger). RED before the
// setReadCursor guard (a $home 404 is captured); GREEN after.

import { loginAs, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const RUN_ID = crypto.randomUUID().slice(0, 8);
const CONTROL_PEER_NICK = "i160-ctlbuddy";

// The synthetic pseudo-window channel segments, URL-encoded as they appear
// on the wire ($ → %24). $server is deliberately absent: it is a real
// scrollback-backed target the server accepts (200), not a fail2ban hazard.
const VIRTUAL_SEGMENTS = ["%24home", "%24admin", "%24list"];

test.describe("#160 virtual-tab read-cursor suppression", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  test("#160 selecting Home after a real channel emits no virtual read-cursor POST and no 4xx", async ({
    page,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = specUser();

    // Record every read-cursor POST the client emits, with url + status.
    const cursorPosts: Array<{ url: string; status: number }> = [];
    page.on("response", (resp) => {
      const req = resp.request();
      if (req.method() === "POST" && resp.url().includes("/read-cursor")) {
        cursorPosts.push({ url: resp.url(), status: resp.status() });
      }
    });

    await loginAs(page, vjt);

    // Be on a real channel first: pane mounted with a visible tail row —
    // the precondition for the onCleanup leak.
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThan(0);

    // Positive control (#1117) — armed BEFORE the stimulus under test, so
    // both assertions below are read against a recorder proven to see.
    // Absence is only evidence once presence has been demonstrated through
    // the SAME `page.on("response")` predicate: a typo in it, or a listener
    // attached after the traffic, leaves `cursorPosts` empty and every
    // filter of it trivially `[]`. The stimulus POSTs for the REAL channel
    // and is neither virtual nor 4xx, so it disturbs neither assertion.
    //
    // A PEER row followed by a switch to the real `$server` window, NOT an
    // own send. Since issue 2407 the server advances the cursor on an own
    // send and fans `read_cursor_set` out, which can reach cic before the
    // 201 — and then cic's own POST is skipped as non-advancing (measured on
    // PR #2414, where the sibling ux-5-bu control went red on that race).
    // The server never moves the cursor for someone else's row, so the
    // pane's leave arm (or the scroll-settle after the arrival) must POST.
    const peer = await IrcPeer.connect({ nick: CONTROL_PEER_NICK });
    try {
      await peer.join(CHANNEL);
      const controlBody = `#160 recorder control ${RUN_ID}`;
      peer.privmsg(CHANNEL, controlBody);
      await expect(
        page.locator('[data-testid="scrollback-line"]', { hasText: controlBody }),
      ).toBeVisible({ timeout: 5_000 });
      await selectChannel(page, NETWORK_SLUG, "Server", { awaitWsReady: false });
      const realSegment = `/channels/${encodeURIComponent(CHANNEL)}/read-cursor`;
      await expect
        .poll(() => cursorPosts.filter((p) => p.url.includes(realSegment)).length, {
          timeout: 5_000,
        })
        .toBeGreaterThan(0);
    } finally {
      await peer.disconnect("#160 control done");
    }

    // Back on the real channel, with its tail row visible: the same
    // precondition the stimulus below was written against.
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

    // Select the Home tab — disposes the ScrollbackPane. Pre-fix, the
    // onCleanup POSTed a read-cursor for $home (404).
    await page.getByRole("button", { name: "home", exact: true }).click();
    // Past the scroll-settle debounce (500ms) + POST round-trip slop.
    await page.waitForTimeout(1200);

    const virtualPosts = cursorPosts.filter((p) =>
      VIRTUAL_SEGMENTS.some((seg) => p.url.includes(`/channels/${seg}/read-cursor`)),
    );
    expect(
      virtualPosts,
      `read-cursor POST(s) emitted for virtual pseudo-window(s): ${JSON.stringify(virtualPosts)}`,
    ).toEqual([]);

    const fourxx = cursorPosts.filter((p) => p.status >= 400);
    expect(
      fourxx,
      `read-cursor POST(s) returned 4xx (fail2ban trigger): ${JSON.stringify(fourxx)}`,
    ).toEqual([]);
  });
});
