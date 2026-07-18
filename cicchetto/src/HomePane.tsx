import { type Component, createResource, createSignal, For, Show } from "solid-js";
import {
  ApiError,
  type AvailableNetworkRow,
  addNetwork,
  getFeaturedChannels,
  patchNetwork,
  postJoin,
} from "./lib/api";
import { token } from "./lib/auth";
import { channelKey } from "./lib/channelKey";
import { friendlyApiError } from "./lib/friendlyApiError";
import { homeData } from "./lib/home";
import { refetchNetworks, refetchUser, user } from "./lib/networks";
import { setSelectedChannel } from "./lib/selection";
import { LIST_WINDOW_NAME, SERVER_WINDOW_NAME } from "./lib/windowKinds";
import { windowStateByChannel } from "./lib/windowState";
import NickText from "./NickText";
import WatchedPanel from "./WatchedPanel";

// #85 — operator-curated featured channels for a network, fetched on
// home DISPLAY (component mount / slug change) so an operator config
// edit lands on the next render without a /me re-fetch or PubSub push.
// Click: not joined → JOIN then focus (intent follows the tap, mirroring
// compose.ts /join); already joined → focus only (#125 tap-already-
// joined). Join errors surface inline — never silently swallowed.
// `heading` (optional) renders a section title ABOVE the list, gated on
// the same has-links condition so an empty featured list shows no
// dangling heading. Registered rows (ConnectedRow / DisconnectedRow) omit
// it — the network card already labels the context; #135's visitor
// landing passes it to title the featured section.
const FeaturedLinks: Component<{ slug: string; heading?: string }> = (props) => {
  const [error, setError] = createSignal<string | null>(null);
  const [links] = createResource(
    () => props.slug,
    async (slug) => {
      const t = token();
      if (!t) return [];
      try {
        return await getFeaturedChannels(t, slug);
      } catch {
        // A failed featured fetch must not break the home view; the
        // section just stays empty. (Distinct from a JOIN failure, which
        // IS surfaced — that's a user-initiated action.)
        return [];
      }
    },
  );

  const onClick = async (name: string): Promise<void> => {
    setError(null);
    const joined = windowStateByChannel()[channelKey(props.slug, name)] === "joined";
    if (!joined) {
      const t = token();
      if (!t) return;
      try {
        await postJoin(t, props.slug, name, null);
      } catch (err) {
        setError(
          err instanceof ApiError ? `${name}: ${friendlyApiError(err)}` : `${name}: join failed`,
        );
        return;
      }
    }
    setSelectedChannel({ networkSlug: props.slug, channelName: name, kind: "channel" });
  };

  return (
    <Show when={(links() ?? []).length > 0}>
      <Show when={props.heading}>{(h) => <h3 class="home-pane-section-title">{h()}</h3>}</Show>
      <ul class="home-pane-featured" data-testid={`home-featured-${props.slug}`}>
        <For each={links()}>
          {(link) => (
            <li class="home-pane-featured-item">
              <button
                type="button"
                class="home-pane-featured-link"
                onClick={() => void onClick(link.name)}
                data-testid={`home-featured-link-${props.slug}-${link.name}`}
              >
                <span class="home-pane-featured-name">{link.name}</span>
                <Show when={link.description}>
                  <span class="home-pane-featured-desc muted">{link.description}</span>
                </Show>
              </button>
            </li>
          )}
        </For>
        <Show when={error()}>
          <li class="home-pane-featured-error" role="alert">
            {error()}
          </li>
        </Show>
      </ul>
    </Show>
  );
};

// UX-4 bucket B / #211 phase 6 — first-class `:home` window pinned ABOVE
// all networks. ONE data-driven component for BOTH subjects now (ruling
// A: "the user + visitor home pages are the SAME"). Off `homeData()`
// (populated for both since phase 6):
//
//   * networks list — one row per attached network with click-to-jump
//     (connected) / [Reconnect] chip (parked/failed). NO compose box
//     (home is a view, not a chat).
//   * available-to-connect section (visitors only — `available_networks`
//     is empty for users) — one-tap connect an on-demand
//     `visitor_enabled` network via `POST /session/networks`.
//   * welcome copy (visitors only) — orientation for a guest session.
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
//     2026-05-19) — a typed chip surfaces the action + inline
//     `friendlyApiError` text on failure (feedback_silent_retry_anti_pattern).

// #211 phase 6 — visitor welcome + orientation copy (guest sessions are
// ephemeral). Rendered above the networks list ONLY for visitor subjects
// (users get straight to their networks). Static cic-side string
// (operator-editable per-network welcome is #136, out of scope).
const HomeVisitorWelcome: Component = () => (
  <section class="home-pane-section home-pane-welcome" data-testid="home-visitor-welcome">
    <h2 class="home-pane-title">Welcome to Grappa</h2>
    <p>
      Grappa is an always-on IRC bouncer. Pick a channel and start talking — while your session
      stays open the bouncer keeps you connected, so you can close this tab and reopen it right
      where you left off.
    </p>
    <p class="muted">
      You're here as a guest. A visitor session is ephemeral: when it expires, its scrollback goes
      with it — nothing is kept for a guest nick.
    </p>
  </section>
);

// #211 phase 6 (ruling C) — "available to connect" section: the
// `visitor_enabled` networks the visitor hasn't attached yet. One-tap
// connect POSTs to `/session/networks` (accretion) → the network spawns
// + appears in the networks list on the next /me/networks refetch. Empty
// for users (`available_networks` is `[]`), so the whole section is gated
// on a non-empty list.
const AvailableNetworks: Component<{ available: AvailableNetworkRow[] }> = (props) => {
  const [error, setError] = createSignal<string | null>(null);
  const [connecting, setConnecting] = createSignal<string | null>(null);

  const onConnect = async (slug: string): Promise<void> => {
    const t = token();
    if (!t) return;
    setError(null);
    setConnecting(slug);
    try {
      await addNetwork(t, slug);
      // The server spawns + the connection_state_changed / networks
      // refetch surfaces the new row; this section drops it once /me
      // reflects the attach. No optimistic local mutation (cic never
      // originates state).
      refetchUser();
      refetchNetworks();
    } catch (err) {
      setError(
        err instanceof ApiError ? `${slug}: ${friendlyApiError(err)}` : `${slug}: connect failed`,
      );
    } finally {
      setConnecting(null);
    }
  };

  return (
    <Show when={props.available.length > 0}>
      <section class="home-pane-section home-pane-available-section" data-testid="home-available">
        <h3 class="home-pane-section-title">Available to connect</h3>
        <ul class="home-pane-available">
          <For each={props.available}>
            {(net) => (
              <li class="home-pane-available-item">
                <button
                  type="button"
                  class="home-pane-available-connect"
                  disabled={connecting() === net.slug}
                  data-testid={`home-available-connect-${net.slug}`}
                  onClick={() => void onConnect(net.slug)}
                >
                  {connecting() === net.slug ? `Connecting ${net.slug}…` : `+ ${net.slug}`}
                </button>
              </li>
            )}
          </For>
          <Show when={error()}>
            <li class="home-pane-available-error" role="alert">
              {error()}
            </li>
          </Show>
        </ul>
      </section>
    </Show>
  );
};

// Is the current subject a visitor? Drives the visitor-only welcome copy
// + the available-networks section (users get neither). Reads the /me
// resource, not the static subject, so a mid-session refetch is honoured.
function isVisitorSubject(): boolean {
  const m = user();
  return m?.kind === "visitor";
}

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
      <FeaturedLinks slug={props.row.slug} />
      <WatchedPanel slug={props.row.slug} />
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
        <FeaturedLinks slug={props.row.slug} />
      </div>
    </li>
  );
};

// The unified home body — renders for BOTH subjects off `homeData()`
// (populated for both since phase 6). `homeData()` is non-null here (the
// top-level `HomePane` gates on it). Visitor extras (welcome copy +
// available-to-connect) are gated on `isVisitorSubject()`; the networks
// list + reconnect/jump rows are identical for both subjects.
const HomePaneBody: Component = () => {
  const rows = () => homeData()?.networks ?? [];
  const available = () => homeData()?.available_networks ?? [];
  const visitor = () => isVisitorSubject();

  return (
    <div class="home-pane home-pane-registered">
      <Show when={visitor()}>
        <HomeVisitorWelcome />
      </Show>

      <h2 class="home-pane-title">Networks</h2>
      <Show
        when={rows().length > 0}
        fallback={
          <p class="muted">
            <Show
              when={visitor()}
              fallback={
                <>
                  No networks bound. Ask the operator to bind one via{" "}
                  <code>bin/grappa bind-network</code>.
                </>
              }
            >
              Connecting… pick a network below to get started.
            </Show>
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

      <AvailableNetworks available={available()} />
    </div>
  );
};

const HomePane: Component = () => {
  // #211 phase 6 — ONE component for both subjects; the fallback is only
  // the logged-out / loading state (homeData() null before /me lands).
  return (
    <Show when={homeData()} fallback={<div class="home-pane home-pane-loading" />}>
      <HomePaneBody />
    </Show>
  );
};

export default HomePane;
