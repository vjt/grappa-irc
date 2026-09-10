// #156 — in-pane unread divider when unread ≫ the initial fetch window.
//
// Root cause this pins: `loadInitialScrollback` (scrollback.ts) fetched a
// TAIL-ONLY page — the server's newest ~50 rows — with no `before`/
// `after`. When the read cursor is OLDER than the oldest row in that tail
// page (i.e. unread exceeds the window), the divider's anchor (the last-
// read row + the first-unread row) is never loaded. The in-pane
// `── XX unread messages ──` marker then slams to the TOP of the pane
// with a window-sized count (~50) and NO read-context above it — or fails
// to inject at all.
//
// The fix: when a read cursor exists, fetch the region AROUND it —
// `listMessagesAfter(cursor, 200)` (the unread region) + a before-context
// page `listMessages(cursor + 1)` (the last-read row + context above the
// divider). The divider then lands BETWEEN the last-read and first-unread
// rows, with read-context visible above it, and the count is the true
// unread (capped at the 200 server max).
//
// This spec is RED against the unmodified tail-only load: the early
// last-read row is not in the tail page, so neither it nor a correctly-
// placed marker appears in the DOM.
//
// Per BUGHUNT-3 cascade rule: this spec rewinds the seeded vjt's #spec-wN
// cursor to an early row, so it MUST restore to tail in afterAll or
// downstream specs inherit a mid-list cursor → marker injects → scroll
// lands mid-pane → cascade.

import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { fetchAllMessagesAsc, setReadCursorToId } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Presence kinds — NOT counted toward the unread-marker, whoever sent them.
// Used only to DERIVE the expected count from server data; it is not the
// behaviour under test.
//
// issue 2069 widened this from OWN presence to ALL presence. The marker's
// label says "messages" and now counts messages, so a PEER join/part in the
// run is excluded too; before, this derivation happened to agree only because
// the seeded run is contiguous privmsgs plus the operator's own auto-JOIN, and
// it would have started lying the first time another spec's peer touched the
// channel ahead of this one.
const PRESENCE_KINDS = new Set(["join", "part", "quit", "nick_change", "mode", "kick"]);

test.describe("#156 unread divider with unread beyond the fetch window", () => {
  test("anchors the divider between last-read and first-unread with context above", async ({
    page,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = specUser();

    // Learn the seeded #bofh id range (the seeder plants 200 lines). Page
    // back oldest-first so the cursor can be planted well below the tail
    // window without hardcoding ids.
    const rows = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, CHANNEL);
    // Sanity: the seed must dwarf the ~50-row window for the bug to bite.
    expect(rows.length).toBeGreaterThanOrEqual(130);

    // Plant the cursor 120 rows from the tail: unread (~119) ≫ the ~50
    // window (the bug bites) AND < 200 (the after-cap doesn't blur the
    // count, so the marker shows the EXACT true unread). The last-read row
    // sits far outside the newest-50 tail page, so pre-fix it is absent.
    const cursorIndex = rows.length - 120;
    const lastReadRow = rows[cursorIndex];
    const firstUnreadRow = rows[cursorIndex + 1];
    // A read-context row a few rows ABOVE the last-read one — comfortably
    // inside the ~50-row before-context page the fix loads, yet far
    // outside the newest-50 tail page (so pre-fix it is also absent). NOT
    // the absolute oldest row: the before page is a single ~50-row page,
    // not the full history (scroll-up `loadMore` pages further back).
    const readContextRow = rows[cursorIndex - 10];
    if (!lastReadRow || !firstUnreadRow || !readContextRow) {
      throw new Error("#156 spec: seeded #spec-wN rows missing expected indices");
    }

    // True unread = MESSAGE rows after the cursor, mirroring the in-pane
    // marker's own predicate: presence rows are excluded whoever sent them
    // (issue 2069), and so are the operator's own messages (#576). Operator-
    // action echoes don't occur in the pure seed.
    const expectedUnread = rows.filter(
      (r) =>
        r.id > lastReadRow.id &&
        !PRESENCE_KINDS.has(r.kind) &&
        r.sender.toLowerCase() !== specNick().toLowerCase(),
    ).length;
    // Guard the chosen window: exact count requires staying under the cap.
    expect(expectedUnread).toBeGreaterThan(60);
    expect(expectedUnread).toBeLessThan(200);

    // Plant the early cursor BEFORE login so the channel hydrates with it.
    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, lastReadRow.id);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

    const scrollbackLine = (id: number) =>
      page.locator(`[data-testid="scrollback-line"][data-msg-id="${id}"]`);
    const marker = page.locator('[data-testid="unread-marker"]');

    // ── Anchor present (RED pre-fix: tail-only load lacks these) ────────
    // The last-read row and the first-unread row are both loaded.
    await expect(scrollbackLine(lastReadRow.id)).toBeVisible({ timeout: 10_000 });
    await expect(scrollbackLine(firstUnreadRow.id)).toBeVisible();
    // Read-context above the divider: a row above the last-read one is
    // loaded (the before-context page), so the operator sees what they'd
    // already read — not a divider slammed to the pane top.
    await expect(scrollbackLine(readContextRow.id)).toBeVisible();

    // ── Divider correctly placed ────────────────────────────────────────
    await expect(marker).toBeVisible();
    // The marker is the row IMMEDIATELY AFTER the last-read row (the seed
    // is contiguous privmsgs, so no excluded row sits between them).
    await expect(
      scrollbackLine(lastReadRow.id).locator("xpath=following-sibling::*[1]"),
    ).toHaveAttribute("data-testid", "unread-marker");
    // …and the first-unread row is the row IMMEDIATELY AFTER the marker.
    await expect(marker.locator("xpath=following-sibling::*[1]")).toHaveAttribute(
      "data-msg-id",
      String(firstUnreadRow.id),
    );

    // ── Count is the TRUE unread, not the window size ───────────────────
    await expect(page.locator(".scrollback-unread-marker-label")).toHaveText(
      `${expectedUnread} unread messages`,
    );
  });
});
