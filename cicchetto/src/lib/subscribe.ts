import type { Channel } from "phoenix";
import { createEffect, createRoot, on, untrack } from "solid-js";
import { assertNever, type ChannelEvent, ownNickForNetwork } from "./api";
import { socketUserName, token } from "./auth";
import { incrementBadge, setBadge } from "./badge";
import { playBeep } from "./beep";
import { type ChannelKey, channelKey, decodeChannelKey } from "./channelKey";
import { seedModes, seedTopic } from "./channelTopic";
import { isDocumentVisible } from "./documentVisibility";
import { seedIsupport } from "./isupport";
import { applyPresenceEvent, seedMembers } from "./members";
import { mentionsUser } from "./mentionMatch";
import { bumpMention } from "./mentions";
import { channelsBySlug, networks, refetchChannels, refetchNetworks, user } from "./networks";
import { nickEquals } from "./nickEquals";
import { isOperatorActionEcho } from "./operatorActionEcho";
import { isOwnPresenceEvent } from "./ownPresenceEvent";
import { setEnsureQueryTopicJoined } from "./queryTopicJoin";
import { openQueryWindowState, queryWindowsByNetwork } from "./queryWindows";
import { applyJoinReply, applyReadCursorSet } from "./readCursor";
import { recordSeen } from "./reconnectBackfill";
import { appendToScrollback, refreshScrollback } from "./scrollback";
import { selectedChannel, setServerSeedCount } from "./selection";
import { joinChannel } from "./socket";
import { socketHealth } from "./socketHealth";
import { SERVER_WINDOW_NAME } from "./windowKinds";
import { setFailed, setJoined, setKicked, setParted, windowStateByChannel } from "./windowState";
import { narrowChannelEvent } from "./wireNarrow";

// WS subscription installer. Reactive side-effect module: imports for
// effect, exports nothing public. The app entry (`main.tsx`) imports
// this so the join-effect createRoot evaluates at boot.
//
// Lifted out of the original `networks.ts` god-module per A4. Owns:
//   * `joined` Set — guards double-joins. Phoenix is idempotent on
//     `socket.channel(topic)` (returns the existing handle), but the
//     Set keeps the handler-install step explicit and lets future
//     Phase-5 PART logic mirror with a `leave + delete`.
//   * Three createEffects, sharing one `routeMessage` body:
//     1. Channels loop — iterates `channelsBySlug()`. Subscribes to
//        every real IRC channel topic. Key = channelKey(slug, name).
//     2. Query-windows loop — iterates `queryWindowsByNetwork()`.
//        Subscribes to the per-(slug, targetNick) topic for every
//        open DM window, EXCLUDING targetNick == ownNick (the dm-
//        listener loop owns that topic — see below). The server
//        broadcasts outbound `/msg <nick>` echoes here; subscribing
//        makes those messages appear live in the query pane without
//        a reload (DM live-WS gap fix).
//     3. DM-listener loop — iterates `networks()`. Subscribes to the
//        own-nick topic per network (`grappa:user:<u>/network:<slug>/
//        channel:<ownNick>`). The server broadcasts INBOUND DMs here
//        (the IRC `PRIVMSG <ownNick> :body` line persists with
//        `channel = ownNick`). The handler RE-KEYS the append to
//        the sender's nick — so an incoming reply from `vjt` lands
//        in the `vjt` query window's scrollback, NOT in an invisible
//        own-nick bucket. Self-msg (sender = ownNick, via `/msg
//        <ownNick> :body`) routes to the own-nick key. Always auto-
//        opens the sender's window (idempotent inside queryWindows.ts).
//        Non-PRIVMSG/ACTION events (NOTICE from services, mode, etc.)
//        are DROPPED — they belong in the server-messages window
//        (feature #4, deferred) and must NOT pollute the own-nick key.
//
// All three effects share `routeMessage` so the privmsg/channel
// ingestion paths are byte-identical downstream — per the user's
// directive: "they should be practically the same." Only the iteration
// source and key derivation differ; everything else (scrollback append,
// presence apply, unread split, mention bump) is one code path.
//
// Identity-scoped cleanup mirrors the on(token) arms in `scrollback.ts`
// and `selection.ts`: logout/rotation clears `joined`. Module-import
// order — subscribe imports scrollback + selection + networks — means
// each peer module's createRoot evaluates first and registers its
// cleanup before this one. On a token flush: scrollback cleanup →
// selection cleanup → networks cleanup → subscribe cleanup → the join
// effect re-runs against fresh state once the resources resolve under
// the new bearer.
//
// C3.1: `topic_changed` and `channel_modes_changed` events route to
// `channelTopic.seedTopic` / `channelTopic.seedModes` so TopicBar can
// display live topic + modes without a REST round-trip.
//
// C3.2: JOIN-by-self detection: `message.kind === "join"` events whose
// `sender` matches own nick are forwarded to `joinEvents.notifyJoin`
// so ScrollbackPane can render the one-time join banner.
//
// C4.1 / DM live-WS gap: the auto-open + re-key behaviour for inbound
// DMs lives in the DM-listener loop. Earlier versions tried to detect
// inbound DMs from inside the channels-loop handler by checking
// `name === ownNick`, but that required cicchetto to fake an own-nick
// channel in the channelsBySlug response — which never happens in
// production (channels list is real IRC channels only). The dedicated
// DM-listener loop subscribes to the own-nick topic explicitly and
// re-keys the append to `channelKey(slug, sender)` so the message
// lands where the user looks for it.

// Bucket G H3: the canonical 6-kind WireChannelEvent union now lives
// in `lib/api.ts` next to its sibling `WireUserEvent` (line 381 there).
// Pre-bucket-G this file declared a local `WireEvent` type that ALSO
// duplicated the full union, while api.ts declared a narrow `message`-
// only `ChannelEvent`. Future consumers importing from api.ts were
// type-blind to 5 of 6 arms. Single source removes the drift class.

// #159 E2E gap seam (module-scope so the window hook below can populate
// it and the in-`createRoot` `phx.on` handler can read it). Populated
// ONLY by `__cic_suppressChannelDeliveryForTests`; empty in production.
const suppressedDeliveryKeys = new Set<ChannelKey>();

createRoot(() => {
  // Codebase review 2026-05-08 cic H2 (HIGH): track Channel objects, not
  // just keys. On rotation we MUST `phx.leave()` each prior Channel
  // before clearing — phoenix.js's `socket.channel(topic)` always
  // creates a NEW Channel and pushes it onto `socket.channels[]`; the
  // OLD Channel and its `phx.on("event", ...)` handler stay alive
  // forever otherwise. Both Channels then receive every dispatched
  // event, doubling presence/unread/mention bumps. N rotations = N+1
  // handlers per channel.
  const joined = new Map<ChannelKey, Channel>();
  // #254 — coalesce concurrent join callers (the reactive query-windows loop +
  // a compose `/msg` via `ensureQueryTopicJoined`) onto ONE join-ACK promise
  // per query topic, so subscribe-before-send awaits the SAME ack the loop
  // drives (no double-join). Cleared on identity rotation alongside `joined`.
  const queryJoinAcks = new Map<ChannelKey, Promise<void>>();

  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) {
        for (const ch of joined.values()) ch.leave();
        joined.clear();
        queryJoinAcks.clear();
      }
    }),
  );

  // Effective focus = cicchetto-selected AND browser-tab visible+focused.
  // A selected window in a hidden/blurred tab is NOT being read live —
  // arrivals must accumulate as unread so the marker surfaces on return.
  // Single source for the focus predicate so `routeMessage` (mention
  // path) and the DM-listener call sites (beep dispatch) read the same
  // rule — per CLAUDE.md "Implement once, reuse everywhere". If the
  // rule evolves (page-frozen check, last-seen-window heuristic, etc.)
  // it changes here only.
  const effectivelyFocused = (slug: string, windowName: string): boolean => {
    const sel = untrack(selectedChannel);
    return (
      sel !== null &&
      sel.networkSlug === slug &&
      sel.channelName === windowName &&
      isDocumentVisible()
    );
  };

  // Shared message-routing body. Given a slug + the rendered window's
  // (key, displayName), drives every downstream side-effect for a
  // `kind: "message"` payload: scrollback append, presence apply,
  // unread split, mention bump.
  //
  // `displayName` is the channel-name segment used to compare against
  // selectedChannel.channelName (the rendered window's identity, not
  // necessarily the topic's channel param). For channels and query
  // windows it equals the topic's channel param; for the DM-listener
  // loop it equals the sender's nick (the rendered DM window).
  //
  // `ownNick` gates two BUG5b rules:
  //   - Own presence events (join/part/quit/nick_change from own nick)
  //     never bump unread — the operator drove those actions.
  //   - Own PRIVMSGs/ACTIONs already skip via the isSelected check when
  //     sent from the compose box; the DM-listener re-keys them to the
  //     DM window which may not be selected, but own-sent messages in an
  //     unselected window do still bump (correct — the operator changed
  //     windows between sending and receiving the echo).
  const routeMessage = (
    slug: string,
    key: ChannelKey,
    displayName: string,
    message: ChannelEvent["message"],
    ownNick: string | null,
  ): void => {
    appendToScrollback(key, message);
    // Message-replay-on-reconnect cluster — track high-water mark per
    // topic so the backfill on the NEXT reconnect knows where to
    // resume. recordSeen is the SAME for live + backfilled rows; the
    // high-water mark is "newest row this client has rendered for the
    // topic", not "newest row read by the user". Placed before all
    // unread/focus logic because the cursor is operational metadata,
    // not user-state.
    //
    // NOTE: the topic key the operator subscribed to is NOT necessarily
    // the same as the routing `key`. The DM-listener handler subscribes
    // to the own-nick topic but re-keys the append to the SENDER's key.
    // For refresh-on-join purposes the topic-of-subscription is what we
    // need, because `refreshScrollback(slug, name)` calls
    // `GET .../channels/<topic-channel>/messages?after=<id>` against
    // the topic the WS uses. The DM-listener installs its own
    // subscription on the own-nick topic — that subscription gets its
    // own resume cursor via the recordSeen call inside
    // installDmListenerHandler (see below), keyed on (slug, ownNick).
    // Per-window query topic subscriptions get their cursor here under
    // routeMessage's `key` (which IS the (slug, peer) topic for query
    // windows in the channels/query loops).
    recordSeen(key, message);
    // Members presence delta (P4-1 Q4) — applyPresenceEvent filters
    // by kind: presence kinds (join/part/quit/nick_change/mode/kick)
    // mutate the per-channel member list; content kinds are no-ops
    // there. Dispatching every event keeps routing local to members.ts.
    applyPresenceEvent(key, message);

    // BUG5b / CP29 R-6: own-action presence events (join/part/quit/
    // nick_change/mode/kick from own nick) must never bump unread — the
    // operator owns those actions and has already seen them. Gate before
    // the isSelected check so own events on both selected and non-
    // selected channels are suppressed. Predicate shared with
    // ScrollbackPane.tsx's in-pane unread-marker filter so the sidebar
    // badge gate and the in-pane marker stay aligned (same single-source
    // pattern as `isOperatorActionEcho`).
    //
    // Post-2026-06-01 (unread-badges-from-cursor cluster, bucket B2):
    // badge counts derive from `(scrollbackByChannel, readCursors,
    // serverSeedCounts)` in `selection.ts` — there are no bump verbs
    // to short-circuit anymore. The own-action gate stays here as the
    // gate for the mention bump path (own /me to a channel that
    // contains your nick mustn't beep / badge yourself) and the early-
    // return short-circuits the dm-listener auto-open logic below.
    if (isOwnPresenceEvent(message, ownNick)) return;

    // Server-numeric-derived NOTICE: routed to the window the operator's
    // own action targeted (e.g. /msg <nick> → ERR_NOSUCHNICK 401, persisted
    // as kind:"notice" with meta.numeric=401). Same "operator owns it"
    // semantics as own-presence above — the operator already saw the
    // action that produced this server reply; surfacing it as unread is
    // a false alert. Predicate shared with ScrollbackPane.tsx so the
    // sidebar badge gate and the in-pane unread-marker stay aligned.
    if (isOperatorActionEcho(message)) return;

    // Mention bump (P4-1) — only PRIVMSGs whose body matches the
    // operator's own nick bump the red mention badge.
    //
    // Mentions stay incrementally tracked because they're body-text
    // predicate (not pure count-after-cursor); the bump path here gates
    // on `effectivelyFocused` so tabbing into the channel clears the
    // count and incoming mentions on the open+focused channel don't
    // double-signal (the line itself gets .scrollback-mention
    // highlight). A selected-but-blurred window still bumps mentions —
    // the user IS away.
    //
    // 2026-06-01 (unread-badges-from-cursor cluster): the own-sender
    // gate ALSO guards the bump now. Pre-cluster, an own /msg sent
    // from another device (same user, second cic session) would arrive
    // here, match `mentionsUser` (your own nick in the body), and bump
    // mentions on YOUR OWN echo. Symmetric with the cross-session own-
    // message bump bug the cluster's whole point is to fix.
    //
    // UX-6-L (2026-05-20): same gate fires the in-app beep — the
    // foreground alert path complements the SW's visibility-anywhere
    // OS-notification suppression (`lib/pushDedup.ts`).
    if (
      message.kind === "privmsg" &&
      !effectivelyFocused(slug, displayName) &&
      !nickEquals(message.sender, ownNick)
    ) {
      const u = untrack(user);
      // #211 phase 7 — mention-match on the PER-NETWORK own nick (`ownNick`,
      // already threaded into this handler), NOT the retired identity-wide
      // `displayNick(u)` (a visitor has no single nick now). `ownNick` is
      // the credential nick for this network — the correct "is this a
      // mention of ME here" key. Guard on `u` so a not-yet-loaded /me still
      // skips (same as before).
      if (u && ownNick != null && mentionsUser(message.body, ownNick)) {
        bumpMention(key);
        playBeep();
        // PWA icon badge: optimistic foreground bump so the desktop
        // `document.title` moves the instant a notify-worthy MENTION
        // lands on an unfocused window — before any read-cursor settle
        // round-trips to the server. This reuses the same focus +
        // own-echo gating as the mention badge above. Scope note: this
        // covers the channel-mention case (the default-prefs notify
        // trigger); non-mention triggers (channel-all / DM-all /
        // whitelist) are NOT bumped optimistically — they surface on the
        // next server sync (`read_cursor_set` / `/me`). cic has no global
        // notification-prefs signal, so the full `shouldNotify` predicate
        // (`pushTriggers.ts`, the parity-locked mirror) can't run here
        // yet; the count is server-authoritative regardless, so any
        // transient under-count self-heals on the next sync.
        incrementBadge();
      }
    }
  };

  // Handler for channel-shape topics (real IRC channels + query
  // windows). Topic/modes events seed their respective stores; message
  // events route through `routeMessage` with key = channelKey(slug, name).
  // The C4.1 "auto-open on PRIVMSG to own nick" arm has migrated to
  // the dedicated DM-listener handler — this handler is now purely
  // about its own topic.
  //
  // #200 (2026-07-11): self-JOIN auto-focus is NO LONGER handled here.
  // Focus is per-device, originated at the issuing boundary (compose.ts
  // `/join`, HomePane featured link, ScrollbackPane invite CTA). The
  // per-channel handler must not originate selection — see the message
  // arm below for the full rationale (it's what makes the own-PART
  // teardown safe).
  //
  // BUG5a: self-PART windowState projection. When `message.kind === "part"`
  // and `sender === ownNick`, call `setParted(key)` so the windowState map
  // drops the entry (absence is the projection per CP15 B5). Window
  // dismissal — picking the next focused window — is owned by the UX-4-E
  // close-watcher in `selection.ts:317`: own-PART → `channels_changed`
  // broadcast → `channelsBySlug` drops the channel → close-watcher fires
  // its MRU/server/home picker for the focused-channel case. #200 also
  // tears down the per-channel WS subscription on own-PART (see below).
  const installChannelHandler = (
    phx: Channel,
    slug: string,
    name: string,
    key: ChannelKey,
    ownNick: string | null,
  ) => {
    phx.on("event", (raw: unknown) => {
      // #159 E2E gap seam — a test may silence live delivery for THIS
      // per-channel topic (keyed on `key`) while the socket and every
      // OTHER channel stay live, to reproduce the socket-stays-open
      // per-channel delivery gap that `__cic_dropSocketForTests` cannot
      // (that drops the WHOLE socket, so every channel auto-rejoins and
      // heals via join-ok). The activation/visibility/reconnect freshness
      // re-fetch is the only recovery for this gap class. `suppressedDeliveryKeys`
      // is empty in production — the branch is a dead no-op there.
      if (suppressedDeliveryKeys.has(key)) return;
      // Bucket G H4+U3: runtime narrowing at the WS edge — same
      // boundary-validation pattern as `userTopic.ts`'s
      // `narrowUserEvent` (CP16-era cic M1). phoenix.js types the
      // event payload as JSON-shaped `unknown`; pre-fix this site
      // cast to `WireChannelEvent` directly, which is a *lie* (no
      // runtime enforcement). Malformed payloads (kind valid but a
      // required field missing/wrong-typed) would either crash a
      // setter (`seedTopic(key, undefined)`) or silently corrupt
      // store state. The narrower returns null on any shape
      // mismatch; we drop + log so the operator can investigate
      // without crashing the WS handler.
      const payload = narrowChannelEvent(raw);
      if (payload === null) {
        console.warn("[subscribe] dropped malformed channel payload", raw);
        return;
      }
      // Codebase audit cic M2 — exhaustive switch + `assertNever`
      // mirrors userTopic.ts CP16 B5 pattern. Pre-fix: the handler used
      // an if-else chain ending in `if (payload.kind !== "message")
      // return;` — any new arm added to `WireChannelEvent` (e.g. a
      // future `topic_unset` or `members_delta`) silently dropped at
      // runtime because the catch-all guard didn't surface the new
      // kind. The switch + `assertNever` makes that a `tsc` compile
      // error: the default arm narrows to `never`, so an unhandled
      // kind widens the parameter type and the build fails before the
      // silent drop ships. Note: `mentions_bundle` / `away_confirmed`
      // cited in the audit row are NOT channel-topic events — they
      // fan out on `Topic.user/1` (server.ex:1852, 2190) and are
      // handled by userTopic.ts. Adding them here would be wrong.
      switch (payload.kind) {
        case "topic_changed":
          seedTopic(key, payload.topic);
          return;
        case "channel_modes_changed":
          seedModes(key, payload.modes);
          return;
        case "isupport_changed":
          // #216 — per-network ISUPPORT capability set. Rides the
          // per-channel cold-WS-subscribe snapshot (the always-on-session
          // path: the live 005 fired long before this client subscribed).
          // Seed the same store userTopic.ts's live arm feeds — keyed by
          // network id, last-write-wins idempotent.
          seedIsupport(payload.network_id, {
            chanmodes: {
              a: payload.chanmodes_a,
              b: payload.chanmodes_b,
              c: payload.chanmodes_c,
              d: payload.chanmodes_d,
            },
            prefix: payload.prefix,
          });
          return;
        // UX-5 BJ (2026-05-19) — recognized-but-ignored. JoinBanner was
        // the only consumer; killed in BJ. Server still emits per-channel
        // on every 329 RPL_CREATIONTIME. Explicit no-op keeps the
        // exhaustive switch + assertNever discipline and prevents the
        // narrower's default-null arm from logging dropped-payload on
        // every JOIN. Server-side reaping is a separate decision.
        case "channel_created":
          return;
        case "members_seeded":
          // Server's 366 RPL_ENDOFNAMES landed and the broadcast carries
          // the full sorted members snapshot. Seed directly — no second
          // fetch needed. Eliminates the WS-subscribed-but-no-fetch-yet
          // race window that an HTTP re-fetch would still be vulnerable
          // to.
          seedMembers(key, payload.members);
          return;
        // CP15 B5: typed window-state events. Same install site as
        // members_seeded so cic flips the rendered window state without
        // polling. setJoined clears any prior failure/kicked metadata
        // for the key so a successful re-join doesn't carry stale
        // by/reason/numeric in the maps.
        //
        // F1 (visitor-parity-and-nickserv 2026-05-15) — live broadcast
        // edge moved to `Topic.user/1` to close the
        // subscribe-then-broadcast race. The per-channel arms below
        // remain the dispatch path for the cold-WS-reconnect snapshot
        // (`push_window_state_if_known/4` pushes via `push(socket,
        // "event", payload)` directly on this channel's socket — no
        // broadcast). Both paths flow through the same setters; both
        // are last-write-wins idempotent so user-topic + per-channel-
        // snapshot dual-arrival on cold reconnect is safe.
        case "joined":
          setJoined(key);
          return;
        case "join_failed":
          setFailed(key, payload.reason, payload.numeric);
          return;
        case "kicked":
          setKicked(key, payload.by, payload.reason);
          return;
        // Cross-device cursor sync. Server emits on every successful
        // `Grappa.ReadCursor.set/4`; route into the signal-map applier.
        case "read_cursor_set":
          applyReadCursorSet(slug, name, payload.last_read_message_id);
          // PWA icon badge door #3: reading anywhere refreshes the
          // server-authoritative count on this client too.
          setBadge(payload.badge_count);
          return;
        // P-0e + P-0f: invite_ack moved to user-topic; the per-channel
        // arm is gone (and `narrowChannelEvent` no longer narrows the
        // kind so this case is unreachable at the type level).
        case "message": {
          const { message } = payload;

          // #200 (2026-07-11): self-JOIN auto-focus is NO LONGER driven
          // from the per-channel WS handler. Pre-#200 an own-nick JOIN
          // echo here called `setSelectedChannel` (the old "BUG4" path),
          // which entangled focus with per-channel broadcast timing: it
          // (a) forced the S19 own-PART sub-teardown revert (81c0e90a)
          // because a re-JOIN's fresh subscribe raced the JOIN echo and
          // Phoenix doesn't replay to late subscribers, and (b) fanned
          // focus out to EVERY connected device. #200 ruling (b): focus is
          // PER-DEVICE, originated at the issuing boundary — `compose.ts`
          // (`/join`), `HomePane` (featured link), and
          // `ScrollbackPane.handleJoinChannel` (invite CTA) each call
          // `setSelectedChannel` directly. The per-channel handler no
          // longer originates selection; that decoupling is what makes the
          // own-PART teardown below safe.

          // BUG5a: own PART → drop the windowState entry. Selection
          // redirection is owned by the close-watcher in selection.ts
          // (UX-4-E), which fires off the channels_changed broadcast.
          const ownPart = message.kind === "part" && nickEquals(message.sender, ownNick);
          if (ownPart) {
            // CP15 B5: own-PART projects to absence in the windowState
            // map. Server intentionally does NOT broadcast `kind:
            // "parted"` — cic derives the projection here.
            setParted(key);
          }

          routeMessage(slug, key, name, message, ownNick);

          // #200: tear down the per-channel WS subscription on OWN-part.
          // Pre-#200 `joined` was only `.leave()`d on token rotation, so an
          // own-part left the Phoenix Channel + its `phx.on("event", …)`
          // handler alive on the socket forever — a leak that accumulates
          // over an always-on session that joins/parts many channels. Runs
          // AFTER routeMessage so the PART line still lands in scrollback.
          // Only OWN-part (guarded above) tears down — a peer's PART must
          // NOT drop the sub, or we'd blank a channel we're still in. A
          // subsequent re-JOIN re-subscribes fresh via the pending
          // pre-subscribe loop (its `joined.has(key)` guard sees the
          // delete); the race-free user-topic `window_pending` → `joined`
          // chain (userTopic.ts) drives state recovery, and the join-reply
          // `refreshScrollback` backfills the JOIN row — none of which
          // depend on this per-channel subscription surviving the part.
          if (ownPart) {
            joined.get(key)?.leave();
            joined.delete(key);
          }
          return;
        }
        default:
          assertNever(payload);
      }
    });
  };

  // Handler for the per-network DM-listener (own-nick topic). Every
  // PRIVMSG/ACTION arriving here is either:
  //   (a) an INBOUND DM from `payload.message.sender` (the server
  //       persists `PRIVMSG <ownNick> :body` with `channel = ownNick`),
  //   (b) a self-msg echo (operator issued `/msg <ownNick> :body` —
  //       sender = ownNick).
  // Both are handled uniformly: auto-open the sender's query window
  // (idempotent inside queryWindows.ts) and re-key the append to
  // `channelKey(slug, sender)`. Self-msg: sender = ownNick → appends
  // to the own-nick key. Inbound: sender = other → appends to
  // sender's key. Correct for both cases with no special-casing.
  //
  // Non-PRIVMSG/ACTION events on the own-nick topic (NOTICE from
  // services, mode, join, part, etc.) are DROPPED here. They belong
  // in the server-messages window (feature #4, deferred). Silently
  // dropping keeps the own-nick query window clean and avoids
  // polluting any key until the dedicated surface exists.
  const installDmListenerHandler = (
    phx: Channel,
    slug: string,
    networkId: number,
    ownNick: string,
  ) => {
    phx.on("event", (raw: unknown) => {
      // Bucket G H4+U3: same narrower as the channel handler above —
      // see that block for the per-call rationale. The DM-listener
      // shares the same boundary class.
      const payload = narrowChannelEvent(raw);
      if (payload === null) {
        console.warn("[subscribe] dropped malformed DM payload", raw);
        return;
      }
      // Codebase audit cic M2 — exhaustive switch + `assertNever`.
      // The DM-listener intentionally DROPS every non-message kind
      // (topic_changed/channel_modes_changed make no sense on a nick
      // target, and members_seeded / joined / join_failed / kicked
      // belong to feature #4's deferred server-messages window).
      // Switch over EVERY kind makes that intent explicit and forces
      // future arm additions through this site at `tsc` time.
      switch (payload.kind) {
        case "topic_changed":
        case "channel_modes_changed":
        case "isupport_changed":
        case "channel_created":
        case "members_seeded":
        case "joined":
        case "join_failed":
        case "kicked":
          // Defensive drop — server never emits these on a nick target;
          // even if it did, the DM window's surface is not the right
          // place for them.
          return;
        // Cursor for the own-nick query window. Server emits on every
        // `Grappa.ReadCursor.set/4` just like channel topics; route
        // into the signal map keyed on (slug, ownNick).
        case "read_cursor_set":
          applyReadCursorSet(slug, ownNick, payload.last_read_message_id);
          // PWA icon badge door #3 (own-nick query window path).
          setBadge(payload.badge_count);
          return;
        case "message": {
          const message = payload.message;
          if (message.kind === "privmsg" || message.kind === "action") {
            // DM (inbound or self-msg) — auto-open sender's query window
            // and route to sender's scrollback key. For self-msg
            // (sender = ownNick), this lands in the own-nick window;
            // for inbound (sender = other), it lands in sender's window.
            openQueryWindowState(networkId, message.sender, new Date().toISOString());
            const senderKey = channelKey(slug, message.sender);
            // UX-6-L (2026-05-20) — inbound DM is operator-targeted by
            // definition; beep at the call site so routeMessage's
            // signature stays narrow (DM-specific audio policy is a
            // DM-listener concern, not a shared-routing concern).
            // `effectivelyFocused` is the single-source focus predicate
            // (see helper at top of createRoot); anchor on the peer's
            // window name (= message.sender for DMs).
            //
            // sender !== ownNick gate: own self-msg echoes ride this
            // topic too; suppress the audible alert for own typing.
            if (!nickEquals(message.sender, ownNick) && !effectivelyFocused(slug, message.sender)) {
              playBeep();
            }
            routeMessage(slug, senderKey, message.sender, message, ownNick);
            return;
          }
          if (message.kind === "notice" && message.sender !== ownNick) {
            // Peer-to-peer NOTICE on the own-nick topic — i.e. landed at
            // `channel == ownNick` because the sender targeted our nick
            // directly. CP23 cluster `code-reload` shipped the canonical
            // case: the CTCP-VERSION-query visibility row (server-emitted
            // notice with body "CTCP VERSION query → grappa <vsn>"; the
            // CTCP reply itself is also a NOTICE so the inbound-side
            // mirror is genuinely a notice, not a privmsg). Auto-open
            // the sender's query window same as PRIVMSG/ACTION — the
            // operator wants the same backgrounded-window-with-unread
            // for ANY inbound DM-shaped traffic.
            //
            // sender !== ownNick guard: don't auto-open on our OWN
            // outbound NOTICEs (they ride the topic too as fan-out
            // echo). Service-to-self NOTICEs (NickServ etc.) never
            // hit this branch — our server routes those to "$server"
            // not the own-nick channel.
            openQueryWindowState(networkId, message.sender, new Date().toISOString());
            const senderKey = channelKey(slug, message.sender);
            // UX-6-L (2026-05-20): peer NOTICEs are inbound DM-shaped
            // traffic — same beep policy as the PRIVMSG/ACTION arm.
            // The sender !== ownNick check above already gates this
            // branch.
            if (!effectivelyFocused(slug, message.sender)) playBeep();
            routeMessage(slug, senderKey, message.sender, message, ownNick);
            return;
          }
          // mode, join, part, quit, kick, nick_change, topic, etc. on
          // the own-nick topic → deferred to feature #4 (server-messages
          // window). Drop silently for now; server-side scrollback row
          // persists at channel=ownNick and will surface when #4 lands.
          return;
        }
        default:
          assertNever(payload);
      }
    });
  };

  // Narrower for the per-channel join reply (`%{read_cursor:
  // <id_or_nil>, unread_count: <integer>}`). phoenix.js delivers the
  // reply as `unknown`-shaped JSON; same boundary-validation pattern
  // as `narrowChannelEvent`. Returns `{cursor, unreadCount}` with
  // `cursor = null` on missing/invalid shape and `unreadCount = 0`
  // when the field is missing or non-numeric — consumers pass
  // `cursor` to `applyJoinReply` (which no-ops on null) and seed
  // `serverSeedCounts` with `{messages: unreadCount, events: 0}`.
  //
  // 2026-06-01 (unread-badges-from-cursor cluster, bucket B2): added
  // unread_count extraction. The join reply doesn't split
  // content/events — that precision comes from the `/me` envelope
  // (bucket C). Until bucket C lands, the seed treats every unread
  // row as messages (bold badge), which slightly overcounts the
  // events-only case. Bounded — the moment the operator focuses the
  // channel, cic loads scrollback and the local-derived count
  // (split by kind in selection.ts) takes over.
  const narrowJoinReply = (reply: unknown): { cursor: number | null; unreadCount: number } => {
    if (typeof reply !== "object" || reply === null) {
      return { cursor: null, unreadCount: 0 };
    }
    const r = reply as Record<string, unknown>;
    let cursor: number | null = null;
    if (typeof r.read_cursor === "number") {
      cursor = r.read_cursor;
    }
    let unreadCount = 0;
    if (typeof r.unread_count === "number" && r.unread_count >= 0) {
      unreadCount = r.unread_count;
    }
    return { cursor, unreadCount };
  };

  // Single helper called from every per-topic join's reply callback —
  // narrows the reply, applies the cursor to readCursor.ts, AND seeds
  // selection.ts's per-channel server seed count. Keeps the four
  // identical chains (channels, query, dm-listener, server-window) in
  // one place.
  const applyJoinReplyAndSeed = (slug: string, channelName: string, reply: unknown): void => {
    const { cursor, unreadCount } = narrowJoinReply(reply);
    applyJoinReply(slug, channelName, cursor);
    // Always call setServerSeedCount — a 0 seed for a channel with no
    // unread state is informative (it tells the memo "the server says
    // no unread"), and the setter short-circuits on equal-value
    // updates so a 0→0 transition won't re-fire the memo.
    setServerSeedCount(channelKey(slug, channelName), {
      messages: unreadCount,
      events: 0,
    });
  };

  // #79 — stamp the per-real-channel WS-ready e2e seam after a join ACK.
  // Production never reads it; specs await it (waitForChannelReady) so a
  // selectChannel-then-composeSend flow doesn't race the channel-topic
  // subscribe. Sibling of `stampQueryWindowReady` / `__cic_dmListenerReady`:
  // the server fastlanes the channel own-echo (persist_event → per-channel
  // PubSub broadcast, synchronous on POST — server.ex handle_persisting_send)
  // ONLY to sockets already subscribed; PubSub has NO replay to late
  // subscribers. The pre-#79 heuristic (selectChannel awaiting the self-JOIN
  // scrollback line) proved the initial REST /messages page landed, NOT that
  // the channel `phx.join()` ACK'd — the JOIN line is a boot-persisted row
  // served by REST, so it renders before the WS subscribe completes under
  // full-suite load. Key = the module-native `channelKey(slug, name)` so the
  // await rebuilds the identical composite key.
  const stampChannelReady = (key: ChannelKey): void => {
    if (typeof window === "undefined") return;
    const w = window as Window & { __cic_channelReady?: Set<ChannelKey> };
    if (!w.__cic_channelReady) w.__cic_channelReady = new Set();
    w.__cic_channelReady.add(key);
  };

  // Channels loop — one join per real IRC channel in channelsBySlug.
  createEffect(() => {
    // Channel topics are addressed by the server's socket-side
    // user_name (set by UserSocket.assign_subject — `"visitor:<uuid>"`
    // for visitors, `User.name` for users). Read via socketUserName()
    // so the visitor topic prefix matches the server-side
    // GrappaChannel.authorize check; pre-C4 cicchetto sent `user.name`
    // for visitors which the server rejected as forbidden — silent
    // root cause of "no networks sidebar for visitors."
    //
    // Track token() explicitly so identity rotation re-runs the
    // effect (socketUserName itself is sync over localStorage and
    // doesn't track on its own).
    const t = token();
    const cbs = channelsBySlug();
    if (!t) return;
    const name = socketUserName();
    const nets = networks();
    const u = user();
    if (!name || !cbs) return;
    for (const [slug, list] of Object.entries(cbs)) {
      // Resolve own IRC nick for this slug so BUG4/BUG5 handlers can
      // detect self-JOIN/PART events. Single-source via
      // `ownNickForNetwork(net, me)` — see api.ts moduledoc for why
      // displayNick(u) is the WRONG fallback (cic H3 root cause).
      const net = nets?.find((n) => n.slug === slug) ?? null;
      if (net === null) continue;
      const ownNick = ownNickForNetwork(net, u);
      for (const ch of list) {
        const key = channelKey(slug, ch.name);
        if (joined.has(key)) continue;
        const phx = joinChannel(name, slug, ch.name, (reply) => {
          applyJoinReplyAndSeed(slug, ch.name, reply);
          // CP29 R-5: refresh on EVERY successful join (initial + every
          // auto-rejoin). The per-key in-flight guard inside
          // refreshScrollback dedupes bursty rejoins; the resume-cursor
          // heuristic short-circuits when there's nothing to fetch.
          void refreshScrollback(slug, ch.name);
          // #79: this callback fires on the join ACK (subscribed), NOT the
          // `joined.set(key, phx)` below which fires on join-ATTEMPT. Stamp
          // the ready seam here so waitForChannelReady observes a live
          // subscription, never a merely-issued join.
          stampChannelReady(key);
        });
        installChannelHandler(phx, slug, ch.name, key, ownNick);
        joined.set(key, phx);
      }
    }
  });

  // CP15 B5 fix - pending-channel pre-subscribe loop. Catches the race
  // where the server broadcasts the typed `joined` event (and the
  // subsequent JOIN presence message + channels_changed heartbeat)
  // BEFORE channels_changed triggers the channelsBySlug refetch +
  // channels-loop join. Phoenix PubSub doesn't replay to late
  // subscribers, so without this loop the JOIN events drop on the
  // floor until the next page reload.
  //
  // setPending fires synchronously from compose.ts on `/join`, so this
  // effect re-runs immediately and joins the per-channel topic
  // (typically before the upstream JOIN echo even lands). When
  // channels_changed later fires + channelsBySlug refetches, the
  // channels-loop sees the key in `joined` and skips the duplicate.
  //
  // Same for any other path that sets state to pending (auto-rejoin
  // after disconnect, etc.) - subscribe lives at the WS-topic boundary,
  // not at the user-action boundary.
  createEffect(() => {
    const t = token();
    const states = windowStateByChannel();
    if (!t) return;
    const name = socketUserName();
    const nets = networks();
    const u = user();
    if (!name || !nets) return;
    for (const [key, state] of Object.entries(states)) {
      // Pre-subscribe on any NOT-JOINED state that has no other live
      // subscription door: "pending" (our own JOIN in flight, CP15 B5)
      // and "invited" (#78 — inbound INVITE to a channel we're not in).
      // Both need the per-channel topic joined here so the JOIN echo /
      // the persisted INVITE row land. ":failed"/":kicked" already had a
      // subscription (they were joined once); they don't reach this loop
      // needing a fresh join.
      if (state !== "pending" && state !== "invited") continue;
      // Codebase audit cic M4 — paired decoder over open-coded
      // `key.indexOf(" ") + key.slice` parsing. The composite-key
      // shape lives in `channelKey.ts`; the decoder is the inverse
      // of `channelKey(slug, name)`. Sidebar.pseudoChannelsForNetwork
      // is the other consumer.
      const decoded = decodeChannelKey(key as ChannelKey);
      if (decoded === null) continue;
      const slug = decoded.slug;
      const channelName = decoded.name;
      const typedKey = channelKey(slug, channelName);
      if (joined.has(typedKey)) continue;
      const net = nets.find((n) => n.slug === slug) ?? null;
      if (net === null) continue;
      const ownNick = ownNickForNetwork(net, u);
      const phx = joinChannel(name, slug, channelName, (reply) => {
        applyJoinReplyAndSeed(slug, channelName, reply);
        void refreshScrollback(slug, channelName);
        // #79: the OTHER channel-topic join path (a mid-session /join goes
        // pending → subscribed HERE → joined, at which point the
        // channels-loop skips it via the `joined` guard and never fires its
        // own ACK). Stamp the ready seam here too so waitForChannelReady
        // works regardless of which loop owned the join. Uniform rule:
        // every channel-topic join ACK stamps `__cic_channelReady`.
        stampChannelReady(typedKey);
      });
      installChannelHandler(phx, slug, channelName, typedKey, ownNick);
      joined.set(typedKey, phx);
    }
  });

  // #254 — stamp the query-window-ready e2e seam after a (slug,target) join
  // ACK. Production never reads it; specs await it (waitForQueryWindowReady)
  // and the subscribe-before-send probe reads it synchronously at POST time.
  const stampQueryWindowReady = (slug: string, target: string): void => {
    if (typeof window === "undefined") return;
    const w = window as Window & { __cic_queryWindowReady?: Set<string> };
    if (!w.__cic_queryWindowReady) w.__cic_queryWindowReady = new Set();
    w.__cic_queryWindowReady.add(`${slug}/${target}`);
  };

  // #254 — subscribe-before-send: join a query peer's (slug,target) topic and
  // resolve on the join ACK. SINGLE source for BOTH the reactive query-windows
  // loop (fire-and-forget) AND compose's `/msg` (awaited) — so the server's
  // own-echo broadcast has a live listener the instant it fires, WITHOUT an
  // optimistic render. Reuses joinChannel + installChannelHandler + the shared
  // `joined` Map (loop and compose dedup against it → no double-join, no second
  // handler on a topic). Own-nick is skipped: the DM-listener loop is the SOLE
  // subscriber for that topic — a channel handler there would route ALL traffic
  // to the own-nick scrollback key, polluting it (the `joined` guard alone is
  // insufficient because effect evaluation order isn't fixed). `queryJoinAcks`
  // coalesces concurrent callers onto ONE ack. Bounded by
  // `ENSURE_JOIN_ACK_TIMEOUT_MS` so a wedged WS (e.g. #193 WS-blocked-but-
  // REST-up) can't hang the send forever — past the cap the send proceeds and
  // the reconnect self-heal (refreshScrollback on the eventual rejoin) recovers
  // the row. Own-nick uses `ownNickForNetwork` (visitor → me.nick; user →
  // per-credential net.nick), never the displayNick fallback (cic H3).
  const ENSURE_JOIN_ACK_TIMEOUT_MS = 4000;
  const ensureQueryTopicJoined = (slug: string, target: string): Promise<void> => {
    const userName = socketUserName();
    const nets = networks();
    const u = user();
    if (!userName || !nets) return Promise.resolve();
    const net = nets.find((n) => n.slug === slug);
    if (!net) return Promise.resolve();
    const ownNick = ownNickForNetwork(net, u);
    if (nickEquals(target, ownNick)) return Promise.resolve();
    const key = channelKey(slug, target);
    const pending = queryJoinAcks.get(key);
    if (pending) return pending;
    if (joined.has(key)) return Promise.resolve();
    const acked = new Promise<void>((resolve) => {
      const phx = joinChannel(userName, slug, target, (reply) => {
        applyJoinReplyAndSeed(slug, target, reply);
        void refreshScrollback(slug, target);
        stampQueryWindowReady(slug, target);
        resolve();
      });
      installChannelHandler(phx, slug, target, key, ownNick);
      joined.set(key, phx);
    });
    const bounded = Promise.race([
      acked,
      new Promise<void>((resolve) => {
        setTimeout(resolve, ENSURE_JOIN_ACK_TIMEOUT_MS);
      }),
    ]);
    queryJoinAcks.set(key, bounded);
    return bounded;
  };
  // Register the real verb so compose.ts (via the queryTopicJoin leaf) can
  // await it without importing this side-effectful module into its unit tests.
  setEnsureQueryTopicJoined(ensureQueryTopicJoined);

  // Query-windows loop — ensure every open query window's (slug,target) topic
  // is joined so outbound `/msg` echoes AND inbound-DM auto-opened windows flow
  // live without a reload. Re-runs when queryWindowsByNetwork changes;
  // `ensureQueryTopicJoined` is idempotent (the `joined` guard makes a
  // re-run a no-op) and skips own-nick internally (the DM-listener loop owns
  // that topic). Fire-and-forget here — the effect only needs the join started.
  createEffect(() => {
    const t = token();
    const qwbn = queryWindowsByNetwork();
    if (!t) return;
    const nets = networks();
    if (!nets) return;
    for (const [networkIdStr, windowsList] of Object.entries(qwbn)) {
      const net = nets.find((n) => n.id === Number(networkIdStr));
      if (!net) continue;
      for (const qw of windowsList) {
        void ensureQueryTopicJoined(net.slug, qw.targetNick);
      }
    }
  });

  // DM-listener loop — one join per network targeting the own-nick
  // topic. Always-on subscription so inbound DMs from any sender
  // (known or first-contact) are captured + auto-opened + re-keyed.
  // Without this, the first inbound from a new sender would land at
  // a topic nobody is subscribed to and be silently dropped.
  //
  // Joined-set key uses the own-nick key for the network so this
  // subscription is deduped against any future code path that joins
  // the same topic.
  //
  // Own-nick per network: single-source via `ownNickForNetwork(net, me)`.
  // The pre-fix fallback to `displayNick(u)` (= user.name) silently
  // subscribed to the WRONG topic when account-name differed from the
  // IRC nick — see api.ts moduledoc + cic H3.
  createEffect(() => {
    const t = token();
    const u = user();
    const nets = networks();
    if (!t) return;
    const userName = socketUserName();
    if (!userName || !u || !nets) return;
    for (const net of nets) {
      const ownNick = ownNickForNetwork(net, u);
      if (!ownNick) continue;
      const key = channelKey(net.slug, ownNick);
      if (joined.has(key)) continue;
      const phx = joinChannel(userName, net.slug, ownNick, (reply) => {
        applyJoinReplyAndSeed(net.slug, ownNick, reply);
        // DM-listener topic refresh: fetches self-msgs only because
        // the controller applies own-nick narrowing when channel ==
        // own_nick (CP14-B3 rule). Inbound peer DMs persist with
        // channel=ownNick AND dm_with=peer; the narrowing filters
        // them out from this fetch by intent (the own-nick query
        // window display would otherwise leak every peer's DMs in).
        // Recovery for inbound peer DMs goes through each open
        // per-peer query window's own refresh — that subscription's
        // rejoin uses the (slug, peer) cursor and the bidirectional
        // DM fetch shape returns BOTH directions. First-contact DMs
        // that arrive during the gap (no per-peer subscription
        // existed yet) are not recovered by this design — deferred
        // edge case, documented here for traceability.
        void refreshScrollback(net.slug, ownNick);
        // UX-6-L e2e seam: stamp the per-slug DM-listener ready set
        // on window after a successful phx.join() ack. Playwright
        // polls `__cic_dmListenerReady?.has(slug)` to await the
        // subscription before driving a peer DM — eliminates the
        // peer-arrives-before-cic-subscribed race (silent broadcast
        // drop) that flaked the ux-6-l e2e ~20% in suite. Production
        // never reads the property; same seam shape as
        // `socket.ts:__cic_dropSocketForTests`. The query-window loop
        // has the SAME no-pre-event-DOM-signal gap (its outbound-echo
        // topic, no self-JOIN line) and carries its own
        // `__cic_queryWindowReady` seam (above); the real-channels loop
        // carries `__cic_channelReady` (stampChannelReady, above) since
        // #79 — the self-JOIN scrollback line is NOT a reliable pre-event
        // signal (it is a boot-persisted row served by the initial REST
        // /messages page, so it renders before the channel `phx.join()`
        // ACKs; the own-echo then fastlanes past the not-yet-subscribed
        // socket and the row never appears). The $server synthetic window
        // is read-only (no compose-then-echo flow) so it needs no seam.
        if (typeof window !== "undefined") {
          const w = window as Window & { __cic_dmListenerReady?: Set<string> };
          if (!w.__cic_dmListenerReady) w.__cic_dmListenerReady = new Set();
          w.__cic_dmListenerReady.add(net.slug);
        }
      });
      installDmListenerHandler(phx, net.slug, net.id, ownNick);
      joined.set(key, phx);
    }
  });

  // BUG2: server-messages loop — one join per network targeting the
  // server-window synthetic channel (SERVER_WINDOW_NAME). The server
  // persists MOTD lines (375/372/376) and server-origin NOTICEs (those
  // addressed to the user's nick, not a channel) to scrollback with
  // channel = SERVER_WINDOW_NAME. Without this subscription, Cicchetto
  // would never receive those events and the :server window stays empty
  // forever.
  //
  // Uses `installChannelHandler` with ownNick=null — no self-JOIN/PART can
  // arrive on this topic, so BUG4/5 detection is intentionally
  // disabled. The cic-side literal lives in windowKinds.ts as a single
  // source matching how the server persists and broadcasts these rows.
  createEffect(() => {
    const t = token();
    const nets = networks();
    if (!t) return;
    const userName = socketUserName();
    if (!userName || !nets) return;
    for (const net of nets) {
      const key = channelKey(net.slug, SERVER_WINDOW_NAME);
      if (joined.has(key)) continue;
      const phx = joinChannel(userName, net.slug, SERVER_WINDOW_NAME, (reply) => {
        applyJoinReplyAndSeed(net.slug, SERVER_WINDOW_NAME, reply);
        void refreshScrollback(net.slug, SERVER_WINDOW_NAME);
      });
      installChannelHandler(phx, net.slug, SERVER_WINDOW_NAME, key, null);
      joined.set(key, phx);
    }
  });

  // Message-replay-on-reconnect cluster bonus — defensive resync on
  // socket-open transitions. Refetches `networks` + `channelsBySlug`
  // so the channels-loop createEffect re-runs against fresh server
  // state. Catches the gap class where:
  //
  //   1. Cic boots, loads channelsBySlug = [#a, #b].
  //   2. Operator joins #c via slash command from another grappa
  //      session OR via a fresh tab; server broadcasts
  //      `channels_changed` on the user-topic — but cic's WS is
  //      mid-reconnect and the broadcast is best-effort fan-out (no
  //      live subscriber).
  //   3. Cic reconnects; phoenix.js auto-rejoins user-topic +
  //      already-known channel topics. #c is NOT in cic's
  //      `channelsBySlug` snapshot (the channels_changed broadcast
  //      that would have triggered refetchChannels() was dropped),
  //      so the channels-loop never iterates over #c, never joins
  //      its topic, never receives any of #c's traffic.
  //   4. Operator sends from #c; cic shows nothing.
  //
  // The defensive refetch on every reconnect-induced socket-open
  // event closes the gap. It is REDUNDANT with `channels_changed`
  // for live operation (the broadcast handles changes during the
  // session); it is the only safety net for the disconnect window.
  //
  // Mirror reasoning for `networks` — operators rarely add networks
  // mid-session but the cost of refetch is one HTTP request and the
  // alternative is silent absence.
  //
  // The `prev` filter masks the initial open transition (createEffect
  // fires once at registration with prev=undefined; the bootstrap path
  // already triggered the resource fetch). Only the
  // post-disconnect transitions ("error" → "open" or "connecting" →
  // "open") trigger the refetch — the steady-state "open" → "open"
  // arm is a no-op.
  createEffect(
    on(
      () => socketHealth().state,
      (state, prev) => {
        if (prev === undefined) return;
        if (state !== "open") return;
        // Transition into "open" from any non-open state means the
        // socket re-established. Force-refresh so the channels-loop
        // re-iterates with fresh server-side truth.
        refetchNetworks();
        refetchChannels();
        // #159 item 3 — cic-driven reconnect catch-up. The refetch above
        // only re-runs the channels-loop, which SKIPS every key already in
        // `joined` (`joined.has(key) continue`), so a channel that was
        // subscribed before the drop is backfilled ONLY if phoenix.js's
        // auto-rejoin re-fires that channel's join "ok" recHook. A rejoin
        // that never reaches "ok" (wedged `errored`/`joining`, or a
        // per-channel fan-out severed without a socket close) leaves the
        // gap unhealed until a full reload. Drive `refreshScrollback` for
        // EVERY already-joined key directly so reconnect recovery no
        // longer depends on the per-channel rejoin completing. The verb's
        // per-key in-flight guard + id-dedupe make it safe to overlap with
        // a rejoin's own join-ok refresh.
        for (const joinedKey of joined.keys()) {
          const decoded = decodeChannelKey(joinedKey);
          if (decoded !== null) {
            void refreshScrollback(decoded.slug, decoded.name);
          }
        }
      },
    ),
  );

  // #200 e2e seam — expose the LIVE set of per-channel WS subscription
  // keys so a Playwright spec can assert own-PART tears the subscription
  // down (the leak fix). A getter over the real `joined` Map (not a
  // mirrored Set) so it can never drift from the actual bookkeeping.
  // Production never reads it; same window-seam convention as
  // `__cic_dmListenerReady` and `__cic_suppressChannelDeliveryForTests`.
  if (typeof window !== "undefined") {
    window.__cic_joinedTopicKeys = () => Array.from(joined.keys());
  }
});

// #159 E2E hook — silence live `phx.on("event")` delivery for a SINGLE
// per-channel topic while the socket and every OTHER channel stay live.
// Sibling to `__cic_dropSocketForTests` (socket.ts), but for the
// socket-STAYS-open per-channel gap class the socket-drop hook can't
// reproduce (a drop rejoins every channel and heals via join-ok). Lets
// a Playwright spec prove that activation/visibility/reconnect freshness
// re-fetch — NOT a socket rejoin — closes the gap. Production never
// calls these, so `suppressedDeliveryKeys` stays empty.
declare global {
  interface Window {
    __cic_suppressChannelDeliveryForTests?: (slug: string, name: string) => void;
    __cic_resumeChannelDeliveryForTests?: (slug: string, name: string) => void;
    // #200 e2e seam — live per-channel WS subscription keys (see the
    // getter installed inside the createRoot above).
    __cic_joinedTopicKeys?: () => string[];
  }
}

if (typeof window !== "undefined") {
  window.__cic_suppressChannelDeliveryForTests = (slug, name) => {
    suppressedDeliveryKeys.add(channelKey(slug, name));
  };
  window.__cic_resumeChannelDeliveryForTests = (slug, name) => {
    suppressedDeliveryKeys.delete(channelKey(slug, name));
  };
}
