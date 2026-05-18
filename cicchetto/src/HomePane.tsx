import { type Component, For, Show } from "solid-js";
import { patchNetwork } from "./lib/api";
import { token } from "./lib/auth";
import { homeData } from "./lib/home";
import { setSelectedChannel } from "./lib/selection";
import { SERVER_WINDOW_NAME } from "./lib/windowKinds";

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
// Click semantics (vjt 2026-05-18):
//   * :parked / :failed row → /connect via patchNetwork. Re-uses
//     the T32 unpark verb already exercised by `slashCommands.ts`'s
//     `/connect` handler — no new REST surface.
//   * :connected row → jump to that network's $server window. Useful
//     "go to network" shortcut; mirrors the existing Sidebar server-
//     row selection contract.

const HomePaneVisitor: Component = () => {
  return (
    <div class="home-pane home-pane-visitor">
      <h2 class="home-pane-title">Welcome to Grappa</h2>
      <p>You are connected as a visitor.</p>
      <p class="muted">
        IRC channels appear in the sidebar. Pick one to start chatting. Your visitor session is
        ephemeral — when it expires, scrollback for this nick stays archived on the bouncer.
      </p>
    </div>
  );
};

const HomePaneRegistered: Component = () => {
  // homeData() is non-null in this branch — TS narrowing relies on
  // the parent <Show when={homeData()}>.
  const rows = () => homeData()?.networks ?? [];

  const onRowClick = async (slug: string, state: "connected" | "parked" | "failed") => {
    if (state === "connected") {
      // Jump to that network's $server window (UX shortcut).
      setSelectedChannel({
        networkSlug: slug,
        channelName: SERVER_WINDOW_NAME,
        kind: "server",
      });
      return;
    }
    // :parked or :failed → /connect. Re-uses patchNetwork, the same
    // verb behind slashCommands.ts /connect.
    const t = token();
    if (!t) return;
    try {
      await patchNetwork(t, slug, { connection_state: "connected" });
      // The server emits home_network_state_changed on success;
      // homeData() patches in-place via userTopic.ts dispatcher.
      // No need to mutate anything here.
    } catch (err) {
      console.warn("[HomePane] connect failed", slug, err);
    }
  };

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
            {(row) => (
              <li
                class="home-pane-network-row"
                classList={{
                  "home-pane-network-row-connected": row.connection_state === "connected",
                  "home-pane-network-row-parked": row.connection_state === "parked",
                  "home-pane-network-row-failed": row.connection_state === "failed",
                }}
              >
                <button
                  type="button"
                  class="home-pane-network-btn"
                  onClick={() => void onRowClick(row.slug, row.connection_state)}
                >
                  <span class="home-pane-network-slug">{row.slug}</span>
                  <span class="home-pane-network-nick">{row.nick}</span>
                  <span class="home-pane-network-state">{row.connection_state}</span>
                  <Show when={row.connection_state_reason}>
                    <span class="home-pane-network-reason">{row.connection_state_reason}</span>
                  </Show>
                </button>
              </li>
            )}
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
