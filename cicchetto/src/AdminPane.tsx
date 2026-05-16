import type { Component } from "solid-js";
import AdminVisitorsTab from "./AdminVisitorsTab";

// M-7 — Admin console pane. Replaces the channel content in
// Shell.tsx when an admin operator clicks "admin console" in
// SettingsDrawer. Outer pane = header + close + tab nav + active
// tab body.
//
// M-8 adds the FIRST tab (Visitors). M-9 (Sessions) / M-10
// (Networks + Credentials) / M-11 (Events) each append their own
// `<button role="tab">` + `<tabpanel>` siblings here and gate the
// active tab via a `currentTab` signal. M-8 ships only one tab so
// the markup is intentionally minimal — a single `aria-selected`
// tab in a tablist is valid ARIA without a tab-switching state
// machine yet.
//
// Mount lifecycle: a `<Show when={adminOpen() && isAdmin()}>` in
// Shell.tsx drives mount/unmount. Shell auto-closes the pane the
// instant `me.is_admin` flips to false — see the demote-mid-session
// policy at Shell.tsx's createEffect. M-8 issues admin REST fetches
// (GET/DELETE /admin/visitors) inside AdminVisitorsTab; the
// `:admin_authn` plug 403s any request from a now-non-admin user
// so the demote race is server-side-safe.
//
// Per-class parity matrix (`feedback_e2e_user_class_parity_matrix`):
// admin-gated, EXEMPT from the visitor / non-admin / admin loop's
// positive assertion. The Playwright spec at m7-admin-gate covers
// reachability; per-tab specs cover only the admin case since
// non-admin can't reach the AdminPane at all.

export type Props = {
  onClose: () => void;
};

const AdminPane: Component<Props> = (props) => {
  return (
    <section class="admin-pane" data-testid="admin-pane">
      <header class="admin-pane-header">
        <h1>admin console</h1>
        <button
          type="button"
          class="admin-pane-close"
          aria-label="close admin console"
          onClick={props.onClose}
          data-testid="admin-pane-close"
        >
          ×
        </button>
      </header>
      {/* `<div role="tablist">` not `<nav>` — biome a11y rule
          `noNoninteractiveElementToInteractiveRole` flags `<nav>`
          with `role="tablist"` because `<nav>` is a landmark
          element, not a tab container. The WAI-ARIA APG canonical
          tablist container IS a `div`. */}
      <div class="admin-tab-nav" role="tablist" aria-label="admin tabs">
        <button
          type="button"
          role="tab"
          class="admin-tab"
          aria-selected="true"
          aria-controls="admin-tab-visitors"
          id="admin-tab-visitors-handle"
          data-testid="admin-tab-visitors"
        >
          Visitors
        </button>
      </div>
      <div
        role="tabpanel"
        id="admin-tab-visitors"
        aria-labelledby="admin-tab-visitors-handle"
        class="admin-tab-panel"
      >
        <AdminVisitorsTab />
      </div>
    </section>
  );
};

export default AdminPane;
