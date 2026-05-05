import { createEffect, createRoot, on, untrack } from "solid-js";
import { type ChannelEvent, displayNick } from "./api";
import { socketUserName, token } from "./auth";
import { type ChannelKey, channelKey } from "./channelKey";
import { type ModesEntry, seedModes, seedTopic, type TopicEntry } from "./channelTopic";
import { applyPresenceEvent } from "./members";
import { mentionsUser } from "./mentionMatch";
import { bumpMention } from "./mentions";
import { channelsBySlug, user } from "./networks";
import { appendToScrollback } from "./scrollback";
import { bumpUnread, selectedChannel } from "./selection";
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
//   * The createEffect that fires once `user()` + `channelsBySlug()`
//     resolve, fans out `joinChannel(...)` per channel, installs an
//     `"event"` handler that ingests messages into `scrollback` and
//     bumps `selection.unreadCounts` when the channel is not the
//     currently-selected one. Selection is read with `untrack` so the
//     join effect itself isn't reactive to selection changes
//     (joining is one-shot per channel; selection is high-frequency).
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
// C3.1: `topic_changed` and `channel_modes_changed` events are now
// routed to `channelTopic.seedTopic` / `channelTopic.seedModes` so
// TopicBar can display live topic + modes without a REST round-trip.
//
// C3.2: JOIN-by-self detection: `message.kind === "join"` events whose
// `sender` matches own nick are forwarded to `joinEvents.notifyJoin`
// so ScrollbackPane can render the one-time join banner.

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
        phx.on("event", (payload: WireEvent) => {
          // Topic cache update (C3.1) — seed the topic store so TopicBar
          // always reflects the latest cached topic without a REST round-trip.
          if (payload.kind === "topic_changed") {
            seedTopic(key, payload.topic);
            return;
          }
          // Channel-modes cache update (C3.1) — feed the modes store so
          // TopicBar renders the compact mode-string live.
          if (payload.kind === "channel_modes_changed") {
            seedModes(key, payload.modes);
            return;
          }
          if (payload.kind !== "message") return;
          // Scrollback ingestion — every message kind appended.
          appendToScrollback(key, payload.message);
          // Members presence delta (P4-1 Q4) — applyPresenceEvent
          // filters by kind: presence kinds (join/part/quit/nick_change/
          // mode/kick) mutate the per-channel member list; content kinds
          // (privmsg/notice/action/topic) are no-ops there. Dispatching
          // every event keeps the routing logic local to members.ts.
          applyPresenceEvent(key, payload.message);
          const sel = untrack(selectedChannel);
          const isSelected =
            sel !== null && sel.networkSlug === slug && sel.channelName === ch.name;
          if (isSelected) return;
          bumpUnread(key);
          // Mention bump (P4-1) — only PRIVMSGs whose body matches the
          // operator's own nick bump the red mention badge. Gated on
          // !isSelected so that tabbing INTO a channel clears the count
          // (selection.bumpMention's selectedChannel-cleared effect)
          // and incoming mentions on the OPEN channel don't double-
          // signal (the line itself gets .scrollback-mention highlight).
          if (payload.message.kind === "privmsg") {
            const u = untrack(user);
            if (u && mentionsUser(payload.message.body, displayNick(u))) {
              bumpMention(key);
            }
          }
        });
        joined.add(key);
      }
    }
  });
});
