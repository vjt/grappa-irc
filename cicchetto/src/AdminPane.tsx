import { type Component, createSignal, onCleanup, onMount, Show } from "solid-js";
import AdminCredentialsTab from "./AdminCredentialsTab";
import AdminDebugTab from "./AdminDebugTab";
import AdminEventsTab from "./AdminEventsTab";
import AdminNetworksTab from "./AdminNetworksTab";
import AdminSessionLogTab from "./AdminSessionLogTab";
import AdminSessionsTab from "./AdminSessionsTab";
import AdminSettingsTab from "./AdminSettingsTab";
import AdminUsersTab from "./AdminUsersTab";
import AdminVhostsTab from "./AdminVhostsTab";
import AdminVisitorsTab from "./AdminVisitorsTab";
import { startAdminEventsSubscription, uninstallAdminEvents } from "./lib/adminEvents";

// M-7 — Admin console pane. Replaces the channel content in
// Shell.tsx when an admin operator clicks "admin console" in
// SettingsDrawer. Outer pane = header + close + tab nav + active
// tab body.
//
// M-8 added Visitors; M-9b added Sessions; M-10 added Networks;
// M-11 adds Events (real-time stream of admin-relevant events
// fan-out on `grappa:admin:events`).
//
// Mount lifecycle: a `<Show when={selectedChannel().kind === "admin" && isAdmin()}>`
// in Shell.tsx drives mount/unmount (UX-4 bucket N: selection-driven;
// pre-bucket-N a parallel `adminOpen` signal duplicated the gate).
// Shell auto-redirects selection to home the instant `me.is_admin`
// flips to false — see the demote-mid-session createEffect at
// Shell.tsx. The tab components issue admin REST fetches which the
// `:admin_authn` plug 403s any request from a now-non-admin user, so
// the demote race is server-side-safe.
//
// M-11 subscription lifecycle lives HERE (not in `AdminEventsTab`)
// so the ring buffer accumulates while the operator browses
// Visitors / Sessions / Networks tabs. AdminPane mount = admin
// console opened; AdminPane unmount = closed → cleanup detaches.
//
// Per-class parity matrix (`feedback_e2e_user_class_parity_matrix`):
// admin-gated, EXEMPT. The Playwright spec at m7-admin-gate covers
// reachability; per-tab specs cover only the admin case since
// non-admin can't reach the AdminPane at all.

export type Props = {
  onClose: () => void;
};

type TabKey =
  | "visitors"
  | "sessions"
  | "networks"
  | "vhosts"
  | "users"
  | "credentials"
  | "events"
  | "session_log"
  | "settings"
  | "debug";

const AdminPane: Component<Props> = (props) => {
  const [currentTab, setCurrentTab] = createSignal<TabKey>("visitors");

  const isActive = (k: TabKey): boolean => currentTab() === k;

  // #215 — `startAdminEventsSubscription` joins `grappa:admin:events` and
  // installs BOTH the admin-events handler AND the session-log handler on
  // the one channel (adminEvents.ts owns the join/leave; it calls
  // `installSessionLog`). `uninstallAdminEvents` leaves the channel and
  // resets both stores. So the Session Log tab's live feed accumulates
  // while the operator browses any admin tab, torn down on pane close.
  onMount(() => {
    startAdminEventsSubscription();
  });

  onCleanup(() => {
    uninstallAdminEvents();
  });

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
        <button
          type="button"
          role="tab"
          class="admin-tab"
          aria-selected={isActive("vhosts")}
          aria-controls="admin-tab-vhosts"
          id="admin-tab-vhosts-handle"
          data-testid="admin-tab-vhosts"
          onClick={() => setCurrentTab("vhosts")}
        >
          Vhosts
        </button>
        <button
          type="button"
          role="tab"
          class="admin-tab"
          aria-selected={isActive("users")}
          aria-controls="admin-tab-users"
          id="admin-tab-users-handle"
          data-testid="admin-tab-users"
          onClick={() => setCurrentTab("users")}
        >
          Users
        </button>
        <button
          type="button"
          role="tab"
          class="admin-tab"
          aria-selected={isActive("credentials")}
          aria-controls="admin-tab-credentials"
          id="admin-tab-credentials-handle"
          data-testid="admin-tab-credentials"
          onClick={() => setCurrentTab("credentials")}
        >
          Credentials
        </button>
        <button
          type="button"
          role="tab"
          class="admin-tab"
          aria-selected={isActive("events")}
          aria-controls="admin-tab-events"
          id="admin-tab-events-handle"
          data-testid="admin-tab-events"
          onClick={() => setCurrentTab("events")}
        >
          Events
        </button>
        <button
          type="button"
          role="tab"
          class="admin-tab"
          aria-selected={isActive("session_log")}
          aria-controls="admin-tab-session_log"
          id="admin-tab-session_log-handle"
          data-testid="admin-tab-session_log"
          onClick={() => setCurrentTab("session_log")}
        >
          Session Log
        </button>
        <button
          type="button"
          role="tab"
          class="admin-tab"
          aria-selected={isActive("settings")}
          aria-controls="admin-tab-settings"
          id="admin-tab-settings-handle"
          data-testid="admin-tab-settings"
          onClick={() => setCurrentTab("settings")}
        >
          Settings
        </button>
        <button
          type="button"
          role="tab"
          class="admin-tab"
          aria-selected={isActive("debug")}
          aria-controls="admin-tab-debug"
          id="admin-tab-debug-handle"
          data-testid="admin-tab-debug"
          onClick={() => setCurrentTab("debug")}
        >
          Debug
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
      <Show when={isActive("vhosts")}>
        <div
          role="tabpanel"
          id="admin-tab-vhosts"
          aria-labelledby="admin-tab-vhosts-handle"
          class="admin-tab-panel"
        >
          <AdminVhostsTab />
        </div>
      </Show>
      <Show when={isActive("users")}>
        <div
          role="tabpanel"
          id="admin-tab-users"
          aria-labelledby="admin-tab-users-handle"
          class="admin-tab-panel"
        >
          <AdminUsersTab />
        </div>
      </Show>
      <Show when={isActive("credentials")}>
        <div
          role="tabpanel"
          id="admin-tab-credentials"
          aria-labelledby="admin-tab-credentials-handle"
          class="admin-tab-panel"
        >
          <AdminCredentialsTab />
        </div>
      </Show>
      <Show when={isActive("events")}>
        <div
          role="tabpanel"
          id="admin-tab-events"
          aria-labelledby="admin-tab-events-handle"
          class="admin-tab-panel"
        >
          <AdminEventsTab />
        </div>
      </Show>
      <Show when={isActive("session_log")}>
        <div
          role="tabpanel"
          id="admin-tab-session_log"
          aria-labelledby="admin-tab-session_log-handle"
          class="admin-tab-panel"
        >
          <AdminSessionLogTab />
        </div>
      </Show>
      <Show when={isActive("settings")}>
        <div
          role="tabpanel"
          id="admin-tab-settings"
          aria-labelledby="admin-tab-settings-handle"
          class="admin-tab-panel"
        >
          <AdminSettingsTab />
        </div>
      </Show>
      <Show when={isActive("debug")}>
        <div
          role="tabpanel"
          id="admin-tab-debug"
          aria-labelledby="admin-tab-debug-handle"
          class="admin-tab-panel"
        >
          <AdminDebugTab />
        </div>
      </Show>
    </section>
  );
};

export default AdminPane;
