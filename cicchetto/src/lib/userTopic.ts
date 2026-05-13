import { createEffect, createRoot, untrack } from "solid-js";
import { assertNever, type QueryWindowEntry, type WireUserEvent } from "./api";
import { socketUserName, token } from "./auth";
import { setAwayState } from "./awayStatus";
import { setServerBundleHash } from "./bundleHash";
import { channelKey } from "./channelKey";
import { setLusersBundle } from "./lusersBundle";
import { setMentionsBundle } from "./mentionsWindow";
import { mutateNetworkNick, refetchChannels, refetchNetworks } from "./networks";
import { setPeerAway } from "./peerAway";
import { type QueryWindow, setQueryWindowsByNetwork } from "./queryWindows";
import { selectedChannel, setSelectedChannel } from "./selection";
import { joinUser } from "./socket";
import { setWhoisBundle } from "./whoisCard";
import { setWhowasBundle } from "./whowasCard";
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

// Codebase audit cic M1 — runtime narrowing for WireUserEvent. The
// `WireUserEvent` discriminated union is a TypeScript-side contract;
// it cannot enforce shape at runtime. A malformed server push (kind
// valid but a required field missing or wrong-typed) would let the
// dispatch arm read `undefined` from the payload and either crash
// (`setAwayState(undefined, ...)`) or silently corrupt state. This
// per-arm validator gates the cast: if the shape doesn't match,
// return null and the dispatcher early-returns + logs. Same boundary
// hardening as `Login.tsx`'s `isCaptchaInfo`.
function narrowUserEvent(raw: unknown): WireUserEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== "string") return null;
  switch (r.kind) {
    case "channels_changed":
      return { kind: "channels_changed" };
    case "query_windows_list":
      if (typeof r.windows !== "object" || r.windows === null) return null;
      return {
        kind: "query_windows_list",
        windows: r.windows as Record<string, QueryWindowEntry[]>,
      };
    case "mentions_bundle":
      if (
        typeof r.network !== "string" ||
        typeof r.away_started_at !== "string" ||
        typeof r.away_ended_at !== "string" ||
        (r.away_reason !== null && typeof r.away_reason !== "string") ||
        !Array.isArray(r.messages)
      )
        return null;
      return {
        kind: "mentions_bundle",
        network: r.network,
        away_started_at: r.away_started_at,
        away_ended_at: r.away_ended_at,
        away_reason: r.away_reason as string | null,
        messages: r.messages,
      };
    case "away_confirmed":
      if (typeof r.network !== "string" || (r.state !== "present" && r.state !== "away"))
        return null;
      return { kind: "away_confirmed", network: r.network, state: r.state };
    case "own_nick_changed":
      if (typeof r.network_id !== "number" || typeof r.nick !== "string") return null;
      return { kind: "own_nick_changed", network_id: r.network_id, nick: r.nick };
    case "window_pending":
      if (typeof r.network !== "string" || typeof r.channel !== "string" || r.state !== "pending")
        return null;
      return {
        kind: "window_pending",
        network: r.network,
        channel: r.channel,
        state: "pending",
      };
    case "connection_state_changed":
      if (
        typeof r.user_id !== "string" ||
        typeof r.network_id !== "number" ||
        typeof r.network_slug !== "string" ||
        typeof r.from !== "string" ||
        typeof r.to !== "string" ||
        (r.reason !== null && typeof r.reason !== "string") ||
        (r.at !== null && typeof r.at !== "string")
      )
        return null;
      return {
        kind: "connection_state_changed",
        user_id: r.user_id,
        network_id: r.network_id,
        network_slug: r.network_slug,
        from: r.from,
        to: r.to,
        reason: r.reason as string | null,
        at: r.at as string | null,
      };
    case "whois_bundle":
      // C2 — every numeric-derived field is nullable; only network +
      // target are required. is_operator + channels also tolerate
      // missing values (boolean false / null) per Wire.whois_bundle/3
      // shape. Defensive: any malformed shape returns null and the
      // dispatcher logs + drops.
      //
      // P-0a — 11 additional WHOIS-leg flags / strings folded by
      // EventRouter (275/301/307/308/309/310/316/325/326/339/378).
      // Booleans default false on the server when the corresponding
      // numeric did not fire; cic narrows defensively (server bug or
      // legacy mismatch returns null).
      if (
        typeof r.network !== "string" ||
        typeof r.target !== "string" ||
        (r.user !== null && typeof r.user !== "string") ||
        (r.host !== null && typeof r.host !== "string") ||
        (r.realname !== null && typeof r.realname !== "string") ||
        (r.server !== null && typeof r.server !== "string") ||
        (r.server_info !== null && typeof r.server_info !== "string") ||
        typeof r.is_operator !== "boolean" ||
        (r.idle_seconds !== null && typeof r.idle_seconds !== "number") ||
        (r.signon !== null && typeof r.signon !== "number") ||
        (r.channels !== null && !Array.isArray(r.channels)) ||
        typeof r.using_ssl !== "boolean" ||
        typeof r.is_registered !== "boolean" ||
        typeof r.is_admin !== "boolean" ||
        typeof r.is_services_admin !== "boolean" ||
        typeof r.is_helper !== "boolean" ||
        typeof r.is_chanop !== "boolean" ||
        typeof r.is_agent !== "boolean" ||
        typeof r.is_java !== "boolean" ||
        (r.umodes !== null && typeof r.umodes !== "string") ||
        (r.away_message !== null && typeof r.away_message !== "string") ||
        (r.actually_host !== null && typeof r.actually_host !== "string") ||
        (r.actually_ip !== null && typeof r.actually_ip !== "string")
      )
        return null;
      return {
        kind: "whois_bundle",
        network: r.network,
        target: r.target,
        user: r.user as string | null,
        host: r.host as string | null,
        realname: r.realname as string | null,
        server: r.server as string | null,
        server_info: r.server_info as string | null,
        is_operator: r.is_operator,
        idle_seconds: r.idle_seconds as number | null,
        signon: r.signon as number | null,
        channels: r.channels as string[] | null,
        using_ssl: r.using_ssl,
        is_registered: r.is_registered,
        is_admin: r.is_admin,
        is_services_admin: r.is_services_admin,
        is_helper: r.is_helper,
        is_chanop: r.is_chanop,
        is_agent: r.is_agent,
        is_java: r.is_java,
        umodes: r.umodes as string | null,
        away_message: r.away_message as string | null,
        actually_host: r.actually_host as string | null,
        actually_ip: r.actually_ip as string | null,
      };
    case "bundle_hash":
      if (typeof r.hash !== "string" || r.hash === "") return null;
      return { kind: "bundle_hash", hash: r.hash };
    case "peer_away":
      // P-0b — standalone 301 RPL_AWAY. cic dm-listener routes by
      // `peer:` field; banner renders inline at the top of the
      // peer's DM scrollback when that window is selected.
      if (
        typeof r.network !== "string" ||
        typeof r.peer !== "string" ||
        typeof r.message !== "string"
      )
        return null;
      return { kind: "peer_away", network: r.network, peer: r.peer, message: r.message };
    case "lusers_bundle": {
      // P-0d — LUSERS bundle. All counts are integer-or-null (253
      // RPL_LUSERUNKNOWN is optional; defensive nullability covers
      // truncated server responses).
      if (typeof r.network !== "string") return null;
      const intOrNull = (v: unknown): number | null =>
        typeof v === "number" ? v : v === null ? null : null;
      return {
        kind: "lusers_bundle",
        network: r.network,
        total_users: intOrNull(r.total_users),
        invisible: intOrNull(r.invisible),
        servers: intOrNull(r.servers),
        operators: intOrNull(r.operators),
        unknown_connections: intOrNull(r.unknown_connections),
        channels_formed: intOrNull(r.channels_formed),
        local_clients: intOrNull(r.local_clients),
        local_servers: intOrNull(r.local_servers),
        current_local: intOrNull(r.current_local),
        max_local: intOrNull(r.max_local),
        current_global: intOrNull(r.current_global),
        max_global: intOrNull(r.max_global),
      };
    }
    case "whowas_bundle":
      // P-0c — WHOWAS bundle. `not_found` discriminates the 406 case;
      // when true, historical fields are nil. cic owns the rendering
      // (single card per network, last-write-wins per /whowas).
      if (
        typeof r.network !== "string" ||
        typeof r.target !== "string" ||
        typeof r.not_found !== "boolean" ||
        (r.user !== null && typeof r.user !== "string") ||
        (r.host !== null && typeof r.host !== "string") ||
        (r.realname !== null && typeof r.realname !== "string") ||
        (r.server !== null && typeof r.server !== "string") ||
        (r.logoff_time !== null && typeof r.logoff_time !== "string")
      )
        return null;
      return {
        kind: "whowas_bundle",
        network: r.network,
        target: r.target,
        user: r.user as string | null,
        host: r.host as string | null,
        realname: r.realname as string | null,
        server: r.server as string | null,
        logoff_time: r.logoff_time as string | null,
        not_found: r.not_found,
      };
    default:
      return null;
  }
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
      const payload = narrowUserEvent(raw);
      if (payload === null) {
        // Malformed payload: kind missing/unknown OR a required field
        // missing/wrong-typed. Server bug or proxy mangling — drop and
        // log so the operator can investigate without crashing the WS
        // handler. Pre-fix `as WireUserEvent` cast would have let this
        // reach the dispatch arm and either crash a setter or corrupt
        // store state silently.
        console.warn("[userTopic] dropped malformed payload", raw);
        return;
      }
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

        case "whois_bundle": {
          // C2 — WHOIS reply complete (server's 318 RPL_ENDOFWHOIS).
          // Replace any prior bundle for this network and let the
          // ScrollbackPane render the WhoisCard at the top of the
          // active window. Focus-rule: per spec #2, the bundle renders
          // INLINE in the window the user typed /whois from, NOT in
          // the $server window. We don't switch focus — the user is
          // already on the issuing window when the reply arrives.
          const { kind: _omit, ...bundle } = payload;
          setWhoisBundle(payload.network, bundle);
          return;
        }

        case "bundle_hash":
          // CP23 S4 B5 — server pushes the deployed cic bundle hash on
          // user-topic join + on every cic-bundle-changed broadcast.
          // bundleHash.ts compares against bootBundleHash (the hash
          // baked into the page the browser loaded); mismatch shows the
          // refresh banner. No focus change — banner is a passive cue.
          setServerBundleHash(payload.hash);
          return;

        case "peer_away":
          // P-0b — standalone 301 RPL_AWAY ephemeral. Stored keyed
          // on (network slug, peer-nick lowercased); ScrollbackPane
          // mounts the banner only when the selected window matches.
          // Last-write-wins: re-/msg'ing the same away peer replaces
          // the prior message. No focus change.
          setPeerAway(payload.network, payload.peer, payload.message);
          return;

        case "lusers_bundle": {
          // P-0d — LUSERS bundle. Last-write-wins per-network snapshot.
          // Card renders pinned at the top of the $server window.
          // No focus change — welcome-time auto-emit shouldn't yank
          // the operator's window.
          const { kind: _omit, network, ...snapshot } = payload;
          setLusersBundle(network, snapshot);
          return;
        }

        case "whowas_bundle": {
          // P-0c — WHOWAS bundle. Last-write-wins per-network. Renders
          // inline above the active window scrollback (mirrors WhoisCard).
          // No focus change: operator typed /whowas from the window
          // they're looking at; the card renders there. The 406
          // not_found case is folded into the same arm — cic renders a
          // "no history" surface from the boolean.
          const { kind: _omit, ...bundle } = payload;
          setWhowasBundle(payload.network, bundle);
          return;
        }

        default:
          assertNever(payload);
      }
    });
  });
});
