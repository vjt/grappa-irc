import { type Component, createResource, createSignal, For, Show } from "solid-js";
import {
  ApiError,
  type AvailableNetworkRow,
  addNetwork,
  type ConnectionState,
  getFeaturedChannels,
  postJoin,
} from "./lib/api";
import { token } from "./lib/auth";
import { channelKey } from "./lib/channelKey";
import { friendlyApiError } from "./lib/friendlyApiError";
import { homeData } from "./lib/home";
import {
  HOME_ALWAYS_ON_COPY,
  HOME_NETWORKS_INTRO_COPY,
  homeFeaturedIntroCopy,
  homeSessionLifetime,
  type SessionLifetimeCopy,
} from "./lib/homeSessionCopy";
import { identifiedForNetwork } from "./lib/identity";
import { createNetworkReconnect } from "./lib/networkReconnect";
import { networkIdBySlug, refetchNetworks, refetchUser, user } from "./lib/networks";
import { flavorForSlug, registerableFlavor } from "./lib/registrationTemplates";
import { openRegistrationWizard } from "./lib/registrationWizard";
import { setSelectedChannel } from "./lib/selection";
import { isShareableSubject, openShareModal, SHARE_SESSION_LABEL } from "./lib/shareModal";
import { pushLinks, pushRecover } from "./lib/socket";
import { confirmDisconnectNetwork } from "./lib/windowClose";
import { LIST_WINDOW_NAME, SERVER_WINDOW_NAME } from "./lib/windowKinds";
import { windowStateByChannel } from "./lib/windowState";
import NickText from "./NickText";

// #496/#513 — the per-network 🗺 Map (LINKS/topology) control stays HIDDEN.
// #513 fixed the two /links defects behind the original #496 gate (the
// mask-matched-nothing empty state + the two-requests lost-bundle race), so
// the button COULD return — but vjt's product call is to keep it hidden: the
// `/links` command is the sole entry point to the topology map. Kept as a flag
// (not deleted) so the button + its onTopology wiring restore in one line if
// that call ever changes.
const SHOW_NETWORK_MAP = false;

// #85 — operator-curated featured channels for a network, fetched on
// home DISPLAY (component mount / slug change) so an operator config
// edit lands on the next render without a /me re-fetch or PubSub push.
// Click: not joined → JOIN then focus (intent follows the tap, mirroring
// compose.ts /join); already joined → focus only (#125 tap-already-
// joined). Join errors surface inline — never silently swallowed.
// #496 — an explanatory intro line (`homeFeaturedIntroCopy`) precedes the
// list, gated on the same has-links condition so an empty featured list
// shows neither the intro nor a dangling heading. `heading` (optional) still
// renders a section title ABOVE the list for callers that title the section.
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
      {/* #529 — the featured-channels subsection heading: real heading weight
          + padding-top (was a muted <p> glued to the buttons above). h3 keeps
          the established subsection level (matches the `heading`-prop path
          above) rather than skipping a level down to h4. */}
      <h3 class="home-pane-featured-heading">{homeFeaturedIntroCopy(props.slug)}</h3>
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
//   * welcome copy — the always-on value prop (#496), shown to EVERYONE
//     (both subjects): the connection lives on the server, so reopening the
//     app is enough to be back in the conversation.
//   * per-subject session-lifetime line (#496) — the honest ∞ / 48h / 7-day
//     truth for the current subject (see `homeSessionLifetime`).
//   * networks list — one row per attached network with click-to-jump
//     (connected) / [Reconnect] chip (parked/failed). NO compose box
//     (home is a view, not a chat).
//   * available-to-connect section — one-tap connect an on-demand
//     `visitor_enabled` network via `POST /session/networks` (#481: both
//     subjects; empty for a fully-bound user).
//
// Help-text + button labels live entirely in cic (the `homeSessionCopy`
// module + this file) per the no-localized-strings-server-side rule. The
// server-side envelope carries structured data only (slug, nick, atom
// states, the `registered` boolean).
//
// Click semantics:
//   * :connected row → jump to that network's $server window. Useful
//     "go to network" shortcut; mirrors the existing Sidebar server-
//     row selection contract.
//   * :parked / :failed row → explicit [Reconnect] chip (UX-5 BR,
//     2026-05-19) — a typed chip surfaces the action + inline
//     `friendlyApiError` text on failure (feedback_silent_retry_anti_pattern).

// #496 — the welcome section: the always-on value prop (universal) followed
// by the honest per-subject session-lifetime line. Rendered for BOTH subjects
// (the guest-orientation copy folded into the per-subject line). `session` is
// null only in the (unreachable-here) no-`/me` window; the block still shows
// the always-on prose.
const HomeWelcome: Component<{ session: SessionLifetimeCopy | null }> = (props) => (
  <section class="home-pane-section home-pane-welcome" data-testid="home-welcome">
    <h2 class="home-pane-title">Welcome to Grappa</h2>
    <p>{HOME_ALWAYS_ON_COPY}</p>
    <Show when={props.session}>
      {(s) => (
        <p class="home-pane-session muted" data-testid={s().testid}>
          {s().text}
        </p>
      )}
    </Show>
  </section>
);

// #211 phase 6 (ruling C) — "available to connect" section: the
// `visitor_enabled` networks the subject hasn't attached yet. One-tap
// connect POSTs to `/session/networks` (accretion) → the network spawns
// + appears in the networks list on the next /me/networks refetch. Empty
// for a fully-bound subject (`available_networks` is `[]`), so the whole
// section is gated on a non-empty list.
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
        <p class="home-pane-section-intro muted">
          Tap a network to connect and start chatting on it.
        </p>
        <ul class="home-pane-available">
          <For each={props.available}>
            {(net) => (
              <li class="home-pane-available-item">
                <button
                  type="button"
                  class="adm-btn home-pane-available-connect"
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

// Is the current subject a visitor? Drives the available-networks section
// visitor-share gate. Reads the /me resource, not the static subject, so a
// mid-session refetch is honoured.
function isVisitorSubject(): boolean {
  const m = user();
  return m?.kind === "visitor";
}

// #1306 — may this session be shared to a second device? Delegates the rule
// to `isShareableSubject` so the settings-drawer door answers identically;
// what stays local is the SOURCE, the /me resource (not the static subject)
// so a mid-session refetch is honoured. #363's incognito exclusion is the
// only thing the rule still refuses.
function canShareSession(): boolean {
  return isShareableSubject(user());
}

// UX-5 BR row sub-component. Per-row local error signal so each
// chip's failure text scopes to its own row — a single top-level
// signal would render the message on every row.
type HomeRow = {
  slug: string;
  nick: string;
  connection_state: ConnectionState;
  connection_state_reason: string | null;
  connection_state_changed_at: string | null;
  // #581 (D2) — the credential carries a NickServ secret, so /recover has
  // something to identify with. Drives the "Recover identity" CTA.
  recoverable: boolean;
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
  // #238 — the per-network "server window" entry point the issue asks for
  // (alongside the /links slash command). Land on this network's $server
  // (so the network-scoped LinksModal shows THIS network's topology when the
  // bundle arrives) then push LINKS. Fire-and-forget behind the modal, like
  // onDisconnect — the canonical error-surfacing door is the /links slash
  // command in the compose box; a rejected push (e.g. no live session) just
  // leaves the modal unopened rather than crashing the row.
  // #496 — invoked only when `SHOW_NETWORK_MAP` is flipped back on.
  const onTopology = () => {
    onJump();
    const id = networkIdBySlug(props.row.slug);
    if (id !== undefined) void pushLinks(id, null).catch(() => {});
  };
  // #283 — per-network Disconnect, symmetric with DisconnectedRow's
  // Reconnect chip. REUSES the #195 confirm modal (windowClose.
  // confirmDisconnectNetwork → "Disconnect from <slug>?"), the SAME verb
  // the sidebar/bottom-bar × fires — subject-agnostic (park-one for both
  // user + visitor since #211 phase 6). Fire-and-forget behind the modal
  // (no pending/error chip): the park is confirmed by the row swapping to
  // DisconnectedRow on the connection_state_changed event, exactly like
  // the ×. (vjt decision, issue #283 2026-07-20: match the ×, not
  // Reconnect's awaited-PATCH UX.)
  const onDisconnect = () => {
    confirmDisconnectNetwork(props.row.slug);
  };
  // #349 — the "Register nick" launcher is gated on TWO reactive signals:
  // (a) the network runs a services suite cic has a REGISTER template for
  // (registerable services_flavor, resolved from the networks store — the
  // HomeRow itself doesn't carry it), and (b) we're NOT already identified
  // to services. Both are reactive, so the button auto-hides the instant
  // registration completes or on an unknown flavor — zero polling.
  // `networkIdBySlug` can be undefined before the networks resource lands;
  // treat that as "not seeded yet" (button shows).
  //
  // #388 — (b) asks the server's NORMALIZED verdict instead of spelling
  // `umodes.includes("r")` here. That spelling was bahamut-only: on Libera
  // there is no registered umode at all, so the button never hid and the
  // wizard could not tell registration had succeeded.
  const canRegister = () => {
    const slug = props.row.slug;
    if (!registerableFlavor(flavorForSlug(slug))) return false;
    const id = networkIdBySlug(slug);
    return id === undefined ? true : !identifiedForNetwork(id);
  };
  // #581 — the "Recover identity" launcher, sibling of canRegister(): shown
  // when (a) the credential carries a NickServ secret (`recoverable`, D2),
  // (b) this is a VISITOR session (recover is visitor-only server-side — a
  // user seeing it would only earn a `forbidden`), and (c) we're NOT already
  // identified. All reactive, so the button auto-hides the instant recovery
  // lands. Mirrors canRegister's undefined-id "not seeded yet" tolerance
  // (button shows), and reads the same #388 normalized verdict.
  const canRecover = () => {
    if (!props.row.recoverable) return false;
    if (!isVisitorSubject()) return false;
    const id = networkIdBySlug(props.row.slug);
    return id === undefined ? true : !identifiedForNetwork(id);
  };
  // Fire-and-forget like onTopology: the RecoverModal opens off the SERVER's
  // first recover_progress event (cic never originates state), and the
  // canonical error-surfacing door is the /recover slash command — a rejected
  // push just leaves the modal unopened rather than crashing the row.
  const onRecover = () => {
    const id = networkIdBySlug(props.row.slug);
    if (id !== undefined) void pushRecover(id).catch(() => {});
  };
  // #529 — the connected-row layout: a horizontal rule opens each network
  // block; the heading carries the network title (slug + nick, clickable →
  // jump-to-$server) on the left and a STATUS group (state label + the
  // Disconnect action it acts on) on the right. The 📇 Browse channels +
  // 📝 Register nick controls pair up as ONE button row (same style, same
  // weight) below the heading, then the operator-featured channels. The 🗺 Map
  // control is flag-hidden (SHOW_NETWORK_MAP) until /links is fixed.
  return (
    <li class="home-pane-network-row home-pane-network-row-connected">
      <hr class="home-pane-network-separator" />
      <div class="home-pane-network-heading">
        <button type="button" class="home-pane-network-title" onClick={onJump}>
          <span class="home-pane-network-slug">{props.row.slug}</span>
          <NickText nick={props.row.nick} extraClass="home-pane-network-nick" />
        </button>
        <div class="home-pane-network-status">
          <span class="home-pane-network-state">{props.row.connection_state}</span>
          <Show when={SHOW_NETWORK_MAP}>
            <button
              type="button"
              class="adm-btn home-pane-network-action home-pane-network-topology"
              data-testid={`home-topology-${props.row.slug}`}
              aria-label={`Network map for ${props.row.slug}`}
              onClick={onTopology}
            >
              🗺 Map
            </button>
          </Show>
          <button
            type="button"
            class="adm-btn adm-btn--danger home-pane-network-action home-pane-network-disconnect"
            aria-label={`Disconnect ${props.row.slug}`}
            onClick={onDisconnect}
          >
            Disconnect
          </button>
        </div>
      </div>
      <div class="home-pane-network-cta">
        <button type="button" class="adm-btn home-pane-network-browse" onClick={onBrowse}>
          📇 Browse channels
        </button>
        <Show when={canRegister()}>
          {/* #529 — same class as Browse so the pair reads as one button set
              (equal weight); identified in tests by its data-testid. */}
          <button
            type="button"
            class="adm-btn home-pane-network-browse"
            data-testid={`home-register-nick-${props.row.slug}`}
            onClick={() => openRegistrationWizard(props.row.slug)}
          >
            📝 Register nick
          </button>
        </Show>
        <Show when={canRecover()}>
          {/* #581 — same button set (equal weight) as Browse / Register;
              identified in tests by its data-testid. */}
          <button
            type="button"
            class="adm-btn home-pane-network-browse"
            data-testid={`home-recover-identity-${props.row.slug}`}
            onClick={onRecover}
          >
            🔑 Recover identity
          </button>
        </Show>
      </div>
      <FeaturedLinks slug={props.row.slug} />
    </li>
  );
};

const DisconnectedRow: Component<{ row: HomeRow }> = (props) => {
  // #1331 — the PATCH, the pending latch and the friendly error mapping moved
  // to `lib/networkReconnect` when the greyed compose seam grew the same
  // action; this row keeps its own error SINK (the `role="alert"` span below)
  // and nothing else. Server emits connection_state_changed (REV-J M15 folded
  // the prior home_network_state_changed arm into it), userTopic.ts patches
  // homeData() in place, and this sub-component unmounts — no local success
  // state to clean up.
  const [error, setError] = createSignal<string | null>(null);
  const reconnector = createNetworkReconnect(setError);

  return (
    <li
      class="home-pane-network-row"
      classList={{
        "home-pane-network-row-parked": props.row.connection_state === "parked",
        "home-pane-network-row-failed": props.row.connection_state === "failed",
      }}
    >
      {/* #529 — same heading/separator shape as ConnectedRow: a horizontal
          rule opens the block, a static title (slug + nick) on the left, and
          a STATUS group pairing the state label with the Reconnect action it
          acts on (symmetric with ConnectedRow's state + Disconnect). Reason +
          inline error sit below the heading; no Browse/Register (a
          parked/failed network has no live session to /LIST or register on). */}
      <hr class="home-pane-network-separator" />
      <div class="home-pane-network-heading">
        <div class="home-pane-network-title home-pane-network-title-static">
          <span class="home-pane-network-slug">{props.row.slug}</span>
          <NickText nick={props.row.nick} extraClass="home-pane-network-nick" />
        </div>
        <div class="home-pane-network-status">
          <span class="home-pane-network-state">{props.row.connection_state}</span>
          <button
            type="button"
            class="adm-btn home-pane-network-action home-pane-network-reconnect"
            disabled={reconnector.pending()}
            aria-label={`Reconnect ${props.row.slug}`}
            onClick={() => void reconnector.reconnect(props.row.slug)}
          >
            {reconnector.pending() ? "Reconnecting…" : "Reconnect"}
          </button>
        </div>
      </div>
      <Show when={props.row.connection_state_reason}>
        <div class="home-pane-network-reason">{props.row.connection_state_reason}</div>
      </Show>
      <Show when={error()}>
        <span class="home-pane-network-error" role="alert">
          {error()}
        </span>
      </Show>
      <FeaturedLinks slug={props.row.slug} />
    </li>
  );
};

// The unified home body — renders for BOTH subjects off `homeData()`
// (populated for both since phase 6). `homeData()` is non-null here (the
// top-level `HomePane` gates on it). The welcome + per-subject session line
// (#496) and the networks list are identical for both subjects; what still
// reads the subject kind is the empty-networks copy, not the share button
// (#1306 opened that to users).
const HomePaneBody: Component = () => {
  const rows = () => homeData()?.networks ?? [];
  const available = () => homeData()?.available_networks ?? [];
  const visitor = () => isVisitorSubject();
  const shareable = () => canShareSession();
  // #496 — the honest per-subject session-lifetime copy. `user()` is non-null
  // here (HomePane gates on `homeData()`, which derives from the same /me
  // resource); the null-guard keeps the type total.
  const session = (): SessionLifetimeCopy | null => {
    const m = user();
    return m ? homeSessionLifetime(m, rows()) : null;
  };

  return (
    <div class="home-pane home-pane-registered">
      <HomeWelcome session={session()} />

      <section class="home-pane-section home-pane-networks-section">
        <h2 class="home-pane-title">Networks</h2>
        <Show
          when={rows().length > 0}
          fallback={
            <p class="muted" data-testid="home-networks-empty">
              {/* #481 — when there are networks to self-connect (available
                  to BOTH subjects now), guide to the picker below instead of
                  telling a user to "ask the operator": that copy is a #461
                  relic when the user can one-tap connect. Only a subject with
                  NO available networks falls back to the per-subject dead-end
                  copy (visitor mid-connect vs user operator-bind hint). */}
              <Show
                when={available().length > 0}
                fallback={
                  <Show
                    when={visitor()}
                    fallback={
                      <>
                        No networks bound. Ask the operator to bind one via{" "}
                        <code>bin/grappa bind-network</code>.
                      </>
                    }
                  >
                    Connecting…
                  </Show>
                }
              >
                Pick a network below to get started.
              </Show>
            </p>
          }
        >
          <p class="home-pane-section-intro muted">{HOME_NETWORKS_INTRO_COPY}</p>
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
      </section>

      <AvailableNetworks available={available()} />

      {/* #392 — session-wide "open on another device" entry, placed AFTER the
          network list because the share is session-wide (every network),
          unlike the per-network 📝 Register nick that lives in each row's
          action area. Opens the SAME modal (QR + native-share + countdown) the
          settings button opens. #1306 — no longer visitor-gated: the server
          mints for a password subject too, so a user shares to their second
          device with the same link instead of re-typing a password. #363 —
          still hidden while incognito: an ephemeral session must not be
          portable. Same `canShareSession()` rule as the settings-side door. */}
      <Show when={shareable()}>
        <button
          type="button"
          class="home-pane-share"
          data-testid="home-share-session"
          onClick={() => openShareModal()}
        >
          <span class="home-pane-share-icon" aria-hidden="true">
            📱
          </span>
          {SHARE_SESSION_LABEL}
        </button>
      </Show>
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
