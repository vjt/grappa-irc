import { type Component, For, Show } from "solid-js";
import CloseButton from "./CloseButton";
import { ownNickForNetwork } from "./lib/api";
import { awayByNetwork } from "./lib/awayStatus";
import { channelKey } from "./lib/channelKey";
import { mentionsBundleBySlug } from "./lib/mentionsWindow";
import { channelsBySlug, isAdmin, networkBySlug, networks, user } from "./lib/networks";
import { navPseudoChannelsForNetwork } from "./lib/pseudoChannels";
import { queryWindowsByNetwork } from "./lib/queryWindows";
import { reconnectingByNetwork } from "./lib/reconnectingStatus";
import { requestScrollToBottom } from "./lib/scrollToBottomCommand";
import { isActiveSelection, selectedChannel, setSelectedChannel } from "./lib/selection";
import { openUmodeModal } from "./lib/umodeModal";
import { umodesForNetwork } from "./lib/umodes";
import {
  closeQueryWindow,
  confirmDisconnectNetwork,
  confirmLeaveChannel,
  dismissPseudoWindow,
} from "./lib/windowClose";
import type { WindowKind } from "./lib/windowKinds";
import {
  ADMIN_WINDOW_NAME,
  ADMIN_WINDOW_SLUG,
  HOME_WINDOW_NAME,
  HOME_WINDOW_SLUG,
  LIST_WINDOW_NAME,
  SERVER_WINDOW_NAME,
} from "./lib/windowKinds";
import { windowStateByChannel } from "./lib/windowState";
import NickText from "./NickText";
import WindowBadges from "./WindowBadges";

// Left-pane sidebar: network → window tree. Renders ordered windows:
//   1. Server (always present, not closeable)
//   2. Channels (from IRC JOIN state; closeable via PART)
//   3. Query windows (DM targets; closeable via close_query_window event)
//   4. Ephemeral pseudo-windows (list, mentions) when present
//
// Close behavior per kind (spec #6):
//   - server   → no X button rendered
//   - channel  → X button → postPart REST (PART IRC command)
//   - query    → X button → closeQueryWindowState (server deletes row)
//   - list     → X button → client-side dismiss (no server call)
//   - mentions → X button → client-side dismiss (no server call)
//
// UX-5 bucket A (2026-05-19) — `onSelect` prop dropped. Pre-bucket
// Shell.tsx fired it from the desktop branch to auto-close the
// sidebar drawer when the operator picked a channel. The desktop
// sidebar is always-visible (no drawer to close) and the mobile
// branch never mounts Sidebar (uses BottomBar instead). The prop
// had no remaining consumer.
//
// CP15 B5 — windowState visual cues:
//   * Channel/query rows whose state ∈ {failed, kicked, parked} get
//     `.sidebar-window-greyed` so the operator sees the row is no
//     longer live (the row stays in place to keep history
//     accessible — archiving on every failure would punish the
//     victim and lose the scrollback).
//   * Pending channels NOT yet in `channelsBySlug` (operator just
//     clicked JOIN; awaiting upstream echo) render as a synthetic
//     pending sidebar row for immediate feedback. When the server
//     echoes JOIN, channelsBySlug refetches via the channels_changed
//     heartbeat and the row continues life under the channelsBySlug
//     branch (state transitions pending → joined; greyed class falls
//     off). The dedup gate skips the synthetic row when the channel
//     is already in channelsBySlug.
//
// CP19 T32 parked-window — per-network derivation overlay:
//   When the network's credential `connection_state ∈ {parked, failed}`
//   the network header gets `.sidebar-network-greyed` AND every channel/
//   query row under it derives as greyed regardless of its individual
//   `windowStateByChannel` entry. Source of truth is
//   `networkBySlug[slug].connection_state` (refreshed via the user-topic
//   `connection_state_changed` event → `refetchNetworks()` arm). Per
//   CLAUDE.md "Don't duplicate state — derive it" — we don't emit
//   per-window `:parked` events from `Session.Server.terminate/2`; cic
//   derives the cascade from the network-level state.

// #902 — `invited` left this set with the pseudo-row itself: an unanswered
// invite is announced by the top banner now, so no sidebar row carries that
// state to grey out.
const NOT_JOINED_STATES = new Set(["failed", "kicked", "parked"]);
const NETWORK_GREYED_STATES = new Set(["parked", "failed"]);

// #96 — a row's state, spoken. Every non-live sidebar row is rendered muted +
// italic and NOTHING else: a screen reader gets no signal at all, and the
// greyed (parked / failed / kicked) and parted treatments are
// pixel-identical, so a sighted operator can't tell them apart either. This
// folds the word into the button's accessible name ("#italia (parked)")
// without touching a single pixel. Renders nothing when there's no state to
// report, so a live row's name is unchanged.
const RowState: Component<{ state: string | null }> = (props) => (
  <Show when={props.state}>{(state) => <span class="sr-only"> ({state()})</span>}</Show>
);

export type Props = Record<string, never>;

const Sidebar: Component<Props> = () => {
  const isSelected = (slug: string, name: string): boolean => {
    const s = selectedChannel();
    return s !== null && s.networkSlug === slug && s.channelName === name;
  };

  // #96 — the row a keyboard/screen-reader operator is ON. Selection was
  // conveyed by the `.selected` class alone (background + accent colour), so
  // an assistive tech had no way to tell which of N rows is the open window.
  // `aria-current` is the annotation for "the one in a set that is current";
  // it goes on the <button> (the focusable node the AT lands on), not the
  // <li> that carries the class.
  const ariaCurrent = (slug: string, name: string): "true" | undefined =>
    isSelected(slug, name) ? "true" : undefined;

  // CP19 T32: network-level greyed when the credential is parked or
  // failed. Drives both the network header `.sidebar-network-greyed`
  // class AND the cascading per-channel/per-query overlay in
  // `greyedState/2` below.
  //
  // Bucket F H4: only UserNetwork carries connection_state. Narrow on
  // network.kind first; visitor networks are never greyed at the
  // network level (visitors have no credential row to park / fail).
  //
  // #96 — returns the STATE WORD, not a boolean: the greyed treatment is
  // muted + italic, which is (a) invisible to a screen reader and (b)
  // pixel-identical to the `.parted` treatment, so not even a sighted
  // operator can tell "network parked" from "you left this channel". One
  // derivation feeds both consumers — the class (colour) and the sr-only
  // word (announced) — so the two can never disagree.
  const networkGreyedState = (slug: string): string | null => {
    const net = networkBySlug(slug);
    if (net?.kind !== "user") return null;
    return NETWORK_GREYED_STATES.has(net.connection_state) ? net.connection_state : null;
  };

  const isNetworkGreyed = (slug: string): boolean => networkGreyedState(slug) !== null;

  // Network cascade wins over the per-window state deliberately: when the
  // credential is parked, EVERY row under it is unreachable regardless of
  // what its own window state last said. Same precedence the boolean had.
  const greyedState = (slug: string, name: string): string | null => {
    const cascade = networkGreyedState(slug);
    if (cascade !== null) return cascade;
    const own = windowStateByChannel()[channelKey(slug, name)];
    return own !== undefined && NOT_JOINED_STATES.has(own) ? own : null;
  };

  const isGreyed = (slug: string, name: string): boolean => greyedState(slug, name) !== null;

  const networkReason = (slug: string): string | undefined => {
    const net = networkBySlug(slug);
    if (net?.kind !== "user") return undefined;
    return net.connection_state_reason ?? undefined;
  };

  // Synthetic non-joined window rows come from the shared projection in
  // `lib/pseudoChannels.ts` (extracted #71 INC-3). Rationale for the
  // joined-exclusion, the #902 invited-exclusion, the channelsBySlug dedup,
  // and the query-target filter lives there.

  const handleClick = (slug: string, name: string, kind: WindowKind) => {
    const target = { networkSlug: slug, channelName: name, kind };
    // #243 — re-tapping the ALREADY-active row is a "jump to latest": fire
    // the scroll-to-bottom command (ScrollbackPane is the only subscriber
    // and it only mounts for scrollback windows, so this self-gates — a
    // re-tap on home/admin/list is a harmless no-op). Compute BEFORE the
    // setter (which is idempotent on a re-tap anyway). A tap that SWITCHES
    // windows leaves existing behaviour untouched.
    if (isActiveSelection(target)) requestScrollToBottom();
    setSelectedChannel(target);
  };

  // #229 — compact umode string for the network-header indicator, e.g.
  // "+iS". Empty when the session reports no umodes (parked / pre-connect /
  // genuinely no umodes) so the indicator hides. Reads the reactive
  // umodesForNetwork store — updates live on 221 / self-MODE echoes.
  const umodeIndicator = (networkId: number): string => {
    const modes = umodesForNetwork(networkId);
    return modes.length > 0 ? `+${modes.join("")}` : "";
  };

  // #195 — the × on a channel row opens an explicit "leave #channel?" confirm
  // modal (windowClose.confirmLeaveChannel → PART on Yes), replacing the
  // removed #172 hold-to-close gesture.
  const handleCloseChannel = (slug: string, channelName: string) => {
    confirmLeaveChannel(slug, channelName);
  };

  const handleCloseQuery = (networkId: number, targetNick: string) => {
    closeQueryWindow(networkId, targetNick);
  };

  // #71 INC-3 — pseudo-row × (pending/failed/kicked/parked) routes through
  // the shared `dismissPseudoWindow` verb in windowClose.ts (drops the
  // windowState key + redirects a focused row to $server). Extracted so the
  // desktop Sidebar and the mobile BottomBar dismiss identically — no inline
  // duplication left behind.

  // UX-4 bucket D — close the server window for a network. Routes
  // through windowClose.ts → visitor branches to quitAll (nuclear: park
  // every network + logout); registered PATCHes the one network to
  // `:parked`. Selection auto-redirects to home via the
  // `connection_state_changed` arm in selection.ts (one effect, all
  // park triggers).
  // #195 — the × on a network-header row opens an explicit "Disconnect from
  // <slug>?" confirm modal (windowClose.confirmDisconnectNetwork →
  // park/quit on Yes), same gate as the channel leave.
  const handleCloseNetwork = (slug: string) => {
    confirmDisconnectNetwork(slug);
  };

  return (
    <>
      {/* UX-4 bucket B — `$home` pinned ABOVE all networks. Identity-
          scoped (NOT per-network), so it lives OUTSIDE the per-network
          `<For>` loop. Both visitor + registered identities see this
          row; HomePane internally branches on `homeData()`. */}
      <ul class="sidebar-home-section">
        <li classList={{ selected: isSelected(HOME_WINDOW_SLUG, HOME_WINDOW_NAME) }}>
          <button
            type="button"
            class="sidebar-window-btn sidebar-home-btn"
            aria-current={ariaCurrent(HOME_WINDOW_SLUG, HOME_WINDOW_NAME)}
            onClick={() => handleClick(HOME_WINDOW_SLUG, HOME_WINDOW_NAME, "home")}
          >
            <span class="sidebar-home-emoji" aria-hidden="true">
              🏠
            </span>
            <span class="sidebar-channel-name">Home</span>
          </button>
        </li>
      </ul>

      {/* UX-4 bucket N — `$admin` pinned between Home and the first
          network's `$server` row. Identity-scoped (NOT per-network)
          AND admin-only (gated on `isAdmin()` — single source of truth
          shared with Shell.tsx pane dispatcher + SettingsDrawer.tsx
          drawer entry). Non-admin operators see no row at all and
          cannot reach the AdminPane by hand-crafting a selection
          (Shell's `<Show when={isAdmin()}>` gates the mount too). */}
      <Show when={isAdmin()}>
        <ul class="sidebar-admin-section">
          <li classList={{ selected: isSelected(ADMIN_WINDOW_SLUG, ADMIN_WINDOW_NAME) }}>
            <button
              type="button"
              class="sidebar-window-btn sidebar-admin-btn"
              aria-current={ariaCurrent(ADMIN_WINDOW_SLUG, ADMIN_WINDOW_NAME)}
              data-testid="sidebar-admin-row"
              onClick={() => handleClick(ADMIN_WINDOW_SLUG, ADMIN_WINDOW_NAME, "admin")}
            >
              <span class="sidebar-admin-emoji" aria-hidden="true">
                🔧
              </span>
              <span class="sidebar-channel-name">admin</span>
            </button>
          </li>
        </ul>
      </Show>

      <Show
        when={(networks()?.length ?? 0) > 0}
        fallback={<p class="muted sidebar-empty">no networks</p>}
      >
        <For each={networks()}>
          {(network) => (
            <>
              {/* #96 — the per-network <ul> is the grouping the sidebar draws
                  with a rail and a tinted header row; unnamed, a screen
                  reader announced it as a bare "list, 6 items" and the
                  network→window hierarchy was carried by pixels only. Naming
                  the list is the whole of that hierarchy expressible without
                  restructuring the DOM (see the tree-role note in the #96 PR
                  body). The home + admin <ul>s stay unnamed on purpose: they
                  are identity-scoped SINGLE rows, not groups — a name there
                  would just repeat the row's own label. */}
              <ul
                class={`sidebar-network-section${isNetworkGreyed(network.slug) ? " sidebar-network-greyed" : ""}`}
                aria-label={`${network.slug} windows`}
              >
                {/* UX-4 bucket C — network header + server window collapsed
                  into a single row. The old per-network `<h3>` is gone; this
                  row IS both the network grouping label AND the server-window
                  selector. Click sets `selectedChannel.kind = "server"` with
                  channel = `$server`. The `.sidebar-network-header` class
                  keeps the row visually distinct from the indented per-channel
                  rows below via accent color + shallower left padding. */}
                <li
                  class="sidebar-network-header"
                  classList={{ selected: isSelected(network.slug, SERVER_WINDOW_NAME) }}
                  data-window-name={SERVER_WINDOW_NAME}
                >
                  <button
                    type="button"
                    onClick={() => handleClick(network.slug, SERVER_WINDOW_NAME, "server")}
                    class="sidebar-window-btn"
                    aria-current={ariaCurrent(network.slug, SERVER_WINDOW_NAME)}
                  >
                    {/* #71 INC-1 — the leading ⚙️ network-emoji is REMOVED.
                      It made the server line read reverse-indented against the
                      channels below (issue #71 "server row affordance"). The
                      slug now leads the row; the header is distinguished as the
                      group parent by weight + background (CSS), and a per-network
                      grouping rail ties the channels to it. The settings cog is
                      NOT here — it lives in the right-bar action cluster (INC-2 /
                      brief comment 5083762039). */}
                    <span
                      class="sidebar-channel-name"
                      title={
                        isNetworkGreyed(network.slug) ? networkReason(network.slug) : undefined
                      }
                    >
                      {network.slug}
                    </span>
                    {/* #96 — the greyed network header's only cue is
                        muted+italic (`.sidebar-network-greyed`) plus a `title`
                        tooltip, and a tooltip is mouse-only. Speak the state. */}
                    <RowState state={networkGreyedState(network.slug)} />
                    {/* C8.3 — away visual indicator. Surfaces on the
                      collapsed network-header row when the user is in away
                      state on this network. Driven by `away_confirmed`
                      server event via awayStatus.ts.
                      #276 — the VISIBLE label is the 💤 (zzz) emoji, not the
                      word "away". The accessible name stays the WORD "away"
                      (aria-label) so a screen reader announces the state, not
                      the emoji's "sleeping symbol" glyph name. */}
                    <Show when={awayByNetwork()[network.slug]}>
                      <span class="sidebar-away-badge" role="img" aria-label="away" title="away">
                        {"💤"}
                      </span>
                    </Show>
                    {/* #100 — transient reconnect indicator. Surfaces on the
                      network-header row while a Session (re)establishes the
                      upstream socket after a drop. Driven by the
                      `connection_progress` server event via
                      reconnectingStatus.ts; presentational overlay only (the
                      durable connection_state is unchanged). Clears on 001. */}
                    <Show when={reconnectingByNetwork()[network.slug]}>
                      <span class="sidebar-reconnecting-badge" data-testid="reconnecting-badge">
                        reconnecting…
                      </span>
                    </Show>
                    {/* CP13 — server-window receives :notice rows for server-routed
                      numerics + NickServ + MOTD + ChanServ-fallback. Same badge
                      treatment as channels so unread counts surface uniformly. */}
                    <WindowBadges
                      channelKey={channelKey(network.slug, SERVER_WINDOW_NAME)}
                      variant="sidebar"
                    />
                  </button>
                  {/* #229 — umode indicator + tap target. Shows the
                    operator's own umodes compactly (e.g. "+iS") and opens
                    the umode viewer/editor modal on tap — the tap entry
                    point alongside `/umode` and `/mode <ownnick>`. A
                    <button> not a <span> (keyboard-reachable, no
                    noStaticElementInteractions — #220 lesson). Rendered
                    when the store holds at least one umode for this network.
                    Like the isupport store, umodesByNetwork is last-write-
                    wins and NOT cleared on park/disconnect — a network that
                    was live keeps its stale indicator on the greyed row
                    until the next connect's 221/cold-snapshot re-seeds it
                    (a never-connected network shows nothing). */}
                  <Show when={umodeIndicator(network.id).length > 0}>
                    <button
                      type="button"
                      class="sidebar-umode-indicator"
                      title={`user modes: ${umodeIndicator(network.id)}`}
                      aria-label={`view your user modes on ${network.slug}`}
                      onClick={() => openUmodeModal(network.slug)}
                    >
                      {umodeIndicator(network.id)}
                    </button>
                  </Show>
                  {/* UX-4 bucket D — × button on the network-header row
                    closes the server window which == /disconnect for
                    registered users (one network parked → selection
                    redirects to home) and == /quit for visitors (all
                    networks parked + logout). Routing in
                    windowClose.disconnectNetwork; selection redirect
                    in selection.ts. */}
                  <CloseButton
                    class="sidebar-close"
                    ariaLabel={`Disconnect ${network.slug}`}
                    onConfirm={() => handleCloseNetwork(network.slug)}
                  />
                </li>

                {/* #84 — per-network channel directory (/list). Selects the `$list`
                  pseudo-window (kind "list"); no scrollback fetch (KIND_HAS_SCROLLBACK
                  .list = false). Browse + one-click join via DirectoryPane. */}
                <li
                  class="sidebar-list-row"
                  classList={{ selected: isSelected(network.slug, LIST_WINDOW_NAME) }}
                  data-window-name={LIST_WINDOW_NAME}
                >
                  <button
                    type="button"
                    onClick={() => handleClick(network.slug, LIST_WINDOW_NAME, "list")}
                    class="sidebar-window-btn"
                    aria-current={ariaCurrent(network.slug, LIST_WINDOW_NAME)}
                  >
                    <span class="sidebar-network-emoji" aria-hidden="true">
                      📇
                    </span>
                    <span class="sidebar-channel-name">channels</span>
                  </button>
                </li>

                {/* #71 INC-2 — mentions row. Desktop replacement for the
                  ShellChrome @ open-mentions button, which now stays MOBILE-only
                  (mobile has no sidebar). Rendered ONLY when this network carries
                  a mentions bundle (the "you were /away" snapshot) — nothing to
                  open otherwise, the SAME gate the @ button used. A direct <li>
                  of THIS network <ul>, so it inherits the per-network grouping
                  rail exactly like a channel row. Selects the mentions
                  pseudo-window (kind "mentions", empty channel name) through the
                  same handleClick verb every row uses — one selection door. */}
                <Show when={mentionsBundleBySlug()[network.slug]}>
                  <li
                    class="sidebar-mentions-row"
                    classList={{ selected: isSelected(network.slug, "") }}
                    data-testid={`sidebar-mentions-row-${network.slug}`}
                  >
                    <button
                      type="button"
                      onClick={() => handleClick(network.slug, "", "mentions")}
                      class="sidebar-window-btn"
                      aria-current={ariaCurrent(network.slug, "")}
                    >
                      <span class="sidebar-network-emoji" aria-hidden="true">
                        @
                      </span>
                      <span class="sidebar-channel-name">mentions</span>
                    </button>
                  </li>
                </Show>

                {/* Channel windows */}
                <For each={channelsBySlug()?.[network.slug] ?? []}>
                  {(channel) => {
                    const key = channelKey(network.slug, channel.name);
                    return (
                      <li
                        classList={{ selected: isSelected(network.slug, channel.name) }}
                        data-window-name={channel.name}
                      >
                        <button
                          type="button"
                          onClick={() => handleClick(network.slug, channel.name, "channel")}
                          class={`sidebar-window-btn${isGreyed(network.slug, channel.name) ? " sidebar-window-greyed" : ""}`}
                          aria-current={ariaCurrent(network.slug, channel.name)}
                        >
                          <span
                            class="sidebar-channel-name"
                            classList={{ parted: !channel.joined }}
                          >
                            {channel.name}
                          </span>
                          {/* #96 — two independent colour-only states on this
                              one row: `.parted` (we left, window kept open) and
                              the greyed overlay (network parked/failed, or the
                              window's own not-joined state). They render
                              IDENTICALLY (muted + italic), so speaking them is
                              the only way either is distinguishable at all. */}
                          <RowState state={channel.joined ? null : "parted"} />
                          <RowState state={greyedState(network.slug, channel.name)} />
                          <WindowBadges channelKey={key} variant="sidebar" />
                        </button>
                        <CloseButton
                          class="sidebar-close"
                          ariaLabel={`Close ${channel.name}`}
                          onConfirm={() => handleCloseChannel(network.slug, channel.name)}
                        />
                      </li>
                    );
                  }}
                </For>

                {/* CP15 B5/B6 — synthetic channel rows: entries the operator
                  is aware of (windowState carries the key) but that aren't
                  in channelsBySlug yet. State drives the styling: pending
                  shows the optimistic-feedback class while the upstream
                  echo is in flight; failed/kicked/parked show the greyed
                  class so a rejected JOIN (invite-only / banned / keyed)
                  still surfaces as a row instead of vanishing. The dedup
                  gate in pseudoChannelsForNetwork drops any key already
                  in channelsBySlug — channelsBySlug branch wins.

                  Joined state is excluded — see pseudoChannelsForNetwork
                  comment. PHASE 1.1's joined-arm produced ghost rows on
                  PART (no cross-topic ordering between channels_changed
                  and per-channel PART broadcasts). Reverted; cp15-b5
                  gates on per-channel join-line wire-truth instead.

                  #402 — via `navPseudoChannelsForNetwork`, the form-factor
                  view of that projection, which is also what the archive
                  filter subtracts. Shell mounts this Sidebar in the desktop
                  branch only, so here it yields every non-joined state, as
                  before. */}
                <For each={navPseudoChannelsForNetwork(network.slug, network.id)}>
                  {(row) => (
                    <li
                      classList={{ selected: isSelected(network.slug, row.name) }}
                      data-window-name={row.name}
                      // #78 redo: expose the discrete pseudo-row state as a
                      // stable test seam (same pattern as data-window-name /
                      // data-kind). `.sidebar-window-greyed` alone is shared
                      // by EVERY not-joined state (pending/failed/kicked/
                      // parked), so an e2e asserting only the greyed class
                      // can't tell one greyed row from another — the vacuity
                      // this attribute closes. Production rendering is
                      // unchanged.
                      //
                      // #902 — `invited` no longer appears here. Specs that
                      // used this attribute as their "the window-state map
                      // has the key" barrier read the banner's
                      // `data-banner-id` instead (BannerSlot.tsx).
                      data-window-state={row.state}
                    >
                      <button
                        type="button"
                        onClick={() => handleClick(network.slug, row.name, "channel")}
                        class={
                          row.state === "pending"
                            ? "sidebar-window-btn sidebar-window-pending"
                            : "sidebar-window-btn sidebar-window-greyed"
                        }
                        aria-current={ariaCurrent(network.slug, row.name)}
                      >
                        <span
                          class="sidebar-channel-name"
                          classList={{ pending: row.state === "pending" }}
                        >
                          {row.name}
                        </span>
                        {/* #96 — the pseudo row IS its state (pending /
                            invited / failed / kicked / parked) and carries it
                            in `data-window-state` for e2e, but rendered it to
                            the operator as opacity + italic only. Speak the
                            same word the test seam already exposes. */}
                        <RowState state={row.state} />
                      </button>
                      {/* UX-5 bucket BK (2026-05-19): × on every pseudo-row.
                        Pre-BK pseudo-rows were uncloseable — a failed JOIN
                        left a sticky greyed row + a duplicate archive
                        entry (visibleArchiveForNetwork filtered only live
                        channelsBySlug/queryWindowsByNetwork, not
                        windowStateByChannel). Now × calls forceParted
                        (via dismissPseudoWindow) → drops the windowState
                        key unconditionally → row vanishes;
                        visibleArchiveForNetwork's pseudo-name filter
                        releases so the archive modal shows the row
                        instead (single surface per window). */}
                      {/* #172: pseudo-row dismiss is a LOCAL projection clear
                        (forceParted), sidebar-only + desktop-only — the mobile
                        fat-finger problem never reaches it. It rides the same
                        <CloseButton> anyway (touch-gate is free; a desktop
                        mouse click stays instant) so every × is one code path
                        — no half-migrated second pattern. */}
                      <CloseButton
                        class="sidebar-close"
                        ariaLabel={`Close ${row.name}`}
                        onConfirm={() => dismissPseudoWindow(network.slug, row.name)}
                      />
                    </li>
                  )}
                </For>

                {/* Query (DM) windows */}
                <For each={queryWindowsByNetwork()[network.id] ?? []}>
                  {(qw) => {
                    const key = channelKey(network.slug, qw.targetNick);
                    return (
                      <li
                        classList={{ selected: isSelected(network.slug, qw.targetNick) }}
                        data-window-name={qw.targetNick}
                      >
                        <button
                          type="button"
                          onClick={() => handleClick(network.slug, qw.targetNick, "query")}
                          class={`sidebar-window-btn${isGreyed(network.slug, qw.targetNick) ? " sidebar-window-greyed" : ""}`}
                          aria-current={ariaCurrent(network.slug, qw.targetNick)}
                        >
                          <NickText nick={qw.targetNick} extraClass="sidebar-channel-name" />
                          <RowState state={greyedState(network.slug, qw.targetNick)} />
                          <WindowBadges channelKey={key} variant="sidebar" />
                        </button>
                        <CloseButton
                          class="sidebar-close"
                          ariaLabel={`Close DM with ${qw.targetNick}`}
                          onConfirm={() => handleCloseQuery(network.id, qw.targetNick)}
                        />
                      </li>
                    );
                  }}
                </For>
              </ul>

              {/* #71 INC-1 — own-nick footer. Surfaces the operator's IRC
                nick on THIS network — previously shown nowhere in the UI
                (issue #71 "Show the user's own nick"). Rendered per-network
                (last element of each group, below the grouping rail) so it
                degrades correctly to multi-network: each group states who you
                are on that network. Sourced from the canonical
                `ownNickForNetwork(net, me)` so the DISPLAY can never drift
                from the self-detection / DM-routing nick (the `displayNick`
                per-network footgun documented in api.ts). Non-interactive —
                identity, not a window row (no `.sidebar-window-btn`). Hidden
                when `me` is null (logged out) — the helper returns null. */}
              <Show when={ownNickForNetwork(network, user())}>
                {(nick) => (
                  <div class="sidebar-own-nick" data-testid={`sidebar-own-nick-${network.slug}`}>
                    <span class="sidebar-own-nick-emoji" aria-hidden="true">
                      👤
                    </span>
                    {/* The 👤 is aria-hidden (its glyph name is noise); this
                      sr-only prefix gives a screen reader the context that the
                      following nick is the operator's OWN identity on this
                      network, not a peer. Mirrors the away-badge aria-label
                      pattern (visible glyph hidden, meaning spoken). */}
                    <span class="sr-only">your nick: </span>
                    <span class="sidebar-own-nick-name">{nick()}</span>
                  </div>
                )}
              </Show>

              {/* #473 — the per-network Archive `<details>` was REMOVED from
                the Sidebar. `ArchiveModal` (opened from the RailActions drawer
                archive button) is now the SINGLE archive surface on both form
                factors, rendering every network as a collapsible group. The
                per-network browsing the `<details>` provided is preserved there
                (one group per network); see ArchiveModal.tsx. */}
            </>
          )}
        </For>
      </Show>
    </>
  );
};

export default Sidebar;
