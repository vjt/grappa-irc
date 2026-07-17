import { setArchiveModalNetwork } from "./archive";
import { requestSettingsPage } from "./settingsNav";

// UX-5 bucket BM (2026-05-20) — mobile chrome panel mutex.
//
// Pre-bucket: `membersOpen`, `settingsOpen`, `archiveModalNetwork` are
// three independent signals owned by Shell.tsx / lib/archive.ts. They
// can all be open simultaneously. The only coordination was the Esc
// keybinding clearing membersOpen + settingsOpen together.
//
// BM contract: on mobile-channel, the three top-right buttons collapse
// into ONE hamburger that opens the members drawer; bottom-fixed
// launcher buttons inside the drawer launch settings / archive. The
// invariant is `members | settings | archive | none` — opening one
// closes the others.
//
// KISS implementation per CLAUDE.md "Lightweight over heavyweight" +
// "Don't duplicate state that already exists — derive it":
//   * No new signal. The three existing signals stay the canonical
//     state. Three thin helpers below wrap the setters and close
//     siblings before opening self.
//   * Setter wiring stays in Shell.tsx; helpers receive the
//     `setMembersOpen` / `setSettingsOpen` thunks from Shell.tsx via
//     the small object passed at call-site. Avoids importing Shell's
//     local createSignal accessors into a sibling module.
//
// `setArchiveModalNetwork` IS importable directly (lives in
// lib/archive.ts as a module-level export from the identityScopedStore
// closure), so the archive arm doesn't need a thunk pass-through.
//
// Mutex applies to mobile-channel only. Desktop call sites continue to
// use the plain `setMembersOpen` / `setSettingsOpen` / archive setters
// directly — desktop has the room for the three affordances and no
// drawer-as-launcher pattern.

export type MobilePanelSetters = {
  membersOpen: () => boolean;
  setMembersOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
};

// Toggle the members drawer: if already open, just close it (the
// hamburger acts as a close affordance too — pre-bucket behavior). If
// closed, open it AND close the sibling panels per mutex.
export function toggleMembersPanel(setters: MobilePanelSetters): void {
  if (setters.membersOpen()) {
    setters.setMembersOpen(false);
    return;
  }
  setters.setSettingsOpen(false);
  setArchiveModalNetwork(null);
  setters.setMembersOpen(true);
}

export function openSettingsPanel(setters: MobilePanelSetters): void {
  setters.setMembersOpen(false);
  setArchiveModalNetwork(null);
  setters.setSettingsOpen(true);
}

// #75 — themes launcher in the mobile drawer footer. Opens the settings
// drawer directly on the "themes" sub-page: same mutex as
// `openSettingsPanel` (close members + archive) plus a one-shot deep-link
// request the drawer consumes on its open transition. No new signal — the
// drawer's own `settingsPage` state is the target.
export function openThemesPanel(setters: MobilePanelSetters): void {
  setters.setMembersOpen(false);
  setArchiveModalNetwork(null);
  requestSettingsPage("themes");
  setters.setSettingsOpen(true);
}

export function openArchivePanel(setters: MobilePanelSetters, slug: string): void {
  setters.setMembersOpen(false);
  setters.setSettingsOpen(false);
  setArchiveModalNetwork(slug);
}

// UX-6 bucket C (2026-05-21) — admin launcher in the mobile drawer
// footer (vjt iPhone-dogfood Bug 3). Unlike settings/archive, admin
// navigation is selection-driven (Shell mounts AdminPane on
// `selectedChannel.kind === "admin"` — single source of truth shared
// with Sidebar admin row + SettingsDrawer admin entry). The helper's
// job here is the SAME mutex shape as openSettingsPanel/openArchivePanel
// — close the three sibling surfaces before navigating — and then
// delegate the selection change via the `navigate` thunk. No new
// `adminOpen` signal: the selection store already carries this state.
export function openAdminPanel(setters: MobilePanelSetters, navigate: () => void): void {
  setters.setMembersOpen(false);
  setters.setSettingsOpen(false);
  setArchiveModalNetwork(null);
  navigate();
}

// #291 — home launcher in the mobile drawer footer. Mobile narrow layout
// has no other way back to the home window (desktop has the sidebar home
// link). Same selection-driven, mutex shape as `openAdminPanel`: close
// the three sibling surfaces, then delegate the selection change via the
// `navigate` thunk (Shell sets `selectedChannel` → kind "home"). No new
// signal — the selection store already carries this state.
export function openHomePanel(setters: MobilePanelSetters, navigate: () => void): void {
  setters.setMembersOpen(false);
  setters.setSettingsOpen(false);
  setArchiveModalNetwork(null);
  navigate();
}
