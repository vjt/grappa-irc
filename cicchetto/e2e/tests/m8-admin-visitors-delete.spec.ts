// M-cluster M-8 — admin visitor delete end-to-end: list + inline-
// confirm delete.
//
// #1157 moved the surface, not the verb. The Visitors tab is gone and its
// rows were merged into the unified Sessions view, so this spec now drives
// `DELETE /admin/visitors/:id` from the row's drill-down instead of from a
// per-row actions cell. The drill-down is where the button belongs: the verb
// is identity-wide while a row here is one (visitor, network) pair, so a
// visitor on two networks yields two rows whose Delete buttons would each
// destroy both. Behind the disclosure and labelled with what it destroys, it
// stops being a footgun — and this spec asserts that placement, because a
// future hand promoting Delete back into the row would restore it.
//
// Per `feedback_e2e_user_class_parity_matrix`: the admin console is
// admin-gated EXEMPT — only the admin user class reaches it. M-7's spec
// (`m7-admin-gate-settings-drawer.spec.ts`) covers reachability for all
// three classes (admin / non-admin / visitor); M-8's spec covers
// only the admin case since the gate is the same.
//
// Per `feedback_cicchetto_browser_smoke`: this Playwright spec IS
// the browser smoke for M-8 — chromium in the e2e harness renders
// the inline-confirm CSS class flip + the drill-down disclosure
// that vitest jsdom can't see.
//
// Pre-UD7 history (no longer current): `mintVisitor()` 504'd because
// the single `login_probe_timeout_ms` 3s budget covered TCP +
// NICK/USER + welcome and exhausted on first-IRC-connection cold-start.
// Post-UD7 (commit a68bc19) the budget splits into connect=3s +
// welcome=30s + outer=35s, so the welcome wait has enough headroom for
// cold-start. This spec re-enables M-8 to verify the post-UD7 budget
// actually holds in the e2e harness.

import {
  adminSessionRowKey,
  openAdminSessionDetail,
  openAdminSessionsTab,
} from "../fixtures/cicchettoPage";
import { mintVisitor, reapVisitors } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

test("M-8 admin deletes a minted visitor from the unified Sessions view (inline confirm two-step)", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const visitorNick = `m8-victim-${Date.now()}`;

  // Mint a throwaway visitor via REST. Post-UD7 the login welcome
  // budget is 30s; cold-start latency to bahamut-test should complete
  // within that window.
  const visitor = await mintVisitor(visitorNick);

  try {
    // Login as admin in the browser, open the drawer, mount AdminPane,
    // open Sessions. Same shape as m-z-admin-cluster-journey.
    await page.addInitScript(
      ([token, subjectJson]) => {
        localStorage.setItem("grappa-token", token);
        localStorage.setItem("grappa-subject", subjectJson);
        localStorage.setItem("cic.installChoice", "browser");
      },
      [admin.token, admin.subjectJson] as const,
    );
    await page.goto("/");
    await openAdminSessionsTab(page);

    // The minted visitor's row is present, and it carries the nick — the
    // row-backed merge must not lose the identity column it was built for.
    const key = await adminSessionRowKey(page, "visitor", visitor.id);
    const row = page.getByTestId(`admin-session-row-${key}`);
    await expect(row).toContainText(visitorNick);

    // Delete is NOT in the row. Asserting its absence before opening the
    // disclosure is the half that survives a regression: without it, a
    // Delete promoted back into the actions cell would still satisfy every
    // assertion below, because the drill-down copy would go on working.
    await expect(row.getByTestId(`admin-session-delete-${key}`)).toHaveCount(0);

    await openAdminSessionDetail(page, key);

    // Inline-confirm two-step: click Delete → label flips to
    // "Confirm" → click again → every row of that visitor disappears.
    const deleteBtn = page.getByTestId(`admin-session-delete-${key}`);
    await expect(deleteBtn).toHaveText(/^delete visitor$/i);
    await deleteBtn.click();
    await expect(deleteBtn).toHaveText(/^confirm delete visitor$/i);
    await deleteBtn.click();

    // Identity-wide: the assertion is on EVERY row of this visitor, not
    // the one the panel hung off. A delete that reaped only the clicked
    // (visitor, network) pair would leave the siblings behind.
    //
    // #1158 item 4 changed what that looks like on screen, not what the
    // verb does. The identity is still destroyed — but `session_log_events`
    // has no FK to the subject, so the session can SURVIVE the CASCADE as
    // the log-only class: no DB state, no pid, no verbs. (#1224 then moved
    // that class off this list onto the ended-sessions sub-page, which is
    // one more reason not to count rows here: the count now depends on a
    // screen this spec is not looking at.)
    //
    // So the identity-wide property moves onto the verbs. `rowActions`
    // gives a credential-backed visitor row exactly one of Disconnect /
    // Reconnect, on every network it is bound to; zero of either across
    // the whole `visitor:<id>:` prefix is "no credential of this visitor
    // survives anywhere" — the same claim, and it holds whether or not
    // the log happened to remember the session (bounded ring, best-effort
    // write: this spec must not depend on it).
    const survivingVerbs = page.locator(
      `[data-testid^="admin-session-disconnect-visitor:${visitor.id}:"],` +
        `[data-testid^="admin-session-reconnect-visitor:${visitor.id}:"]`,
    );
    await expect(survivingVerbs).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId("admin-sessions-error")).toHaveCount(0);
  } finally {
    // Idempotent — 404 if test already deleted it; safety net for
    // mid-arrange failures (so we don't leak a visitor row across runs).
    await reapVisitors(admin.token, visitor.id);
  }
});
