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

import { expect, test } from "../fixtures/test";
import { loginAs, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// The synthetic pseudo-window channel segments, URL-encoded as they appear
// on the wire ($ → %24). $server is deliberately absent: it is a real
// scrollback-backed target the server accepts (200), not a fail2ban hazard.
const VIRTUAL_SEGMENTS = ["%24home", "%24admin", "%24list"];

test.describe("#160 virtual-tab read-cursor suppression", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  test.afterAll(async () => {
    if (!CHANNEL) return;
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("#160 selecting Home after a real channel emits no virtual read-cursor POST and no 4xx", async ({
    page,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();

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
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThan(0);

    // Select the Home tab — disposes the ScrollbackPane. Pre-fix, the
    // onCleanup POSTed a read-cursor for $home (404).
    await page.getByRole("button", { name: "Home", exact: true }).click();
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
