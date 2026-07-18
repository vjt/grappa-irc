// #318 — foreground visibility heartbeat.
//
// Web Push was suppressed indefinitely for an iOS PWA the user
// backgrounded/closed: the WebSocket stays open but iOS does not reliably
// fire `visibilitychange`, so the server kept reading the socket as
// `:visible` and skipped the push — self-healing only after ~90 min when the
// zombie socket finally died.
//
// The server (Grappa.WSPresence) now trusts a `:visible` pid only while its
// last report is FRESH (read-time staleness downgrade). This is the client
// complement: while genuinely foreground, re-report visibility on a fixed
// interval. A real foreground app therefore stays fresh (foreground
// push-suppression preserved by construction), while a backgrounded app
// either (a) stops firing the timer as iOS suspends JS, or (b) — since
// `reportVisibility` re-reads the live `document.visibilityState` /
// `hasFocus()` on every call — reports hidden the moment the property
// silently flips. Either way the server goes stale and push resumes within
// `stale_ms` instead of ~90 min.
//
// REUSES the existing `visibility` verb (`reportVisibility`) — no new
// channel event (CLAUDE.md "reuse the verbs, not the nouns"). Timer logic is
// isolated behind an injectable interval so vitest fake timers drive it
// deterministically, mirroring socket.ts's `kickReconnect` testability.

// Client heartbeat cadence. MUST stay ≤ half the server's `stale_ms`
// (Grappa.WSPresence @default_stale_ms = 60_000) so a genuinely-foreground
// PWA refreshes with a whole beat of margin before it would be counted
// stale. Keep the two values in sync across the codebases.
export const VISIBILITY_HEARTBEAT_MS = 30_000;

export interface VisibilityHeartbeat {
  // Start the periodic report when visible; stop it when hidden. Idempotent
  // — repeated `setVisible(true)` does not stack intervals.
  setVisible(visible: boolean): void;
  // Cancel any running interval (teardown).
  stop(): void;
}

export function createVisibilityHeartbeat(
  report: () => void,
  intervalMs: number = VISIBILITY_HEARTBEAT_MS,
): VisibilityHeartbeat {
  let id: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (id !== null) {
      clearInterval(id);
      id = null;
    }
  };

  const start = (): void => {
    // Guard against stacking: only one interval runs at a time.
    if (id === null) {
      id = setInterval(report, intervalMs);
    }
  };

  return {
    setVisible(visible: boolean): void {
      if (visible) {
        start();
      } else {
        stop();
      }
    },
    stop,
  };
}
