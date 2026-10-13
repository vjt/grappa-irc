// issue 2394 — on a phone no text inside a modal or lookup card could be
// selected: not the host or IP on the WHOIS card, not a /who row. The sheet's
// `@media (pointer: coarse)` block kills selection on <html>, and the
// re-enable beneath it named only the topic modal's text, so every modal and
// card added after it inherited `none`.
//
// Fix: the standing re-enable is a SHAPE — `.modal-backdrop` (every viewport
// modal, by default) and the shared `.selectable-text` class (the lookup cards,
// the topic text) — with the controls inside them (`button`, `svg`) carved back
// out. keepKeyboard.ts owns that list; touchSelectionPolicy.test.ts pins the
// sheet to it in both directions.
//
// What this spec can prove is the COMPUTED cascade on both touch engines
// (`webkit-iphone-15` and `chromium-pixel-touch` both report `pointer: coarse`
// natively). What it cannot prove is that the platform's selection handles and
// copy toolbar actually appear on a real device: Playwright webkit is not iOS
// and no project renders native selection UI — the same limit #589 and #1869
// declare. Real-device dogfood is the final word on the feel.

import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const PEER_NICK = "i2394-target";
const CHANNEL = AUTOJOIN_CHANNELS[0];

test("@webkit @touch issue 2394 — WHOIS card and /who modal text is selectable on a coarse pointer; their controls are not", async ({
  page,
}) => {
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await peer.join(CHANNEL);

    // ── the WHOIS card (a `.selectable-text` surface) ──
    await composeSend(page, `/whois ${peer.nick}`);
    const card = page.locator(".scrollback-overlay").getByTestId("whois-card");
    await expect(card).toBeVisible({ timeout: 5_000 });
    await expect(card.locator("dt", { hasText: /userhost/ })).toBeVisible();

    const cardStyles = await page.evaluate(() => {
      const us = (el: Element): string => {
        const s = getComputedStyle(el);
        return s.webkitUserSelect || s.userSelect;
      };
      const card = document.querySelector('[data-testid="whois-card"]');
      const value = card?.querySelector("dd") ?? null;
      const close = card?.querySelector(".whois-card-close") ?? null;
      if (card === null || value === null || close === null) return { missing: true } as const;
      return {
        missing: false,
        coarse: matchMedia("(pointer: coarse)").matches,
        html: us(document.documentElement),
        value: us(value),
        close: us(close),
      } as const;
    });

    // Live-surface precondition — no hollow green if a selector drifted.
    expect(cardStyles.missing).toBe(false);
    // The project really runs under the kill the fix re-enables against.
    expect(cardStyles.coarse).toBe(true);
    expect(cardStyles.html).toBe("none");
    // THE fix: the userhost value can be selected…
    expect(cardStyles.value).toBe("text");
    // …and the dismiss control stays chrome.
    expect(cardStyles.close).toBe("none");

    await card.locator(".whois-card-close").click();
    await expect(card).toBeHidden({ timeout: 2_000 });

    // ── the /who modal (a `.modal-backdrop` modal, covered by default) ──
    await composeSend(page, `/who ${CHANNEL}`);
    const modal = page.getByTestId("who-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });
    const row = modal.locator(".who-modal-row", { hasText: peer.nick });
    await expect(row.locator(".who-modal-userhost")).toContainText("@");

    const modalStyles = await page.evaluate((nick) => {
      const us = (el: Element): string => {
        const s = getComputedStyle(el);
        return s.webkitUserSelect || s.userSelect;
      };
      const modal = document.querySelector('[data-testid="who-modal"]');
      const row = Array.from(modal?.querySelectorAll(".who-modal-row") ?? []).find((r) =>
        r.textContent?.includes(nick),
      );
      const userhost = row?.querySelector(".who-modal-userhost") ?? null;
      const nickButton = row?.querySelector("button") ?? null;
      const close = modal?.querySelector(".who-modal-close") ?? null;
      if (userhost === null || nickButton === null || close === null) {
        return { missing: true } as const;
      }
      return {
        missing: false,
        userhost: us(userhost),
        nickButton: us(nickButton),
        close: us(close),
      } as const;
    }, peer.nick);

    expect(modalStyles.missing).toBe(false);
    expect(modalStyles.userhost).toBe("text");
    // The nick is a control (it opens a query), so it is carved out with the ✕.
    expect(modalStyles.nickButton).toBe("none");
    expect(modalStyles.close).toBe("none");
  } finally {
    await peer.disconnect("issue 2394 done");
  }
});
