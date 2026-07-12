// #152 — ident + realname user-settable, live-applied via reconnect.
//
// This surface IS e2e-able (form logic + a live upstream effect), so per
// the build recipe it ships a REAL browser spec asserting the visible
// upstream outcome with an INDEPENDENT witness (a peer IRC client sharing
// the channel) — NOT merely "the field was accepted".
//
// grappa runs no identd, so bahamut tilde-prefixes the ident it can't
// verify: a visitor whose ident is `grp` appears on the wire as
// `nick!~grp@host`. The peer only sees that prefix if the visitor's
// upstream USER registration actually carried the ident — so the
// assertion is the visible upstream effect, not a client-side spy.
//
// Two flows:
//   1. LOGIN-ADVANCED — drive the real login form (nick + Advanced ident),
//      join a channel, and a peer witnesses the `~grp` prefix on the
//      visitor's PRIVMSG. Proves the login-Advanced ident reached the
//      FIRST USER registration.
//   2. SETTINGS LIVE-APPLY — the same visitor changes its ident in the
//      SettingsDrawer, applies (which internally reconnects), and the peer
//      witnesses the NEW ident prefix on a later PRIVMSG. Proves the
//      reconnect primitive re-registers upstream with the changed ident
//      AND rejoins the channel (the visitor can speak in it again).

import { expect, test } from "../fixtures/test";
import { composeSend, selectChannel, waitForUserTopicReady } from "../fixtures/cicchettoPage";
import { adminDeleteVisitor } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { getSeededAdmin } from "../fixtures/seedData";

test("issue #152 — login-Advanced ident + settings live-apply reach upstream", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const stamp = Date.now();
  const visitorNick = `v152-${stamp}`;
  const channel = `#t152-${stamp}`;
  const loginIdent = "grp";
  const newIdent = "grp2";
  const marker1 = `m152a-${stamp}`;
  const marker2 = `m152b-${stamp}`;

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let peer: IrcPeer | null = null;
  let visitorId: string | null = null;

  try {
    // ----- (1) LOGIN-ADVANCED: real form login carrying the ident -------
    await page.addInitScript(() => {
      localStorage.setItem("cic.installChoice", "browser");
    });
    await page.goto("/login");
    await expect(page.getByLabel(/nick or email/i)).toBeVisible({ timeout: 10_000 });

    await page.getByLabel(/nick or email/i).fill(visitorNick);
    await page.getByRole("button", { name: /advanced/i }).click();
    await page.getByLabel(/real name/i).fill("Grappa Tester");
    await page.getByLabel(/^ident$/i).fill(loginIdent);
    await page.getByRole("button", { name: /^connect$/i }).click();

    // Login resolves into Shell — the settings gear is the Shell anchor.
    await expect(page.getByLabel(/open settings/i)).toBeVisible({ timeout: 30_000 });

    // Read back the visitor id from the persisted subject so the finally
    // block can delete the row even if a later step throws.
    visitorId = await page.evaluate(() => {
      const raw = localStorage.getItem("grappa-subject");
      return raw ? (JSON.parse(raw) as { id: string }).id : null;
    });
    // #211 phase 7 — the subject wire no longer carries `network_slug`
    // (a visitor is multi-network; per-network attachment lives on the
    // GET /networks rows). Resolve the anchor slug from /networks using
    // the persisted bearer, the same pattern `mintVisitor` uses — reading
    // `subject.network_slug` would be a dead `undefined`.
    const networkSlug = await page.evaluate(async () => {
      const token = localStorage.getItem("grappa-token");
      if (!token) return "azzurra";
      const r = await fetch("/networks", { headers: { authorization: `Bearer ${token}` } });
      const nets = (await r.json()) as Array<{ slug: string }>;
      return nets[0]?.slug ?? "azzurra";
    });

    // Wait for the visitor's upstream registration (server-window notices)
    // then join the per-spec channel.
    await selectChannel(page, networkSlug, "Server", { awaitWsReady: false });
    await expect(
      page.locator('[data-testid="scrollback-line"][data-kind="notice"]').first(),
    ).toBeVisible({ timeout: 20_000 });

    await waitForUserTopicReady(page, `visitor:${visitorId}`);
    await composeSend(page, `/join ${channel}`);
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: channel }),
    ).toHaveCount(1, { timeout: 15_000 });
    await selectChannel(page, networkSlug, channel, { ownNick: visitorNick });
    await expect(page.locator(".members-pane")).toBeVisible({ timeout: 10_000 });

    // Independent witness shares the channel.
    peer = await IrcPeer.connect({ nick: `peer152-${stamp}` });
    await peer.join(channel);

    // The peer sees the visitor's PRIVMSG prefix — `nick!~grp@host` (the
    // `~` is bahamut marking the unverified ident). Proves the
    // login-Advanced ident reached the first USER registration.
    const identWitness1 = peer.waitForLine(
      new RegExp(`:${visitorNick}!~${loginIdent}@\\S+ PRIVMSG ${channel} :.*${marker1}`, "i"),
      `visitor login-ident ~${loginIdent}`,
    );
    // The channel is focused, so a plain body PRIVMSGs it (no /msg needed).
    await composeSend(page, marker1);
    await identWitness1;

    // ----- (2) SETTINGS LIVE-APPLY: change the ident, reconnect ---------
    await page.getByLabel(/open settings/i).click();
    const identInput = page.getByLabel(/^ident$/i);
    await expect(identInput).toBeVisible({ timeout: 10_000 });
    // Editor seeds from /me with the login ident.
    await expect(identInput).toHaveValue(loginIdent);

    await identInput.fill(newIdent);
    // Two-tap apply (arm, then confirm) — the reconnect is disruptive.
    const applyBtn = page.getByTestId("settings-identity-apply");
    await applyBtn.click(); // arm
    await applyBtn.click(); // confirm

    // The apply triggers an internal reconnect: the session drops + rejoins
    // the channel. Once re-registered under the NEW ident, the visitor can
    // speak in the channel again, and the peer witnesses the new prefix
    // `nick!~grp2@host`. This is the observable proof the reconnect
    // primitive re-registered upstream with the changed ident AND rejoined.
    const identWitness2 = peer.waitForLine(
      new RegExp(`:${visitorNick}!~${newIdent}@\\S+ PRIVMSG ${channel} :.*${marker2}`, "i"),
      `visitor reconnected-ident ~${newIdent}`,
      30_000,
    );

    // Close the drawer, wait for the channel to be joined again post-
    // reconnect, then speak. selectChannel's ownNick gate waits for the
    // self-JOIN line that the reconnect's autojoin re-emits.
    await page.keyboard.press("Escape");
    await selectChannel(page, networkSlug, channel, { ownNick: visitorNick });
    // Retry the compose until the rejoined session accepts it (the pane may
    // briefly be mid-rejoin). The witness promise resolves on the first
    // relayed line.
    await expect(async () => {
      await composeSend(page, marker2);
      await Promise.race([
        identWitness2,
        new Promise((_, rej) => setTimeout(() => rej(new Error("not yet")), 3_000)),
      ]);
    }).toPass({ timeout: 30_000 });
  } finally {
    if (peer) await peer.disconnect("issue152 done").catch(() => {});
    await ctx.close();
    if (visitorId) await adminDeleteVisitor(admin.token, visitorId).catch(() => {});
  }
});
