// Issue #260 — mobile bottom bar: sticky network tab (horizontal
// section header).
//
// The bottom bar (BottomBar.tsx, mobile-only) groups window tabs per
// network: each `.bottom-bar-network` is a flex row inside the
// `.bottom-bar` overflow-x scroller, and its FIRST child is the
// `.bottom-bar-network-header` (the ⚙️+slug server-window tab). #260
// makes that header a horizontal `position: sticky; left: 0` section
// header: it pins to the scroller's leading edge while its group is in
// view, and the NEXT group's header PUSHES it out (displace) when that
// group reaches the edge — so there is always EXACTLY ONE network tab at
// the leading edge. Pure CSS: the browser owns the pin/displace math and
// cic never originates state (CLAUDE.md — no parallel state machine).
//
// WHY these assertions, not a synthetic touch swipe: the sticky effect
// is driven by the scroller's `scrollLeft`, whatever moves it (native
// touch pan or a programmatic write). There is NO touch-JS handler to
// prove (unlike #123's compose swipe) — so the deterministic contract is
// "set scrollLeft, read the header's box". `element.scrollLeft =` and
// `getBoundingClientRect()` are plain DOM ops, deterministic in webkit;
// the #123/#255 caveat is about reproducing TOUCH PAN PHYSICS, which
// these tests deliberately do not attempt. The "does it FEEL right on a
// real finger" check rides the pending iOS/Android device-verify batch.
//
// Mobile-only: `.bottom-bar` renders solely in Shell.tsx's mobile
// branch, so both tests are @webkit (webkit-iphone-15, 393×852). A
// chromium run of `#260` is intentionally empty.

import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import { loginAs, waitForUserTopicReady } from "../fixtures/cicchettoPage";
import {
  adminDeleteVisitor,
  GRAPPA_BASE_URL,
  type MintedVisitor,
  mintVisitor,
} from "../fixtures/grappaApi";
import { getSeededAdmin, getSeededVjt } from "../fixtures/seedData";

// Two separate ircds → distinct nick namespaces → ONE visitor can hold
// both live with no 433 autokill (the #211 phase-7 topology). Two live
// networks = two `.bottom-bar-network` groups = a real displace target.
const ANCHOR = "azzurra";
const SECOND = "azzurra2";

// Pin tolerance in px. A sticky element pins exactly at the scrollport's
// leading edge (== the bar's border-box left; `.bottom-bar` has no left
// border/padding), but subpixel rounding warrants a small epsilon.
const EDGE_EPS = 2;

type StripSnapshot = {
  barLeft: number;
  clientWidth: number;
  scrollWidth: number;
  scrollLeft: number;
  headers: Array<{ slug: string; left: number; right: number }>;
  groups: Array<{ slug: string; left: number; right: number; width: number }>;
};

// Set the bottom-bar's scrollLeft, then read back the post-scroll layout.
// `"max"` over-requests scrollWidth so the browser clamps to the true
// maximum. Reading `getBoundingClientRect` after the write forces a
// synchronous reflow, so the returned boxes reflect the new scroll
// (`.bottom-bar` uses the default instant scroll-behavior).
async function snapshotStrip(page: Page, scrollTo: number | "max"): Promise<StripSnapshot> {
  return page.evaluate((mode) => {
    const bar = document.querySelector<HTMLElement>(".bottom-bar");
    if (!bar) throw new Error("snapshotStrip: no .bottom-bar in the DOM");
    bar.scrollLeft = mode === "max" ? bar.scrollWidth : mode;
    const barRect = bar.getBoundingClientRect();
    const headers = Array.from(
      bar.querySelectorAll<HTMLElement>(".bottom-bar-network-header"),
    ).map((h) => {
      const r = h.getBoundingClientRect();
      return { slug: h.getAttribute("data-network-slug") ?? "", left: r.left, right: r.right };
    });
    const groups = Array.from(bar.querySelectorAll<HTMLElement>(".bottom-bar-network")).map((g) => {
      const r = g.getBoundingClientRect();
      const slug =
        g.querySelector(".bottom-bar-network-header")?.getAttribute("data-network-slug") ?? "";
      return { slug, left: r.left, right: r.right, width: r.width };
    });
    return {
      barLeft: barRect.left,
      clientWidth: bar.clientWidth,
      scrollWidth: bar.scrollWidth,
      scrollLeft: bar.scrollLeft,
      headers,
      groups,
    };
  }, scrollTo);
}

const isAtEdge = (snap: StripSnapshot, slug: string): boolean => {
  const h = snap.headers.find((x) => x.slug === slug);
  return h !== undefined && Math.abs(h.left - snap.barLeft) <= EDGE_EPS;
};

const edgeCount = (snap: StripSnapshot): number =>
  snap.headers.filter((h) => Math.abs(h.left - snap.barLeft) <= EDGE_EPS).length;

// Boot cicchetto as a freshly-minted visitor on the current (mobile)
// page fixture — mirrors loginAs but for the visitor subject wire
// ({kind:"visitor", id}). The webkit-iphone-15 viewport makes Shell.tsx
// render the mobile `.bottom-bar`.
async function bootVisitorMobile(page: Page, visitor: MintedVisitor): Promise<void> {
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [visitor.token, JSON.stringify({ kind: "visitor", id: visitor.id })] as const,
  );
  await page.goto("/");
  await expect(page.locator(".bottom-bar-network-header").first()).toBeVisible({
    timeout: 15_000,
  });
  await waitForUserTopicReady(page, `visitor:${visitor.id}`);
}

async function getNetworks(
  token: string,
): Promise<Array<{ slug: string; connection_state: string }>> {
  const res = await fetch(`${GRAPPA_BASE_URL}/networks`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`getNetworks: ${res.status} ${await res.text()}`);
  return (await res.json()) as Array<{ slug: string; connection_state: string }>;
}

async function waitForNetworkState(
  token: string,
  slug: string,
  state: string,
  attempts = 60,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const rows = await getNetworks(token);
    if (rows.find((r) => r.slug === slug)?.connection_state === state) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForNetworkState: ${slug} never reached ${state}`);
}

// Accrete a second network onto the visitor (visitor-only door).
async function accreteNetwork(token: string, slug: string): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/session/networks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ network: slug }),
  });
  if (res.status !== 204) {
    throw new Error(`accreteNetwork: ${slug} → ${res.status} ${await res.text()}`);
  }
}

// JOIN via REST, retrying on 404 (`:no_session` — session mid-register).
// Same poll-until-ready discipline as the #211 multinet specs.
async function joinChannelWhenReady(token: string, slug: string, channel: string): Promise<void> {
  let last = "";
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${GRAPPA_BASE_URL}/networks/${slug}/channels`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: channel }),
    });
    if (res.ok) return;
    last = `${res.status} ${await res.text()}`;
    if (res.status !== 404) throw new Error(`joinChannelWhenReady: ${slug}/${channel} → ${last}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`joinChannelWhenReady: ${slug}/${channel} never became joinable (last: ${last})`);
}

test("@webkit #260 — the network header carries the sticky-left CSS contract", async ({ page }) => {
  // Deterministic, isolated anchor: the computed style the browser
  // consults to pin the header. Seeded vjt has ONE network → one header;
  // read-only (no JOINs), so no shared-stack poisoning.
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  const header = page.locator(".bottom-bar-network-header").first();
  await expect(header).toBeVisible({ timeout: 10_000 });

  const contract = await header.evaluate((el) => {
    const bar = document.querySelector<HTMLElement>(".bottom-bar");
    const cs = getComputedStyle(el);
    return {
      position: cs.position,
      left: cs.left,
      background: cs.backgroundColor,
      barBackground: bar ? getComputedStyle(bar).backgroundColor : null,
    };
  });

  // PRE-FIX: position "static", left "auto". POST-FIX: the horizontal
  // sticky section-header contract.
  expect(contract.position).toBe("sticky");
  expect(contract.left).toBe("0px");

  // The pinned header MUST be opaque — channel/query tabs scroll UNDER it,
  // so a transparent background lets their text bleed through mid-scroll.
  // At rest it resolves to the bar's own --bg-alt (theme-agnostic compare,
  // never "rgba(0, 0, 0, 0)"). Guards the (0,1,0) source-order tie against
  // `.bottom-bar-tab { background: transparent }` that would otherwise win.
  expect(contract.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(contract.background).toBe(contract.barBackground);
});

test("@webkit #260 — the sticky header pins under scroll and the next network displaces it", async ({
  page,
}) => {
  // Two full connect chains + several JOINs across two live upstreams —
  // give it testnet-latency headroom (matches the #211 phase-7 budget).
  test.setTimeout(150_000);

  const admin = getSeededAdmin();
  const stamp = Date.now();
  let visitor: MintedVisitor | null = null;

  try {
    // ── SETUP: one visitor, two networks, wide groups on both ──
    visitor = await mintVisitor(`s260-${stamp}`);
    expect(visitor.network_slug).toBe(ANCHOR);
    await waitForNetworkState(visitor.token, ANCHOR, "connected");
    await accreteNetwork(visitor.token, SECOND);
    await waitForNetworkState(visitor.token, SECOND, "connected");

    // JOIN several long-named channels on BOTH networks so each group is
    // WIDER than the viewport. The displace endpoint is only reachable if
    // the incoming (last) group can scroll all the way to the leading
    // edge, which requires last-group-width ≥ viewport (else the previous
    // group's tail still covers left:0 at max scroll — inherent to
    // horizontal scrolling). The width guard in (c) fails loud if this
    // setup assumption ever breaks.
    const channelsFor = (net: string): string[] =>
      [0, 1, 2, 3].map((i) => `#s260-${net}-channel-longname-${i}-${stamp}`);
    const anchorChans = channelsFor("a");
    const secondChans = channelsFor("b");
    for (const c of anchorChans) await joinChannelWhenReady(visitor.token, ANCHOR, c);
    for (const c of secondChans) await joinChannelWhenReady(visitor.token, SECOND, c);

    await bootVisitorMobile(page, visitor);

    // Wait until the strip is ready to measure: both network groups
    // rendered, the strip OVERFLOWS the viewport, and the last group is
    // wide enough to reach the leading edge (the displace precondition).
    // Gate on GEOMETRY, not exact channel names — channel tabs arrive
    // progressively AND the ircd truncates names past its CHANNELLEN, so
    // a requested-name locator is unreliable; the width is what the
    // displace assertion actually depends on.
    await expect(page.locator(".bottom-bar-network")).toHaveCount(2, { timeout: 15_000 });
    await expect
      .poll(
        async () => {
          const s = await snapshotStrip(page, 0);
          if (s.headers.length !== 2) return `headers=${s.headers.length}`;
          if (s.scrollWidth <= s.clientWidth) {
            return `no-overflow(${s.scrollWidth}<=${s.clientWidth})`;
          }
          const lastWidth = s.groups[s.groups.length - 1]?.width ?? 0;
          if (lastWidth < s.clientWidth - EDGE_EPS) {
            return `last-group-narrow(${lastWidth}<${s.clientWidth})`;
          }
          return "ready";
        },
        { timeout: 25_000, intervals: [500] },
      )
      .toBe("ready");

    // ── MEASURE ──
    const atStart = await snapshotStrip(page, 0);
    // Setup sanity: the strip overflows and both headers exist.
    expect(atStart.scrollWidth).toBeGreaterThan(atStart.clientWidth);
    expect(atStart.headers.length).toBe(2);

    // DOM order = networks() render order; identify first/last groups by
    // position so the assertion is order-agnostic (proves displace
    // regardless of which network cic renders first).
    const firstSlug = atStart.groups[0].slug;
    const lastSlug = atStart.groups[atStart.groups.length - 1].slug;
    expect(firstSlug).not.toBe(lastSlug);

    // (a) AT REST: the FIRST network header sits at the leading edge, and
    // it is the ONLY header there.
    expect(isAtEdge(atStart, firstSlug)).toBe(true);
    expect(edgeCount(atStart)).toBe(1);

    // (b) PIN: scroll deep into the first group's channels (halfway
    // through the group, well past the header). Without sticky the header
    // scrolls off (its left goes negative); with sticky it stays pinned
    // and remains the only header at the edge.
    const firstGroupWidth = atStart.groups[0].width;
    const midScroll = Math.max(1, Math.floor(firstGroupWidth * 0.5));
    const atMid = await snapshotStrip(page, midScroll);
    expect(atMid.scrollLeft).toBeGreaterThan(EDGE_EPS); // actually scrolled
    expect(isAtEdge(atMid, firstSlug)).toBe(true);
    expect(edgeCount(atMid)).toBe(1);

    // (c) DISPLACE: scroll to the end. The width guard ensures the last
    // group can physically reach the leading edge.
    const lastGroupWidth = atStart.groups[atStart.groups.length - 1].width;
    expect(lastGroupWidth).toBeGreaterThanOrEqual(atStart.clientWidth - EDGE_EPS);

    const atEnd = await snapshotStrip(page, "max");
    // The incoming (last) network header now owns the leading edge, and
    // it is the ONLY header there — it displaced the first one.
    expect(isAtEdge(atEnd, lastSlug)).toBe(true);
    expect(edgeCount(atEnd)).toBe(1);
    // The outgoing (first) header is fully pushed out past the edge.
    const outgoing = atEnd.headers.find((h) => h.slug === firstSlug);
    expect(outgoing).toBeDefined();
    if (outgoing) expect(outgoing.right).toBeLessThanOrEqual(atEnd.barLeft + EDGE_EPS);
  } finally {
    if (visitor) await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});
