// #75/#252/#332 — settings-drawer sub-page routing + cross-module deep-link.
//
// The settings drawer is a flat "main" page that pushes into dedicated
// sub-pages (vhost #252, themes #75), each entered from a nav row inside
// the drawer. `SettingsSubPage` is the single source of truth for that
// union — it lives here (not in SettingsDrawer.tsx) so other modules can
// deep-link into a sub-page WITHOUT importing the component.
//
// #332 restored the mobile footer 🎨 themes launcher (Shell.tsx →
// lib/mobilePanel.ts `openThemesPanel`). That launcher opens the drawer
// AND wants it to land directly on the themes sub-page — a cross-module
// hand-off the drawer can't receive as a prop (the launcher lives in a
// sibling component). The mechanism is a one-shot module-level request:
// the launcher calls `requestSettingsPage("themes")` before opening the
// drawer; the drawer consumes it on its open transition
// (`consumePendingSettingsPage`) and, if non-null, jumps to that page.
// No signal, no reactive state — the drawer's own `settingsPage` signal
// is the target; this is just the pending hand-off between the tap and
// the drawer's open effect. (#299 removed this launcher; #332 brought it
// back — see Shell.tsx.)
export type SettingsSubPage = "main" | "vhost" | "themes";

let pendingPage: SettingsSubPage | null = null;

// Request the drawer open directly on `page`. Overwrites any prior
// un-consumed request (last tap wins). Paired with the drawer's open
// transition, which consumes it exactly once.
export function requestSettingsPage(page: SettingsSubPage): void {
  pendingPage = page;
}

// Consume the pending deep-link request (one-shot). Returns null when no
// request is outstanding — the drawer then stays on whatever page it
// reset to on its prior close (main).
export function consumePendingSettingsPage(): SettingsSubPage | null {
  const page = pendingPage;
  pendingPage = null;
  return page;
}
