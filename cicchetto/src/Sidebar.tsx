import { type Component, createSignal, For, Show } from "solid-js";
import InlineConfirmButton from "./InlineConfirmButton";
import { deleteArchiveEntry } from "./lib/api";
import { loadArchive, visibleArchiveForNetwork } from "./lib/archive";
import { token } from "./lib/auth";
import { awayByNetwork } from "./lib/awayStatus";
import { type ChannelKey, channelKey, decodeChannelKey } from "./lib/channelKey";
import { mentionCounts } from "./lib/mentions";
import { channelsBySlug, isAdmin, networkBySlug, networks } from "./lib/networks";
import { openQueryWindowState, queryWindowsByNetwork } from "./lib/queryWindows";
import { eventsUnread, messagesUnread, selectedChannel, setSelectedChannel } from "./lib/selection";
import { closeChannelWindow, closeQueryWindow, disconnectNetwork } from "./lib/windowClose";
import type { WindowKind } from "./lib/windowKinds";
import {
  ADMIN_WINDOW_NAME,
  ADMIN_WINDOW_SLUG,
  HOME_WINDOW_NAME,
  HOME_WINDOW_SLUG,
  SERVER_WINDOW_NAME,
} from "./lib/windowKinds";
import { setParted, windowStateByChannel } from "./lib/windowState";

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

const NOT_JOINED_STATES = new Set(["failed", "kicked", "parked"]);
const NETWORK_GREYED_STATES = new Set(["parked", "failed"]);

export type Props = Record<string, never>;

const Sidebar: Component<Props> = () => {
  // UX-1 (2026-05-17) — singleton armed-key for archive delete confirm.
  // Mirrors AdminSessionsTab / AdminVisitorsTab — one armed row at a
  // time across the WHOLE sidebar (across every network's archive
  // section). Key shape: `"<slug> <target>"`. Space separator is safe
  // here because network slugs and IRC targets cannot contain raw
  // spaces (RFC 1459 section 2.2 + Networks.Network.changeset slug).
  const [armedArchiveKey, setArmedArchiveKey] = createSignal<string | null>(null);
  const archiveKey = (slug: string, target: string) => `${slug} ${target}`;

  const isSelected = (slug: string, name: string): boolean => {
    const s = selectedChannel();
    return s !== null && s.networkSlug === slug && s.channelName === name;
  };

  // CP19 T32: network-level greyed when the credential is parked or
  // failed. Drives both the network header `.sidebar-network-greyed`
  // class AND the cascading per-channel/per-query overlay in
  // `isGreyed/2` below.
  //
  // Bucket F H4: only UserNetwork carries connection_state. Narrow on
  // network.kind first; visitor networks are never greyed at the
  // network level (visitors have no credential row to park / fail).
  const isNetworkGreyed = (slug: string): boolean => {
    const net = networkBySlug(slug);
    return net?.kind === "user" && NETWORK_GREYED_STATES.has(net.connection_state);
  };

  const isGreyed = (slug: string, name: string): boolean => {
    if (isNetworkGreyed(slug)) return true;
    const s = windowStateByChannel()[channelKey(slug, name)];
    return s !== undefined && NOT_JOINED_STATES.has(s);
  };

  const networkReason = (slug: string): string | undefined => {
    const net = networkBySlug(slug);
    if (net?.kind !== "user") return undefined;
    return net.connection_state_reason ?? undefined;
  };

  // Synthetic sidebar rows: keys with windowState != "joined" whose
  // (slug, name) is NOT yet in channelsBySlug AND not a known query
  // (DM) target for this network. Returns name + state tuples so the
  // JSX can render the right classList branch (pending styling vs
  // greyed) without a second windowState lookup.
  //
  // The projection covers ALL four non-joined states — pending,
  // failed, kicked, parked — under the same rule: cic mirrors a row
  // whenever the operator is aware of the channel (windowState carries
  // the key) but channelsBySlug doesn't. Without this, a failed JOIN
  // (invite-only / banned / +k miss) leaves the operator with no
  // sidebar entry at all: the pending row vanishes when state flips
  // to failed and the channelsBySlug branch never receives the
  // channel since the JOIN was rejected. Intent doc:
  // "Sidebar entry greyed/dim" on every failed/kicked/parked window.
  //
  // The joined state is INTENTIONALLY EXCLUDED. PHASE 1.1 added a
  // joined arm here to bridge the small per-channel-`joined` →
  // user-topic-`channels_changed` window so cp15-b5 wouldn't flash an
  // empty sidebar between the two broadcasts. That arm violated the
  // "SOURCE state must clear at switch BEFORE TARGET decisions" rule
  // (memory feedback_target_window_ux_rule) and produced a ghost-row
  // regression on PART: when channels_changed arrived BEFORE the
  // per-channel `kind:"message"` part broadcast (no cross-topic
  // ordering guarantee at the WS edge), channelsBySlug dropped the
  // channel while windowState still carried `joined` — sidebar
  // synthesized a ghost row that lingered until the next render tick.
  // Bug B (M9 X-button PART) reproduced this. Reverted to the
  // pre-PHASE-1.1 shape; cp15-b5 now gates on the WS-truth signal
  // (per-channel join-line in scrollback) instead of the sidebar row
  // existence to avoid the same flake.
  //
  // Query (DM) targets are filtered out — windowState may carry a
  // (slug, nick) entry too (the kicked/away projection plays nicely
  // with DMs), but the dedicated query-windows branch below handles
  // their rendering. Without this filter, the synthetic loop would
  // dup-render every greyed query target as a "ghost" channel row.
  type PseudoRow = { name: string; state: "pending" | "failed" | "kicked" | "parked" };
  const pseudoChannelsForNetwork = (slug: string, networkId: number): PseudoRow[] => {
    const states = windowStateByChannel();
    const live = new Set((channelsBySlug()?.[slug] ?? []).map((c) => c.name));
    const queries = new Set((queryWindowsByNetwork()[networkId] ?? []).map((qw) => qw.targetNick));
    const out: PseudoRow[] = [];
    for (const [key, state] of Object.entries(states)) {
      if (state === "joined") continue;
      // Codebase audit cic M4 — paired decoder over open-coded
      // `key.startsWith(prefix) + key.slice(prefix.length)`. The
      // composite-key shape is owned by `lib/channelKey.ts`; one site
      // here + one in `subscribe.ts` would otherwise drift if the
      // shape ever changed.
      const decoded = decodeChannelKey(key as ChannelKey);
      if (decoded === null || decoded.slug !== slug) continue;
      const name = decoded.name;
      if (live.has(name)) continue;
      if (queries.has(name)) continue;
      out.push({ name, state: state as PseudoRow["state"] });
    }
    return out;
  };

  const handleClick = (slug: string, name: string, kind: WindowKind) => {
    setSelectedChannel({ networkSlug: slug, channelName: name, kind });
  };

  const handleCloseChannel = (slug: string, channelName: string) => {
    closeChannelWindow(slug, channelName);
  };

  const handleCloseQuery = (networkId: number, targetNick: string) => {
    closeQueryWindow(networkId, targetNick);
  };

  const handleClosePseudo = (slug: string, name: string) => {
    // UX-5 bucket BK (2026-05-19): × on a pseudo-row (pending/failed/
    // kicked/parked) drops the windowStateByChannel entry. setParted
    // is the existing "absence is the projection" verb — all three
    // sibling maps cleared. After this fires:
    //   * The pseudo-row vanishes (windowState key gone →
    //     pseudoChannelsForNetwork no longer emits it).
    //   * visibleArchiveForNetwork's pseudo-name filter releases, so
    //     the archive section shows the row (if it carries scrollback;
    //     pending never has scrollback so it surfaces nowhere — that's
    //     correct, the operator cancelled a join in flight).
    // If the closed pseudo-row WAS the selected window, redirect
    // selection to $server (same shape as own-PART dismiss in
    // subscribe.ts:347).
    const sel = selectedChannel();
    if (sel !== null && sel.networkSlug === slug && sel.channelName === name) {
      setSelectedChannel({ networkSlug: slug, channelName: SERVER_WINDOW_NAME, kind: "server" });
    }
    setParted(channelKey(slug, name));
  };

  // UX-4 bucket D — close the server window for a network. Routes
  // through windowClose.ts → visitor branches to quitAll (nuclear: park
  // every network + logout); registered PATCHes the one network to
  // `:parked`. Selection auto-redirects to home via the
  // `connection_state_changed` arm in selection.ts (one effect, all
  // park triggers).
  const handleCloseNetwork = (slug: string) => {
    disconnectNetwork(slug);
  };

  // UX-1 (2026-05-17) — confirmed delete of an archive entry. Both
  // channel-shaped + query-shaped targets get the delete affordance
  // per vjt scope decision. Server dispatches by sigil on its end;
  // cic hands over the user-facing target string as-is. On success
  // the server broadcasts `archive_changed` and the userTopic
  // dispatcher re-fetches archivedBySlug for this network — no need
  // for an optimistic mutation here.
  const handleConfirmArchiveDelete = async (slug: string, target: string) => {
    const t = token();
    if (!t) return;
    try {
      await deleteArchiveEntry(t, slug, target);
    } catch {
      // Server-side delete failed (network blip, 4xx). Leave the row;
      // the operator can retry. The InlineConfirmButton disarms on the
      // next sibling arming or refresh. No toast — Sidebar is dense
      // and a generic error wouldn't tell the user anything actionable.
    } finally {
      setArmedArchiveKey(null);
    }
  };

  // Archive visibility filter is shared with BottomBar/ArchiveModal —
  // see `lib/archive.ts` visibleArchiveForNetwork. Pre-UX-2 lived
  // inline here.

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
            <section
              class={`sidebar-network${isNetworkGreyed(network.slug) ? " sidebar-network-greyed" : ""}`}
            >
              <ul>
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
                >
                  <button
                    type="button"
                    onClick={() => handleClick(network.slug, SERVER_WINDOW_NAME, "server")}
                    class="sidebar-window-btn"
                  >
                    <span class="sidebar-network-emoji" aria-hidden="true">
                      ⚙️
                    </span>
                    <span
                      class="sidebar-channel-name"
                      title={
                        isNetworkGreyed(network.slug) ? networkReason(network.slug) : undefined
                      }
                    >
                      {network.slug}
                    </span>
                    {/* C8.3 — away visual indicator. Surfaces on the
                      collapsed network-header row when the user is in away
                      state on this network. Driven by `away_confirmed`
                      server event via awayStatus.ts. */}
                    <Show when={awayByNetwork()[network.slug]}>
                      <span class="sidebar-away-badge">[away]</span>
                    </Show>
                    {/* CP13 — server-window receives :notice rows for server-routed
                      numerics + NickServ + MOTD + ChanServ-fallback. Same badge
                      treatment as channels so unread counts surface uniformly. */}
                    {(() => {
                      const key = channelKey(network.slug, SERVER_WINDOW_NAME);
                      return (
                        <>
                          <Show when={(messagesUnread()[key] ?? 0) > 0}>
                            <span class="sidebar-msg-unread">{messagesUnread()[key]}</span>
                          </Show>
                          <Show when={(eventsUnread()[key] ?? 0) > 0}>
                            <span class="sidebar-events-unread">{eventsUnread()[key]}</span>
                          </Show>
                          <Show when={(mentionCounts()[key] ?? 0) > 0}>
                            <span class="sidebar-mention">@{mentionCounts()[key]}</span>
                          </Show>
                        </>
                      );
                    })()}
                  </button>
                  {/* UX-4 bucket D — × button on the network-header row
                    closes the server window which == /disconnect for
                    registered users (one network parked → selection
                    redirects to home) and == /quit for visitors (all
                    networks parked + logout). Routing in
                    windowClose.disconnectNetwork; selection redirect
                    in selection.ts. */}
                  <button
                    type="button"
                    class="sidebar-close"
                    aria-label={`Disconnect ${network.slug}`}
                    onClick={() => handleCloseNetwork(network.slug)}
                  >
                    ×
                  </button>
                </li>

                {/* Channel windows */}
                <For each={channelsBySlug()?.[network.slug] ?? []}>
                  {(channel) => {
                    const key = channelKey(network.slug, channel.name);
                    return (
                      <li classList={{ selected: isSelected(network.slug, channel.name) }}>
                        <button
                          type="button"
                          onClick={() => handleClick(network.slug, channel.name, "channel")}
                          class={`sidebar-window-btn${isGreyed(network.slug, channel.name) ? " sidebar-window-greyed" : ""}`}
                        >
                          <span
                            class="sidebar-channel-name"
                            classList={{ parted: !channel.joined }}
                          >
                            {channel.name}
                          </span>
                          <Show when={(messagesUnread()[key] ?? 0) > 0}>
                            <span class="sidebar-msg-unread">{messagesUnread()[key]}</span>
                          </Show>
                          <Show when={(eventsUnread()[key] ?? 0) > 0}>
                            <span class="sidebar-events-unread">{eventsUnread()[key]}</span>
                          </Show>
                          <Show when={(mentionCounts()[key] ?? 0) > 0}>
                            <span class="sidebar-mention">@{mentionCounts()[key]}</span>
                          </Show>
                        </button>
                        <button
                          type="button"
                          class="sidebar-close"
                          aria-label={`Close ${channel.name}`}
                          onClick={() => handleCloseChannel(network.slug, channel.name)}
                        >
                          ×
                        </button>
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
                  gates on per-channel join-line wire-truth instead. */}
                <For each={pseudoChannelsForNetwork(network.slug, network.id)}>
                  {(row) => (
                    <li classList={{ selected: isSelected(network.slug, row.name) }}>
                      <button
                        type="button"
                        onClick={() => handleClick(network.slug, row.name, "channel")}
                        class={
                          row.state === "pending"
                            ? "sidebar-window-btn sidebar-window-pending"
                            : "sidebar-window-btn sidebar-window-greyed"
                        }
                      >
                        <span
                          class="sidebar-channel-name"
                          classList={{ pending: row.state === "pending" }}
                        >
                          {row.name}
                        </span>
                      </button>
                      {/* UX-5 bucket BK (2026-05-19): × on every pseudo-row.
                        Pre-BK pseudo-rows were uncloseable — a failed JOIN
                        left a sticky greyed row + a duplicate archive
                        entry (visibleArchiveForNetwork filtered only live
                        channelsBySlug/queryWindowsByNetwork, not
                        windowStateByChannel). Now × calls setParted →
                        drops the windowState key → row vanishes;
                        visibleArchiveForNetwork's pseudo-name filter
                        releases so the archive section shows the row
                        instead (single surface per window). */}
                      <button
                        type="button"
                        class="sidebar-close"
                        aria-label={`Close ${row.name}`}
                        onClick={() => handleClosePseudo(network.slug, row.name)}
                      >
                        ×
                      </button>
                    </li>
                  )}
                </For>

                {/* Query (DM) windows */}
                <For each={queryWindowsByNetwork()[network.id] ?? []}>
                  {(qw) => {
                    const key = channelKey(network.slug, qw.targetNick);
                    return (
                      <li classList={{ selected: isSelected(network.slug, qw.targetNick) }}>
                        <button
                          type="button"
                          onClick={() => handleClick(network.slug, qw.targetNick, "query")}
                          class={`sidebar-window-btn${isGreyed(network.slug, qw.targetNick) ? " sidebar-window-greyed" : ""}`}
                        >
                          <span class="sidebar-channel-name">{qw.targetNick}</span>
                          <Show when={(messagesUnread()[key] ?? 0) > 0}>
                            <span class="sidebar-msg-unread">{messagesUnread()[key]}</span>
                          </Show>
                          <Show when={(eventsUnread()[key] ?? 0) > 0}>
                            <span class="sidebar-events-unread">{eventsUnread()[key]}</span>
                          </Show>
                          <Show when={(mentionCounts()[key] ?? 0) > 0}>
                            <span class="sidebar-mention">@{mentionCounts()[key]}</span>
                          </Show>
                        </button>
                        <button
                          type="button"
                          class="sidebar-close"
                          aria-label={`Close DM with ${qw.targetNick}`}
                          onClick={() => handleCloseQuery(network.id, qw.targetNick)}
                        >
                          ×
                        </button>
                      </li>
                    );
                  }}
                </For>
              </ul>

              {/* CP15 B4 — Archive section, collapsed by default. Lazy fetch
                on first expand via the toggle event; entries clickable to
                set selection. Channel kind keeps the channel-shaped name;
                query kind opens the DM window for the target nick. */}
              <details
                class="sidebar-archive"
                onToggle={(e) => {
                  if ((e.currentTarget as HTMLDetailsElement).open) {
                    void loadArchive(network.slug);
                  }
                }}
              >
                <summary>Archive</summary>
                <ul>
                  <For each={visibleArchiveForNetwork(network.slug, network.id)}>
                    {(entry) => {
                      const key = archiveKey(network.slug, entry.target);
                      return (
                        <li class="sidebar-archive-row">
                          <button
                            type="button"
                            class="sidebar-window-btn"
                            onClick={() => {
                              // UX-3 Z: re-open archived query window as live
                              // so cic subscribes to the per-channel topic and
                              // receives server broadcasts (NOTICE 401, etc.).
                              // Idempotent — no-op if already open.
                              if (entry.kind === "query") {
                                openQueryWindowState(
                                  network.id,
                                  entry.target,
                                  new Date().toISOString(),
                                );
                              }
                              handleClick(
                                network.slug,
                                entry.target,
                                entry.kind === "channel" ? "channel" : "query",
                              );
                            }}
                          >
                            <span class="sidebar-channel-name parted">{entry.target}</span>
                          </button>
                          <InlineConfirmButton
                            idleLabel="×"
                            confirmLabel="really delete?"
                            armed={armedArchiveKey() === key}
                            onArm={() => setArmedArchiveKey(key)}
                            onConfirm={() => handleConfirmArchiveDelete(network.slug, entry.target)}
                            testId={`archive-delete-${network.slug}-${entry.target}`}
                            extraClass="sidebar-archive-delete"
                          />
                        </li>
                      );
                    }}
                  </For>
                </ul>
              </details>
            </section>
          )}
        </For>
      </Show>
    </>
  );
};

export default Sidebar;
