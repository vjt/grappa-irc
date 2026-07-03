import { createSignal } from "solid-js";

// Shared ring buffer for on-device compose-gesture diagnostics (#123). The
// swipe handlers push one line per touch phase (touchstart geometry, the claim
// decision, the touchend action); DiagFloat renders diagLog(). This is the
// evidence surface webkit playwright can't provide — real iOS touch physics
// only shows up on vjt's device (feedback_playwright_webkit_not_ios_scroll).
//
// Callers gate on isDiagEnabled() (the overlay only renders with the
// `cic_diag` flag on), so pushes are free no-ops in production. Kept a leaf
// module — DiagFloat imports it; it imports nothing that imports back — to
// avoid a cycle with DiagFloat's flag helpers.
const [entries, setEntries] = createSignal<string[]>([]);

// Newest-first, capped. A gesture emits ~3 lines; 40 keeps a few gestures of
// scrollback visible on-device without unbounded growth.
export const diagLog = entries;

export function diagPush(line: string): void {
  setEntries((prev) => [line, ...prev].slice(0, 40));
}
