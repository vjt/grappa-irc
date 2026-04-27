import { createEffect, createRoot, createSignal, on } from "solid-js";
import { sendMessage as apiSendMessage, listMessages, type ScrollbackMessage } from "./api";
import { token } from "./auth";
import { type ChannelKey, channelKey } from "./channelKey";

// Per-channel scrollback store: the source of truth for messages
// rendered in `ScrollbackPane`. Module-singleton signal store mirroring
// `auth.ts` / `socket.ts`; one fine-grained subscription per consumer,
// no provider boilerplate.
//
// Lifted out of the original `networks.ts` god-module per A4. Owns:
//   * `scrollbackByChannel` — the signal map keyed on `ChannelKey`.
//   * `loadedChannels` — a Set guarding the load-once REST gate.
//   * Verbs `loadInitialScrollback`, `loadMore`, `sendMessage`.
//   * The cross-module ingestion verb `appendToScrollback` consumed by
//     `subscribe.ts` (the WS event handler) — public so the producer
//     can mutate the signal without re-importing the setter.
//
// Scrollback ordering: stored ASCENDING by `server_time` so `<For>`
// keys (message id) stay stable and render is natural top-to-bottom.
// REST returns DESC; we reverse on ingestion. WS appends arrive
// newest-last and append to the tail. Dedupe by `id` because the REST
// initial-load and the WS broadcast for a recently-sent message can
// overlap in a small race window — the same row would otherwise
// appear twice. `id` is monotonic per the schema's auto-increment column.
//
// Identity-scoped state: `loadedChannels` and the contents of
// `scrollbackByChannel` are scoped to the *current* bearer. Logout or
// rotation MUST clear them so a new identity gets a fresh re-load and
// no cross-tenant leak (key shape `${slug} ${name}` is user-agnostic).
// The on(token) cleanup arm registered first, before any verb fires,
// mirrors the A1 pattern propagated across all post-A4 stores.

const exports = createRoot(() => {
  const loadedChannels = new Set<ChannelKey>();
  const [scrollbackByChannel, setScrollbackByChannel] = createSignal<
    Record<ChannelKey, ScrollbackMessage[]>
  >({});

  // Identity-transition cleanup. `prev != null` filters BOTH the
  // initial run (prev === undefined) and the cold-start login
  // (prev === null) via the loose-equality `!= null` idiom — both
  // are no-ops for cleanup. The two transitions that DO need cleanup:
  //   - logout: prev = "tokA", t = null
  //   - rotation: prev = "tokA", t = "tokB"
  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) {
        loadedChannels.clear();
        setScrollbackByChannel({});
      }
    }),
  );

  // Insert an incoming message into the per-channel ascending list,
  // deduping by id. REST + WS can overlap: the row inserted by POST
  // arrives both as the HTTP 201 body (we ignore that body) and as a
  // WS push from the per-channel PubSub broadcast. Both paths route
  // through here; whichever lands first wins, the second is dropped.
  const appendToScrollback = (key: ChannelKey, msg: ScrollbackMessage) => {
    setScrollbackByChannel((prev) => {
      const existing = prev[key];
      if (existing?.some((m) => m.id === msg.id)) return prev;
      const next = existing ? [...existing, msg] : [msg];
      return { ...prev, [key]: next };
    });
  };

  // Merge a freshly-fetched REST page into the per-channel list. Server
  // returns DESC; we reverse to ASC then dedupe + sort. Used by both
  // initial-load (replaces the empty seed) and load-more (prepends
  // older history to the head).
  const mergeIntoScrollback = (key: ChannelKey, page: ScrollbackMessage[]) => {
    setScrollbackByChannel((prev) => {
      const existing = prev[key] ?? [];
      const ids = new Set(existing.map((m) => m.id));
      const fresh = page.filter((m) => !ids.has(m.id));
      if (fresh.length === 0) return prev;
      const merged = [...existing, ...fresh].sort((a, b) => a.server_time - b.server_time);
      return { ...prev, [key]: merged };
    });
  };

  const loadInitialScrollback = async (slug: string, name: string): Promise<void> => {
    const t = token();
    if (!t) return;
    const key = channelKey(slug, name);
    if (loadedChannels.has(key)) return;
    loadedChannels.add(key);
    // Seed an empty list so the pane renders immediately while the
    // REST page is in flight; WS events arriving in the meantime
    // append to this seed via `appendToScrollback`.
    setScrollbackByChannel((prev) => (key in prev ? prev : { ...prev, [key]: [] }));
    try {
      const page = await listMessages(t, slug, name);
      mergeIntoScrollback(key, page);
    } catch {
      // First-load failure leaves the empty seed in place; the pane
      // shows "no messages yet". A retry mechanism is Phase 5+.
      loadedChannels.delete(key);
    }
  };

  const loadMore = async (slug: string, name: string): Promise<void> => {
    const t = token();
    if (!t) return;
    const key = channelKey(slug, name);
    const current = scrollbackByChannel()[key];
    if (!current || current.length === 0) return;
    const oldest = current[0];
    if (!oldest) return;
    try {
      const page = await listMessages(t, slug, name, oldest.server_time);
      mergeIntoScrollback(key, page);
    } catch {
      // No-op for walking skeleton; user can retry by scrolling again.
    }
  };

  const sendMessage = async (slug: string, name: string, body: string): Promise<void> => {
    const t = token();
    if (!t) return;
    // Server persists+broadcasts atomically — the WS push will deliver
    // the same row to this socket and `appendToScrollback` will display
    // it. We don't read the 201 body to avoid double-rendering on the
    // race where WS lands first.
    await apiSendMessage(t, slug, name, body);
  };

  return {
    scrollbackByChannel,
    appendToScrollback,
    loadInitialScrollback,
    loadMore,
    sendMessage,
  };
});

export const scrollbackByChannel = exports.scrollbackByChannel;
export const appendToScrollback = exports.appendToScrollback;
export const loadInitialScrollback = exports.loadInitialScrollback;
export const loadMore = exports.loadMore;
export const sendMessage = exports.sendMessage;
