// Read-cursor store — localStorage-backed per-channel read position.
//
// C7.3: tracks the server_time of the last-read message per (networkSlug,
// channel) pair. Used by ScrollbackPane to render the unread-marker:
// messages after the cursor are "unread"; messages at or before are "read".
//
// Key format: `rc:<networkSlug>:<channel>` — human-readable, scoped by the
// `rc:` prefix so bulk clearance is possible without touching unrelated keys.
//
// Identity-scoped cleanup: `clearReadCursors()` is called on logout/rotation
// (mirrors the on(token) cleanup arms in scrollback.ts / selection.ts).
// The auth module calls this when the bearer changes. This prevents a
// cross-user cursor leak when a second user logs in on the same browser.
//
// Why a separate module (not buried in selection.ts or scrollback.ts):
//   - Read-cursor is localStorage-only (no Solid signal needed — the
//     cursor is written once per channel-leave, read once per channel-enter;
//     no reactive consumer exists).
//   - Identity-scoped cleanup is the only lifecycle concern; the module is
//     intentionally slim (3 functions + a key helper).
//   - Mirrors the "one concern per module" pattern: scrollback.ts owns the
//     in-memory message list, selection.ts owns the selected-channel signal,
//     readCursor.ts owns the durable read position.
//
// C8 extension point: if the cursor ever needs to drive a server-side
// MARKREAD endpoint, extend this module with an async flush function — the
// localStorage shape stays as the synchronous fast path.

const KEY_PREFIX = "rc:";

const storageKey = (networkSlug: string, channel: string): string =>
  `${KEY_PREFIX}${networkSlug}:${channel}`;

/**
 * Returns the stored read-cursor server_time for `(networkSlug, channel)`,
 * or null if no cursor has been stored yet.
 */
export const getReadCursor = (networkSlug: string, channel: string): number | null => {
  const raw = localStorage.getItem(storageKey(networkSlug, channel));
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Persists the read cursor for `(networkSlug, channel)` to localStorage.
 * `serverTime` is the epoch-ms timestamp of the last-read message.
 */
export const setReadCursor = (networkSlug: string, channel: string, serverTime: number): void => {
  localStorage.setItem(storageKey(networkSlug, channel), String(serverTime));
};

/**
 * Clears ALL read-cursor entries from localStorage. Called on identity
 * transition (logout / token rotation) so a new user starts with a clean
 * slate and doesn't inherit the previous user's read positions.
 */
export const clearReadCursors = (): void => {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(KEY_PREFIX)) keysToRemove.push(k);
  }
  for (const k of keysToRemove) localStorage.removeItem(k);
};
