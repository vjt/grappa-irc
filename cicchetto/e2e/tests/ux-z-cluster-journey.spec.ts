// UX-Z — full UX cluster end-to-end journey.
//
// Mirrors `ios-z-cluster-journey.spec.ts` / `m-z-admin-cluster-journey.spec.ts`
// / `u-z-cap-honesty-cluster-journey.spec.ts` shape: ONE spec replays all 3
// UX buckets back-to-back inside a single webkit iPhone 15 session, so the
// cluster's shipping reality is exercised in CI on every integration run.
//
// Bucket coverage:
//   * UX-3 .shell-empty-toolbar Dynamic Island clearance — walk
//     document.styleSheets for the rule, assert padding declaration
//     contains `env(` and `safe-area-inset-top`. Runs FIRST (pre-PART,
//     pre-modal) so the empty-toolbar is surfaceable via the BUG5a
//     contract (PART → setSelectedChannel(null) → empty stub).
//   * UX-2 archive surface (#473 rework) — after PARTing seeded channel,
//     open the archive via the always-on RailActions archive button in the
//     rail drawer (mobile: open rail → tap archive; openArchive helper).
//     The grouped ArchiveModal shows every network as a collapsible group;
//     expand the seeded network to reveal the archived row. Supersedes the
//     ShellChrome `shell-chrome-archive` button (removed #473) and the
//     earlier per-network `.bottom-bar-archive-chip`.
//   * UX-1 archive delete × + permanent scrollback drop — inside the
//     modal, tap × (arms confirm), tap again (DELETE fires →
//     `archive_changed` broadcast → entry gone from modal).
//
// Per-class parity matrix per `feedback_e2e_user_class_parity_matrix`:
// the cluster's per-bucket specs are subject-agnostic UI shape buckets
// (single visitor login sufficient there). UX-Z is the compositional
// spec — runs as the "registered" parity arm (vjt seed). Visitor +
// nickserv arms are NOT driven here:
//   - visitor: ArchiveModal + InlineConfirmButton render keys off no
//     visitor-specific data; per-bucket UX-1/UX-2 specs cover the
//     subject-agnostic UI shape using vjt.
//   - nickserv: vjt's bahamut-test bind uses --auth password-only; no
//     nickserv-identified user is seeded in the e2e harness. The
//     archive surface + delete are class-agnostic — nothing in
//     `Scrollback.delete_for_dm` or `:archive_changed` broadcast keys
//     off subject KIND. Unit coverage of the controller surface is at
//     `archive_controller_test.exs` (subject-shape-agnostic).
//
// spec-audit-r3 (2026-05-26): dropped the prior CLASSES loop that
// skipped 2/3 arms via `continue` — parity theatre per audit verdict.
// If a future operator wires the visitor + nickserv arms, restore the
// loop and drive them; today the test is honestly "registered only."

import {
  expandArchiveGroup,
  loginAs,
  openArchive,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.afterEach(async () => {
  // Restore seeded baseline so the next spec sees #bofh joined.
  const vjt = getSeededVjt();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
});

test("@webkit UX-Z cluster — Dynamic Island clearance + RailActions archive + delete (registered class)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // ── UX-3 BIS — .shell.shell-mobile carries safe-area inset ──
  //
  // Originally surfaced via PART → `.shell-empty-toolbar` empty stub
  // → assert the SHELL container — not the bars — carries the inset.
  // UX-4 bucket L (commit 17aefeb) DROPPED `.shell-empty-toolbar`
  // from the JSX (replaced by always-visible ShellChrome bar), so
  // there's no longer an empty-stub to surface. The structural
  // invariant `.shell.shell-mobile` carrying `env(safe-area-inset-*)`
  // is testable directly from the stylesheet without any DOM-state
  // setup — assert it after `loginAs` settles.
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
  // #1127 — the BOTTOM edge is flush now: the home-indicator inset lifted
  // the shell off the bottom and exposed the transparent area behind it.
  // Still declared (an empty string would mean base `.shell`'s inset
  // cascades in at equal specificity), just zero; CSSOM may serialize the
  // authored `0` as `0px`.
  expect(shellPadding?.bottom ?? "").toMatch(/^0(px)?$/);

  // PART seed channel so the UX-2 archive-button arm has an archived
  // entry to render in the modal.
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);

  // ── UX-2 — archive opened via the always-on RailActions button (#473) ──
  //
  // The PART above moved #bofh into archive. #473 removed the ShellChrome
  // archive button; archive is now reached from the always-on archive button
  // in the RailActions rail drawer, reachable on EVERY window kind (not
  // selection-gated). After the PART bucket E's close-watcher lands selection
  // on a non-channel window (home/server) — openArchive opens the rail (via
  // the ShellChrome ☰ rail opener on non-channel windows) and taps archive.
  const modal = await openArchive(page);
  // Plain "Archive" header — the grouped modal spans all networks (no more
  // "Archive — <slug>").
  await expect(modal.locator(".archive-modal-header h2")).toHaveText("Archive");

  // Expand the seeded network's collapsible group (lazy row load) and find
  // the archived #bofh row within it.
  const group = await expandArchiveGroup(page, NETWORK_SLUG);
  const row = group.locator(".archive-modal-row", { hasText: CHANNEL });
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
  // state (afterEach re-JOINs).
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
});
