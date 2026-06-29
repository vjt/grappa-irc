// Issue #126 (P0) — lifecycle verbs detach / disconnect / reconnect /
// quit, standardized across user + NickServ-visitor + ephemeral.
//
// This spec owns the two VISIBLE, ISOLATABLE outcomes (the rest of the
// matrix is covered by the server SessionController test + the cic
// lifecycle/SettingsDrawer vitest, because a *registered* visitor in the
// e2e testnet needs the full NickServ REGISTER dance — out of scope for a
// stable browser gate):
//
//   1. EPHEMERAL VISITOR GATING — a minted (anon, no NickServ identity)
//      visitor's settings drawer offers ONLY "quit": no "detach", no
//      "disconnect"/"reconnect", and the retired "log out" label is gone.
//      RED before #126 (an ephemeral visitor saw a single "log out"
//      button and no `quit-irc-btn`).
//
//   2. USER DETACH KEEPS THE BOUNCER (bug #1 + #2) — after a user detaches
//      via the drawer, the web session ends (back to /login) but the
//      server-side Session.Server + upstream IRC connection STAY UP: the
//      autojoin channel is still `joined` server-side. RED before #126
//      (logout called stop_all_user_sessions, tearing the upstream down →
//      the channel would read `joined: false`, and the credential stayed
//      `:connected` while the pid was gone — the desync).
//
// The user-detach test uses a FRESH vjt bearer (grappaApi.login), NOT the
// shared seeded token, so revoking it on detach can't 401 downstream vjt
// specs. The afterEach reconnects vjt's network defensively (a pre-#126
// RED run of this spec would tear the seeded session down).

import { test, expect } from "../fixtures/test";
import { loginAs } from "../fixtures/cicchettoPage";
import {
  adminDeleteVisitor,
  GRAPPA_BASE_URL,
  login,
  mintVisitor,
  patchNetworkConnectionState,
} from "../fixtures/grappaApi";
import {
  AUTOJOIN_CHANNELS,
  getSeededVjt,
  NETWORK_SLUG,
  VJT_IDENTIFIER,
  VJT_PASSWORD,
} from "../fixtures/seedData";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];

// Build a loginAs-shaped seed from a FRESH user login (own bearer +
// subject), so detach revokes only this token — not the shared seeded
// one every other vjt spec rides on.
async function freshVjtSeed(): Promise<{
  name: string;
  password: string;
  identifier: string;
  token: string;
  subjectJson: string;
}> {
  const { token, subject } = await login(VJT_IDENTIFIER, VJT_PASSWORD);
  return {
    name: subject.name,
    password: VJT_PASSWORD,
    identifier: VJT_IDENTIFIER,
    token,
    subjectJson: JSON.stringify(subject),
  };
}

async function channelJoined(token: string, slug: string, channel: string): Promise<boolean> {
  const res = await fetch(`${GRAPPA_BASE_URL}/networks/${slug}/channels`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return false;
  const channels = (await res.json()) as Array<{ name: string; joined: boolean }>;
  return channels.find((c) => c.name === channel)?.joined === true;
}

test.describe("issue #126 — detach lifecycle", () => {
  test.afterEach(async () => {
    // A pre-#126 (RED) run of the user-detach test tears the seeded vjt
    // Session.Server down (stop_all_user_sessions). Reconnect defensively
    // so the next spec inherits a live autojoin. Post-#126 detach keeps
    // the session, so this is a no-op (already connected → :not_connected,
    // swallowed).
    const vjt = getSeededVjt();
    await patchNetworkConnectionState(vjt.token, NETWORK_SLUG, {
      connection_state: "connected",
    }).catch(() => {});

    // Wait for the autojoin to land again so the next spec doesn't race a
    // half-spawned session (same pattern as cp15-b6-parked-disconnect).
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await channelJoined(vjt.token, NETWORK_SLUG, SEED_CHANNEL)) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  test("ephemeral visitor settings offers ONLY quit (no detach/disconnect, no 'log out')", async ({
    browser,
  }) => {
    const visitor = await mintVisitor(`e2e126-${Date.now()}`);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      const subjectJson = JSON.stringify({
        kind: "visitor",
        id: visitor.id,
        nick: visitor.nick,
        network_slug: visitor.network_slug,
        // ephemeral: no NickServ identity → not registered
        registered: false,
      });
      await page.addInitScript(
        ([token, subject]) => {
          localStorage.setItem("grappa-token", token);
          localStorage.setItem("grappa-subject", subject);
          localStorage.setItem("cic.installChoice", "browser");
        },
        [visitor.token, subjectJson] as const,
      );
      await page.goto("/");
      await page.getByLabel(/open settings/i).click();
      const drawer = page.getByRole("dialog", { name: /settings/i });
      await expect(drawer).toHaveClass(/open/);

      // The ONLY lifecycle verb an ephemeral visitor gets is quit.
      await expect(page.getByTestId("quit-irc-btn")).toBeVisible();
      await expect(page.getByTestId("quit-irc-btn")).toHaveText(/^quit$/i);
      // Persistent-identity verbs are withheld …
      await expect(page.getByTestId("detach-btn")).toHaveCount(0);
      await expect(page.getByTestId("disconnect-btn")).toHaveCount(0);
      await expect(page.getByTestId("reconnect-btn")).toHaveCount(0);
      // … and the retired "log out" label is gone (positive twin so a
      // testid typo can't silently green this).
      await expect(page.getByText(/^log out$/i)).toHaveCount(0);
    } finally {
      await ctx.close();
      // Best-effort: tear down the throwaway visitor's row + session.
      const admin = (await import("../fixtures/seedData")).getSeededAdmin();
      await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
    }
  });

  test("user detach keeps the upstream session up (bug #1 + #2)", async ({ page }) => {
    const vjt = await freshVjtSeed();

    // Baseline: the autojoin channel is live server-side.
    expect(await channelJoined(vjt.token, NETWORK_SLUG, SEED_CHANNEL)).toBe(true);

    await loginAs(page, vjt);

    // Detach via the drawer — the web session ends (back to /login) …
    await page.getByLabel(/open settings/i).click();
    const drawer = page.getByRole("dialog", { name: /settings/i });
    await expect(drawer).toHaveClass(/open/);
    await page.getByTestId("detach-btn").click();
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

    // … but the bouncer STAYS UP: the upstream Session.Server survived, so
    // the autojoin channel is still joined server-side (a SEPARATE fresh
    // bearer proves it without depending on the just-revoked token).
    // Pre-#126 detach tore the session down → this would read false.
    const probe = await freshVjtSeed();
    let stillJoined = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      stillJoined = await channelJoined(probe.token, NETWORK_SLUG, SEED_CHANNEL);
      if (stillJoined) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(stillJoined).toBe(true);
  });
});
