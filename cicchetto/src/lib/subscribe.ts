import type { Channel } from "phoenix";
import { createEffect, createRoot, on, untrack } from "solid-js";
import { type ChannelEvent, displayNick } from "./api";
import { socketUserName, token } from "./auth";
import { type ChannelKey, channelKey } from "./channelKey";
import { type ModesEntry, seedModes, seedTopic, type TopicEntry } from "./channelTopic";
import { applyPresenceEvent } from "./members";
import { mentionsUser } from "./mentionMatch";
import { bumpMention } from "./mentions";
import { channelsBySlug, networks, user } from "./networks";
import { openQueryWindowState, queryWindowsByNetwork } from "./queryWindows";
import { appendToScrollback } from "./scrollback";
import { bumpEventUnread, bumpMessageUnread, bumpUnread, selectedChannel } from "./selection";
import { joinChannel } from "./socket";

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

// Full union of event payloads pushed by GrappaChannel on the
// per-channel Phoenix topic. `kind` is the discriminator.
type WireEvent =
  | ChannelEvent
  | { kind: "topic_changed"; network: string; channel: string; topic: TopicEntry }
  | { kind: "channel_modes_changed"; network: string; channel: string; modes: ModesEntry };

createRoot(() => {
  const joined = new Set<ChannelKey>();

  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) {
        joined.clear();
      }
    }),
  );

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
  const routeMessage = (
    slug: string,
    key: ChannelKey,
    displayName: string,
    message: ChannelEvent["message"],
  ): void => {
    appendToScrollback(key, message);
    // Members presence delta (P4-1 Q4) — applyPresenceEvent filters
    // by kind: presence kinds (join/part/quit/nick_change/mode/kick)
    // mutate the per-channel member list; content kinds are no-ops
    // there. Dispatching every event keeps routing local to members.ts.
    applyPresenceEvent(key, message);
    const sel = untrack(selectedChannel);
    const isSelected = sel !== null && sel.networkSlug === slug && sel.channelName === displayName;
    if (isSelected) return;
    bumpUnread(key);
    // C7.5: per-kind split counters. Content kinds bump messagesUnread
    // (bold badge); presence kinds bump eventsUnread (dimmer indicator).
    if (message.kind === "privmsg" || message.kind === "notice" || message.kind === "action") {
      bumpMessageUnread(key);
    } else {
      bumpEventUnread(key);
    }
    // Mention bump (P4-1) — only PRIVMSGs whose body matches the
    // operator's own nick bump the red mention badge. Gated on
    // !isSelected so tabbing into the channel clears the count and
    // incoming mentions on the OPEN channel don't double-signal (the
    // line itself gets .scrollback-mention highlight).
    if (message.kind === "privmsg") {
      const u = untrack(user);
      if (u && mentionsUser(message.body, displayNick(u))) {
        bumpMention(key);
      }
    }
  };

  // Handler for channel-shape topics (real IRC channels + query
  // windows). Topic/modes events seed their respective stores; message
  // events route through `routeMessage` with key = channelKey(slug, name).
  // The C4.1 "auto-open on PRIVMSG to own nick" arm has migrated to
  // the dedicated DM-listener handler — this handler is now purely
  // about its own topic.
  const installChannelHandler = (phx: Channel, slug: string, name: string, key: ChannelKey) => {
    phx.on("event", (payload: WireEvent) => {
      if (payload.kind === "topic_changed") {
        seedTopic(key, payload.topic);
        return;
      }
      if (payload.kind === "channel_modes_changed") {
        seedModes(key, payload.modes);
        return;
      }
      if (payload.kind !== "message") return;
      routeMessage(slug, key, name, payload.message);
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
    _ownNick: string,
  ) => {
    phx.on("event", (payload: WireEvent) => {
      if (payload.kind === "topic_changed" || payload.kind === "channel_modes_changed") {
        // Topic / modes on the own-nick "channel" make no sense — the
        // server never emits these for a nick target. Defensive drop.
        return;
      }
      if (payload.kind !== "message") return;
      const message = payload.message;
      if (message.kind === "privmsg" || message.kind === "action") {
        // DM (inbound or self-msg) — auto-open sender's query window
        // and route to sender's scrollback key. For self-msg
        // (sender = ownNick), this lands in the own-nick window;
        // for inbound (sender = other), it lands in sender's window.
        openQueryWindowState(networkId, message.sender, new Date().toISOString());
        const senderKey = channelKey(slug, message.sender);
        routeMessage(slug, senderKey, message.sender, message);
        return;
      }
      // NOTICE, mode, join, part, quit, kick, nick_change, topic, etc.
      // on the own-nick topic → deferred to feature #4 (server-messages
      // window). Drop silently for now; server-side scrollback row
      // persists at channel=ownNick and will surface when #4 lands.
    });
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
    if (!name || !cbs) return;
    for (const [slug, list] of Object.entries(cbs)) {
      for (const ch of list) {
        const key = channelKey(slug, ch.name);
        if (joined.has(key)) continue;
        const phx = joinChannel(name, slug, ch.name);
        installChannelHandler(phx, slug, ch.name, key);
        joined.add(key);
      }
    }
  });

  // Query-windows loop — one join per (networkId, targetNick) tuple in
  // queryWindowsByNetwork. Catches outbound DM echoes (the server
  // broadcasts the operator's own `/msg <target> body` on the
  // (slug, target) topic). When the auto-open from the DM-listener
  // adds a new entry, this effect re-runs and joins the new topic so
  // ongoing exchanges flow without a reload.
  //
  // IMPORTANT: skip targetNick == ownNick. The dm-listener loop is the
  // SOLE handler for the own-nick topic — installing an extra channel-
  // handler there would route ALL traffic (NOTICEs, presence events,
  // etc.) to the own-nick scrollback key, polluting it. The `joined`
  // Set deduplication alone is insufficient because whichever loop runs
  // first installs its handler; this explicit skip guarantees the
  // dm-listener handler wins regardless of effect evaluation order.
  createEffect(() => {
    const t = token();
    const qwbn = queryWindowsByNetwork();
    if (!t) return;
    const userName = socketUserName();
    const nets = networks();
    const u = user();
    if (!userName || !nets) return;
    const ownNick = u ? displayNick(u) : null;
    for (const [networkIdStr, windowsList] of Object.entries(qwbn)) {
      const networkId = Number(networkIdStr);
      const net = nets.find((n) => n.id === networkId);
      if (!net) continue;
      for (const qw of windowsList) {
        // Skip own-nick — the dm-listener loop is the sole subscriber
        // for that topic and installs the correct re-keying handler.
        if (ownNick && qw.targetNick.toLowerCase() === ownNick.toLowerCase()) continue;
        const key = channelKey(net.slug, qw.targetNick);
        if (joined.has(key)) continue;
        const phx = joinChannel(userName, net.slug, qw.targetNick);
        installChannelHandler(phx, net.slug, qw.targetNick, key);
        joined.add(key);
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
  createEffect(() => {
    const t = token();
    const u = user();
    const nets = networks();
    if (!t) return;
    const userName = socketUserName();
    if (!userName || !u || !nets) return;
    const ownNick = displayNick(u);
    if (!ownNick) return;
    for (const net of nets) {
      const key = channelKey(net.slug, ownNick);
      if (joined.has(key)) continue;
      const phx = joinChannel(userName, net.slug, ownNick);
      installDmListenerHandler(phx, net.slug, net.id, ownNick);
      joined.add(key);
    }
  });
});
