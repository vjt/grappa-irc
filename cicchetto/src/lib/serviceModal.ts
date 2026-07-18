import { createRoot, createSignal } from "solid-js";
import { channelKey } from "./channelKey";
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
// `sinceId` is the $server high-water mark captured at open: the modal shows
// ONLY service notices with `id > sinceId`, i.e. those that arrive WHILE it
// is open (spec: "capturing only while open" — shrinks the display-only
// phishing surface). Derived from the EXISTING $server scrollback store, not
// a duplicated capture buffer — the notices stay in $server (mirror, not
// move; nothing lost), the modal is a filtered live view over them.
//
// Module-singleton signal (like modeModal / umodeModal) — the modal is
// transient UI, not identity-scoped survival state. A logout unmounts the
// shell so a stale-open modal disappears with it.

export type ServiceModalTarget = {
  networkSlug: string;
  service: string;
  sinceId: number;
};

const exports_ = createRoot(() => {
  const [serviceModalState, setServiceModalState] = createSignal<ServiceModalTarget | null>(null);

  const openServiceModal = (networkSlug: string, service: string): void => {
    // High-water mark of the $server window at open time: the max message id
    // currently loaded (0 for a fresh/empty window). Any service notice that
    // arrives after open gets a higher id (ids are monotonic per the messages
    // schema), so `id > sinceId` selects exactly the while-open arrivals.
    // Assumes the $server subscription has already seeded local history (the
    // common case — cic subscribes at connect). If $server is empty here
    // (sinceId=0) and a later reconnect refresh backfills pre-open notices,
    // they could surface once; display-only, so a benign, low-probability edge.
    const rows = scrollbackByChannel()[channelKey(networkSlug, SERVER_WINDOW_NAME)] ?? [];
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
