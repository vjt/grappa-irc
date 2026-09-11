// channel-directory — e2e channel directory browse + join (#84)
//
// What this spec asserts:
//   1. The 📇 channels ($list) sidebar row opens DirectoryPane.
//   2. The server-issued LIST populates the directory; a peer-created
//      channel (PEER_CHANNEL) and the seeded autojoin channel (#spec-wN)
//      both appear after clicking Refresh.
//   3. Selecting the $list window fires NO GET /messages request
//      (grappa-irc#81: kindHasScrollback("list") === false).
//   4. Typing in the search box filters results to matching channels
//      (server-side query re-GET; server returns only matching entries), and
//      a term matching NOTHING renders the issue-2046 `no_results` line with
//      the snapshot's capture time still on screen.
//   5. Clicking a channel's join control adds it to the sidebar AND
//      foregrounds its window (#244 — a user-initiated directory tap now
//      JOINs and selects the new window, amending #125's no-auto-open).
//      The in-row "joined" badge is unit-covered (DirectoryPane.test.tsx);
//      it can't be asserted here because the foreground unmounts the pane.
//
// Why peer stays connected: bahamut only includes non-empty channels in
// LIST replies. The peer must remain joined in PEER_CHANNEL for the
// duration of the LIST cycle, or the channel won't appear in the 322s
// grappa captures.
//
// Cleanup: PART PEER_CHANNEL via REST in afterEach so the
// autojoin-persistence side-effect from the one-click-join step
// doesn't bleed into subsequent runs. The global _vjtReset fixture
// (from fixtures/test) also resets autojoin to AUTOJOIN_CHANNELS
// after every test.

import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

// "$list" — LIST_WINDOW_NAME from src/lib/windowKinds.ts, mirrored rather than
// imported to keep src VALUES out of the e2e runtime graph (see the header of
// fixtures/grappaApi.ts). NOT because "the e2e tsconfig does not resolve src/
// imports", which is what this comment said until #1646 and is false: that same
// fixture type-imports from src and `tsc -p e2e/tsconfig.json` is green.
// The copy is pinned — src/__tests__/e2eConstantMirrors.test.ts fails if either
// side moves.
const LIST_WINDOW_NAME = "$list";

// Unique channel per run: avoids persistent state bleed across
// test retries and parallel runs on the same testnet DB.
// crypto.randomUUID() is available in the Node.js e2e context.
const PEER_CHANNEL = `#e2edir-${crypto.randomUUID().slice(0, 8)}`;

test.afterEach(async () => {
  // PART PEER_CHANNEL server-side even on failure so the next run
  // starts clean. Idempotent: 404 if the channel was never joined.
  const vjt = specUser();
  await partChannel(vjt.token, NETWORK_SLUG, PEER_CHANNEL).catch(() => {});
});

test("channel-directory — browse, no /messages fetch (#81 guard), search filter, one-click join", async ({
  page,
}) => {
  const vjt = specUser();

  // Connect an IRC peer and join PEER_CHANNEL so it exists in bahamut
  // before grappa issues LIST. The peer stays connected for the whole
  // test so the channel is non-empty in bahamut's 322 replies.
  const peer = await IrcPeer.connect({
    nick: `e2edir-${crypto.randomUUID().slice(0, 4)}`,
  });
  try {
    await peer.join(PEER_CHANNEL);

    await loginAs(page, vjt);

    // Focus #spec-wN and wait for its scrollback to land so the initial
    // GET /messages for the autojoin channel has already fired BEFORE
    // we arm the request collector.
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], {
      ownNick: specNick(),
    });

    // Arm the /messages request collector from this point forward, SCOPED
    // to the $list window under test (#534/#653). The regression the #81
    // guard catches — a kindHasScrollback("list") slip — would fetch
    // scrollback for the SELECTED window, i.e. cic's listMessages hits
    // GET .../channels/%24list/messages (encodeURIComponent("$list")).
    // Record ONLY that path: an unrelated forward gap-fill on the live
    // autojoin #spec-wN (.../channels/%23spec-wN/messages?after=...) is legitimate
    // background activity — a peer is connected and seed traffic is real —
    // NOT the regression, and under full-gate load it can fire inside this
    // window and trip a global-zero collector (the load-only flake).
    // Keying on the $list channel segment keeps the assertion STRICT (a
    // genuine $list scrollback fetch still reds it below) while making it
    // deterministic — this is NOT a toHaveLength(<=1) relaxation nor a
    // blanket substring filter that would blind the guard.
    // Recorded WIDE (every `/messages` request) and filtered NARROW at each
    // assertion — #1117. A collector armed on the $list path alone can only
    // ever be empty here, so its emptiness proves nothing: the same `[]`
    // comes out of a mistyped path, a listener attached after the traffic,
    // or a handler on the wrong page. Widening costs the guard nothing —
    // the assertion below still filters to the $list path, so a genuine
    // $list scrollback fetch still reds it — and it buys a positive control
    // at the end of the test, where the joined channel's own GET proves
    // this recorder sees `/channels/<enc>/messages` when one is issued.
    const listMessagesPath = `/channels/${encodeURIComponent(LIST_WINDOW_NAME)}/messages`;
    const messagesRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/messages")) {
        messagesRequests.push(url);
      }
    });

    // Open the 📇 channels directory window for this network.
    // sidebarWindow resolves `li[data-window-name="$list"]` on
    // desktop; .sidebar-window-btn is the clickable button inside it.
    await sidebarWindow(page, NETWORK_SLUG, LIST_WINDOW_NAME)
      .locator(".sidebar-window-btn")
      .click();

    // DirectoryPane is now mounted. The search box and Refresh button
    // render outside the <Show when={page()}> guard and are immediate.
    await expect(page.locator(".directory-search")).toBeVisible({
      timeout: 5_000,
    });
    const refreshBtn = page.locator(".directory-refresh");
    await expect(refreshBtn).toBeVisible({ timeout: 5_000 });

    // (3) Assert NO /messages request was fired for the $list window
    // selection. Checked here — before any join that would legitimately
    // trigger GET /messages for the newly-joined channel window.
    expect(
      messagesRequests.filter((url) => url.includes(listMessagesPath)),
      "GET /messages must NOT fire when selecting kind=list — grappa-irc#81 guard",
    ).toHaveLength(0);

    // Force a fresh server-side LIST so PEER_CHANNEL (just created
    // above) is captured even if a stale snapshot already exists.
    await refreshBtn.click();

    // (2a) PEER_CHANNEL appears in the directory. Generous timeout:
    // the LIST → Session.Server 322 capture → 323 → progress ping
    // → cic re-GET round-trip is fully async; allow 15 s.
    const peerRow = page.locator(".directory-row-join").filter({ hasText: PEER_CHANNEL });
    await expect(peerRow).toBeVisible({ timeout: 15_000 });

    // (2b) The seeded autojoin channel also appears.
    const bofhRow = page.locator(".directory-row-join").filter({ hasText: AUTOJOIN_CHANNELS[0] });
    await expect(bofhRow).toBeVisible({ timeout: 5_000 });

    // (4) Search filter: typing the unique fragment ("e2edir") routes a
    // server-side query re-GET. Only PEER_CHANNEL should match;
    // AUTOJOIN_CHANNELS[0] (#spec-wN) should be absent.
    await page.locator(".directory-search").fill("e2edir");
    await expect(peerRow).toBeVisible({ timeout: 5_000 });
    await expect(bofhRow).toBeHidden({ timeout: 5_000 });

    // (4b) issue 2046 — a search that matches NOTHING is its own state on
    // the wire (`no_results`), and the pane must say so. Before this the
    // server answered `empty` — the same value it used for "this network was
    // never LISTed" — and the pane rendered a blank box. Asserted here
    // against the real bahamut snapshot rather than a fixture, because the
    // half that matters is the second one: the capture time must SURVIVE the
    // miss. A `never` here would mean the envelope forgot the snapshot the
    // search just ran against, which is the same class of lie as the skew
    // this issue is about.
    await page.locator(".directory-search").fill("zzz-no-such-channel-2046");
    const emptyLine = page.locator(".directory-empty");
    await expect(emptyLine).toHaveText(/no channels match/i, { timeout: 5_000 });
    await expect(peerRow).toBeHidden({ timeout: 5_000 });
    await expect(page.locator(".directory-captured-at")).not.toHaveText(/never/i, {
      timeout: 5_000,
    });

    // Clear the filter so all rows are back before the join step.
    await page.locator(".directory-search").fill("");
    await expect(bofhRow).toBeVisible({ timeout: 5_000 });
    // The empty line is not a fixture of the pane: with rows back it is gone.
    // Without this the assertion above would also pass on a pane that printed
    // it unconditionally.
    await expect(emptyLine).toHaveCount(0);

    // (5) One-click join: assert PEER_CHANNEL is not yet in the sidebar,
    // click its join control, then assert the sidebar gains an entry
    // (mirrors m8: sidebarWindow toHaveCount(1)).
    await expect(sidebarWindow(page, NETWORK_SLUG, PEER_CHANNEL)).toHaveCount(0);
    await peerRow.click();
    await expect(sidebarWindow(page, NETWORK_SLUG, PEER_CHANNEL)).toHaveCount(1, {
      timeout: 10_000,
    });

    // #244 — a user-initiated directory tap now JOINs *and* foregrounds
    // the new channel's window (amends #125's original no-auto-open). So
    // the tap flips selKind() list → channel, unmounting DirectoryPane;
    // the `.directory-row-badge` (a DirectoryPane-only element) is no
    // longer observable in a mounted pane. Assert the foreground signal
    // instead: the newly-joined channel is the SELECTED sidebar window.
    // The badge itself is unit-covered in DirectoryPane.test.tsx; the
    // foreground behaviour is the #244 P0 fix, covered end-to-end in
    // issue244-directory-tap-foreground.spec.ts.
    await expect(sidebarWindow(page, NETWORK_SLUG, PEER_CHANNEL)).toHaveClass(/selected/, {
      timeout: 10_000,
    });

    // Positive control for the #81 guard above (#1117). The foregrounded
    // channel hydrates its scrollback, which is exactly the request shape
    // the guard forbids for $list — same recorder, same `/messages`
    // predicate, only a different channel segment. If this stays empty the
    // recorder was blind and the `toHaveLength(0)` above was vacuous.
    const peerMessagesPath = `/channels/${encodeURIComponent(PEER_CHANNEL)}/messages`;
    await expect
      .poll(() => messagesRequests.filter((url) => url.includes(peerMessagesPath)).length, {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
  } finally {
    await peer.disconnect("e2e channel-directory done");
  }
});
