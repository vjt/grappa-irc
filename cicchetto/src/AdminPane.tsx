import { type Component, createSignal, Show } from "solid-js";
import AdminNetworksTab from "./AdminNetworksTab";
import AdminSessionsTab from "./AdminSessionsTab";
import AdminVisitorsTab from "./AdminVisitorsTab";

// M-7 — Admin console pane. Replaces the channel content in
// Shell.tsx when an admin operator clicks "admin console" in
// SettingsDrawer. Outer pane = header + close + tab nav + active
// tab body.
//
// M-8 added Visitors; M-9b added Sessions; M-10 adds Networks.
// M-11 (Events) will append its own `<button role="tab">` + tabpanel
// + gate via the `currentTab` signal.
//
// Mount lifecycle: a `<Show when={adminOpen() && isAdmin()}>` in
// Shell.tsx drives mount/unmount. Shell auto-closes the pane the
// instant `me.is_admin` flips to false — see the demote-mid-session
// policy at Shell.tsx's createEffect. The tab components issue admin
// REST fetches which the `:admin_authn` plug 403s any request from a
// now-non-admin user, so the demote race is server-side-safe.
//
// Per-class parity matrix (`feedback_e2e_user_class_parity_matrix`):
// admin-gated, EXEMPT. The Playwright spec at m7-admin-gate covers
// reachability; per-tab specs cover only the admin case since
// non-admin can't reach the AdminPane at all.

export type Props = {
  onClose: () => void;
};

type TabKey = "visitors" | "sessions" | "networks";

const AdminPane: Component<Props> = (props) => {
  const [currentTab, setCurrentTab] = createSignal<TabKey>("visitors");

  const isActive = (k: TabKey): boolean => currentTab() === k;

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
          aria-selected={isActive("visitors")}
          aria-controls="admin-tab-visitors"
          id="admin-tab-visitors-handle"
          data-testid="admin-tab-visitors"
          onClick={() => setCurrentTab("visitors")}
        >
          Visitors
        </button>
        <button
          type="button"
          role="tab"
          class="admin-tab"
          aria-selected={isActive("sessions")}
          aria-controls="admin-tab-sessions"
          id="admin-tab-sessions-handle"
          data-testid="admin-tab-sessions"
          onClick={() => setCurrentTab("sessions")}
        >
          Sessions
        </button>
        <button
          type="button"
          role="tab"
          class="admin-tab"
          aria-selected={isActive("networks")}
          aria-controls="admin-tab-networks"
          id="admin-tab-networks-handle"
          data-testid="admin-tab-networks"
          onClick={() => setCurrentTab("networks")}
        >
          Networks
        </button>
      </div>
      <Show when={isActive("visitors")}>
        <div
          role="tabpanel"
          id="admin-tab-visitors"
          aria-labelledby="admin-tab-visitors-handle"
          class="admin-tab-panel"
        >
          <AdminVisitorsTab />
        </div>
      </Show>
      <Show when={isActive("sessions")}>
        <div
          role="tabpanel"
          id="admin-tab-sessions"
          aria-labelledby="admin-tab-sessions-handle"
          class="admin-tab-panel"
        >
          <AdminSessionsTab />
        </div>
      </Show>
      <Show when={isActive("networks")}>
        <div
          role="tabpanel"
          id="admin-tab-networks"
          aria-labelledby="admin-tab-networks-handle"
          class="admin-tab-panel"
        >
          <AdminNetworksTab />
        </div>
      </Show>
    </section>
  );
};

export default AdminPane;
