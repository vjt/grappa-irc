// #282 (P2, cic-only) — explicit "Reconnect to apply" button at the bottom
// of the vhost sub-page.
//
// The vhost (source-bind address) is edited server-side on every toggle but
// is INERT until the upstream reconnects (`Grappa.Vhosts.effective_source/2`
// resolves the bind per connect). This spec proves the NEW cic wiring that
// closes that gap:
//
//   1. The sub-page carries an always-available "Reconnect to apply" footer
//      button. Pressing it BOUNCES every connected network — park then
//      reconnect — via the per-network `PATCH /networks/:slug
//      {connection_state}` path (the clean SAME-ACCOUNT teardown the
//      home-page Reconnect uses, reused verbatim by
//      `reconnectConnectedNetworks`).
//   2. The reconnect is EXPLICIT only: leaving the panel via ‹ back NEVER
//      reconnects. (Least-astonishment — a heavyweight, externally-visible
//      QUIT/JOIN must not hide behind navigation; this is the #281 self-ban
//      class the explicit button exists to avoid.)
//
// SCOPE — this proves the cic TRIGGER (the button issues the correct clean
// park→reconnect sequence, and back issues nothing), NOT the server-side
// reconnect mechanics: those (park→reconnect re-JOINs, members heal) are
// already proven end-to-end by issue211-phase6-matrix + issue211-phase7.
// So the `PATCH /networks/:slug` calls are recorded and short-circuited
// (fulfilled 200) — the live `azzurra` session is minted real (the
// connection_state filter needs a genuinely `connected` network) but never
// actually bounced, keeping the assertion deterministic and free of
// IRC-reconnect flake. GET /me/settings/vhost is stubbed so the sub-page
// renders regardless of whether the e2e testnet seeds a vhost inventory.

import type { Browser, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import { waitForUserTopicReady } from "../fixtures/cicchettoPage";
import { adminDeleteVisitor, GRAPPA_BASE_URL, mintVisitor } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";

const ANCHOR = "azzurra";

// Mint (live azzurra connect) + a clean cic boot + two settings navigations.
test.setTimeout(90_000);

// A vhost view so the drawer nav row + sub-page render regardless of testnet
// vhost seeding (targeted stub of the vhost READ only — boot/auth untouched).
const VHOST_VIEW = {
  available: [{ address: "2001:db8::1", in_pool: true, granted: false, name: "e2e-vhost.cloak" }],
  selection: [],
};

async function waitForNetworkState(
  token: string,
  slug: string,
  state: string,
  attempts = 60,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(`${GRAPPA_BASE_URL}/networks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`waitForNetworkState: /networks → ${res.status}`);
    const rows = (await res.json()) as Array<{ slug: string; connection_state: string }>;
    if (rows.find((r) => r.slug === slug)?.connection_state === state) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForNetworkState: ${slug} never reached ${state}`);
}

// Boot cic as the minted visitor, wire the recording routes, open the drawer
// and land on the vhost sub-page. Returns the recorded connection_state
// PATCH spellings (mutated as the test drives the button).
async function bootToVhostPage(
  browser: Browser,
  visitor: { id: string; token: string },
): Promise<{ ctx: Awaited<ReturnType<Browser["newContext"]>>; page: Page; patches: string[] }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const patches: string[] = [];

  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [visitor.token, JSON.stringify({ kind: "visitor", id: visitor.id })] as const,
  );

  // Stub the vhost view (GET only); a PUT would fall through to the server.
  await page.route("**/me/settings/vhost", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(VHOST_VIEW),
      });
    }
    return route.continue();
  });

  // Record + short-circuit the connection_state PATCH (the reconnect verb's
  // wire trace). Non-PATCH requests to this exact path fall through.
  await page.route(`**/networks/${ANCHOR}`, (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { connection_state?: string } | null;
      if (typeof body?.connection_state === "string") patches.push(body.connection_state);
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    }
    return route.continue();
  });

  await page.goto("/");
  await expect(page.getByLabel(/open settings/i)).toBeVisible({ timeout: 10_000 });
  // Gate on cic hydration: the reconnect verb reads cic's networks() store,
  // so azzurra must be loaded before the button can bounce it. User-topic
  // ready is downstream of the networks() load (subscribe.ts).
  await waitForUserTopicReady(page, `visitor:${visitor.id}`);

  await page.getByLabel(/open settings/i).click();
  await expect(page.getByRole("dialog", { name: /settings/i })).toHaveClass(/open/);
  await page.getByTestId("vhost-settings-entry").click();
  await expect(page.getByTestId("vhost-subpage")).toBeVisible();

  return { ctx, page, patches };
}

test.describe("issue #282 — explicit vhost Reconnect button", () => {
  test("‹ back never reconnects, but the footer button bounces the connected network", async ({
    browser,
  }) => {
    const admin = getSeededAdmin();
    const stamp = Date.now();
    let visitor: Awaited<ReturnType<typeof mintVisitor>> | null = null;
    let ctx: Awaited<ReturnType<Browser["newContext"]>> | null = null;

    try {
      // A real, genuinely-connected network — the reconnect verb filters on
      // connection_state === "connected", so the button is inert without one.
      visitor = await mintVisitor(`p282-${stamp}`);
      expect(visitor.network_slug).toBe(ANCHOR);
      await waitForNetworkState(visitor.token, ANCHOR, "connected");

      const booted = await bootToVhostPage(browser, visitor);
      ctx = booted.ctx;
      const { page, patches } = booted;

      // The button is ALWAYS available (D2 — never gated on pending-detection)
      // and communicates intent in its label.
      const reconnect = page.getByTestId("vhost-reconnect");
      await expect(reconnect).toBeEnabled();
      await expect(reconnect).toHaveText(/reconnect to apply/i);

      // SAFETY: leaving via ‹ back must NOT reconnect (explicit-only).
      await page.getByTestId("vhost-back").click();
      await expect(page.getByTestId("vhost-subpage")).toHaveCount(0);
      await page.waitForTimeout(300); // let any (buggy) async reconnect fire
      expect(patches).toEqual([]);

      // ACTION: re-enter the sub-page and press Reconnect → the connected
      // network is bounced park→reconnect (the clean same-account teardown).
      await page.getByTestId("vhost-settings-entry").click();
      await expect(page.getByTestId("vhost-subpage")).toBeVisible();
      await page.getByTestId("vhost-reconnect").click();

      await expect.poll(() => patches.length, { timeout: 10_000 }).toBe(2);
      expect(patches).toEqual(["parked", "connected"]);

      // The in-flight guard resolves and the button returns to its idle,
      // intent-communicating label (never wedged in "Reconnecting…").
      await expect(page.getByTestId("vhost-reconnect")).toHaveText(/reconnect to apply/i);
    } finally {
      if (ctx) await ctx.close();
      if (visitor) await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
    }
  });
});
