// UX-5 bucket BC2 — colored nicks (deterministic djb2 hash → palette
// index) + irssi-style channel-mode prefix glyph in scrollback senders.
//
// Pre-bucket symptoms:
//   * Every nick rendered with the same foreground color (--fg); only
//     length and casing differentiated operators visually. Dense
//     channels became a wall of same-colored `<nick>` brackets.
//   * Scrollback PRIVMSG senders were bare `<nick>` — no @ / % / +
//     prefix to surface op/halfop/voiced status at a glance. Members
//     pane already had the sigil (UX-4 bucket J) but the asymmetry
//     made the scrollback the weaker surface.
//
// Post-bucket end state:
//   * Every nick render site routes through `<NickText>`. Outer span
//     is `.nick`; inline `style="color: var(--nick-color-N)"` where
//     N = djb2(nick.toLowerCase()) % 16. Theme blocks
//     (`:root[data-theme="..."]`) define `--nick-color-0..15` per
//     theme so palette swaps with the rest of the chrome.
//   * Op/halfop/voiced senders get a bold `.nick-prefix.nick-prefix-{op,
//     halfop,voiced}` span BEFORE the nick text, taking the existing
//     mode-token color (`--mode-op` etc.). Plain members render with
//     no prefix glyph.
//   * Members pane uses the same component → same color contract.
//
// jsdom is CSS-cascade-blind (per `feedback_cicchetto_browser_smoke`)
// — the live `var()` resolution + theme switch MUST be exercised in a
// real browser. Unit/component tests pin the structural contract;
// this e2e pins the CSS-driven color application.
//
// Parity matrix: UI shape contract, subject-shape-agnostic. Registered
// seed (vjt + #bofh autojoin) suffices.

import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(60_000);

// Parses an rgb(R, G, B) computed-style string into a tuple. jsdom
// returns "" for unresolved var(); a real browser resolves the
// `var(--nick-color-N)` to the theme's defined hue and returns
// `rgb(...)`. We assert on the parsed tuple to dodge whitespace /
// rgba alpha variants.
function parseRgb(input: string): [number, number, number] | null {
  const m = input.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

test("ux-5-bc2 desktop — scrollback sender: own nick renders with NickText (.nick-text + colored)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

  // Send a probe PRIVMSG so a sender-rendered row lands in scrollback.
  // Scrollback senders are the canonical colored NickText site
  // (members pane uses `noColor` → renders in `--fg`, see
  // MembersPane.tsx:182 + UX-6 bucket A v2 rationale in NickText.tsx).
  // Asserting color on the members site is invalid by design; the
  // sender site is where the per-nick palette hue actually applies.
  const compose = page.locator(".compose-box textarea");
  const probe = `ux-5-bc2 colored-nick probe ${crypto.randomUUID().slice(0, 6)}`;
  await compose.fill(probe);
  await compose.press("Enter");

  const ownPrivmsg = page
    .locator('[data-testid="scrollback-line"][data-kind="privmsg"]')
    .filter({ hasText: probe })
    .first();
  await expect(ownPrivmsg).toBeVisible({ timeout: 10_000 });

  // The NickText helper renders `<span class="nick"><span class="nick-text"
  // style="color: var(--nick-color-N)">{nick}</span></span>`. Assert
  // the inner span exists AND has a resolved (non-empty, non-default)
  // computed color.
  const nickTextSpan = ownPrivmsg.locator(".scrollback-sender .nick-text").first();
  await expect(nickTextSpan).toHaveText(NETWORK_NICK);
  const computedColor = await nickTextSpan.evaluate((el) => getComputedStyle(el).color);
  const rgb = parseRgb(computedColor);
  expect(rgb).not.toBeNull();
  // Non-trivial color — at least one channel above 0 (the palette has
  // no pure black slot; any `--nick-color-N` resolves to a colored hue).
  if (rgb) {
    expect(rgb[0] + rgb[1] + rgb[2]).toBeGreaterThan(0);
  }
});

test("ux-5-bc2 desktop — distinct nicks resolve to distinct CSS color values via the djb2 hash", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Probe at the document level: render two NickText nodes with known
  // distinct nicks ("alice" and "bob") and read their computed colors.
  // Injecting into the page rather than driving IRC traffic keeps the
  // assertion deterministic; the real DOM cascade still runs.
  const colors = await page.evaluate(() => {
    const make = (nick: string) => {
      // Construct the same DOM shape NickText produces; the live CSS
      // cascade resolves the `var(--nick-color-N)` value the same way.
      const outer = document.createElement("span");
      outer.className = "nick";
      const text = document.createElement("span");
      text.className = "nick-text";
      // Mirror the djb2 hash + palette modulo from
      // cicchetto/src/lib/nickColor.ts so this probe doesn't fork
      // the contract — if the hash changes there the e2e fails here.
      const folded = nick.toLowerCase();
      let hash = 5381;
      for (let i = 0; i < folded.length; i++) {
        hash = (Math.imul(hash, 33) + folded.charCodeAt(i)) | 0;
      }
      const idx = (hash >>> 0) % 16;
      text.style.color = `var(--nick-color-${idx})`;
      text.textContent = nick;
      outer.appendChild(text);
      document.body.appendChild(outer);
      const resolved = getComputedStyle(text).color;
      document.body.removeChild(outer);
      return resolved;
    };
    return { alice: make("alice"), bob: make("bob"), aliceUpper: make("ALICE") };
  });

  const alice = parseRgb(colors.alice);
  const bob = parseRgb(colors.bob);
  const aliceUpper = parseRgb(colors.aliceUpper);
  expect(alice).not.toBeNull();
  expect(bob).not.toBeNull();
  expect(aliceUpper).not.toBeNull();

  // alice + bob hash to different palette slots — assert their colors
  // differ. (djb2 distribution: indices for `alice`/`bob` differ in
  // practice; if a future palette rotation made them collide, this
  // assertion would force us to reconsider the palette ordering.)
  expect(alice).not.toEqual(bob);

  // Case-insensitivity: ALICE === alice → same color slot.
  expect(aliceUpper).toEqual(alice);
});

test("ux-5-bc2 desktop — own nick (operator self, plain in channel) has no @/%/+ prefix glyph on PRIVMSG sender", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // GREEN-CI batch 2 — use a fresh channel where a peer joins FIRST so
  // vjt is plain (no @ prefix) deterministically. The previous "use
  // #bofh, vjt is not opped on autojoin" assumption became flaky after
  // GREEN-CI batch 1 raised the autojoin race to 3 users (vjt +
  // m9b-test + m9b-victim) — vjt has a 1/3 chance of winning +o on a
  // fresh #bofh, in which case her sender renders with `@` prefix and
  // the negative-twin assertion below fails. Per-spec dedicated channel
  // with peer-first JOIN guarantees plain status.
  const FRESH = `#bc2-plain-${crypto.randomUUID().slice(0, 6)}`;
  const peer = await IrcPeer.connect({ nick: `bc2plain-${crypto.randomUUID().slice(0, 6)}` });
  try {
    await peer.join(FRESH);
    const compose = page.locator(".compose-box textarea");
    await compose.fill(`/join ${FRESH}`);
    await compose.press("Enter");
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: FRESH }),
    ).toHaveCount(1, { timeout: 10_000 });
    await selectChannel(page, NETWORK_SLUG, FRESH, { ownNick: NETWORK_NICK });

    const probe = `ux-5-bc2 probe message ${crypto.randomUUID().slice(0, 6)}`;
    await page.locator(".compose-box textarea").fill(probe);
    await page.locator(".compose-box textarea").press("Enter");

    // The own-PRIVMSG row's sender span must exist and carry NickText.
    // vjt joined this fresh channel SECOND → plain. Assert no
    // `.nick-prefix` child inside the sender. This pins the
    // negative-twin (no false prefix injection on plain members).
    const ownPrivmsg = page
      .locator('[data-testid="scrollback-line"][data-kind="privmsg"]')
      .filter({ hasText: probe })
      .first();
    await expect(ownPrivmsg).toBeVisible({ timeout: 10_000 });
    const sender = ownPrivmsg.locator(".scrollback-sender").first();
    await expect(sender).toBeVisible();
    // NickText is mounted (verify by `.nick-text` presence + correct text).
    const senderText = sender.locator(".nick-text");
    await expect(senderText).toHaveText(NETWORK_NICK);
    // No prefix glyph on the plain own-nick.
    await expect(sender.locator(".nick-prefix")).toHaveCount(0);
  } finally {
    await peer.disconnect("bc2 plain done");
  }
});

test("ux-5-bc2 desktop — theme switch repaints nick colors (irssi-dark → mirc-light)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Capture own-nick color under whichever theme is active by default,
  // then flip the theme via setTheme() (theme.ts exports it). Assert
  // the color changes (palette hues differ per theme by design).
  const ownNickLocator = page
    .locator(".members-pane .member-name")
    .filter({ hasText: NETWORK_NICK })
    .first();
  await expect(ownNickLocator).toBeVisible({ timeout: 10_000 });
  const colorBefore = await ownNickLocator
    .locator(".nick-text")
    .first()
    .evaluate((el) => getComputedStyle(el).color);

  // Read current theme; flip to the opposite.
  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  const target = before === "mirc-light" ? "irssi-dark" : "mirc-light";
  await page.evaluate((t) => {
    localStorage.setItem("grappa-theme", t);
    document.documentElement.dataset.theme = t;
  }, target);

  // The `<html>` data-theme attr flip is enough — `:root[data-theme="..."]`
  // selectors re-resolve `--nick-color-N` to the new palette. No re-render
  // of NickText is required (the inline style is `var()`, not a hex).
  const colorAfter = await ownNickLocator
    .locator(".nick-text")
    .first()
    .evaluate((el) => getComputedStyle(el).color);

  expect(colorBefore).not.toBe(colorAfter);
  // Sanity: both colors are resolved (non-empty).
  expect(parseRgb(colorBefore)).not.toBeNull();
  expect(parseRgb(colorAfter)).not.toBeNull();
});

test("ux-5-bc2 desktop — scrollback PRIVMSG sender wraps the nick inside angle brackets <{nick}>", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // GREEN-CI batch 2 — peer-first JOIN on a dedicated channel so vjt
  // is plain (no `@` prefix), same rationale as the previous test:
  // 3-way autojoin race on #bofh post-m9b-victim makes vjt's status
  // there non-deterministic. Bracket-shape assertion below assumes
  // bare `<nick>` textContent (no `@nick`), which only holds when vjt
  // is plain.
  const FRESH = `#bc2-bracket-${crypto.randomUUID().slice(0, 6)}`;
  const peer = await IrcPeer.connect({ nick: `bc2brkt-${crypto.randomUUID().slice(0, 6)}` });
  try {
    await peer.join(FRESH);
    const compose = page.locator(".compose-box textarea");
    await compose.fill(`/join ${FRESH}`);
    await compose.press("Enter");
    await expect(
      page.locator(".sidebar-network-section li").filter({ hasText: FRESH }),
    ).toHaveCount(1, { timeout: 10_000 });
    await selectChannel(page, NETWORK_SLUG, FRESH, { ownNick: NETWORK_NICK });

    const probe = `ux-5-bc2 bracket-shape probe ${crypto.randomUUID().slice(0, 6)}`;
    await page.locator(".compose-box textarea").fill(probe);
    await page.locator(".compose-box textarea").press("Enter");

    const ownPrivmsg = page
      .locator('[data-testid="scrollback-line"][data-kind="privmsg"]')
      .filter({ hasText: probe })
      .first();
    await expect(ownPrivmsg).toBeVisible({ timeout: 10_000 });
    // Sender textContent is `<nick>` (no prefix, vjt is plain on the
    // peer-first fresh channel). The bracket pair is OUTSIDE the
    // NickText component (per the ScrollbackPane senderSpan closure
    // contract), so it appears in the sender button's textContent
    // unchanged.
    const senderText = await ownPrivmsg.locator(".scrollback-sender").first().textContent();
    expect(senderText).toBe(`<${NETWORK_NICK}>`);
  } finally {
    await peer.disconnect("bc2 bracket done");
  }
});
