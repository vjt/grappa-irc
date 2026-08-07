import { createSignal } from "solid-js";
import type { ScrollbackMessage } from "./api";
import { channelKey } from "./channelKey";
import { moduleRoot } from "./moduleRoot";
import { scrollbackByChannel } from "./scrollback";
import { SERVER_WINDOW_NAME } from "./windowKinds";

// #290 — dedicated services console modal open/close store.
//
// Holds `{networkSlug, service, sinceId}` — or `null` when closed. Opened
// ONLY in response to a bare services command (`/ns`, `/cs`, `/ms`, …) via
// compose.ts's `service-modal` arm (which also fires `help`). `service` is
// the canonical services nick ("NickServ", "ChanServ", …) and titles the
// modal; ServiceModal.tsx derives its notice-mirror body from the $server
// scrollback filtered to this service.
//
// `sinceId` is the mirror high-water mark captured at open: the modal shows
// ONLY service notices with `id > sinceId`, i.e. those that arrive WHILE it
// is open (spec: "capturing only while open" — shrinks the display-only
// phishing surface). Derived from the EXISTING scrollback store, not a
// duplicated capture buffer — the notices stay in their window (mirror, not
// move; nothing lost), the modal is a filtered live view over them. Which
// window that is depends on the server's #400 rule: see `serviceMirrorRows`.
//
// Module-singleton signal (like modeModal / umodeModal) — the modal is
// transient UI, not identity-scoped survival state. A logout unmounts the
// shell so a stale-open modal disappears with it.

export type ServiceModalTarget = {
  networkSlug: string;
  service: string;
  sinceId: number;
};

// #661 — the two windows a service's arrivals can land in, merged in id order.
//
// The server routes a services-sender NOTICE/PRIVMSG to `$server` — UNLESS the
// operator has that service's own query window open, in which case it lands
// THERE (#400, `EventRouter.open_query_or_server/2`). Reading only `$server`
// made the console look dead exactly for the operator who had a NickServ query
// open: modal up, help wall piling into the query behind it, mirror empty
// forever. The mirror is a view over wherever the notices land, so it spans
// both; the union also needs no open/closed flag of its own (a closed query
// contributes an empty list) and survives the operator closing the query while
// the modal is open — the two SSOTs cannot drift because there is no second
// copy of the routing rule here, just both destinations.
//
// Ids are globally monotonic (`messages.id`), so a plain id sort interleaves
// the two windows chronologically.
// Returns a READONLY view: the `$server`-only fast path hands back the live
// store array itself (no copy on the hot reactive read), so the type is the
// guard against a caller mutating the scrollback in place.
export const serviceMirrorRows = (
  networkSlug: string,
  service: string,
): readonly ScrollbackMessage[] => {
  const byChannel = scrollbackByChannel();
  const server = byChannel[channelKey(networkSlug, SERVER_WINDOW_NAME)] ?? [];
  const query = byChannel[channelKey(networkSlug, service)] ?? [];
  if (query.length === 0) return server;
  return [...server, ...query].sort((a, b) => a.id - b.id);
};

const exports_ = moduleRoot(() => {
  const [serviceModalState, setServiceModalState] = createSignal<ServiceModalTarget | null>(null);

  const openServiceModal = (networkSlug: string, service: string): void => {
    // High-water mark at open time: the max message id currently loaded across
    // both mirror windows (0 for a fresh/empty pair). Any service notice that
    // arrives after open gets a higher id (ids are monotonic per the messages
    // schema), so `id > sinceId` selects exactly the while-open arrivals — and
    // spanning both windows keeps an open query's own history from leaking in.
    // Assumes both windows' subscriptions have already seeded local history
    // (the common case — cic subscribes at connect). If either has not landed
    // yet and a later refresh backfills its pre-open notices above the mark,
    // they could surface once; display-only, so a benign, low-probability edge.
    const rows = serviceMirrorRows(networkSlug, service);
    const sinceId = rows.reduce((max, m) => (m.id > max ? m.id : max), 0);
    setServiceModalState({ networkSlug, service, sinceId });
  };

  const closeServiceModal = (): void => {
    setServiceModalState(null);
  };

  return { serviceModalState, openServiceModal, closeServiceModal };
});

export const serviceModalState = exports_.serviceModalState;
export const openServiceModal = exports_.openServiceModal;
export const closeServiceModal = exports_.closeServiceModal;
