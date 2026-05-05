import { createRoot, createSignal } from "solid-js";

// Per-window ephemeral numeric-routing inline store (C5.2, spec #21).
//
// Module-singleton signal map. Keyed by a window-identity string (the same
// key format used by channelKey, queryWindows, scrollback, etc. — arbitrary
// string chosen by the caller; subscribe.ts / userTopic.ts build it from
// the numeric_routed event's target_window fields).
//
// Lifecycle: lines are ephemeral — they are NOT persisted to the scrollback
// store and are lost on page reload. They accumulate up to
// MAX_INLINE_PER_WINDOW entries per window (oldest dropped); callers can
// clear via clearNumericInline. No identity-scoped cleanup is needed here:
// the store is write-only from the event consumer and the signal map is
// small enough that stale entries from a previous session are benign.
//
// Severity mirrors the server-side atom set from numeric_router.ex:
//   :ok → "ok"   (info / success numerics)
//   :error → "error"  (failure numerics ≥400, rendered in red per spec #21)
// Phoenix Channels JSON-encodes Elixir atoms as strings — the cicchetto
// type reflects the wire encoding, not the atom.

export type NumericSeverity = "ok" | "error";

export type NumericInlineLine = {
  numeric: number;
  text: string;
  severity: NumericSeverity;
};

export const MAX_INLINE_PER_WINDOW = 20;

const exports_ = createRoot(() => {
  const [numericsByWindow, setNumericsByWindow] = createSignal<Record<string, NumericInlineLine[]>>(
    {},
  );

  const appendNumericInline = (key: string, line: NumericInlineLine): void => {
    setNumericsByWindow((prev) => {
      const current = prev[key] ?? [];
      const next = [...current, line];
      // Enforce cap: drop oldest entries from the front.
      const capped =
        next.length > MAX_INLINE_PER_WINDOW ? next.slice(-MAX_INLINE_PER_WINDOW) : next;
      return { ...prev, [key]: capped };
    });
  };

  const clearNumericInline = (key: string): void => {
    setNumericsByWindow((prev) => ({ ...prev, [key]: [] }));
  };

  return { numericsByWindow, appendNumericInline, clearNumericInline };
});

export const numericsByWindow = exports_.numericsByWindow;
export const appendNumericInline = exports_.appendNumericInline;
export const clearNumericInline = exports_.clearNumericInline;
