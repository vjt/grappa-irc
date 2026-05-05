import { createEffect, createRoot } from "solid-js";
import { socketUserName, token } from "./auth";
import { refetchChannels } from "./networks";
import { type QueryWindow, setQueryWindowsByNetwork } from "./queryWindows";
import { joinUser } from "./socket";

// Per-user PubSub topic subscriber. Module-singleton side-effect:
// imports for effect, exports nothing public. `main.tsx` imports this
// alongside `subscribe.ts` so the createRoot evaluates at boot.
//
// Wires the server-side `channels_changed` heartbeat (broadcast on
// `Topic.user(user_name)` whenever `Map.keys(Session.Server.state.members)`
// mutates) to a `refetchChannels()` call. The cicchetto `channelsBySlug`
// createResource then re-resolves with the canonical {name, joined,
// source} envelopes from `GET /channels`, and `subscribe.ts`'s
// createEffect re-runs to join WS topics for the new channels.
//
// C1.3: also handles `query_windows_list` push. The server sends string
// map keys (JSON objects always have string keys) and snake_case field
// names; we coerce to integer keys + camelCase before storing.
//
// Identity-scoped: re-evaluates when `user()` resolves under a fresh
// bearer. The Phoenix Channel handle is per-tab and persists across
// `user()` rotations through the Socket's connect/disconnect lifecycle
// in socket.ts; we don't need a `leave()` arm here.

// Wire shape from the server — integer keys come over as string keys in JSON.
type WireWindow = { target_nick: string; opened_at: string };
type WireWindowsMap = Record<string, WireWindow[]>;

function parseWindowsMap(raw: unknown): Record<number, QueryWindow[]> {
  if (typeof raw !== "object" || raw === null) return {};
  const result: Record<number, QueryWindow[]> = {};
  for (const [key, val] of Object.entries(raw as WireWindowsMap)) {
    const networkId = Number(key);
    if (!Number.isFinite(networkId) || !Array.isArray(val)) continue;
    result[networkId] = val.map((w) => ({
      targetNick: w.target_nick,
      openedAt: w.opened_at,
    }));
  }
  return result;
}

createRoot(() => {
  let joined = false;
  let joinedFor: string | null = null;

  createEffect(() => {
    // Track the bearer; identity is derived from the persisted
    // Subject via socketUserName() (see auth.ts). Visitor sessions
    // get the `"visitor:<uuid>"` prefix the server-side
    // UserSocket.assign_subject expects; user sessions get the
    // user.name. On token rotation re-derive and re-join.
    const t = token();
    if (!t) {
      joined = false;
      joinedFor = null;
      return;
    }
    const name = socketUserName();
    if (name === null) return;
    if (joined && joinedFor === name) return;
    joined = true;
    joinedFor = name;

    const channel = joinUser(name);
    channel.on("event", (payload: { kind?: string; [k: string]: unknown }) => {
      if (payload.kind === "channels_changed") {
        refetchChannels();
      } else if (payload.kind === "query_windows_list") {
        setQueryWindowsByNetwork(parseWindowsMap(payload.windows));
      }
    });
  });
});
