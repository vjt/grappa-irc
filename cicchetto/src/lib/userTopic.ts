import { createEffect, createRoot, untrack } from "solid-js";
import { assertNever, type QueryWindowEntry, type WireUserEvent } from "./api";
import { socketUserName, token } from "./auth";
import { setAwayState } from "./awayStatus";
import { channelKey } from "./channelKey";
import { setMentionsBundle } from "./mentionsWindow";
import { mutateNetworkNick, refetchChannels, refetchNetworks } from "./networks";
import { type QueryWindow, setQueryWindowsByNetwork } from "./queryWindows";
import { selectedChannel, setSelectedChannel } from "./selection";
import { joinUser } from "./socket";
import { setPending } from "./windowState";

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
// CP16 B5: payload typed as `WireUserEvent` discriminated union; the
// dispatch switch ends with `assertNever(payload)` so adding a new
// server-side event kind without a handler arm fails at `tsc` time.
//
// Identity-scoped: re-evaluates when `user()` resolves under a fresh
// bearer.

function parseWindowsMap(raw: Record<string, QueryWindowEntry[]>): Record<number, QueryWindow[]> {
  const result: Record<number, QueryWindow[]> = {};
  for (const [key, val] of Object.entries(raw)) {
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
    channel.on("event", (raw: unknown) => {
      const payload = raw as WireUserEvent;
      switch (payload.kind) {
        case "channels_changed":
          refetchChannels();
          return;

        case "query_windows_list":
          setQueryWindowsByNetwork(parseWindowsMap(payload.windows));
          return;

        case "mentions_bundle": {
          // C8.1 — back-from-away mentions window. Wire the bundle
          // into the mentionsWindow store and auto-focus the mentions
          // pseudo-window so the user sees the aggregation immediately
          // on return. Focus-rule: this IS a user-action-driven event
          // (returning from away) so auto-focus is appropriate here
          // (unlike DM auto-open).
          const bundle = {
            network_slug: payload.network,
            away_started_at: payload.away_started_at,
            away_ended_at: payload.away_ended_at,
            away_reason: payload.away_reason,
            messages: payload.messages,
          };
          setMentionsBundle(payload.network, bundle);
          const currentSel = untrack(selectedChannel);
          if (
            !currentSel ||
            currentSel.networkSlug !== payload.network ||
            currentSel.kind !== "mentions"
          ) {
            setSelectedChannel({
              networkSlug: payload.network,
              channelName: "",
              kind: "mentions",
            });
          }
          return;
        }

        case "away_confirmed":
          // C8.3 — away visual indicator. Server broadcasts
          // away_confirmed with state: "away" | "present" on both set
          // and cancel paths. Update the awayByNetwork signal so the
          // Sidebar can show [away].
          setAwayState(payload.network, payload.state === "away");
          return;

        case "own_nick_changed":
          // BUG1-FIX: the live IRC nick may differ from the credential's
          // configured nick after NickServ ghost recovery or an explicit
          // /nick. Patch the in-memory networks list so the DM-listener
          // loop and the query-window own-nick skip see the correct
          // nick immediately — no REST round-trip needed. The `joined`
          // set deduplication in subscribe.ts means the DM-listener
          // createEffect will re-run and subscribe to the new own-nick
          // topic on the next tick.
          mutateNetworkNick(payload.network_id, payload.nick);
          return;

        case "connection_state_changed":
          // Codebase review 2026-05-08 cross-infra H1: T32
          // disconnect/connect/mark_failed transitions emit this event
          // on the user-level topic. Refetch /networks so the UI sees
          // the updated `connection_state` / `connection_state_reason` /
          // `connection_state_changed_at` fields immediately on the
          // initiating tab AND on any sibling tab logged in to the
          // same account.
          refetchNetworks();
          return;

        case "window_pending":
          // CP17 — server-driven `:pending` window-state origination.
          // Server's `record_in_flight_join/2` writes
          // `window_states[ch] = :pending` and broadcasts on
          // `Topic.user/1` (NOT per-channel — chicken-and-egg: cic
          // only joins the per-channel topic AFTER seeing :pending
          // here). subscribe.ts:425's pre-subscribe loop re-runs on
          // the windowStateByChannel signal change and joins the
          // per-channel WS topic so the subsequent typed `joined` /
          // `join_failed` / `kicked` events land. Pre-CP17 cic mutated
          // the same store optimistically from compose.ts:210, which
          // was a parallel client-side state machine — closed by this
          // arm.
          setPending(channelKey(payload.network, payload.channel));
          return;

        default:
          assertNever(payload);
      }
    });
  });
});
