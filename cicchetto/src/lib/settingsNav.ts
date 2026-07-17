import { createSignal } from "solid-js";

// #75 — SettingsDrawer sub-page navigation.
//
// The drawer is a flat "main" page that can push into dedicated
// sub-pages ("vhost" #252, "themes" #75). Most sub-pages are entered
// from a nav row INSIDE the drawer, but the mobile footer 🎨 launcher
// must open the drawer AND jump straight to the themes sub-page. This
// module carries that one-shot deep-link target: the launcher calls
// `requestSettingsPage("themes")` + opens the drawer, and the drawer
// consumes it on its open transition (`consumePendingSettingsPage`).
// One-shot so a subsequent plain open lands on "main".
//
// Single source of truth for the sub-page union — imported by
// SettingsDrawer (its `settingsPage` signal type) and the footer helper.

export type SettingsSubPage = "main" | "vhost" | "themes";

const [pending, setPending] = createSignal<SettingsSubPage | null>(null);

export function requestSettingsPage(page: SettingsSubPage): void {
  setPending(page);
}

// Read + clear the pending deep-link target (one-shot). Returns null when
// nothing was requested — the drawer then opens on its default page.
export function consumePendingSettingsPage(): SettingsSubPage | null {
  const p = pending();
  if (p !== null) setPending(null);
  return p;
}
