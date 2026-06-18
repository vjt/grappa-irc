// Per-identity persistence of the last focused window, for cold-start
// restore (issue #35). Mirrors the localStorage discipline of
// `clientId.ts` / `theme.ts` / `fontSize.ts` / `sidebarWidths.ts`:
// safe `try/catch` around every access (Safari Private Browsing zero
// quota + SecurityError on storage-disabled origins) and a single
// `STORAGE_KEY` prefix.
//
// Scoping: keyed by `user().id` (stable UUID from /me), so a multi-
// account browser keeps a separate last-focused window per identity.
// On logout the prior identity's entry survives, ready for the next
// login with the same id.
//
// Stored shape: `{slug, name, kind}` JSON. Restore validity is the
// caller's problem — `Shell.tsx`'s cold-load arm checks against
// `channelsBySlug` / `queryWindowsByNetwork` / `networks` and falls
// back to the existing home default when the saved window is no
// longer live.

import type { WindowKind } from "./windowKinds";

const STORAGE_PREFIX = "cic.lastFocusedChannel.";

export type PersistedFocus = {
  networkSlug: string;
  channelName: string;
  kind: WindowKind;
};

const keyFor = (userId: string): string => `${STORAGE_PREFIX}${userId}`;

export function loadLastFocused(userId: string): PersistedFocus | null {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedFocus>;
    if (
      typeof parsed.networkSlug !== "string" ||
      typeof parsed.channelName !== "string" ||
      typeof parsed.kind !== "string"
    ) {
      return null;
    }
    return {
      networkSlug: parsed.networkSlug,
      channelName: parsed.channelName,
      kind: parsed.kind as WindowKind,
    };
  } catch {
    return null;
  }
}

export function saveLastFocused(userId: string, focus: PersistedFocus): void {
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(focus));
  } catch {
    // Quota / SecurityError — drop silently, same posture as the
    // other localStorage helpers. Worst case: next reload lands on
    // home (the pre-#35 behaviour).
  }
}
