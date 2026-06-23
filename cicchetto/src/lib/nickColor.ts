import type { ChannelMembers } from "./memberTypes";
import { nickEquals } from "./nickEquals";

// UX-5 bucket BC2 — colored nicks (xchat-style) + scrollback-side
// mode-prefix glyph lookup.
//
// Two concerns, ONE module (per CLAUDE.md "implement once, reuse
// everywhere"; the render-side consumers always need BOTH the color
// and the prefix for a given (channel, nick) pair, and bundling here
// avoids two parallel import chains across the ~13 render sites).
//
// ## Colored nicks
//
// Each nick maps to a deterministic palette index via the djb2 hash
// (https://theartincomputerprogramming.com/djb2). djb2 chosen over
// fnv1a for two reasons: (1) ~5-line implementation that fits in
// the head; (2) decades of irc-client precedent (xchat/hexchat use
// the same idea — they vary the multiplier but not the structure).
//
// Hash input is the LOWERCASED nick (RFC 2812 §2.2 case-folding;
// `Vjt` and `vjt` are the same operator, must hash to the same color).
// Bucket count is `NICK_PALETTE_SIZE` (16) — xchat uses 16, weechat
// 10, irssi 12; 16 was picked here to interpolate enough hues for
// dense channels without overflowing the readability budget.
//
// The actual hue colors live in `cicchetto/src/themes/default.css`
// as `--nick-color-0` through `--nick-color-15` under each
// `:root[data-theme="..."]` block. Theme-aware by construction: the
// helper produces a `var(--nick-color-N)` string; the theme owns the
// hue. Switching themes re-renders the same nicks in a new palette
// without touching this module.
//
// ## Scrollback sender prefix
//
// Members-pane nicks already carry the prefix via `memberSigil`
// (op `@`, halfop `%`, voiced `+`, plain ` `). Scrollback PRIVMSG
// senders are bare `{nick}` interpolations — no per-message mode
// flag on the wire (scrollback `messages` table is mode-agnostic;
// modes belong to the live members store). The `senderPrefix`
// helper looks up the CURRENT membership for (channel, nick) and
// returns the highest-precedence prefix glyph for inline render in
// `<sender>` / `*sender` lines.
//
// Returns empty string `""` (not " ") for plain / unknown members:
// scrollback senders live inside `<...>` brackets and any space
// would render as `< nick>` with a visible gap. The members-pane
// padding-space (`memberSigil` returns " ") only makes sense in a
// column layout where prefix-aligned glyphs share width.

export const NICK_PALETTE_SIZE = 16;

// djb2 hash, classic 5381 seed + 33 multiplier. Folded modulo
// NICK_PALETTE_SIZE at the boundary; intermediate keeps full 32-bit
// width via Math.imul to avoid sign-bit weirdness from `* 33`.
export const nickColorIndex = (nick: string): number => {
  const folded = nick.toLowerCase();
  let hash = 5381;
  for (let i = 0; i < folded.length; i++) {
    hash = (Math.imul(hash, 33) + folded.charCodeAt(i)) | 0;
  }
  // `>>> 0` coerces to unsigned 32-bit so the modulo is always
  // non-negative — `-1 % 16` is `-1` in JS, which would slot us
  // outside the palette.
  return (hash >>> 0) % NICK_PALETTE_SIZE;
};

export const nickColorVar = (nick: string): string => `var(--nick-color-${nickColorIndex(nick)})`;

// Highest-precedence channel-mode prefix glyph for a (members, nick)
// pair. Mirrors the precedence in `memberSigil` (@ > % > +) — both
// derive from the same `MemberEntry.modes` array, just diverge on
// what to return for the plain case.
export const senderPrefix = (
  members: ChannelMembers | undefined,
  nick: string,
): "@" | "%" | "+" | "" => {
  if (!members) return "";
  const entry = members.find((m) => nickEquals(m.nick, nick));
  if (!entry) return "";
  if (entry.modes.includes("@")) return "@";
  if (entry.modes.includes("%")) return "%";
  if (entry.modes.includes("+")) return "+";
  return "";
};

// #25: glyph for a CONTENT row's own sender, read from the server's
// send-time snapshot (`meta.sender_prefix`) instead of live member
// state. The server captures the sender's grade at persist time so a
// later MODE change can't retroactively re-prefix old lines. Returns ""
// when the snapshot is absent — a plain sender, or a row persisted
// before #25 landed — so cic never falls back to a live-derived guess
// (which is exactly the bug). `meta` is the untyped wire bag, so the
// value is validated against the three glyphs here.
export const snapshotSenderPrefix = (meta: Record<string, unknown>): "@" | "%" | "+" | "" => {
  const p = meta.sender_prefix;
  return p === "@" || p === "%" || p === "+" ? p : "";
};
