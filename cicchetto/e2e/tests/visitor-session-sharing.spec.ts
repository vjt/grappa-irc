// Visitor session-sharing — end-to-end Playwright flow.
//
// What this covers:
//   1. Visitor logs in via /auth/login (anon, no password).
//   2. Visitor mints a share-token from the Settings drawer → the share
//      SUB-PAGE (#335, was a modal) shows the share URL.
//   3. A second browser context opens the URL → ShareConsume route
//      auto-consumes → cic navigates into Shell.
//   4. BOTH contexts stay connected as the SAME visitor:
//      - device A still alive (NOT a transfer).
//      - device B sees the same nick + network in its subject envelope.
//
// Why this matters: this is the user-visible promise of the feature.
// Vitest jsdom can't see the live multi-context fan-out; the e2e
// harness is the only place to assert "device A still has its bearer
// after device B redeems."
//
// Per `feedback_e2e_user_class_parity_matrix`: this flow is
// visitor-only by design (mint endpoint 403s for users). One-class spec.

import { expect, test } from "../fixtures/test";
import { adminDeleteVisitor, mintVisitor } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";

test("visitor session-sharing — mint on device A, consume on device B, both connected", async ({
  browser,
}) => {
  const admin = getSeededAdmin();
  const visitorNick = `share-${Date.now()}`;
  const visitor = await mintVisitor(visitorNick);

  // Device A: load the visitor's bearer + subject so cic boots
  // straight into Shell without re-running the captcha/anon dance.
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();

  // Device B: starts with NO localStorage — represents a fresh
  // device opening the share link cold.
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();

  try {
    const visitorSubject = {
      kind: "visitor",
      id: visitor.id,
    };

    await pageA.addInitScript(
      ([token, subjectJson]) => {
        localStorage.setItem("grappa-token", token);
        localStorage.setItem("grappa-subject", subjectJson);
        localStorage.setItem("cic.installChoice", "browser");
      },
      [visitor.token, JSON.stringify(visitorSubject)] as const,
    );
    await pageA.goto("/");

    // Open Settings drawer → click the "share session" section-button →
    // the share sub-page (#335) pushes in and mints on mount.
    await pageA.getByLabel(/open settings/i).click();
    await expect(pageA.getByRole("dialog", { name: /settings/i })).toBeVisible();
    await pageA.getByTestId("share-session-entry").click();
    await expect(pageA.getByTestId("share-subpage")).toBeVisible();

    // Wait for the URL to materialize after the mint request resolves.
    const urlInput = pageA.getByTestId("share-url");
    await expect(urlInput).toBeVisible();
    await expect(urlInput).not.toHaveValue("", { timeout: 10_000 });

    const shareUrl = await urlInput.inputValue();
    expect(shareUrl).toMatch(/\/share\//);

    // Device B navigates to the share URL. Plain path (NOT hash) —
    // `@solidjs/router` v0.16 uses path-mode by default; nginx's
    // `try_files $uri /index.html` falls back to the SPA for any
    // unknown path so `/share/<token>` reaches the ShareConsume route.
    const sharePath = shareUrl.replace(/^https?:\/\/[^/]+/, "");
    await ctxB.addInitScript(() => {
      localStorage.setItem("cic.installChoice", "browser");
    });
    await pageB.goto(sharePath);

    // ShareConsume mounts, runs the consume call, and navigates to /
    // on success. The page transition can happen so fast the share-
    // consume route never renders for a measurable instant — we
    // therefore assert on the post-redirect Shell surface directly
    // (the settings button is stable across desktop + mobile).
    await expect(pageB.getByLabel(/open settings/i)).toBeVisible({ timeout: 10_000 });
    // No error rendered: a failure would keep the share-consume page
    // mounted with the error visible.
    await expect(pageB.getByTestId("share-consume-error")).toHaveCount(0);

    // Device B's persisted subject matches device A's visitor row.
    // #211 phase 7 — the subject wire carries only `{id, registered}`
    // now (nick/network_slug moved to the per-network GET /networks rows),
    // so cross-device identity is proven by the shared `id`; the
    // per-network nick is asserted separately against /networks below.
    const subjectB = await pageB.evaluate(() => localStorage.getItem("grappa-subject"));
    expect(subjectB).not.toBeNull();
    const parsedB = JSON.parse(subjectB ?? "{}") as {
      kind: string;
      id: string;
    };
    expect(parsedB.kind).toBe("visitor");
    expect(parsedB.id).toBe(visitor.id);

    // Device B resolves the SAME per-network identity — the visitor's nick
    // lives on the GET /networks rows now, and device B (same visitor row)
    // must see it via its own bearer.
    const tokenB = await pageB.evaluate(() => localStorage.getItem("grappa-token"));
    expect(tokenB).not.toBeNull();
    const netsB = await pageB.evaluate(async (t) => {
      const r = await fetch("/networks", { headers: { authorization: `Bearer ${t}` } });
      return (await r.json()) as Array<{ slug: string; nick: string }>;
    }, tokenB ?? "");
    const anchorB = netsB.find((n) => n.slug === visitor.network_slug);
    expect(anchorB?.nick).toBe(visitorNick);

    // Device A's token + subject UNCHANGED — this is sharing, not
    // transfer. The original bearer must still be present, and a
    // /me probe from inside pageA returns 200.
    const tokenA = await pageA.evaluate(() => localStorage.getItem("grappa-token"));
    expect(tokenA).toBe(visitor.token);

    const meStatusA = await pageA.evaluate(async (t) => {
      const r = await fetch("/me", { headers: { authorization: `Bearer ${t}` } });
      return r.status;
    }, visitor.token);
    expect(meStatusA).toBe(200);

    // Reopening the same share URL on a third context fails with
    // 410 share_token_consumed — one-shot semantics.
    const ctxC = await browser.newContext();
    const pageC = await ctxC.newPage();
    try {
      await ctxC.addInitScript(() => {
        localStorage.setItem("cic.installChoice", "browser");
      });
      await pageC.goto(sharePath);
      await expect(pageC.getByTestId("share-consume-error")).toBeVisible({ timeout: 10_000 });
      await expect(pageC.getByTestId("share-consume-error")).toHaveText(/share_token_consumed/);
    } finally {
      await ctxC.close();
    }
  } finally {
    await ctxA.close();
    await ctxB.close();
    await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});
