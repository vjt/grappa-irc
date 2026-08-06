import { createSignal } from "solid-js";
import { type ChannelKey, channelKey, decodeChannelKey } from "./channelKey";
import { identityScopedStore } from "./identityScopedStore";
import { selectedChannel } from "./selection";

// CP15 B5: cic mirror of the server-side per-(network, channel) window
// state machine. The server splits state across three maps so each
// concern is reactive on its own (lib/grappa/session/server.ex):
//
//   * window_states         : %{channel => :pending | :invited | :joined | :failed | :kicked | :parked}
//   * window_failure_reasons: %{channel => String.t()}
//   * window_failure_numerics: %{channel => pos_integer()}
//   * window_kicked_meta    : %{channel => %{by, reason}}
//   * invited_by            : %{channel => String.t()}   (#902)
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
  // S13 — mirrors the server contract `join_failed_payload.numeric:
  // pos_integer() | nil` (nil when the failing numeric was never
  // recorded, e.g. the cold-subscribe "failed tab" snapshot).
  numeric: number | null;
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
  // #902 — mirror of the server's `invited_by`. Same invariant as there: a
  // key exists IF AND ONLY IF the state map says "invited", so every
  // transition below drops it. It is NOT a second source of truth for
  // invitedness — `windowStateByChannel` is — only the extra datum the
  // banner renders, exactly as `windowKickedMetaByChannel` decorates
  // "kicked".
  const [invitedByChannel, setInvitedByChannel] = createSignal<Record<ChannelKey, string>>({});

  onIdentityChange(() => setWindowStateByChannel({}));
  onIdentityChange(() => setWindowFailureByChannel({}));
  onIdentityChange(() => setWindowKickedMetaByChannel({}));
  onIdentityChange(() => setInvitedByChannel({}));

  const dropKey = <T>(key: ChannelKey) => {
    return (prev: Record<ChannelKey, T>): Record<ChannelKey, T> => {
      if (!(key in prev)) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    };
  };

  const setPending = (key: ChannelKey): void => {
    setWindowStateByChannel((prev) => ({ ...prev, [key]: "pending" }));
    setInvitedByChannel(dropKey(key));
  };

  // #78: inbound INVITE to a not-joined channel. #902 — what this DRAWS
  // changed (a dismissable top banner with [Join], not a greyed sidebar
  // tab), and with it the storage: the inviter used to be conveyed only by
  // the persisted scrollback row, which the banner cannot wait for — it
  // renders before that channel's buffer is ever fetched. So the nick now
  // rides the `window_invited` event and lands here.
  const setInvited = (key: ChannelKey, inviter: string): void => {
    setWindowStateByChannel((prev) => ({ ...prev, [key]: "invited" }));
    setInvitedByChannel((prev) => ({ ...prev, [key]: inviter }));
  };

  const setJoined = (key: ChannelKey): void => {
    setWindowStateByChannel((prev) => ({ ...prev, [key]: "joined" }));
    setInvitedByChannel(dropKey(key));
    // Joining wipes any prior :failed / :kicked snapshot mirrors —
    // mirrors apply_effects([{:joined, channel} | rest], state) on
    // the server. A successful re-join must not leave stale
    // by/reason/numeric in the maps; the next render reads "joined"
    // and looks up failure metadata that should no longer exist.
    setWindowFailureByChannel(dropKey(key));
    setWindowKickedMetaByChannel(dropKey(key));
  };

  const setFailed = (key: ChannelKey, reason: string | null, numeric: number | null): void => {
    setWindowStateByChannel((prev) => ({ ...prev, [key]: "failed" }));
    setWindowFailureByChannel((prev) => ({ ...prev, [key]: { reason, numeric } }));
    setInvitedByChannel(dropKey(key));
  };

  const setKicked = (key: ChannelKey, by: string | null, reason: string | null): void => {
    setWindowStateByChannel((prev) => ({ ...prev, [key]: "kicked" }));
    setWindowKickedMetaByChannel((prev) => ({ ...prev, [key]: { by, reason } }));
    setInvitedByChannel(dropKey(key));
  };

  // forceParted: the unconditional "absence is the projection" verb —
  // drop the key from all three maps. Idempotent (parting an unknown key
  // is a no-op). This is the USER-initiated close (windowClose.ts: the ×
  // on a live tab or a non-joined pseudo-row), where the drop is FRESH
  // intent and must always apply — even mid-"pending" — so a pseudo-row's
  // × is never a silent no-op. The server-echo path uses setParted below,
  // which guards against a stale echo.
  const forceParted = (key: ChannelKey): void => {
    setWindowStateByChannel(dropKey(key));
    setWindowFailureByChannel(dropKey(key));
    setWindowKickedMetaByChannel(dropKey(key));
    setInvitedByChannel(dropKey(key));
  };

  // setParted: the SERVER-echo projection of an own-PART (subscribe.ts's
  // own-PART arm — the ONLY caller). #495 ordering guard: a "pending" key
  // means a re-join is in flight (its optimistic window_pending already
  // landed). A part echo arriving now is the STALE echo of an EARLIER part
  // — an ircd round-trip that lost the race to the synchronous pending.
  // Dropping the fresh pending would let the selection close-watcher
  // misread the SELECTED window's live→dead flip as a genuine vanish and
  // evict focus to $server. So a stale part on a "pending" key is a no-op;
  // the genuine-part case leaves the key "joined", where the guard is
  // inert. Same class as ba4dc179 (out-of-order event applied to fresh
  // state). USER-initiated closes use forceParted (above), which bypasses
  // this guard. KNOWN GAP + bounds (part→re-join→part-again fast):
  // DESIGN_NOTES 2026-07-27 (#495).
  const setParted = (key: ChannelKey): void => {
    if (windowStateByChannel()[key] === "pending") return;
    forceParted(key);
  };

  return {
    windowStateByChannel,
    windowFailureByChannel,
    windowKickedMetaByChannel,
    invitedByChannel,
    setPending,
    setInvited,
    setJoined,
    setFailed,
    setKicked,
    setParted,
    forceParted,
  };
});

export const windowStateByChannel = exports_.windowStateByChannel;
export const windowFailureByChannel = exports_.windowFailureByChannel;
export const windowKickedMetaByChannel = exports_.windowKickedMetaByChannel;
export const invitedByChannel = exports_.invitedByChannel;
export const setPending = exports_.setPending;
export const setInvited = exports_.setInvited;
export const setJoined = exports_.setJoined;
export const setFailed = exports_.setFailed;
export const setKicked = exports_.setKicked;
export const setParted = exports_.setParted;
export const forceParted = exports_.forceParted;

// Render-time predicates for "show the member LIST?" — and nothing else.
//
// A live member list only exists for an actively-joined channel. Servers,
// DMs, mentions/list pseudo-windows, and parked/failed/kicked channels do
// not have one, so `MembersPane` is `<Show>`-gated on these predicates in
// both Shell.tsx branches; on desktop the same signal narrows the rail
// column (`.shell-no-members`) rather than reserving grid space for
// nothing.
//
// #881 — SCOPE, and it is load-bearing: joinedness gates the LIST, never
// the CHROME AROUND IT. This comment used to name "the right hamburger
// toggle in TopicBar" as member-list UI, and TopicBar believed it. That ☰
// is the rail DOOR (`.shell-members` has been the permanent Archive /
// Settings / Rooms / Admin rail since #71 INC-2 / #473, and it is a
// channel window's ONLY door), so gating it here deleted the whole
// navigation for a non-joined window. vjt's ruling: a non-joined window
// renders what a joined one renders MINUS the members list. Before adding
// a caller, ask whether the thing you are gating IS the list — if it only
// sits near it, this is the wrong predicate.
//
// `windowIsJoined(key)` is the primitive over the state map; absence
// (parted / never-joined / non-channel pseudo-window) is treated as
// "not joined" — no member list. `isActiveChannelJoined()` composes
// it with the active selection's `kind` — exposed as a derived signal
// (no arg) so each consumer just reads it without rebuilding the
// channelKey itself. TopicBar's remaining `windowIsJoined` call is
// `canEditTopic`: a genuine IRC permission (you cannot TOPIC a channel
// you are not on), not chrome.

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

// #902 — the source projection behind the invite banner. Every key the
// server currently holds at `:invited`, decoded into what the banner needs:
// who to name, which channel to join, and on which network.
//
// Read STRAIGHT off `windowStateByChannel`, deliberately NOT through
// `pseudoChannelsForNetwork`. That projection subtracts `channelsBySlug` and
// the query windows, which arrive on the USER topic with no ordering
// guarantee against the per-channel broadcasts that drive this map — so it
// answers "should a sidebar row be drawn", a different question. This one
// answers "what does the server say is invited", which is exactly what the
// banner announces, and it makes the rendered banner a faithful DOM
// projection of this map (the property `issue30-channel-tab-completion`
// relies on for its synchronisation barrier, previously supplied by the
// greyed `:invited` pseudo-row this issue removes).
//
// A malformed key is skipped rather than rendered half-decoded; the inviter
// falls back to the same `"*"` anonymous-sender sentinel the server uses, so
// a payload from a pre-#902 server degrades to a nameless banner instead of
// `undefined` leaking into the copy.
export type InvitedWindow = {
  key: ChannelKey;
  networkSlug: string;
  channelName: string;
  inviter: string;
};

export const invitedWindows = (): InvitedWindow[] => {
  const states = windowStateByChannel();
  const inviters = invitedByChannel();
  const out: InvitedWindow[] = [];
  for (const [key, state] of Object.entries(states) as [ChannelKey, WindowState][]) {
    if (state !== "invited") continue;
    const decoded = decodeChannelKey(key);
    if (decoded === null) continue;
    out.push({
      key,
      networkSlug: decoded.slug,
      channelName: decoded.name,
      inviter: inviters[key] ?? "*",
    });
  }
  return out;
};

export const isActiveChannelJoined = (): boolean => {
  const sel = selectedChannel();
  if (sel === null) return false;
  if (sel.kind !== "channel") return false;
  return windowIsJoined(channelKey(sel.networkSlug, sel.channelName));
};
