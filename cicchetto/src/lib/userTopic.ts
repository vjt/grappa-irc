import { createEffect, createRoot } from "solid-js";
import { socketUserName, token } from "./auth";
import { refetchChannels } from "./networks";
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
// Identity-scoped: re-evaluates when `user()` resolves under a fresh
// bearer. The Phoenix Channel handle is per-tab and persists across
// `user()` rotations through the Socket's connect/disconnect lifecycle
// in socket.ts; we don't need a `leave()` arm here.

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
    channel.on("event", (payload: { kind?: string }) => {
      if (payload.kind === "channels_changed") {
        refetchChannels();
      }
    });
  });
});
