import { createEffect, createRoot, untrack } from "solid-js";
import {
  assertNever,
  type MentionsBundleMessage,
  type QueryWindowEntry,
  type WireUserEvent,
} from "./api";
import { loadArchive } from "./archive";
import { socketUserName, token } from "./auth";
import { setAwayState } from "./awayStatus";
import { setServerBundleHash } from "./bundleHash";
import { channelKey } from "./channelKey";
import { patchHomeNetwork } from "./home";
import { appendInviteAck } from "./inviteAck";
import { setLusersBundle } from "./lusersBundle";
import { setMentionsBundle } from "./mentionsWindow";
import { mutateNetworkNick, refetchChannels, refetchNetworks } from "./networks";
import { setPeerAway } from "./peerAway";
import { type QueryWindow, setQueryWindowsByNetwork } from "./queryWindows";
import { clearSeen } from "./reconnectBackfill";
import { purgeScrollback } from "./scrollback";
import { selectedChannel, setSelectedChannel } from "./selection";
import { applyServerSettings } from "./serverSettings";
import { joinUser } from "./socket";
import { setWhoisBundle } from "./whoisCard";
import { setWhowasBundle } from "./whowasCard";
import { setFailed, setJoined, setKicked, setPending } from "./windowState";
import { narrowWindowStateEvent } from "./wireNarrow";

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

// no-silent-drops B6.10 HIGH-11 — per-element narrowers for bundle
// arrays. Pre-fix `narrowUserEvent` checked `Array.isArray(messages)`
// for `mentions_bundle` and `Array.isArray(channels)` for
// `whois_bundle` but did NOT typecheck array elements. A malformed
// element (server bug, proxy mangling, partial response) would slip
// through the boundary and crash a downstream renderer that read a
// missing field. Now each element is narrowed against its wire
// shape; any failure drops the whole bundle (loud, log-once).

function narrowMentionsBundleMessage(raw: unknown): MentionsBundleMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.server_time !== "number" ||
    typeof r.channel !== "string" ||
    typeof r.sender_nick !== "string" ||
    (r.body !== null && typeof r.body !== "string") ||
    typeof r.kind !== "string"
  )
    return null;
  return {
    server_time: r.server_time,
    channel: r.channel,
    sender_nick: r.sender_nick,
    body: r.body as string | null,
    kind: r.kind,
  };
}

// `whois_bundle.channels` is `string[] | null`. Wire elements arrive
// as IRC mode-prefixed channel names (`@#italia`, `+#grappa`). Reject
// non-string elements; preserve raw strings (cic owns the prefix
// rendering).
function narrowWhoisChannel(raw: unknown): string | null {
  return typeof raw === "string" ? raw : null;
}

// Maps a per-element narrower across an array; returns the array of
// narrowed values or null if any element fails. Strict — partial
// bundles are server bugs, not graceful-degradation cases.
function narrowArray<T>(raw: unknown, narrow: (el: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const out: T[] = [];
  for (const el of raw) {
    const n = narrow(el);
    if (n === null) return null;
    out.push(n);
  }
  return out;
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
    case "mentions_bundle": {
      if (
        typeof r.network !== "string" ||
        typeof r.away_started_at !== "string" ||
        typeof r.away_ended_at !== "string" ||
        (r.away_reason !== null && typeof r.away_reason !== "string")
      )
        return null;
      const messages = narrowArray(r.messages, narrowMentionsBundleMessage);
      if (messages === null) return null;
      return {
        kind: "mentions_bundle",
        network: r.network,
        away_started_at: r.away_started_at,
        away_ended_at: r.away_ended_at,
        away_reason: r.away_reason as string | null,
        messages,
      };
    }
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
    case "whois_bundle": {
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
      //
      // no-silent-drops B6.10 HIGH-11 — `channels` array elements are
      // now per-element narrowed (string-only). A non-string element
      // drops the whole bundle.
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
      let channels: string[] | null = null;
      if (r.channels !== null) {
        channels = narrowArray(r.channels, narrowWhoisChannel);
        if (channels === null) return null;
      }
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
        channels,
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
    }
    case "invite_ack":
      // P-0e + P-0f — 341 RPL_INVITING ack. Server emits structured
      // (network, channel, peer); cic appends a synthetic row to the
      // per-network store keyed on target channel and renders inline
      // in the $server window scrollback.
      if (
        typeof r.network !== "string" ||
        typeof r.channel !== "string" ||
        typeof r.peer !== "string"
      )
        return null;
      return {
        kind: "invite_ack",
        network: r.network,
        channel: r.channel,
        peer: r.peer,
      };
    case "bundle_hash":
      if (typeof r.hash !== "string" || r.hash === "") return null;
      return { kind: "bundle_hash", hash: r.hash };
    case "server_settings_changed": {
      // UX-6-B2 (2026-05-21) — operator-visible server-settings push.
      // Wire shape mirrors `Grappa.ServerSettings.Wire.server_settings_
      // changed/1` (atoms-out). Per-field narrowing rejects any
      // server bug / proxy mangling at the boundary; a malformed
      // payload drops without corrupting the cache.
      const up = r.upload;
      if (typeof up !== "object" || up === null) return null;
      const u = up as Record<string, unknown>;
      if (
        (u.active_host !== "embedded" && u.active_host !== "litterbox") ||
        typeof u.per_file_cap_bytes !== "number" ||
        u.per_file_cap_bytes <= 0 ||
        typeof u.global_cap_bytes !== "number" ||
        u.global_cap_bytes <= 0
      )
        return null;
      return {
        kind: "server_settings_changed",
        upload: {
          active_host: u.active_host,
          per_file_cap_bytes: u.per_file_cap_bytes,
          global_cap_bytes: u.global_cap_bytes,
        },
      };
    }
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
    case "joined":
    case "join_failed":
    case "kicked":
      // F1 (visitor-parity-and-nickserv cluster, 2026-05-15) — typed
      // window-state terminal events dual-broadcast on user-topic by
      // `Session.Server.broadcast_window_state_dual/3` to close the
      // subscribe-then-broadcast race. REV-A H1 (2026-05-22) — shape
      // narrowing extracted to shared `narrowWindowStateEvent` so any
      // future server-side field add to e.g. `Session.Wire.kicked/4`
      // lands once at the helper. Dispatcher routes the typed result to
      // the per-store setters (setJoined/setFailed/setKicked) at the
      // call-site switch below (different store keys per topic boundary
      // → "reuses the verb, not the noun").
      return narrowWindowStateEvent(r);
    case "archive_changed":
      // UX-1 (2026-05-17) — server broadcasts after a successful PART
      // (channel moves into archive list). Single-field envelope: cic
      // re-fetches via `loadArchive(slug)` rather than tracking a
      // wire-side delta (small set; refresh is idempotent and survives
      // reconnect replay). For the DESTRUCTIVE
      // `DELETE /networks/:slug/archive/:target` path the server now
      // broadcasts `archive_purged` instead — see below (UX-7-B).
      if (typeof r.network_slug !== "string") return null;
      return { kind: "archive_changed", network_slug: r.network_slug };
    case "archive_purged":
      // UX-7-B (2026-05-22) — server broadcasts after a successful
      // DELETE /networks/:slug/archive/:target. Two fields: the slug
      // (refresh the archive list, same as archive_changed) AND the
      // target (invalidate `scrollbackByChannel[channelKey(slug,
      // target)]` so the pre-delete rows don't ghost in the live Solid
      // store on re-JOIN — refreshScrollback's `?after=cursor` fetch
      // is past every deleted row, masking the gap without the purge).
      if (typeof r.network_slug !== "string" || typeof r.target !== "string") return null;
      return { kind: "archive_purged", network_slug: r.network_slug, target: r.target };
    case "home_network_state_changed": {
      // UX-4 bucket B — per-row patch for the HomePane's networks list.
      // Co-emitted by `Networks.broadcast_state_change/4` alongside the
      // wider `connection_state_changed` arm so HomePane can patch its
      // `home_data.networks` slot in-place from the narrow payload
      // (no /me refetch). Same shape as `home_data.networks[*]` —
      // single shared server-side builder `Wire.home_network_row/2`.
      const net = r.network;
      if (typeof net !== "object" || net === null) return null;
      const n = net as Record<string, unknown>;
      if (
        typeof n.slug !== "string" ||
        typeof n.nick !== "string" ||
        (n.connection_state !== "connected" &&
          n.connection_state !== "parked" &&
          n.connection_state !== "failed") ||
        (n.connection_state_reason !== null && typeof n.connection_state_reason !== "string") ||
        (n.connection_state_changed_at !== null &&
          typeof n.connection_state_changed_at !== "string")
      )
        return null;
      return {
        kind: "home_network_state_changed",
        network: {
          slug: n.slug,
          nick: n.nick,
          connection_state: n.connection_state,
          connection_state_reason: n.connection_state_reason as string | null,
          connection_state_changed_at: n.connection_state_changed_at as string | null,
        },
      };
    }
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

        case "server_settings_changed":
          // UX-6-B2 (2026-05-21) — operator-visible server-settings
          // push. Hydrates the reactive `serverSettings()` signal so
          // ComposeBox / SettingsDrawer / PrivacyModal pick up the
          // new active host + caps without a page reload. After-join
          // snapshot AND admin-PUT fan-out both ride this arm — same
          // setter applies in both directions (last-write-wins,
          // idempotent). Destructure to drop the `kind` discriminator
          // — `applyServerSettings` takes the `ServerSettingsWirePayload`
          // shape (upload subtree only) so structural-typing drift
          // (e.g. a future log site reading `raw.kind`) can't surprise
          // the REST call site whose response has no `kind`.
          applyServerSettings({ upload: payload.upload });
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

        case "invite_ack":
          // P-0e + P-0f — append a synthetic row to the per-network
          // store keyed on target channel. `InviteAckRows` mounts on
          // the $server window scrollback and renders one row per
          // event. No focus change — server-window auto-yank would
          // be antisocial.
          appendInviteAck(payload.network, payload.channel, payload.peer);
          return;

        case "joined":
          // F1 (visitor-parity-and-nickserv cluster, 2026-05-15) — typed
          // window-state terminal events ALSO arrive on user-topic as a
          // safety net for the subscribe-then-broadcast race documented
          // at `Session.Server.broadcast_window_state_dual/3`. Same
          // setter the per-channel arm at `subscribe.ts` calls;
          // last-write-wins idempotent so dual-delivery (per-channel
          // arrives a tick later than user-topic) is safe.
          setJoined(channelKey(payload.network, payload.channel));
          return;

        case "join_failed":
          // F1 — see `joined` arm above. Same shape + setter as
          // `subscribe.ts:313` per-channel arm.
          setFailed(channelKey(payload.network, payload.channel), payload.reason, payload.numeric);
          return;

        case "kicked":
          // F1 — see `joined` arm above. Same shape + setter as
          // `subscribe.ts` per-channel kicked arm.
          setKicked(channelKey(payload.network, payload.channel), payload.by, payload.reason);
          return;

        case "archive_changed":
          // UX-1 (2026-05-17) — PART moved a channel into archive.
          // Re-fetch via the existing `loadArchive(slug)` helper rather
          // than tracking the wire-side delta (the set is small and
          // refresh is idempotent + reconnect-safe).
          void loadArchive(payload.network_slug);
          return;

        case "archive_purged":
          // UX-7-B (2026-05-22) — destructive archive-entry delete.
          // Order (purge → clearSeen → loadArchive) covers the common
          // happy path: invalidate the in-memory scrollback cache for
          // the target key, then drop the high-water mark so the next
          // refresh fetches from 0 (or the server-side read cursor)
          // rather than the pre-delete high-water, then refresh the
          // archive list so the modal/sidebar sections drop the row.
          //
          // Edge case (not defended): an `await listMessagesAfter(...)`
          // already in flight when this handler runs will resolve into
          // `appendToScrollback` + `recordSeen` on the just-purged
          // key, re-seeding the store from rows the server returned
          // BEFORE the delete landed. Practical likelihood is ~zero
          // because the DELETE response (204) is sent by the same
          // controller process that emits this broadcast, well before
          // any post-delete re-JOIN's refreshScrollback could fire.
          // Stale rows would be re-purged on the next archive_purged
          // anyway. Not worth the complexity to await/cancel.
          //
          // The cic-side `readCursor.cursors[key]` is INTENTIONALLY
          // NOT cleared here: (1) the server's `read_cursors` row was
          // already `ON DELETE SET NULL`'d by the migration FK; (2)
          // `applyJoinReply` no-ops on a null cursor so cic's signal
          // map retains the stale id; (3) sqlite AUTOINCREMENT is
          // monotonic, so any post-purge live message has id > stale
          // cursor and the next `refreshScrollback` returns the full
          // gap. Clearing client-side would break cross-device cursor
          // sync (settled reads on device A would vanish on device B
          // after the unrelated archive delete).
          {
            const key = channelKey(payload.network_slug, payload.target);
            purgeScrollback(key);
            clearSeen(key);
            void loadArchive(payload.network_slug);
          }
          return;

        case "home_network_state_changed":
          // UX-4 bucket B — per-row patch into the HomePane signal.
          // Co-emitted with `connection_state_changed`; HomePane
          // patches in-place without a /me refetch.
          patchHomeNetwork(payload.network);
          return;

        default:
          assertNever(payload);
      }
    });
  });
});
