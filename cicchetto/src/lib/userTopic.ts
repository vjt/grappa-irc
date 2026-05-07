import { createEffect, createRoot, untrack } from "solid-js";
import { socketUserName, token } from "./auth";
import { setAwayState } from "./awayStatus";
import { setMentionsBundle } from "./mentionsWindow";
import { mutateNetworkNick, refetchChannels } from "./networks";
import { type QueryWindow, setQueryWindowsByNetwork } from "./queryWindows";
import { selectedChannel, setSelectedChannel } from "./selection";
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
// C1.3: also handles `query_windows_list` push.
//
// CP13: the pre-CP13 `numeric_routed` ephemeral push is gone — server
// numerics now persist as `:notice` rows in their routed window via
// the regular per-channel topic (handled by subscribe.ts), so they
// flow through the same pipeline as PRIVMSG/NOTICE.
//
// Identity-scoped: re-evaluates when `user()` resolves under a fresh
// bearer.

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
      } else if (payload.kind === "mentions_bundle") {
        // C8.1 — back-from-away mentions window. Wire the bundle into the
        // mentionsWindow store and auto-focus the mentions pseudo-window so
        // the user sees the aggregation immediately on return.
        // Focus-rule: this IS a user-action-driven event (returning from away)
        // so auto-focus is appropriate here (unlike DM auto-open).
        const networkSlug = payload.network as string;
        const bundle = {
          network_slug: networkSlug,
          away_started_at: payload.away_started_at as string,
          away_ended_at: payload.away_ended_at as string,
          away_reason: (payload.away_reason as string | null) ?? null,
          messages: payload.messages as {
            server_time: number;
            channel: string;
            sender_nick: string;
            body: string | null;
            kind: string;
          }[],
        };
        setMentionsBundle(networkSlug, bundle);
        // Auto-focus the mentions pseudo-window (channelName="" for pseudo-windows).
        const currentSel = untrack(selectedChannel);
        if (
          !currentSel ||
          currentSel.networkSlug !== networkSlug ||
          currentSel.kind !== "mentions"
        ) {
          setSelectedChannel({ networkSlug, channelName: "", kind: "mentions" });
        }
      } else if (payload.kind === "away_confirmed") {
        // C8.3 — away visual indicator. Server broadcasts away_confirmed
        // with state: "away" | "present" on both set and cancel paths.
        // Update the awayByNetwork signal so the Sidebar can show [away].
        const networkSlug = payload.network as string;
        setAwayState(networkSlug, (payload.state as string) === "away");
      } else if (payload.kind === "own_nick_changed") {
        // BUG1-FIX: the live IRC nick may differ from the credential's
        // configured nick after NickServ ghost recovery or an explicit /nick.
        // Patch the in-memory networks list so the DM-listener loop and the
        // query-window own-nick skip see the correct nick immediately — no
        // REST round-trip needed. The `joined` set deduplication in
        // subscribe.ts means the DM-listener createEffect will re-run and
        // subscribe to the new own-nick topic on the next tick.
        const networkId = payload.network_id as number;
        const nick = payload.nick as string;
        mutateNetworkNick(networkId, nick);
      }
    });
  });
});
