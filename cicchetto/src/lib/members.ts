import { createSignal } from "solid-js";
import type { ScrollbackMessage } from "./api";
import type { ChannelKey } from "./channelKey";
import { identityScopedStore } from "./identityScopedStore";
import type { Casemapping } from "./isupport";
import type { ChannelMembers } from "./memberTypes";
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

export type { ChannelMembers, MemberEntry, MemberGender } from "./memberTypes";

// issue 2692 — `meta.member_modes` off the wire: nick → that member's whole
// mode list after the MODE. `meta` is typed `unknown` per key, so narrow it
// here; an entry that is not a string array is dropped rather than applied.
// `Object.entries` reads own keys only, so a nick spelled like an
// `Object.prototype` member is matched as the string it is.
const memberModesOf = (raw: unknown): Array<[string, string[]]> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  return Object.entries(raw).filter(
    (entry): entry is [string, string[]] =>
      Array.isArray(entry[1]) && entry[1].every((mode) => typeof mode === "string"),
  );
};

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

  // #1861 — the casemapping is passed IN rather than resolved here: this
  // store is keyed by ChannelKey and never learns a network id, and the
  // dispatcher (`subscribe.ts`) already holds the network. Same
  // fact-as-data shape `chantypes.ts` uses for CHANTYPES=.
  const applyPresenceEvent = (
    key: ChannelKey,
    msg: ScrollbackMessage,
    casemapping: Casemapping,
  ): void => {
    setMembersByChannel((prev) => {
      const current = prev[key] ?? [];

      switch (msg.kind) {
        case "join": {
          // Skip if already present (out-of-order JOIN after 353 NAMES).
          // Case-insensitive (RFC 2812 §2.2) — server may emit JOIN with
          // differently-cased nick than the prior NAMES snapshot.
          if (current.some((m) => nickEquals(m.nick, msg.sender, casemapping))) return prev;
          return { ...prev, [key]: [...current, { nick: msg.sender, modes: [] }] };
        }
        case "part":
        case "quit": {
          const next = current.filter((m) => !nickEquals(m.nick, msg.sender, casemapping));
          if (next.length === current.length) return prev;
          return { ...prev, [key]: next };
        }
        case "kick": {
          const target = typeof msg.meta.target === "string" ? msg.meta.target : null;
          if (!target) return prev;
          const next = current.filter((m) => !nickEquals(m.nick, target, casemapping));
          if (next.length === current.length) return prev;
          return { ...prev, [key]: next };
        }
        case "nick_change": {
          const newNick = typeof msg.meta.new_nick === "string" ? msg.meta.new_nick : null;
          if (!newNick) return prev;
          const next = current.map((m) =>
            nickEquals(m.nick, msg.sender, casemapping) ? { ...m, nick: newNick } : m,
          );
          return { ...prev, [key]: next };
        }
        case "mode": {
          // issue 2692 — the server derived what this line did to the roster
          // (from the network's PREFIX and CHANMODES) and wrote each changed
          // member's ABSOLUTE modes onto the row. Apply that; never walk
          // `modes`/`args` here — that is IRC grammar, and the copy that
          // lived in this client graded the wrong member. A row without the
          // key changed nobody, or predates protocol 66: leave the roster.
          const memberModes = memberModesOf(msg.meta.member_modes);
          if (memberModes.length === 0) return prev;
          let changed = false;
          const next = current.map((m) => {
            const hit = memberModes.find(([nick]) => nickEquals(m.nick, nick, casemapping));
            if (hit === undefined) return m;
            changed = true;
            return { ...m, modes: [...hit[1]] };
          });
          return changed ? { ...prev, [key]: next } : prev;
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
// The tier IS the index into the network's advertised sigil run (highest
// rank first, from `sigilRank`), so lower value = higher position. Plain
// takes `rank.length`, one past every real index whatever the run's size.
//
// issue 1999 — this used to be a hardcoded `@ > % > +` ladder, and the
// comment here claimed the server only ever admits `o/h/v`. #216 had
// already made that false: the membership set is per-network, from the 005
// PREFIX. Consequence once the server stopped gluing sigils to nicks — a
// founder's `["~"]` matched no branch, fell to plain, and the channel's
// founder rendered at the BOTTOM of the pane, below every lurker.
//
// A sigil the network never advertised is not a grade: `findIndex` misses
// and the member falls to plain, the same posture `memberSigil` takes.
const tierRank = (modes: readonly string[], rank: readonly string[]): number => {
  const tier = rank.findIndex((sigil) => modes.includes(sigil));
  return tier === -1 ? rank.length : tier;
};

/**
 * Returns a new array with members sorted by advertised grade (highest
 * first, plain last) and case-insensitive alpha within each tier. Pure —
 * does not mutate the input.
 *
 * `rank` is the network's sigil run — `sigilRankForSlug(slug)` at the
 * render site. Passed in rather than read from the store so this stays a
 * pure function; it is required rather than defaulted because a wrong
 * default here silently reorders someone's pane (CLAUDE.md: no default
 * arguments, they create silent degradation paths).
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
export const sortMembers = (members: ChannelMembers, rank: readonly string[]): ChannelMembers =>
  [...members].sort((a, b) => {
    const rankDiff = tierRank(a.modes, rank) - tierRank(b.modes, rank);
    if (rankDiff !== 0) return rankDiff;
    return a.nick.toLowerCase().localeCompare(b.nick.toLowerCase());
  });
