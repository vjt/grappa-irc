import { type Component, createSignal, For, Show } from "solid-js";
import { ApiError, patchNetwork } from "./lib/api";
import { token } from "./lib/auth";
import { friendlyApiError } from "./lib/friendlyApiError";
import { homeData } from "./lib/home";
import { setSelectedChannel } from "./lib/selection";
import { LIST_WINDOW_NAME, SERVER_WINDOW_NAME } from "./lib/windowKinds";
import NickText from "./NickText";

// UX-4 bucket B — first-class `:home` window pinned ABOVE all
// networks. Two branches off `homeData()`:
//
//   * registered user (homeData() !== null) → networks list with
//     click-to-connect on parked rows + click-to-jump on connected
//     rows. NO compose box (home is a view, not a chat).
//   * visitor / logged-out (homeData() === null) → cic-only help
//     text (placeholder, expanded in a follow-up UX-4 copy bucket).
//
// Help-text + button labels live entirely in this file per the
// no-localized-strings-server-side rule. The server-side envelope
// carries structured data only (slug, nick, atom states).
//
// Click semantics:
//   * :connected row → jump to that network's $server window. Useful
//     "go to network" shortcut; mirrors the existing Sidebar server-
//     row selection contract.
//   * :parked / :failed row → explicit [Reconnect] chip (UX-5 BR,
//     2026-05-19). Pre-BR the WHOLE row was clickable to /connect
//     but the affordance was invisible (looked like a label) and
//     errors silently `console.warn`'d (violation of
//     feedback_silent_retry_anti_pattern). Post-BR a typed chip
//     surfaces the action + inline `friendlyApiError` text on
//     failure. Server-side admission (UX-5 BC) ensures the chip
//     doesn't 503 on T32 park → reconnect under default cap.

const HomePaneVisitor: Component = () => {
  return (
    <div class="home-pane home-pane-visitor">
      <h2 class="home-pane-title">Welcome to Grappa</h2>
      <p>You are connected as a visitor.</p>
      <p class="muted">
        IRC channels appear in the sidebar. Pick one to start chatting. While your session is open
        the bouncer keeps you connected — close cicchetto and reopen, and you're still on, right
        where you left off. But a visitor session is ephemeral: when it expires its scrollback goes
        with it. Nothing is kept for a visitor nick.
      </p>
      <p class="muted">
        This is IRC: to join a channel, tap the server tab below and <code>/join</code> it. To get
        started, <code>/join #grappa</code>.
      </p>
    </div>
  );
};

// UX-5 BR row sub-component. Per-row local error signal so each
// chip's failure text scopes to its own row — a single top-level
// signal would render the message on every row.
type HomeRow = {
  slug: string;
  nick: string;
  connection_state: "connected" | "parked" | "failed";
  connection_state_reason: string | null;
  connection_state_changed_at: string | null;
};

const ConnectedRow: Component<{ row: HomeRow }> = (props) => {
  const onJump = () => {
    setSelectedChannel({
      networkSlug: props.row.slug,
      channelName: SERVER_WINDOW_NAME,
      kind: "server",
    });
  };
  const onBrowse = () => {
    setSelectedChannel({
      networkSlug: props.row.slug,
      channelName: LIST_WINDOW_NAME,
      kind: "list",
    });
  };
  return (
    <li class="home-pane-network-row home-pane-network-row-connected">
      <button type="button" class="home-pane-network-btn" onClick={onJump}>
        <span class="home-pane-network-slug">{props.row.slug}</span>
        <NickText nick={props.row.nick} extraClass="home-pane-network-nick" />
        <span class="home-pane-network-state">{props.row.connection_state}</span>
      </button>
      <button type="button" class="home-pane-network-browse" onClick={onBrowse}>
        📇 Browse channels
      </button>
    </li>
  );
};

const DisconnectedRow: Component<{ row: HomeRow }> = (props) => {
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  const onReconnect = async () => {
    const t = token();
    if (!t) return;
    setError(null);
    setPending(true);
    try {
      await patchNetwork(t, props.row.slug, { connection_state: "connected" });
      // Server emits connection_state_changed (REV-J M15 folded the
      // prior home_network_state_changed arm into it); userTopic.ts
      // patches homeData() in place. The row will re-render as
      // connected and this sub-component will unmount — no local state
      // cleanup needed.
    } catch (err) {
      // feedback_silent_retry_anti_pattern: errors MUST surface above
      // the threshold. friendlyApiError maps known cap/admission codes
      // to operator-facing copy; unknown errors collapse to the
      // ApiError.message verbatim (status + code token).
      const friendly =
        err instanceof ApiError ? friendlyApiError(err) : "reconnect failed (unknown error)";
      setError(friendly);
    } finally {
      setPending(false);
    }
  };

  return (
    <li
      class="home-pane-network-row"
      classList={{
        "home-pane-network-row-parked": props.row.connection_state === "parked",
        "home-pane-network-row-failed": props.row.connection_state === "failed",
      }}
    >
      <div class="home-pane-network-card">
        <div class="home-pane-network-card-row">
          <span class="home-pane-network-slug">{props.row.slug}</span>
          <NickText nick={props.row.nick} extraClass="home-pane-network-nick" />
          <span class="home-pane-network-state">{props.row.connection_state}</span>
        </div>
        <Show when={props.row.connection_state_reason}>
          <div class="home-pane-network-reason">{props.row.connection_state_reason}</div>
        </Show>
        <div class="home-pane-network-actions">
          <button
            type="button"
            class="home-pane-network-reconnect"
            disabled={pending()}
            aria-label={`Reconnect ${props.row.slug}`}
            onClick={() => void onReconnect()}
          >
            {pending() ? "Reconnecting…" : "Reconnect"}
          </button>
          <Show when={error()}>
            <span class="home-pane-network-error" role="alert">
              {error()}
            </span>
          </Show>
        </div>
      </div>
    </li>
  );
};

const HomePaneRegistered: Component = () => {
  // homeData() is non-null in this branch — TS narrowing relies on
  // the parent <Show when={homeData()}>.
  const rows = () => homeData()?.networks ?? [];

  return (
    <div class="home-pane home-pane-registered">
      <h2 class="home-pane-title">Networks</h2>
      <Show
        when={rows().length > 0}
        fallback={
          <p class="muted">
            No networks bound. Ask the operator to bind one via <code>bin/grappa bind-network</code>
            .
          </p>
        }
      >
        <ul class="home-pane-networks">
          <For each={rows()}>
            {(row) =>
              row.connection_state === "connected" ? (
                <ConnectedRow row={row} />
              ) : (
                <DisconnectedRow row={row} />
              )
            }
          </For>
        </ul>
      </Show>
    </div>
  );
};

const HomePane: Component = () => {
  return (
    <Show when={homeData()} fallback={<HomePaneVisitor />}>
      <HomePaneRegistered />
    </Show>
  );
};

export default HomePane;
