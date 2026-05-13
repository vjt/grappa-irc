import { createSignal } from "solid-js";
import { sendMessage as apiSendMessage, listMessages, type ScrollbackMessage } from "./api";
import { token } from "./auth";
import { type ChannelKey, channelKey } from "./channelKey";
import { identityScopedStore } from "./identityScopedStore";

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
// Identity-scoped state via identityScopedStore (dup-A3 close): four
// resets registered (3 Set.clear() + the signal flush). The factory
// preserves the A1 invariant — registration runs before any verb fires,
// so a logout/rotation between `loadInitialScrollback` start and finish
// always wins the race.
//
// ---------------------------------------------------------------------------
// CP14 B3 — DM history is now bidirectional server-side.
// ---------------------------------------------------------------------------
//
// Pre-CP14-B3 this module carried `shouldKeepInOwnNickQuery` /
// `ownNickIfOwnNickQuery` to filter the own-nick query window down to
// only self-msgs. That was a band-aid for the broken DM fetch
// semantics: the server persisted inbound DMs on `channel = own_nick`,
// so `loadInitialScrollback(own_nick)` would dump every inbound DM,
// every NickServ NOTICE, and every server-origin notice into the own-
// nick window. The client kept only self-msgs to hide the noise.
//
// CP14 B3 ships `:dm_with` on the server-side `messages` schema.
// `Scrollback.fetch/5` for a peer-shaped channel name now returns
// inbound (channel = own_nick AND dm_with = peer) UNION outbound
// (channel = peer) — server is now authoritative; cic doesn't filter.
// Service NOTICEs land at $server (the dedicated server-messages
// window) per existing routing, so the noise that motivated the
// filter is already absent from the DM fetch surface.

const exports = identityScopedStore((onIdentityChange) => {
  const loadedChannels = new Set<ChannelKey>();
  // CP14 B2: per-key in-flight Set guards against scroll-burst fan-out
  // (the user flicks the scrollbar; the browser fires `scroll` 5+ times
  // in a frame and the onScroll handler would otherwise dispatch 5+
  // identical REST requests). While a key is in `loadMoreInFlight`, a
  // second `loadMore` call for the same key is a no-op. Released in
  // `finally` so a transient REST error doesn't permanently lock out
  // future retries — only the exhausted-latch is forward-only.
  const loadMoreInFlight = new Set<ChannelKey>();
  // CP14 B2: end-of-history latch. When `loadMore` returns 0 fresh
  // rows, the channel is exhausted — the server has no rows older than
  // our current oldest. Subsequent calls are no-ops. Latch is forward-
  // only; cleared on identity transition alongside `loadedChannels`.
  const loadMoreExhausted = new Set<ChannelKey>();
  const [scrollbackByChannel, setScrollbackByChannel] = createSignal<
    Record<ChannelKey, ScrollbackMessage[]>
  >({});

  // Identity-transition cleanup. Four registered resets fired by the
  // factory's createEffect(on(token, ...)) — three Set.clear() + the
  // signal flush. Order matches the pre-A3 inline shape.
  onIdentityChange(() => loadedChannels.clear());
  onIdentityChange(() => loadMoreInFlight.clear());
  onIdentityChange(() => loadMoreExhausted.clear());
  onIdentityChange(() => setScrollbackByChannel({}));

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
  //
  // Codebase audit cic M3 — secondary sort by `id` ASC. Server-side
  // `Scrollback.fetch/5` orders by `[desc: m.server_time, desc: m.id]`,
  // so client mirrors with `[asc: server_time, asc: id]`. Without the
  // tie-breaker, same-millisecond message bursts from the REST DESC page
  // could land in arbitrary order vs the WS append stream — visible
  // reorder of bursty traffic on reload. `id` is monotonic per
  // sqlite's auto-increment column.
  const mergeIntoScrollback = (key: ChannelKey, page: ScrollbackMessage[]) => {
    setScrollbackByChannel((prev) => {
      const existing = prev[key] ?? [];
      const ids = new Set(existing.map((m) => m.id));
      const fresh = page.filter((m) => !ids.has(m.id));
      if (fresh.length === 0) return prev;
      const merged = [...existing, ...fresh].sort((a, b) => {
        if (a.server_time !== b.server_time) return a.server_time - b.server_time;
        return a.id - b.id;
      });
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
    // CP14 B2 gates — order matters:
    //   1. Exhausted latch first: if the channel has no older rows on
    //      the server, every scroll-to-top would otherwise hit REST
    //      and get an empty page back. One-line short-circuit.
    //   2. In-flight guard second: a parallel scroll-burst converges
    //      onto a single REST request; the second call returns void
    //      while the first is still pending.
    if (loadMoreExhausted.has(key)) return;
    if (loadMoreInFlight.has(key)) return;
    const current = scrollbackByChannel()[key];
    if (!current || current.length === 0) return;
    const oldest = current[0];
    if (!oldest) return;
    loadMoreInFlight.add(key);
    try {
      // CP29 R-2: cursor flipped from `oldest.server_time` to
      // `oldest.id`. The server-side `?before=` parameter now expects
      // a `messages.id` value, eliminating same-ms ties that straddled
      // page boundaries pre-flip.
      const page = await listMessages(t, slug, name, oldest.id);
      // CP14 B2: empty page from the server means there's no older
      // history to load. Latch the channel so subsequent scroll-to-
      // top events don't re-fetch.
      if (page.length === 0) {
        loadMoreExhausted.add(key);
      } else {
        mergeIntoScrollback(key, page);
      }
    } catch {
      // Transient error — do NOT latch as exhausted. The user can
      // retry by scrolling again; the in-flight guard releases via
      // the finally clause below.
    } finally {
      loadMoreInFlight.delete(key);
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
