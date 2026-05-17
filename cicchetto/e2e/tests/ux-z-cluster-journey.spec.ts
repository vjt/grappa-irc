// UX-Z — full UX cluster end-to-end journey.
//
// Mirrors `ios-z-cluster-journey.spec.ts` / `m-z-admin-cluster-journey.spec.ts`
// / `u-z-cap-honesty-cluster-journey.spec.ts` shape: ONE spec replays all 3
// UX buckets back-to-back inside a single webkit iPhone 15 session, so the
// cluster's shipping reality is exercised in CI on every integration run.
//
// Bucket coverage (per user class):
//   * UX-3 .shell-empty-toolbar Dynamic Island clearance — walk
//     document.styleSheets for the rule, assert padding declaration
//     contains `env(` and `safe-area-inset-top`. Runs FIRST (pre-PART,
//     pre-modal) so the empty-toolbar is surfaceable via the BUG5a
//     contract (PART → setSelectedChannel(null) → empty stub).
//   * UX-2 BottomBar archive chip — after PARTing seeded channel,
//     archive chip appears in `.bottom-bar-network`; tap opens
//     ArchiveModal.
//   * UX-1 archive delete × + permanent scrollback drop — inside the
//     modal, tap × (arms confirm), tap again (DELETE fires →
//     `archive_changed` broadcast → entry gone from modal).
//
// Per-class parity matrix per `feedback_e2e_user_class_parity_matrix`:
// the cluster's per-bucket specs are subject-agnostic UI shape buckets
// (single visitor login sufficient there); UX-Z is the compositional
// spec where the parity matrix is asserted. CLASSES is a parameterized
// loop:
//
//   - "registered" — vjt (seeded user bound to bahamut-test with
//     #bofh autojoin). DRIVEN end-to-end. The shipping reality across
//     the live archive + delete + chip + modal surfaces.
//   - "visitor" — blocked on `feedback_visitor_mint_e2e_cold_start`:
//     the synchronous bahamut-test mint pathway 504s on cold-start
//     because `POST /auth/login {identifier: nick}` exceeds the
//     3s `login_probe_timeout_ms` before the first upstream IRC
//     connection completes. Same blocker as M-8 + U-4. The
//     production behavior is otherwise covered by per-bucket UI
//     shape specs (UX-1/UX-2 use vjt; the underlying ArchiveModal
//     + InlineConfirmButton render is subject-agnostic — the same
//     DOM applies once the visitor cold-start unblock lands).
//   - "nickserv" — not seeded in the e2e harness. vjt's bahamut-test
//     bind uses `--auth password-only`; nickserv-identified path
//     (`--auth nickserv`) would require a second seeded user with a
//     services NICK + cleartext password. The Archive surface +
//     delete are class-agnostic — nothing in `Scrollback.delete_for_dm`
//     or `:archive_changed` broadcast keys off subject KIND. Unit
//     coverage of the controller surface is at
//     `archive_controller_test.exs` (subject-shape-agnostic).
//
// The loop structure is preserved so a future operator unblocking
// visitor cold-start can flip the skip + add nickserv seeding without
// restructuring the spec.

import { expect, test } from "@playwright/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

type UserClass = {
  name: "registered" | "visitor" | "nickserv";
  skipReason?: string;
};

const CLASSES: ReadonlyArray<UserClass> = [
  { name: "registered" },
  {
    name: "visitor",
    skipReason:
      "blocked on feedback_visitor_mint_e2e_cold_start — synchronous mint 504 on bahamut-test cold-start",
  },
  {
    name: "nickserv",
    skipReason:
      "no nickserv-identified user seeded in e2e harness (vjt bind uses --auth password-only); archive surface is subject-agnostic — unit-covered at archive_controller_test.exs",
  },
];

test.afterEach(async () => {
  // Restore seeded baseline so the next spec sees #bofh joined.
  const vjt = getSeededVjt();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
});

test("@webkit UX-Z cluster — Dynamic Island clearance + BottomBar archive chip + delete (parity matrix)", async ({
  page,
}) => {
  for (const klass of CLASSES) {
    if (klass.skipReason) {
      // Loop preserves the parity-matrix shape per
      // feedback_e2e_user_class_parity_matrix; skipped classes log
      // their reason so the next operator unblocking them sees the
      // hook. test.info().annotations is the playwright-idiomatic
      // way to surface a skip rationale without failing the spec.
      test.info().annotations.push({
        type: `skip-${klass.name}`,
        description: klass.skipReason,
      });
      continue;
    }

    // Only the "registered" class falls through to here today.
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    // ── UX-3 BIS — .shell.shell-mobile carries safe-area inset ──
    //
    // Surface the empty-toolbar by PARTing the autojoin channel (so
    // selectedChannel goes back to null + empty stub renders), then
    // assert the SHELL container — not the bars — carries the inset.
    // See ux-3-empty-toolbar-island.spec.ts for the WHY (the original
    // bar-level padding cleared content but left the bar's outer box
    // under the island, where iOS captures touches).
    await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
    const emptyToolbar = page.locator(".shell-empty-toolbar");
    await expect(emptyToolbar).toBeVisible({ timeout: 10_000 });

    const shellPadding = await page.evaluate(() => {
      function visitRules(rules: CSSRuleList): { top: string; bottom: string } | null {
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSMediaRule) {
            const inner = visitRules(rule.cssRules);
            if (inner) return inner;
            continue;
          }
          if (!(rule instanceof CSSStyleRule)) continue;
          const selectors = rule.selectorText.split(",").map((s) => s.trim());
          if (!selectors.includes(".shell-mobile")) continue;
          return {
            top: rule.style.getPropertyValue("padding-top").trim(),
            bottom: rule.style.getPropertyValue("padding-bottom").trim(),
          };
        }
        return null;
      }
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        const found = visitRules(rules);
        if (found) return found;
      }
      return null;
    });
    expect(shellPadding).not.toBeNull();
    expect(shellPadding?.top ?? "").toContain("safe-area-inset-top");
    expect(shellPadding?.bottom ?? "").toContain("safe-area-inset-bottom");

    // ── UX-2 — BottomBar archive chip surfaces post-PART ──
    //
    // The PART above moved #bofh into archive. BottomBar's eager
    // createEffect calls loadArchive on mount, and the
    // `archive_changed` broadcast on PART re-triggers the fetch, so
    // the chip should appear within the archive-broadcast round-trip.
    const networkSection = page.locator(".bottom-bar-network", {
      has: page.locator(".bottom-bar-network-chip", { hasText: NETWORK_SLUG }),
    });
    const chip = networkSection.locator(".bottom-bar-archive-chip");
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await expect(chip).toContainText("Archive");
    await chip.tap();

    const modal = page.locator(".archive-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(modal.locator(".archive-modal-header h2")).toContainText(NETWORK_SLUG);

    const row = modal.locator(".archive-modal-row", { hasText: CHANNEL });
    await expect(row).toHaveCount(1);

    // ── UX-1 — delete × confirms + drops entry + scrollback ──
    //
    // InlineConfirmButton two-step: first tap arms ("really
    // delete?"), second tap fires DELETE → server broadcasts
    // `archive_changed` → modal row vanishes.
    const deleteBtn = page.getByTestId(`archive-modal-delete-${NETWORK_SLUG}-${CHANNEL}`);
    await expect(deleteBtn).toHaveText("×");
    await deleteBtn.tap();
    await expect(deleteBtn).toHaveText("really delete?", { timeout: 2_000 });
    await deleteBtn.tap();
    await expect(row).toHaveCount(0, { timeout: 5_000 });

    // Close the modal so the test ends with the cic in a clean
    // state (subsequent classes / afterEach re-JOIN).
    await modal.getByLabel("close archive").tap();
    await expect(modal).not.toBeVisible({ timeout: 3_000 });

    // Smoking gun: re-JOIN the channel and confirm the scrollback
    // is empty (rows were actually deleted server-side, not just
    // hidden from the cic cache). Mirror of UX-1's spec.
    await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible({ timeout: 10_000 });
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    const messageRows = page.locator(".scrollback-line[data-kind='privmsg']");
    await expect(messageRows).toHaveCount(0, { timeout: 3_000 });
  }
});
