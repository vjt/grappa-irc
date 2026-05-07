import { type Component, For, Show } from "solid-js";
import { postPart } from "./lib/api";
import { archivedBySlug, loadArchive } from "./lib/archive";
import { token } from "./lib/auth";
import { awayByNetwork } from "./lib/awayStatus";
import { channelKey } from "./lib/channelKey";
import { mentionCounts } from "./lib/mentions";
import { channelsBySlug, networks } from "./lib/networks";
import { closeQueryWindowState, queryWindowsByNetwork } from "./lib/queryWindows";
import { eventsUnread, messagesUnread, selectedChannel, setSelectedChannel } from "./lib/selection";
import type { WindowKind } from "./lib/windowKinds";
import { windowStateByChannel } from "./lib/windowState";

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
// onSelect is fired AFTER the selection state is updated — Shell.tsx
// uses it to auto-close the mobile sidebar drawer.
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

const NOT_JOINED_STATES = new Set(["failed", "kicked", "parked"]);

export type Props = {
  onSelect?: () => void;
};

const Sidebar: Component<Props> = (props) => {
  const isSelected = (slug: string, name: string): boolean => {
    const s = selectedChannel();
    return s !== null && s.networkSlug === slug && s.channelName === name;
  };

  const isGreyed = (slug: string, name: string): boolean => {
    const s = windowStateByChannel()[channelKey(slug, name)];
    return s !== undefined && NOT_JOINED_STATES.has(s);
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
  // Query (DM) targets are filtered out — windowState may carry a
  // (slug, nick) entry too (the kicked/away projection plays nicely
  // with DMs), but the dedicated query-windows branch below handles
  // their rendering. Without this filter, the synthetic loop would
  // dup-render every greyed query target as a "ghost" channel row.
  type PseudoRow = { name: string; state: "pending" | "failed" | "kicked" | "parked" };
  const pseudoChannelsForNetwork = (slug: string, networkId: number): PseudoRow[] => {
    const states = windowStateByChannel();
    const live = new Set((channelsBySlug()?.[slug] ?? []).map((c) => c.name));
    const queries = new Set(
      (queryWindowsByNetwork()[networkId] ?? []).map((qw) => qw.targetNick),
    );
    const prefix = `${slug} `;
    const out: PseudoRow[] = [];
    for (const [key, state] of Object.entries(states)) {
      if (state === "joined") continue;
      if (!key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      if (live.has(name)) continue;
      if (queries.has(name)) continue;
      out.push({ name, state: state as PseudoRow["state"] });
    }
    return out;
  };

  const handleClick = (slug: string, name: string, kind: WindowKind) => {
    setSelectedChannel({ networkSlug: slug, channelName: name, kind });
    props.onSelect?.();
  };

  const handleCloseChannel = (slug: string, channelName: string) => {
    const t = token();
    if (!t) return;
    void postPart(t, slug, channelName);
  };

  const handleCloseQuery = (networkId: number, targetNick: string) => {
    closeQueryWindowState(networkId, targetNick);
  };

  // CP15 B5 fix - archive list rendering filters out entries that are
  // CURRENTLY active (joined channel OR open query window). Server-side
  // Scrollback.list_archive/3 does the same exclusion via active_keyset,
  // but the client-side cache survives JOIN echoes; a re-JOIN of an
  // archived channel would otherwise duplicate the row in both Active +
  // Archive sections (and the archive row's click would race against the
  // live row's selection-set). Render-time derivation keeps the backing
  // archivedBySlug cache untouched - refresh on next user expand updates
  // the snapshot via REST refetch.
  const visibleArchiveForNetwork = (slug: string, networkId: number) => {
    const entries = archivedBySlug()[slug] ?? [];
    if (entries.length === 0) return entries;
    const liveChannels = new Set((channelsBySlug()?.[slug] ?? []).map((c) => c.name));
    const liveQueries = new Set(
      (queryWindowsByNetwork()[networkId] ?? []).map((qw) => qw.targetNick),
    );
    return entries.filter((entry) => {
      if (entry.kind === "channel") return !liveChannels.has(entry.target);
      return !liveQueries.has(entry.target);
    });
  };

  return (
    <Show
      when={(networks()?.length ?? 0) > 0}
      fallback={<p class="muted sidebar-empty">no networks</p>}
    >
      <For each={networks()}>
        {(network) => (
          <section class="sidebar-network">
            <h3>
              {network.slug}
              {/* C8.3 — away visual indicator. Shows [away] badge when the
                  user is in away state on this network. Driven by the
                  away_confirmed server event via awayStatus.ts. */}
              <Show when={awayByNetwork()[network.slug]}>
                <span class="sidebar-away-badge">[away]</span>
              </Show>
            </h3>
            <ul>
              {/* Server window — always present, not closeable */}
              <li classList={{ selected: isSelected(network.slug, "$server") }}>
                <button
                  type="button"
                  onClick={() => handleClick(network.slug, "$server", "server")}
                  class="sidebar-window-btn"
                >
                  <span class="sidebar-channel-name">Server</span>
                  {/* CP13 — server-window receives :notice rows for server-routed
                      numerics + NickServ + MOTD + ChanServ-fallback. Same badge
                      treatment as channels so unread counts surface uniformly. */}
                  {(() => {
                    const key = channelKey(network.slug, "$server");
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
                        <span class="sidebar-channel-name" classList={{ parted: !channel.joined }}>
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
                  in channelsBySlug — channelsBySlug branch wins. */}
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
                  {(entry) => (
                    <li>
                      <button
                        type="button"
                        class="sidebar-window-btn"
                        onClick={() =>
                          handleClick(
                            network.slug,
                            entry.target,
                            entry.kind === "channel" ? "channel" : "query",
                          )
                        }
                      >
                        <span class="sidebar-channel-name parted">{entry.target}</span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </details>
          </section>
        )}
      </For>
    </Show>
  );
};

export default Sidebar;
