import { postPart } from "./api";
import { token } from "./auth";
import { closeQueryWindowState } from "./queryWindows";

// Shared close-window helpers. Two call sites: Sidebar × on desktop,
// BottomBar × on mobile (iOS-3). Mirror the one-feature-one-code-path
// rule (CLAUDE.md): channel close goes through PART; query close drops
// the cic-side window row.

export function closeChannelWindow(networkSlug: string, channelName: string): void {
  const t = token();
  if (!t) return;
  void postPart(t, networkSlug, channelName);
}

export function closeQueryWindow(networkId: number, targetNick: string): void {
  closeQueryWindowState(networkId, targetNick);
}
