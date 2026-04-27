import { createEffect, createRoot, createSignal, on } from "solid-js";
import { listMembers, type ScrollbackMessage } from "./api";
import { token } from "./auth";
import { type ChannelKey, channelKey } from "./channelKey";
import type { ChannelMembers } from "./memberTypes";
import { applyModeString } from "./modeApply";

// Per-channel members store. Source-of-truth for the right-pane
// MembersPane (Task 26). Module-singleton signal store mirroring
// `scrollback.ts` / `selection.ts`.
//
// Lifecycle:
//   1. Initial bootstrap: `loadMembers(slug, name)` fetches GET /members
//      snapshot, populates the per-channel signal map. Once-per-channel
//      gate via `loadedChannels` Set (mirror of scrollback's pattern).
//   2. Live updates: `applyPresenceEvent(key, msg)` — called from
//      subscribe.ts (Task 20) for every message arriving on the channel
//      WS push. Filters by `msg.kind`: presence kinds mutate the map,
//      content kinds are no-ops. Q4 pinned: derived from existing
//      message stream — no new server-side broadcast.
//
// Identity-scoped state: `loadedChannels` + `membersByChannel` are
// scoped to the CURRENT bearer. Logout / rotation flushes both. The
// on(token) cleanup arm mirrors the C7/A1 pattern in scrollback.ts.
//
// Renderer-stable order: `loadMembers` preserves the server's mIRC
// sort (ops → voiced → plain, alphabetical within tier). Live presence
// events APPEND new joiners to the tail without re-sorting — so a
// freshly-JOINed user doesn't jump-cut the renderer; the next page
// reload (or channel-select re-fetch) re-sorts.

export type { ChannelMembers, MemberEntry } from "./memberTypes";

const exports_ = createRoot(() => {
  const loadedChannels = new Set<ChannelKey>();
  const [membersByChannel, setMembersByChannel] = createSignal<Record<ChannelKey, ChannelMembers>>(
    {},
  );

  // Identity-transition cleanup. Same shape as scrollback.ts.
  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) {
        loadedChannels.clear();
        setMembersByChannel({});
      }
    }),
  );

  const loadMembers = async (slug: string, name: string): Promise<void> => {
    const t = token();
    if (!t) return;
    const key = channelKey(slug, name);
    if (loadedChannels.has(key)) return;
    loadedChannels.add(key);
    try {
      const list = await listMembers(t, slug, name);
      setMembersByChannel((prev) => ({ ...prev, [key]: list }));
    } catch {
      // First-load failure leaves no entry; the pane renders
      // "no members yet" until the user re-selects (which calls this
      // again and lets the gate re-try).
      loadedChannels.delete(key);
    }
  };

  const applyPresenceEvent = (key: ChannelKey, msg: ScrollbackMessage): void => {
    setMembersByChannel((prev) => {
      const current = prev[key] ?? [];

      switch (msg.kind) {
        case "join": {
          // Skip if already present (out-of-order JOIN after 353 NAMES).
          if (current.some((m) => m.nick === msg.sender)) return prev;
          return { ...prev, [key]: [...current, { nick: msg.sender, modes: [] }] };
        }
        case "part":
        case "quit": {
          const next = current.filter((m) => m.nick !== msg.sender);
          if (next.length === current.length) return prev;
          return { ...prev, [key]: next };
        }
        case "kick": {
          const target = typeof msg.meta.target === "string" ? msg.meta.target : null;
          if (!target) return prev;
          const next = current.filter((m) => m.nick !== target);
          if (next.length === current.length) return prev;
          return { ...prev, [key]: next };
        }
        case "nick_change": {
          const newNick = typeof msg.meta.new_nick === "string" ? msg.meta.new_nick : null;
          if (!newNick) return prev;
          const next = current.map((m) => (m.nick === msg.sender ? { ...m, nick: newNick } : m));
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
  // reason. Production callers go through `loadMembers` + WS events.
  const seedFromTest = (key: ChannelKey, list: ChannelMembers): void => {
    setMembersByChannel((prev) => ({ ...prev, [key]: list }));
  };

  return {
    membersByChannel,
    loadMembers,
    applyPresenceEvent,
    seedFromTest,
  };
});

export const membersByChannel = exports_.membersByChannel;
export const loadMembers = exports_.loadMembers;
export const applyPresenceEvent = exports_.applyPresenceEvent;
export const seedFromTest = exports_.seedFromTest;
