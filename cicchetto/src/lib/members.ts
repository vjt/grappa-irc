import { createSignal } from "solid-js";
import type { ScrollbackMessage } from "./api";
import type { ChannelKey } from "./channelKey";
import { identityScopedStore } from "./identityScopedStore";
import type { ChannelMembers } from "./memberTypes";
import { applyModeString } from "./modeApply";
import { nickEquals } from "./nickEquals";

// Per-channel members store. Source-of-truth for the right-pane
// MembersPane (Task 26). Module-singleton signal store mirroring
// `scrollback.ts` / `selection.ts`.
//
// Lifecycle (CP15 B5):
//   * Bootstrap: server pushes `members_seeded` via WS on after_join
//     (CP15 B3) AND on every 366 RPL_ENDOFNAMES — `seedMembers` writes
//     the snapshot directly. No REST fetch ever; the WS push is the
//     sole source of truth.
//   * Live updates: `applyPresenceEvent(key, msg)` — called from
//     subscribe.ts for every message arriving on the channel WS push.
//     Filters by `msg.kind`: presence kinds mutate the map, content
//     kinds are no-ops.
//
// Pre-B5 history: this module exposed `loadMembers` (REST GET /members
// with a once-per-channel `loadedChannels` Set as the gate). Both went
// away in B5 because the server-side `members_seeded` broadcast covers
// the bootstrap surface AND closes the WS-subscribed-but-no-fetch-yet
// race window the REST gate could never fully eliminate.
//
// Identity-scoped state: `membersByChannel` is scoped to the CURRENT
// bearer. Logout / rotation flushes it via the identityScopedStore
// reset (dup-A3 close).

export type { ChannelMembers, MemberEntry } from "./memberTypes";

const exports_ = identityScopedStore((onIdentityChange) => {
  const [membersByChannel, setMembersByChannel] = createSignal<Record<ChannelKey, ChannelMembers>>(
    {},
  );

  onIdentityChange(() => setMembersByChannel({}));

  // Direct seed from a server-provided members snapshot — used by
  // subscribe.ts when the server emits a `members_seeded` event (366
  // RPL_ENDOFNAMES landed AND the after_join cold-WS-resubscribe push).
  // The payload carries the full sorted snapshot, so this is a single
  // signal write — no REST fetch path remains.
  const seedMembers = (key: ChannelKey, list: ChannelMembers): void => {
    setMembersByChannel((prev) => ({ ...prev, [key]: list }));
  };

  const applyPresenceEvent = (key: ChannelKey, msg: ScrollbackMessage): void => {
    setMembersByChannel((prev) => {
      const current = prev[key] ?? [];

      switch (msg.kind) {
        case "join": {
          // Skip if already present (out-of-order JOIN after 353 NAMES).
          // Case-insensitive (RFC 2812 §2.2) — server may emit JOIN with
          // differently-cased nick than the prior NAMES snapshot.
          if (current.some((m) => nickEquals(m.nick, msg.sender))) return prev;
          return { ...prev, [key]: [...current, { nick: msg.sender, modes: [] }] };
        }
        case "part":
        case "quit": {
          const next = current.filter((m) => !nickEquals(m.nick, msg.sender));
          if (next.length === current.length) return prev;
          return { ...prev, [key]: next };
        }
        case "kick": {
          const target = typeof msg.meta.target === "string" ? msg.meta.target : null;
          if (!target) return prev;
          const next = current.filter((m) => !nickEquals(m.nick, target));
          if (next.length === current.length) return prev;
          return { ...prev, [key]: next };
        }
        case "nick_change": {
          const newNick = typeof msg.meta.new_nick === "string" ? msg.meta.new_nick : null;
          if (!newNick) return prev;
          const next = current.map((m) =>
            nickEquals(m.nick, msg.sender) ? { ...m, nick: newNick } : m,
          );
          return { ...prev, [key]: next };
        }
        case "mode": {
          const modes = typeof msg.meta.modes === "string" ? msg.meta.modes : null;
          const args = Array.isArray(msg.meta.args)
            ? (msg.meta.args.filter((a) => typeof a === "string") as string[])
            : [];
          if (!modes) return prev;
          const next = applyModeString(current, modes, args);
          return { ...prev, [key]: next };
        }
        case "privmsg":
        case "notice":
        case "action":
        case "topic":
        case "server_event":
          return prev;
        default: {
          const _exhaustive: never = msg.kind;
          void _exhaustive;
          return prev;
        }
      }
    });
  };

  // Test seam: lets unit tests inject a known-state member list without
  // exercising the full WS-bootstrap path. Mirrors the
  // `appendToScrollback` helper that scrollback.ts exposes for the same
  // reason. Production callers go through `seedMembers` + WS events.
  const seedFromTest = (key: ChannelKey, list: ChannelMembers): void => {
    setMembersByChannel((prev) => ({ ...prev, [key]: list }));
  };

  return {
    membersByChannel,
    seedMembers,
    applyPresenceEvent,
    seedFromTest,
  };
});

export const membersByChannel = exports_.membersByChannel;
export const seedMembers = exports_.seedMembers;
export const applyPresenceEvent = exports_.applyPresenceEvent;
export const seedFromTest = exports_.seedFromTest;

// UX-4 bucket J (2026-05-19) — tier rank for MembersPane sort order.
// Mirrors the sigil precedence in `memberSigil.ts`: op (@) outranks
// halfop (%), halfop outranks voice (+), voice outranks plain. Lower
// rank value = higher position (op = 0 on top).
//
// Server-side `Grappa.Session.EventRouter.@user_mode_prefixes` is the
// allowed set of per-user modes (o/h/v); any other prefix on a member's
// `modes` array would mean wire contract drift, so this fn doesn't
// need a defensive fallback for unknown prefixes — the entry falls
// through to plain (rank 3) on its own.
const tierRank = (modes: readonly string[]): 0 | 1 | 2 | 3 => {
  if (modes.includes("@")) return 0;
  if (modes.includes("%")) return 1;
  if (modes.includes("+")) return 2;
  return 3;
};

/**
 * Returns a new array with members sorted by tier (op > halfop > voice
 * > plain) and case-insensitive alpha within each tier. Pure — does
 * not mutate the input.
 *
 * Used by MembersPane to keep the right-pane order stable across MODE
 * events: `+o alice` moves alice to the top, `-o alice` drops her
 * back into the plain tier. The render side calls this on every
 * `membersByChannel` change; the work is O(n log n) over a per-channel
 * member count (typically tens to low hundreds) and cheap enough to
 * skip memoisation.
 *
 * Alpha tie-breaker is case-insensitive per RFC 2812 §2.2 — IRC nicks
 * are case-insensitive, so sort order MUST match.
 */
export const sortMembers = (members: ChannelMembers): ChannelMembers =>
  [...members].sort((a, b) => {
    const rankDiff = tierRank(a.modes) - tierRank(b.modes);
    if (rankDiff !== 0) return rankDiff;
    return a.nick.toLowerCase().localeCompare(b.nick.toLowerCase());
  });
