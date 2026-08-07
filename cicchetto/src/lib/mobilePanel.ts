import { setArchiveModalOpen } from "./archive";
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
// `setArchiveModalOpen` IS importable directly (lives in
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
  setArchiveModalOpen(false);
  setters.setMembersOpen(true);
}

// #308 INC-A — open the members drawer (edge-swipe right→center). Unlike
// `toggleMembersPanel`, this is an idempotent OPEN: an already-open drawer stays
// open. The right-edge swipe means "show me the members bar", never "hide it" —
// so it must not double as a close (the drawer covers the right edge once open,
// and a directional open gesture that toggles-closed reads as a bug). Same mutex
// as the toggle's open branch: close settings + archive first.
export function openMembersPanel(setters: MobilePanelSetters): void {
  setters.setSettingsOpen(false);
  setArchiveModalOpen(false);
  setters.setMembersOpen(true);
}

export function openSettingsPanel(setters: MobilePanelSetters): void {
  setters.setMembersOpen(false);
  setArchiveModalOpen(false);
  setters.setSettingsOpen(true);
}

// #75/#332 — themes launcher in the mobile drawer footer. Opens the
// settings drawer directly on the "themes" sub-page: same mutex as
// `openSettingsPanel` (close members + archive) plus a one-shot deep-link
// request the drawer consumes on its open transition. No new signal — the
// drawer's own `settingsPage` state is the target. (#299 dropped this;
// #332 restored it — see lib/settingsNav.ts.)
export function openThemesPanel(setters: MobilePanelSetters): void {
  setters.setMembersOpen(false);
  setArchiveModalOpen(false);
  requestSettingsPage("themes");
  setters.setSettingsOpen(true);
}

// #473 — archive launcher, now folded into the RailActions drawer (was the
// mobile-only `.mobile-panel-actions` footer). No slug argument any more: the
// grouped `ArchiveModal` renders EVERY network as a collapsible group, so the
// launcher just OPENS the one modal rather than targeting a single network.
// Same own-signal shape as `openSettingsPanel` — close members + settings,
// then flip the archive-open flag.
export function openArchivePanel(setters: MobilePanelSetters): void {
  setters.setMembersOpen(false);
  setters.setSettingsOpen(false);
  setArchiveModalOpen(true);
}

// #291 / UX-6-C / #361 — the three selection-driven "navigate to a window"
// launchers (admin / home / list) share ONE mutex shape: close the members
// drawer + settings + archive, THEN delegate the selection change via the
// `navigate` thunk (Shell sets `selectedChannel` → the target kind). The
// mutex lives HERE, in one place, so a future 4th nav surface (e.g.
// `:search`) is a one-line edit, not N identical bodies (CLAUDE.md
// "implement once, reuse everywhere"). The own-signal launchers
// (openSettingsPanel / openThemesPanel / openArchivePanel) are NOT nav
// launchers — each flips its OWN surface signal — so they stay distinct
// and do NOT route through here. The three public wrappers below are kept
// (rather than one generic `openNavPanel`) so each launcher keeps its
// self-documenting name + WHY-comment, matching the per-launcher helper
// convention the rest of this module already uses.
function openNavWindow(setters: MobilePanelSetters, navigate: () => void): void {
  setters.setMembersOpen(false);
  setters.setSettingsOpen(false);
  setArchiveModalOpen(false);
  navigate();
}

// UX-6 bucket C (2026-05-21) — admin launcher in the mobile drawer footer
// (vjt iPhone-dogfood Bug 3). Selection-driven: Shell mounts AdminPane on
// `selectedChannel.kind === "admin"` (single source of truth shared with
// the Sidebar admin row + SettingsDrawer admin entry). No new `adminOpen`
// signal — the selection store already carries this state.
export function openAdminPanel(setters: MobilePanelSetters, navigate: () => void): void {
  openNavWindow(setters, navigate);
}

// #291 — home launcher in the mobile drawer footer. Mobile narrow layout
// has no other way back to the home window (desktop has the sidebar home
// link). Shell sets `selectedChannel` → kind "home".
export function openHomePanel(setters: MobilePanelSetters, navigate: () => void): void {
  openNavWindow(setters, navigate);
}

// #986 — mentions launcher. The @ re-open door left `.shell-chrome` (the
// band #985 removes) for the rail, so the ONE way back into a network's
// "you were /away" bundle now routes through the same nav mutex as home /
// rooms / admin. Shell sets `selectedChannel` → kind "mentions" for the
// network the current selection implies.
export function openMentionsPanel(setters: MobilePanelSetters, navigate: () => void): void {
  openNavWindow(setters, navigate);
}

// #361 — list launcher (channel directory / $list) in the mobile drawer
// footer. Pre-bucket the ONLY mobile way to open the $list window was to
// TYPE `/list`; the desktop sidebar's 📇 $list row had no mobile
// equivalent. Shell sets `selectedChannel` → kind "list" for the active
// network → DirectoryPane mounts and auto-loads.
export function openListPanel(setters: MobilePanelSetters, navigate: () => void): void {
  openNavWindow(setters, navigate);
}
