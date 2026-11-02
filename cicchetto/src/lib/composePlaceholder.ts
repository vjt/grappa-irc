import { encryptedWindowPeer, SERVER_WINDOW_NAME } from "./windowKinds";

// Friendly placeholder text for the compose textarea (#151).
//
// `channelName` for the server window is the INTERNAL sentinel
// `$server` (windowKinds.ts), not a real IRC target — interpolating it
// raw into `message ${channelName}` leaked the token to the operator.
// The server window is labelled with its network slug, mirroring the
// Sidebar's `<slug>` network-header row (the same row that IS the
// server-window selector; its leading ⚙️ was removed in #71 INC-1).
//
// General rule, not the one example (CLAUDE.md "fix root causes" +
// "total consistency"): EVERY synthetic window carries a `$`-prefixed
// sentinel as `channelName`, and real IRC targets never start with `$`.
// `$server` and the encrypted query (issue 2512, `$e2e:<nick>`, which names
// its peer and where the line goes) are the synthetic windows that render a
// compose box; should another appear, fall back to a generic hint rather than
// leak its sentinel — no per-sentinel exclusion list.
//
// Pure + dependency-light (only the sentinel const) so it's directly
// unit-testable and importable into ComposeBox render tests without
// dragging compose.ts's stateful network graph through the mock layer.
export function composePlaceholder(networkSlug: string, channelName: string): string {
  if (channelName === SERVER_WINDOW_NAME) return `message ${networkSlug}`;
  const peer = encryptedWindowPeer(channelName);
  if (peer !== null) return `encrypted message to ${peer}`;
  if (channelName.startsWith("$")) return "send a command…";
  return `message ${channelName}`;
}
