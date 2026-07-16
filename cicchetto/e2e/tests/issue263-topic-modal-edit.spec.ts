// #263 — move topic editing INTO the modal (supersedes the #74 inline strip
// editor). The full modal-edit flow, proven end-to-end against live upstream:
//
//   (a) tapping the topic strip ALWAYS opens the read-only modal (for everyone
//       — the inline in-place editor from #74 is gone);
//   (b) an OP (topic-set rights) sees a ✏️ edit toggle in the modal; a non-op
//       (a +t-locked channel we don't hold ops on) sees NO toggle;
//   (c) ✏️ → the topic text swaps for a multi-line <textarea> + ❌ cancel + ✅
//       save; ❌ cancel REVERTS the draft, restores read-only + the ✏️, and the
//       modal STAYS OPEN (does not close);
//   (e) ESC while editing runs cancelEdit via the #232 shared overlay stack
//       (revert + stay open + ✏️ back), NOT closeModal — proving the edit-aware
//       onEscape branch works in a real browser with the textarea focused;
//   (d) ✅ save submits via the EXISTING `postTopic` REST door → the session
//       relays TOPIC upstream → bahamut echoes `topic_changed` → the modal
//       CLOSES and the bar repaints (cic mirrors the server: NO optimistic
//       write, so the bar reflecting the topic PROVES the round-trip, and a
//       second in-channel peer witnessing the raw TOPIC proves the real send);
//   (e) a server REJECT preserves the draft + keeps the modal open (S21
//       no-false-success — mirrors s21-topic-clear-error-surface.spec.ts);
//   (f) a MULTI-LINE textarea value is flattened to a SINGLE wire line on
//       submit — the critical domain gotcha. The server REJECTS a body with
//       raw \r/\n (Identifier.safe_line_token?/1 → :invalid_line), so an
//       unflattened submit would fail the save entirely; the peer only ever
//       sees the one-line flattened topic. If the flatten regressed, the modal
//       would stay open on the reject and the peer would never see the topic —
//       this spec would fail, which is the point.
//
// vjt founds a fresh per-run channel (creator → chanop, which beats the default
// +t topic-lock so the ✏️ toggle is offered), NOT the shared autojoin #bofh —
// mutating a shared topic leaks into later specs (seed-expansion cascade
// hazard). The channel is PARTed in `finally`. Model: issue74-inline-topic-edit
// (op-editable fresh channel + peer topic witness) + s21-topic-clear-error-
// surface (awaited send, no false success).
//
// This needs the live user-level session + upstream round-trip + the shared
// desktop/mobile modal, which jsdom/vitest cannot exercise — the e2e harness is
// the only place to prove the end-to-end modal edit.

import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

test.describe("#263 topic editing inside the modal", () => {
  test("op edits the topic from the modal: read-only → ✏️ → cancel-stays-open → esc-cancel → multi-line save flattens + closes", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    const channel = `#e2e263-${crypto.randomUUID().slice(0, 8)}`;
    // Multi-line input (three lines) — proves the flatten: the peer must see
    // the single flattened line, never the raw multi-line string.
    const line1 = `modal edit ${crypto.randomUUID().slice(0, 6)}`;
    const line2 = "second line";
    const line3 = "third line";
    const multiline = `${line1}\n${line2}\n${line3}`;
    const flattened = `${line1} ${line2} ${line3}`;

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

    const peer = await IrcPeer.connect({ nick: `e2e263-${crypto.randomUUID().slice(0, 4)}` });
    try {
      // vjt founds + joins the fresh channel (→ chanop, beats +t), then selects.
      await composeSend(page, `/join ${channel}`);
      await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toBeVisible({ timeout: 10_000 });
      await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });
      await peer.join(channel);

      const strip = page.locator('[data-testid="topic-strip"]');
      const modal = page.locator(".topic-modal");
      const editToggle = page.locator('[data-testid="topic-modal-edit"]');
      const editor = page.locator('[data-testid="topic-modal-editor"]');
      const cancelBtn = page.locator('[data-testid="topic-modal-cancel"]');
      const saveBtn = page.locator('[data-testid="topic-modal-save"]');

      // (a) tapping the strip opens the READ-ONLY modal (no inline editor ever
      // appears — the #74 in-place editor is gone). Retry to absorb the
      // members/modes seed race (op sigil not yet cached → toggle not yet
      // rendered): re-open until the ✏️ is present.
      await expect(async () => {
        if (!(await modal.isVisible().catch(() => false))) {
          await strip.click();
        }
        await expect(modal).toBeVisible({ timeout: 1_000 });
        // The old inline strip editor must NOT exist anymore.
        await expect(page.locator('[data-testid="topic-editor"]')).toHaveCount(0);
        // (b) op sees the ✏️ edit toggle once the op sigil is cached.
        await expect(editToggle).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 20_000 });

      // Read-only first: no textarea, no cancel/save until ✏️ is pressed.
      await expect(editor).toHaveCount(0);
      await expect(cancelBtn).toHaveCount(0);
      await expect(saveBtn).toHaveCount(0);

      // (c) ✏️ → textarea + ❌/✅ appear, ✏️ disappears.
      await editToggle.click();
      await expect(editor).toBeVisible();
      await expect(cancelBtn).toBeVisible();
      await expect(saveBtn).toBeVisible();
      await expect(editToggle).toHaveCount(0);
      // Seeded with the raw (empty here — fresh channel) topic.
      await expect(editor).toHaveValue("");

      // ❌ cancel REVERTS the draft + restores read-only, modal STAYS OPEN.
      await editor.fill("discard me");
      await cancelBtn.click();
      await expect(modal).toBeVisible();
      await expect(editor).toHaveCount(0);
      await expect(editToggle).toBeVisible();

      // (e) ESC while editing = cancel via the #232 shared overlay stack:
      // revert + stay open + ✏️ back, NOT closeModal. The textarea is focused
      // (fill focuses it) — proves the global keydown Esc authority reaches the
      // edit-aware onEscape even with focus inside the editor.
      await editToggle.click();
      await expect(editor).toBeVisible();
      await editor.fill("esc discard me");
      await page.keyboard.press("Escape");
      await expect(editor).toHaveCount(0);
      await expect(modal).toBeVisible();
      await expect(editToggle).toBeVisible();

      // (f) re-enter edit, type a MULTI-LINE value, ✅ save.
      await editToggle.click();
      await expect(editor).toBeVisible();
      await editor.fill(multiline);
      // Arm the upstream witness BEFORE saving. The peer only ever sees the
      // FLATTENED one-line topic — an unflattened submit is rejected upstream
      // (:invalid_line) and this never resolves → the test fails.
      const witnessed = peer.waitForTopic(channel, flattened);
      await saveBtn.click();

      // Real upstream send proven: the in-channel peer saw `TOPIC #chan :<flat>`.
      await witnessed;

      // (d) save CLOSES the modal on success.
      await expect(modal).toHaveCount(0, { timeout: 10_000 });

      // The bar reflects the FLATTENED topic — via the server's relayed
      // topic_changed → topicByChannel (NO optimistic client write).
      await expect(page.locator(".topic-bar-topic")).toContainText(flattened, { timeout: 10_000 });
    } finally {
      await peer.disconnect("e2e263 done");
      await partChannel(vjt.token, NETWORK_SLUG, channel).catch(() => {});
    }
  });

  test("save on a rejected topic preserves the draft and keeps the modal open (S21)", async ({
    page,
  }) => {
    // Force a DETERMINISTIC, SYNCHRONOUS server reject (no upstream round-trip,
    // no shared-topic mutation): a body over the `BodyLimit` byte cap
    // (max_body_bytes, ≤ 8192) is rejected at the grappa boundary with
    // {:error, :body_too_large} → 413 → `postTopic` throws → S21 surfaces
    // inline + preserves the draft + keeps the modal open. Mirrors the
    // synchronous-reject strategy of s21-topic-clear-error-surface.spec.ts.
    const vjt = getSeededVjt();
    const channel = `#e2e263s21-${crypto.randomUUID().slice(0, 8)}`;
    const overLong = "z".repeat(9000); // > BodyLimit cap (8192) → 413 reject

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

    try {
      await composeSend(page, `/join ${channel}`);
      await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toBeVisible({ timeout: 10_000 });
      await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });

      const strip = page.locator('[data-testid="topic-strip"]');
      const modal = page.locator(".topic-modal");
      const editToggle = page.locator('[data-testid="topic-modal-edit"]');
      const editor = page.locator('[data-testid="topic-modal-editor"]');
      const saveBtn = page.locator('[data-testid="topic-modal-save"]');
      const editError = page.locator(".topic-modal-edit-error[role='alert']");

      await expect(async () => {
        if (!(await modal.isVisible().catch(() => false))) {
          await strip.click();
        }
        await expect(editToggle).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 20_000 });

      await editToggle.click();
      await expect(editor).toBeVisible();
      await editor.fill(overLong);
      await saveBtn.click();

      // S21 — the reject surfaces inline, the draft SURVIVES, modal stays open.
      await expect(editError).toBeVisible({ timeout: 10_000 });
      await expect(editor).toHaveValue(overLong);
      await expect(modal).toBeVisible();
    } finally {
      await partChannel(vjt.token, NETWORK_SLUG, channel).catch(() => {});
    }
  });
});
