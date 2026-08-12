// UX-6 bucket G (2026-05-21) — admin tables on mobile render the
// horizontal scrollbar but ignore the iOS pan-x gesture (vjt iPhone
// dogfood: "horiz content, scrollbar, but content doesn't move").
//
// Root cause was `.admin-pane`'s `touch-action: pan-y` (a UX-5 BO carve-out
// against the `.shell-mobile { touch-action: none }` blanket) clamping the
// ancestor INTERSECTION so a child's `pan-x` could never take effect. The
// gesture PERMISSION half of that fix is still asserted below, verbatim.
//
// #1157 REPLACED the other half, and the spec has to be read as a whole to
// see why. The 2026-05 fix, and #1074 after it, both took for granted that a
// phone SHOULD pan a wide admin table, and argued only about which element
// owns the scroll. vjt reversed the premise after dogfooding 0.15.0: the pan
// is what goes. Rows become cards below 900px, and there is nothing wide
// left to travel across.
//
// That reversal forced a new oracle, because the old one had stopped
// watching. It looped `["visitors", "sessions", "networks"]` but gated the
// width assertion on `DETERMINISTIC_POPULATED_TAB = "networks"`, with a
// comment conceding that Visitors and Sessions were empty in the baseline
// seed and "would pass the fits-the-panel check trivially". So it measured
// ONE tab, the only one vjt did not ask to change — and `"visitors"` does
// not exist any more.
//
// The replacement is a claim no relocation of the scroller can satisfy: at
// 393px, on EVERY surface (#1224 — tabs AND the sub-pages that open from
// inside one), no scroll container inside the admin pane may have
// `scrollWidth > clientWidth`. Moving `overflow-x` one level in or out —
// the exact trap the deleted CSS comment documented, and the thing #1074
// did — fails it, because the offender is reported wherever it lands.
//
// Restricted to containers whose computed `overflow-x` is `auto` or
// `scroll`, which is precisely the set that CAN pan. Not every overflowing
// box: an inline element reports `clientWidth: 0` and would false-positive
// on any text at all, and `overflow: hidden` is a deliberate idiom here
// (`.adm-table-truncate` clips to an ellipsis with the full value on a
// `title`), so flagging it would fail on a feature.
//
// Seeded rather than trusted: an empty tab cannot overflow, which is how
// the old spec came to be green while watching nothing. The arrange block
// mints a visitor (a Sessions row on top of the four seeded credentials)
// and creates a vhost (a Vhosts row, the tab vjt called "un puttanaio"),
// and both are torn down in `finally`.
//
// Per `feedback_e2e_user_class_parity_matrix`: AdminPane is admin-gated
// (EXEMPT). This spec runs the admin arm only; non-admin can't reach the
// surface at all.
//
// Seed shape: same as UX-6-C — PATCH the seeded `vjt` user to admin
// via admin-vjt bearer at test start, revert in afterEach. admin-vjt
// has no IRC bind (m9b session-count == 2 hardcode); vjt has the bind
// + autojoined #bofh so it can reach the mobile launcher footer.

import type { Page } from "@playwright/test";
import { loginAs, openRailMenu, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { listSessionLogSessions, mintVisitor, reapVisitors } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededAdmin, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const GRAPPA_BASE_URL = "http://grappa-test:4000";

// Every tab AdminPane mounts (`TABS` in AdminPane.tsx).
const ADMIN_TABS = [
  "sessions",
  "events",
  "session_log",
  "networks",
  "vhosts",
  // #1158 — no `credentials` entry: the Credentials tab is gone as an
  // operator surface, its job moved onto the per-user page behind Users.
  // The claim below is "no admin tab pans sideways", so this list has to be
  // the tabs that EXIST — a stale name here reads as a 3-minute tap timeout,
  // not as a missing tab.
  "users",
  "settings",
  "debug",
] as const;

// #1224 — the width oracle enumerates SURFACES, not tabs.
//
// This comment used to say "the pan is a property of the pane, not of the
// three tabs that happened to have tables" and then loop the tab list. Both
// halves were true when written and the second stopped being true: a tab is
// not the only thing the pane shows. `AdminUsersTab` has opened
// `AdminUserPage` from inside the Users panel since #1158 (which is where
// the Credentials tab went), and #1224 added the ended-sessions page behind
// the Sessions card header. Two full-pane surfaces with tables, at 393px,
// that a loop over `ADMIN_TABS` structurally cannot reach — the guard had
// quietly become a list of the places that existed when it was written.
//
// So the list of TABS stays (it is what the touch-action tests below are
// about — `#admin-tab-<key>` is a real element with a real CSS contract),
// and the width claim moves onto this list of surfaces instead.
//
// 🔴 Why the sub-page half is still hand-written, and what would fix it.
// A surface is discoverable once you are ON it — both sub-pages render
// `.adm-subpage-head`. A DOOR is not: `admin-sessions-ended-open` is a
// static testid on a card-header button, `admin-user-networks-<id>` is a
// per-row button in an actions cell, they share no convention, and the
// cells they sit in also hold Delete. There is nothing a crawl could press
// safely and nothing a selector could match honestly. Giving every door one
// marker attribute would make this list derive itself; until then the
// completeness assertion below covers the TAB half automatically, and a new
// sub-page needs a line here. That is a real gap, stated rather than
// papered over — a comment that claims coverage it does not have is exactly
// how this one went stale.
type Surface = {
  name: string;
  open: (page: Page) => Promise<void>;
};

async function openTab(page: Page, tab: string): Promise<void> {
  await page.getByTestId(`admin-tab-${tab}`).tap();
  await expect(page.locator(`#admin-tab-${tab}`)).toBeVisible({ timeout: 10_000 });
}

// Takes the subject's id because the user page is per-user and only one
// user will do: its networks TABLE renders under `mine().length > 0`, and
// the seeded `admin-vjt` — which `.first()` reaches, being row one — has no
// IRC bind, so it shows the empty state and the surface would be measured
// with nothing on it. `vjt` has the bind. Measured, not assumed: `.first()`
// is what the first run of this extension did, and the barrier caught it.
function adminSurfaces(vjtUserId: string): Surface[] {
  return [
    ...ADMIN_TABS.map((tab) => ({
      name: `tab:${tab}`,
      open: (page: Page) => openTab(page, tab),
    })),
    {
      name: "subpage:ended-sessions",
      open: async (page: Page) => {
        await openTab(page, "sessions");
        await page.getByTestId("admin-sessions-ended-open").tap();
        await expect(page.getByTestId("admin-ended-sessions-page")).toBeVisible({
          timeout: 10_000,
        });
        // Anti-hollow-green: measure a POPULATED page or fail here. An
        // empty-state card cannot overflow and would pass on nothing.
        await expect(page.getByTestId("admin-ended-sessions-table")).toBeVisible({
          timeout: 10_000,
        });
      },
    },
    {
      name: "subpage:user-page",
      open: async (page: Page) => {
        await openTab(page, "users");
        await page.getByTestId(`admin-user-networks-${vjtUserId}`).tap();
        await expect(page.getByTestId("admin-user-page")).toBeVisible({ timeout: 10_000 });
        await expect(page.getByTestId("admin-user-networks-card")).toBeVisible({
          timeout: 10_000,
        });
      },
    },
  ];
}

test.setTimeout(180_000);

type Offender = {
  surface: string;
  tag: string;
  testId: string | null;
  cls: string;
  scrollW: number;
  clientW: number;
};

async function findVjtUserId(adminToken: string): Promise<string> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/users`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) {
    throw new Error(`GET /admin/users → ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { users: { id: string; name: string }[] };
  const vjt = body.users.find((u) => u.name === specUser().name);
  if (!vjt) {
    throw new Error(`vjt user not found in admin users list: ${JSON.stringify(body)}`);
  }
  return vjt.id;
}

async function setAdminFlag(adminToken: string, userId: string, isAdmin: boolean): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ is_admin: isAdmin }),
  });
  if (!res.ok) {
    throw new Error(
      `PATCH /admin/users/${userId} is_admin=${isAdmin} → ${res.status} ${await res.text()}`,
    );
  }
}

// A Vhosts row to measure. Mirrors issue252's candidate rule: the address
// must be one with no vhost row yet, or the create 409s.
async function createSeedVhost(adminToken: string): Promise<number | null> {
  const idx = await fetch(`${GRAPPA_BASE_URL}/admin/vhosts`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!idx.ok) throw new Error(`GET /admin/vhosts → ${idx.status}`);
  const body = (await idx.json()) as {
    host_candidates: string[];
    vhosts: { address: string }[];
  };
  const configured = new Set(body.vhosts.map((v) => v.address));
  const address = body.host_candidates.find((a) => !configured.has(a));
  // Already-configured is fine: the tab has a row either way, which is all
  // this spec needs. Only a total absence of candidates is worth a null.
  if (address === undefined) return null;
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/vhosts`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ address, generally_available: true }),
  });
  if (!res.ok) throw new Error(`POST /admin/vhosts ${address} → ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: number }).id;
}

// A row on the ended-sessions sub-page. The only thing that puts one there
// is a session the lifecycle log remembers whose subject no longer exists
// (#1158 item 4), so this mints a visitor, waits for the sink to write its
// row, then destroys the identity — the same arrange `issue1158-item4` uses.
// No teardown: the subject is already gone, and the log row is the point.
async function seedEndedSession(adminToken: string): Promise<void> {
  const visitor = await mintVisitor(`ux6g-ended-${Date.now()}`);
  const prefix = `visitor:${visitor.id}:`;
  await expect
    .poll(
      async () =>
        (await listSessionLogSessions(adminToken)).filter((e) => e.session_id.startsWith(prefix))
          .length,
      {
        timeout: 20_000,
        message: `precondition: session_log never recorded ${prefix}* — the ended-sessions surface cannot be populated, so measuring it would prove nothing`,
      },
    )
    .toBeGreaterThan(0);
  await reapVisitors(adminToken, visitor.id);
}

async function deleteSeedVhost(adminToken: string, id: number | null): Promise<void> {
  if (id === null) return;
  await fetch(`${GRAPPA_BASE_URL}/admin/vhosts/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${adminToken}` },
  }).catch(() => undefined);
}

test.describe("UX-6-G — admin pane horizontal scroll on mobile", () => {
  let vjtUserId: string;

  // beforeEACH, not beforeAll: the subject is per-test (#1078), so its
  // user id has to be resolved per test — a once-per-file lookup would
  // hold the id of a user that no longer exists.
  test.beforeEach(async () => {
    const admin = getSeededAdmin();
    vjtUserId = await findVjtUserId(admin.token);
  });

  test.afterEach(async () => {
    const admin = getSeededAdmin();
    await setAdminFlag(admin.token, vjtUserId, false);
  });

  async function openAdminPane(page: Page): Promise<void> {
    const admin = getSeededAdmin();
    await setAdminFlag(admin.token, vjtUserId, true);

    const vjt = specUser();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

    await page.getByLabel(/open members sidebar/i).tap();
    // #500 — the admin button lives behind the rail launcher menu now.
    await openRailMenu(page);
    await page.locator(".rail-actions-menu [data-testid='mobile-panel-admin']").tap();
    await expect(page.getByTestId("admin-pane")).toBeVisible({ timeout: 5_000 });
  }

  test("@webkit admin on mobile — no surface can be panned sideways", async ({ page }) => {
    const admin = getSeededAdmin();
    const visitor = await mintVisitor(`ux6g-${Date.now()}`);
    let vhostId: number | null = null;

    try {
      vhostId = await createSeedVhost(admin.token);
      // A row on the ended-sessions sub-page, by the only route that makes
      // one: a session the log remembers whose subject is gone. Without it
      // that surface renders an empty-state card and measuring it would be
      // the very "an empty tab cannot overflow" pass this spec was rewritten
      // to stop doing.
      await seedEndedSession(admin.token);
      await openAdminPane(page);

      // The TAB half of the surface list maintains itself: a tab added to
      // `TABS` without a line here fails on the count rather than going
      // unmeasured. The sub-page half cannot (see the note on `Surface`).
      await expect(
        page.getByTestId("admin-pane").locator("[role='tab']"),
        "a tab exists that the surface list does not name — add it to ADMIN_TABS",
      ).toHaveCount(ADMIN_TABS.length);

      const offenders: Offender[] = [];

      for (const surface of adminSurfaces(vjtUserId)) {
        await surface.open(page);

        // The pane, not just the panel: the pre-#1157 arrangement made the
        // PANEL the scroller, and a future one could push it further out.
        const found = await page.getByTestId("admin-pane").evaluate((root) => {
          const out: Omit<Offender, "surface">[] = [];
          const consider = (el: Element): void => {
            // 🔴 NAMED EXEMPTION — restored on purpose, by whom and when:
            // vjt, on the 2026-08-12 retest of `e0ef575c`, filing #1244.
            // *"la top bar che faceva hor scroll andava bene — mo sto wrap
            // leva spazio"*, and on the issue itself: *"that call was mine
            // and it was wrong"*.
            //
            // The history matters, because this exemption was deleted for
            // a good reason and is coming back for a different one. #1223
            // removed it as an oracle that could not fail: it was written
            // as a product argument ("a navigation affordance an operator
            // swipes to CHOOSE a tab ... not a record whose columns you
            // must pan to READ"), it exempted the one box that was
            // actually panning, and it carried its own escape hatch — "if
            // it is ever meant to be in scope, that is a separate product
            // call". An exemption phrased that way is indistinguishable
            // from one written to make a red go away.
            //
            // What is different now is the cost, measured on the device
            // rather than argued: wrapping the eight chips puts them on
            // two rows, and the second row is 44px of a 440px screen
            // spent on navigation, on every tab. #1244 is the issue about
            // exactly that budget. vjt has now seen both layouts on the
            // phone and chosen the pan.
            //
            // And it is no longer unfalsifiable. `the tab strip is one
            // row, and it pans` below asserts the strip does the thing
            // this line waves through — so removing the pan turns a test
            // red instead of quietly widening the exemption into a hole.
            // A documented exemption with a guard on the exempted
            // behaviour is a decision; a silent one is a defect.
            if (el.classList.contains("adm-nav")) return;
            const overflowX = window.getComputedStyle(el).overflowX;
            if (overflowX !== "auto" && overflowX !== "scroll") return;
            if (el.scrollWidth <= el.clientWidth + 1) return;
            out.push({
              tag: el.tagName.toLowerCase(),
              testId: el.getAttribute("data-testid"),
              cls: String((el as HTMLElement).className ?? "").slice(0, 90),
              scrollW: el.scrollWidth,
              clientW: el.clientWidth,
            });
          };
          consider(root);
          for (const el of root.querySelectorAll("*")) consider(el);
          return out;
        });

        offenders.push(...found.map((o) => ({ ...o, surface: surface.name })));
      }

      expect(
        offenders,
        `nothing in the admin pane may be pannable at 393px, on any surface — ` +
          `offenders: ${JSON.stringify(offenders, null, 2)}`,
      ).toEqual([]);
    } finally {
      await deleteSeedVhost(admin.token, vhostId);
      await reapVisitors(admin.token, visitor.id);
    }
  });

  test("@webkit admin on mobile — the pane still permits pan-x", async ({ page }) => {
    await openAdminPane(page);

    // Kept from the original fix and deliberately NOT deleted along with
    // the overflow it was paired to. Nothing needs to pan any more, but a
    // pane that REFUSES a horizontal gesture is the bug this bucket was
    // opened for, and a future hand re-tightening either declaration back
    // to `pan-y` would silently restore it. Cheap to keep, and it fails on
    // a cause the width oracle above cannot see.
    const paneTouch = await page
      .getByTestId("admin-pane")
      .evaluate((el) => window.getComputedStyle(el).touchAction);
    expect(paneTouch, "admin-pane touch-action must allow pan-x").toMatch(/pan-x/);

    for (const tab of ADMIN_TABS) {
      await page.getByTestId(`admin-tab-${tab}`).tap();
      const panel = page.locator(`#admin-tab-${tab}`);
      await expect(panel).toBeVisible({ timeout: 10_000 });
      const panelTouch = await panel.evaluate((el) => window.getComputedStyle(el).touchAction);
      expect(panelTouch, `admin-tab-panel(${tab}) touch-action must allow pan-x`).toMatch(/pan-x/);
    }
  });

  // #1244 — the guard ON the exemption above, and the reason restoring it
  // is a decision rather than a hole.
  //
  // It replaces `every tab chip is on screen, none cut off`, which was
  // #1223's symptom 4 and asserted the opposite: that no chip is cut at
  // the right edge, i.e. that the strip does not pan. vjt reverted that
  // call on the 2026-08-12 retest — the wrap costs a full 44px row of a
  // 440px screen, which is the budget #1244 exists to win back — so the
  // old assertion is not weakened here, it is contradicted, and it goes.
  //
  // What takes its place is the shape he asked for, stated so that
  // undoing it turns something red: ONE row, and pannable. The two halves
  // fail to different mutations, which is why they are both here — a
  // strip switched to `overflow-x: hidden` stays one row and stops
  // panning (chips clipped, unreachable), and a strip given `flex-wrap:
  // wrap` stops being one row. Neither is visible to the width oracle
  // above: the first because a `hidden` box is not in its scope, the
  // second because a wrapped strip does not overflow.
  test("@webkit admin on mobile — the tab strip is one row, and it pans", async ({ page }) => {
    await openAdminPane(page);

    const strip = await page.getByTestId("admin-pane").evaluate((pane) => {
      const nav = pane.querySelector(".adm-nav");
      if (nav === null) throw new Error(".adm-nav is gone — the tab strip's class drifted");
      const chips = [...nav.querySelectorAll("[role='tab']")];
      return {
        count: chips.length,
        // Distinct line positions. Rounded, because baseline alignment
        // leaves sub-pixel differences between chips on the SAME row and
        // a second row is 44px away — no threshold argument available.
        rows: new Set(chips.map((el) => Math.round(el.getBoundingClientRect().top))).size,
        overflowX: window.getComputedStyle(nav).overflowX,
        scrollW: nav.scrollWidth,
        clientW: nav.clientWidth,
      };
    });

    // Non-vacuity: one chip is trivially one row, and an empty strip is
    // trivially not overflowing. `ADMIN_TABS` is the list the count
    // assertion in the width oracle pins.
    expect(strip.count, "the tab strip must have chips to measure").toBe(ADMIN_TABS.length);

    expect(
      strip.rows,
      `the tab strip must stay on one row at 393px — chips found on ${strip.rows} rows`,
    ).toBe(1);

    // And it must be REACHABLE by the gesture, not merely clipped: the
    // exemption above waves through a box that pans, so if this strip
    // stopped panning the exemption would be waving through nothing and
    // three destinations would be unreachable.
    expect(
      strip.overflowX,
      "the tab strip must be able to pan — that is what the h-scroll exemption is for",
    ).toMatch(/auto|scroll/);
    expect(
      strip.scrollW,
      `the tab strip must actually overflow, or the exemption guards nothing ` +
        `(scrollWidth ${strip.scrollW} vs clientWidth ${strip.clientW})`,
    ).toBeGreaterThan(strip.clientW + 1);
  });

  test("@webkit admin on mobile — vertical scroll inside the pane still works", async ({
    page,
  }) => {
    await openAdminPane(page);

    // Negative twin: relaxing `.admin-pane` from `pan-y` to `pan-x pan-y`
    // must keep pan-y intact (a careless rewrite to `pan-x` alone would
    // silently drop vertical scroll while passing the pan-x asserts
    // above). Both axes must remain in the touch-action declaration.
    const paneTouch = await page
      .getByTestId("admin-pane")
      .evaluate((el) => window.getComputedStyle(el).touchAction);
    expect(paneTouch, "admin-pane touch-action must STILL allow pan-y").toMatch(/pan-y/);
    expect(paneTouch, "admin-pane touch-action must allow pan-x").toMatch(/pan-x/);
  });

  test("@webkit admin on mobile — opening a row's detail does not move the row", async ({
    page,
  }) => {
    await openAdminPane(page);

    await page.getByTestId("admin-tab-networks").tap();
    await expect(page.getByTestId("admin-networks-table")).toBeVisible({ timeout: 10_000 });

    const expander = page.locator("[data-testid^='admin-network-expand-']").first();
    await expect(expander).toBeVisible({ timeout: 5_000 });

    // A DURABLE pre-state, and the reason it is here. `tap()` scrolls its
    // target into view first, so a row sitting near the fold makes the tap
    // itself move the page and the delta below measures Playwright rather
    // than the layout. This test passed for as long as the pane's chrome
    // happened to leave row one comfortably on screen, and #1223 changed
    // that chrome — the tab strip wraps to two rows now, and every card is
    // taller by a label line. Scrolling first means any movement left is
    // the layout's.
    await expander.scrollIntoViewIfNeeded();

    // EVERY scrollable ancestor, not `.admin-pane` alone. The first version
    // of this diagnostic read the pane and reported `0 → 0`, which says
    // nothing: `.admin-tab-panel` is `overflow-y: auto` too and is the box
    // that actually scrolls the tab's content. Reading one named box and
    // concluding from its silence is the same error as normalising a width
    // by the box being squeezed — measure the ancestor CHAIN and let it say
    // which link moved.
    const scrollChain = (): Promise<Record<string, number>> =>
      expander.evaluate((el) => {
        const out: Record<string, number> = {};
        for (let n = el.parentElement, i = 0; n !== null; n = n.parentElement, i++) {
          if (n.scrollHeight <= n.clientHeight) continue;
          const name = n.getAttribute("data-testid") ?? (n.className || n.tagName.toLowerCase());
          out[`${i}:${String(name).slice(0, 40)}`] = n.scrollTop;
        }
        out.window = window.scrollY;
        return out;
      });

    const scrollBefore = await scrollChain();
    const before = await expander.boundingBox();
    expect(before, "expander must have a box before the tap").not.toBeNull();

    await expander.tap();
    await expect(expander).toHaveAttribute("aria-expanded", "true", { timeout: 5_000 });
    await expect(page.locator(".adm-detail").first()).toBeVisible({ timeout: 5_000 });

    // The whole complaint, as one number. When the panel rendered
    // before the table, opening it inserted a card ABOVE this row and
    // pushed it down the page — and `scrollIntoView` then dragged the
    // viewport up to the card, leaving the operator somewhere they had
    // not asked to be. In the row's own position the row stays put.
    const after = await expander.boundingBox();
    const scrollAfter = await scrollChain();
    expect(after, "expander must still have a box after the tap").not.toBeNull();
    expect(
      Math.abs((after?.y ?? 0) - (before?.y ?? 0)),
      `the row an operator tapped must not move when its detail opens — ` +
        `scrollable ancestors ${JSON.stringify(scrollBefore)} → ${JSON.stringify(scrollAfter)}: ` +
        `all unchanged means the LAYOUT moved, any change means the tap scrolled`,
    ).toBeLessThanOrEqual(1);
  });
});
