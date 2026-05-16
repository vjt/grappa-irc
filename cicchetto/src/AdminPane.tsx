import type { Component } from "solid-js";

// M-7 — Admin console SKELETON. Replaces the channel content in
// Shell.tsx when an admin operator clicks "admin console" in
// SettingsDrawer. Tabs (Visitors / Sessions / Networks / Credentials /
// Events / Reaper) land in M-8 / M-9 / M-10 / M-11 — this is strictly
// the outer pane with a header + a close action + an explicit "tabs
// land in M-8..M-11" stub so the operator sees a coherent surface
// instead of a blank pane.
//
// Mount lifecycle: a `<Show when={adminOpen() && isAdmin()}>` in
// Shell.tsx drives mount/unmount. Shell also runs a createEffect that
// auto-closes the pane the moment `me.is_admin` flips to false — see
// the demote-mid-session policy in the M-7 plan. M-7 does NOT issue
// any admin REST fetches; pure presentational.
//
// Per-class parity matrix (`feedback_e2e_user_class_parity_matrix`):
// admin-gated, EXEMPT from the visitor / non-admin / admin loop's
// positive assertion. The Playwright spec still loops the three
// classes to assert the OPPOSITE polarity (non-admin + visitor see
// no drawer entry → no pane).

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
      <p class="admin-pane-placeholder">
        tabs land in M-8 (visitors), M-9 (sessions), M-10 (networks + credentials), and M-11
        (events).
      </p>
    </section>
  );
};

export default AdminPane;
