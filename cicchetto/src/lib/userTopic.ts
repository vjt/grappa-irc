import { createEffect, createRoot } from "solid-js";
import { token } from "./auth";
import { refetchChannels, user } from "./networks";
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

  createEffect(() => {
    // Track the bearer + user identity; on rotation Solid re-runs this
    // effect against fresh resources.
    const t = token();
    const u = user();
    if (!t || !u) return;
    if (joined) return;
    joined = true;

    const channel = joinUser(u.name);
    channel.on("event", (payload: { kind?: string }) => {
      if (payload.kind === "channels_changed") {
        refetchChannels();
      }
    });
  });
});
