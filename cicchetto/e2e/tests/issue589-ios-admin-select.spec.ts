// #589 (2026-08-01) — on iOS NO text inside the admin pane was selectable,
// keyboard up or down. The admin tables are exactly the surfaces an operator
// needs to copy off the device (IPs, session/visitor ids, vhosts, UA strings,
// error text), so the bug forced retyping by hand.
//
// ROOT CAUSE (pure CSS): `html.is-ios` applies a blanket
// `-webkit-user-select: none` (Telegram Web K pattern, themes/default.css) that
// inherits to every descendant, paired with an explicit re-enable allowlist
// (.scrollback, .topic-modal-text, input, textarea, select). The admin pane was
// NOT in that list, so `.admin-tab-panel` and every table cell inherited `none`.
// Fix: re-enable `.admin-tab-panel` (one wrapper covers all ten tabs) and
// re-exclude the controls inside it (`button`) so a long-press on a control
// doesn't pop the selection magnifier — the same carve-out `.scrollback-invite-join`
// makes for the [Join] CTA.
//
// The keepKeyboard.ts SELECTABLE_TEXT_SURFACES list was deliberately NOT
// touched: that list is compose-focus KEYBOARD policy, and the AdminPane <Match>
// arm UNMOUNTS ComposeBox (Shell.tsx <Switch>), so no text input holds focus
// behind the pane — handleMouseDown bails on document.activeElement. iOS native
// long-press selection here is pure CSS.
//
// jsdom is blind to CSS + has a no-op Selection
// (feedback_cicchetto_browser_smoke), so this regression can ONLY be pinned in a
// real browser. Real iOS long-press selection (magnifier/handles) isn't
// emulatable on Playwright webkit (feedback_playwright_webkit_not_ios_scroll),
// so computed style is the testable boundary — same posture as
// text-selection-restored.spec.ts's @webkit half. Real-device dogfood remains
// the final iOS verification (vjt post-ship).

import { expect, test } from "../fixtures/test";
import { openAdminConsole } from "../fixtures/cicchettoPage";
import { getSeededAdmin } from "../fixtures/seedData";
import { mintVisitor, reapVisitors } from "../fixtures/grappaApi";

test.setTimeout(60_000);

test("@webkit iOS — admin pane content re-enables user-select under the is-ios global kill; controls stay unselectable", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  // A minted visitor guarantees a populated Visitors table: a real `<td>` cell
  // (the IP — exactly the copyable content #589 is about) plus a per-row Delete
  // button that lives INSIDE `.admin-tab-panel` (the re-exclude target).
  // Short prefix: `${Date.now()}` is 13 digits, so the nick must stay under
  // the upstream NICKLEN (bahamut 30) — a longer prefix trips 400 malformed_nick.
  const visitorNick = `ios589-${Date.now()}`;
  const visitor = await mintVisitor(visitorNick);

  try {
    await page.addInitScript(
      ([token, subjectJson]) => {
        localStorage.setItem("grappa-token", token);
        localStorage.setItem("grappa-subject", subjectJson);
        localStorage.setItem("cic.installChoice", "browser");
      },
      [admin.token, admin.subjectJson] as const,
    );
    await page.goto("/");

    // Viewport-aware single door to AdminPane — on the iPhone-15 (mobile)
    // project this routes rail-drawer → cog → settings drawer → admin entry.
    await openAdminConsole(page);
    await page.getByTestId("admin-tab-visitors").click();
    await expect(page.getByTestId("admin-visitors-table")).toBeVisible({ timeout: 10_000 });

    const row = page.getByTestId(`admin-visitor-row-${visitor.id}`);
    await expect(row).toBeVisible();

    const styles = await page.evaluate((visitorId) => {
      const panel = document.querySelector(".admin-tab-panel");
      // First body cell of the visitors table — a real `<td>` (the copyable
      // surface the bug killed), not a header.
      const cell = document.querySelector(".admin-visitors-table tbody td");
      const button = document.querySelector(`[data-testid="admin-visitor-delete-${visitorId}"]`);
      if (panel === null || cell === null || button === null) {
        return { missing: true } as const;
      }
      return {
        missing: false,
        htmlIsIos: document.documentElement.classList.contains("is-ios"),
        htmlUserSelect: getComputedStyle(document.documentElement).webkitUserSelect,
        panelUserSelect: getComputedStyle(panel).webkitUserSelect,
        cellUserSelect: getComputedStyle(cell).webkitUserSelect,
        buttonUserSelect: getComputedStyle(button).webkitUserSelect,
      } as const;
    }, visitor.id);

    // Live-surface precondition — no hollow green if a selector drifted.
    expect(styles.missing).toBe(false);
    // iPhone 15 UA → applyIosClass marks the root; the blanket kill is active,
    // so this test genuinely runs under the policy the fix re-enables.
    expect(styles.htmlIsIos).toBe(true);
    expect(styles.htmlUserSelect).toBe("none");

    // THE fix: the panel wrapper + its table cells are selectable again.
    expect(styles.panelUserSelect).toBe("text");
    expect(styles.cellUserSelect).toBe("text");

    // The re-exclude: a control inside the panel stays unselectable, so a
    // long-press on it doesn't pop the selection magnifier over a button.
    expect(styles.buttonUserSelect).toBe("none");
  } finally {
    await reapVisitors(admin.token, visitor.id);
  }
});
