import { createEffect, createRoot, untrack } from "solid-js";
import type { NumericRouted } from "./api";
import { socketUserName, token } from "./auth";
import { channelKey } from "./channelKey";
import { setMentionsBundle } from "./mentionsWindow";
import { channelsBySlug, refetchChannels } from "./networks";
import { appendNumericInline } from "./numericInline";
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
// C1.3: also handles `query_windows_list` push. The server sends string
// map keys (JSON objects always have string keys) and snake_case field
// names; we coerce to integer keys + camelCase before storing.
//
// C5.2: handles `numeric_routed` push. Routes the numeric line to the
// per-window numericInline store keyed by window identity. Routing:
//   - "active" or "server" → active window (selectedChannel). "server"
//     falls back to active because the server-messages window isn't
//     implemented yet (flagged as spec gap).
//   - "channel" → channelKey(slug, target). Network slug is resolved by
//     searching channelsBySlug() for the first network containing that
//     channel (heuristic; gaps in multi-network same-channel covered by
//     falling back to the active window if no match found).
//   - "query" → channelKey(slug, target) using the same slug heuristic.
//   - "list" / "mentions" → active window (pseudo-windows not yet live).
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

// Resolve the window key string for a `numeric_routed` event.
// `selectedChannel()` is read with `untrack` so this function doesn't
// create reactive dependencies in the event handler call site.
function resolveNumericWindowKey(event: NumericRouted): string {
  const sel = untrack(selectedChannel);
  const activeKey = sel !== null ? channelKey(sel.networkSlug, sel.channelName) : "active";

  const { kind, target } = event.target_window;

  // "active" → whatever window is focused.
  // "server" → fallback to active (server-messages window not yet live).
  // "list" / "mentions" → pseudo-windows not yet live; fall back to active.
  if (kind === "active" || kind === "server" || kind === "list" || kind === "mentions") {
    return activeKey;
  }

  // "channel" / "query" → find the network slug by searching channelsBySlug.
  if ((kind === "channel" || kind === "query") && target !== null) {
    const cbs = untrack(channelsBySlug);
    if (cbs) {
      for (const [slug, channels] of Object.entries(cbs)) {
        const lowerTarget = target.toLowerCase();
        if (channels.some((ch) => ch.name.toLowerCase() === lowerTarget)) {
          return channelKey(slug, target);
        }
      }
    }
    // No match found — fall back to active window.
    return activeKey;
  }

  return activeKey;
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
      } else if (payload.kind === "numeric_routed") {
        // C5.2 — route numeric feedback to the correct window's inline store.
        const event = payload as unknown as NumericRouted;
        const windowKey = resolveNumericWindowKey(event);
        const text = event.trailing ?? `[${event.numeric}]`;
        appendNumericInline(windowKey, {
          numeric: event.numeric,
          text,
          severity: event.severity,
        });
      }
    });
  });
});
