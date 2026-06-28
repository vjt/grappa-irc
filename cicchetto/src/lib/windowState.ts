import { createSignal } from "solid-js";
import { type ChannelKey, channelKey } from "./channelKey";
import { identityScopedStore } from "./identityScopedStore";
import { selectedChannel } from "./selection";

// CP15 B5: cic mirror of the server-side per-(network, channel) window
// state machine. The server splits state across three maps so each
// concern is reactive on its own (lib/grappa/session/server.ex):
//
//   * window_states         : %{channel => :pending | :joined | :failed | :kicked | :parked}
//   * window_failure_reasons: %{channel => String.t()}
//   * window_failure_numerics: %{channel => pos_integer()}
//   * window_kicked_meta    : %{channel => %{by, reason}}
//
// Cic mirrors that split — three signal maps with one signal per
// concern — so a render branch reading "is it failed AND show the
// reason" only re-runs when the failure metadata changes, not when an
// unrelated channel transitions to :joined.
//
// `:parted` is intentionally absent from the broadcast surface — its
// projection is "key removed from windowStateByChannel" (the archive
// section in Sidebar derives from `scrollback present + state absent`).
// `setParted` clears all three maps for the key so a re-join + re-fail
// cycle starts from a fresh slate.
//
// Identity-rotation cleanup via identityScopedStore (dup-A3 close):
// three resets registered, one per signal map; on token rotation/logout
// all three maps are emptied so a new bearer doesn't see the prior
// tenant's window states.

export type WindowState = "pending" | "invited" | "joined" | "failed" | "kicked" | "parked";

export type WindowFailure = {
  reason: string | null;
  numeric: number;
};

export type WindowKickedMeta = {
  by: string | null;
  reason: string | null;
};

const exports_ = identityScopedStore((onIdentityChange) => {
  const [windowStateByChannel, setWindowStateByChannel] = createSignal<
    Record<ChannelKey, WindowState>
  >({});
  const [windowFailureByChannel, setWindowFailureByChannel] = createSignal<
    Record<ChannelKey, WindowFailure>
  >({});
  const [windowKickedMetaByChannel, setWindowKickedMetaByChannel] = createSignal<
    Record<ChannelKey, WindowKickedMeta>
  >({});

  onIdentityChange(() => setWindowStateByChannel({}));
  onIdentityChange(() => setWindowFailureByChannel({}));
  onIdentityChange(() => setWindowKickedMetaByChannel({}));

  const setPending = (key: ChannelKey): void => {
    setWindowStateByChannel((prev) => ({ ...prev, [key]: "pending" }));
  };

  // #78: inbound INVITE to a not-joined channel → a greyed, not-joined
  // sidebar tab the operator can /join on their own time. Like setPending,
  // touches only the state map — an invite carries no failure / kicked
  // metadata; the inviter is conveyed by the persisted scrollback row.
  const setInvited = (key: ChannelKey): void => {
    setWindowStateByChannel((prev) => ({ ...prev, [key]: "invited" }));
  };

  const setJoined = (key: ChannelKey): void => {
    setWindowStateByChannel((prev) => ({ ...prev, [key]: "joined" }));
    // Joining wipes any prior :failed / :kicked snapshot mirrors —
    // mirrors apply_effects([{:joined, channel} | rest], state) on
    // the server. A successful re-join must not leave stale
    // by/reason/numeric in the maps; the next render reads "joined"
    // and looks up failure metadata that should no longer exist.
    setWindowFailureByChannel((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
    setWindowKickedMetaByChannel((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
  };

  const setFailed = (key: ChannelKey, reason: string | null, numeric: number): void => {
    setWindowStateByChannel((prev) => ({ ...prev, [key]: "failed" }));
    setWindowFailureByChannel((prev) => ({ ...prev, [key]: { reason, numeric } }));
  };

  const setKicked = (key: ChannelKey, by: string | null, reason: string | null): void => {
    setWindowStateByChannel((prev) => ({ ...prev, [key]: "kicked" }));
    setWindowKickedMetaByChannel((prev) => ({ ...prev, [key]: { by, reason } }));
  };

  const setParted = (key: ChannelKey): void => {
    // Absence is the projection — drop the entry from all three maps.
    // Idempotent: parting an unknown key is a no-op.
    setWindowStateByChannel((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
    setWindowFailureByChannel((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
    setWindowKickedMetaByChannel((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
  };

  return {
    windowStateByChannel,
    windowFailureByChannel,
    windowKickedMetaByChannel,
    setPending,
    setInvited,
    setJoined,
    setFailed,
    setKicked,
    setParted,
  };
});

export const windowStateByChannel = exports_.windowStateByChannel;
export const windowFailureByChannel = exports_.windowFailureByChannel;
export const windowKickedMetaByChannel = exports_.windowKickedMetaByChannel;
export const setPending = exports_.setPending;
export const setInvited = exports_.setInvited;
export const setJoined = exports_.setJoined;
export const setFailed = exports_.setFailed;
export const setKicked = exports_.setKicked;
export const setParted = exports_.setParted;

// Render-time predicates for "show member-list-shaped UI?".
//
// Member list UI (right pane + the right hamburger toggle in TopicBar)
// only makes sense when the window is an actively-joined channel.
// Servers, DMs, mentions/list pseudo-windows, and parked/failed/kicked
// channels do NOT have a live member list — showing the pane there
// either reserves grid space for nothing (desktop) or surfaces a stale
// "not joined" stub through a hamburger that should never have been
// offered in the first place.
//
// `windowIsJoined(key)` is the primitive over the state map; absence
// (parted / never-joined / non-channel pseudo-window) is treated as
// "not joined" — no member list. `isActiveChannelJoined()` composes
// it with the active selection's `kind` to gate the render-time
// branches in Shell.tsx + TopicBar.tsx — exposed as a derived signal
// (no arg) so each consumer just reads it without rebuilding the
// channelKey itself.

export const windowIsJoined = (key: ChannelKey): boolean =>
  windowStateByChannel()[key] === "joined";

// UX-7-E: channel-window presence primitive. Any non-undefined state
// (pending|joined|failed|kicked|parked) means the operator's sidebar
// still includes the window — as a live row OR as a greyed pseudo-row
// via `Sidebar.pseudoChannelsForNetwork`. Used by `selection.ts`'s
// close-watcher (channel-kind branch) so a transition that drops
// `channelsBySlug[slug]` while keeping a pseudo-row (peer KICK,
// JOIN-failed) doesn't yank focus away from the row the operator is
// still looking at. Scope: channel-shaped keys only; the Sidebar
// primitive layers extra projection filters (slug match, live-row
// dedup, query-row exclusion) on top of the same state map — those
// filters are automatic in the channel-kind selection path (selKey
// is built from the active network slug; live wins via the earlier
// `list.some` check in selection.ts; DM nicks don't share the
// channel-name keyspace).
export const windowIsPresent = (key: ChannelKey): boolean =>
  windowStateByChannel()[key] !== undefined;

export const isActiveChannelJoined = (): boolean => {
  const sel = selectedChannel();
  if (sel === null) return false;
  if (sel.kind !== "channel") return false;
  return windowIsJoined(channelKey(sel.networkSlug, sel.channelName));
};
