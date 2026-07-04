import { type Component, For, Show } from "solid-js";
import type { ServerReplySource } from "./lib/api";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { selectedChannel } from "./lib/selection";
import { dismissServerReplyModal, serverReplyBySlug } from "./lib/serverReplyModal";
import { MircBody } from "./MircText";

// #127 — /info, /version, /motd modal. Centered, scrollable, dismissable
// overlay rendering the raw reply lines from a `server_reply` event
// (Session.Server's buffered 371/374, 351, or 375/372/376/422 drain).
// Mirrors WhoModal (same overlay/scroll-lock/dismiss scaffolding); the body
// differs — a monospace pre-wrapped line list (classic-IRC MOTD/INFO look)
// instead of the per-user table. Mounted once per Shell branch (mobile +
// desktop); only one branch is live, so a single instance exists.
//
// Reads the reply for the CURRENTLY-ACTIVE network
// (`selectedChannel()?.networkSlug`) from the per-slug `serverReplyBySlug`
// store. Lines arrive in server wire order (event_router preserves it); cic
// renders them verbatim in a monospace block. Ephemeral — dismissing drops
// the store entry. Dismiss via ×, Esc, or backdrop. There is NO nick-click:
// these are server-text replies, not member rosters.
//
// The server emits only the typed `source` + raw lines (no display strings,
// per the no-localized-strings-server rule); cic owns the human title +
// retro chrome. `source` drives both the title and a `data-source` hook so
// each query type can carry its own accent.

const SOURCE_TITLE: Record<ServerReplySource, string> = {
  info: "Server Info",
  version: "Version",
  motd: "Message of the Day",
};

const ServerReplyModal: Component = () => {
  const activeSlug = (): string | undefined => selectedChannel()?.networkSlug;
  const reply = () => {
    const slug = activeSlug();
    return slug === undefined ? undefined : serverReplyBySlug()[slug];
  };

  // Refcounted overlay scroll-lock — same wiring as WhoModal. The scroller is
  // `.server-reply-modal-body` (header + footer are pinned).
  createOverlayLock(() => reply() !== undefined, ".server-reply-modal-body");

  const close = (): void => {
    const slug = activeSlug();
    if (slug !== undefined) dismissServerReplyModal(slug);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };

  return (
    <Show when={reply()} keyed>
      {(r) => {
        const title = (): string => SOURCE_TITLE[r.source];
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc handled by dialog onKeyDown
          // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim
          <div class="server-reply-modal-backdrop" onClick={close}>
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="server-reply-modal-title"
              class="server-reply-modal"
              data-testid="server-reply-modal"
              data-source={r.source}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={onKeyDown}
              tabIndex={-1}
            >
              <header class="server-reply-modal-header">
                <h2 id="server-reply-modal-title">
                  <span class="server-reply-modal-sigil" aria-hidden="true">
                    ▚
                  </span>
                  {title()}
                </h2>
                <button
                  type="button"
                  class="server-reply-modal-close"
                  aria-label="close"
                  onClick={close}
                >
                  ×
                </button>
              </header>
              <div class="server-reply-modal-body">
                <Show
                  when={r.lines.length > 0}
                  fallback={<div class="server-reply-modal-empty">(no reply)</div>}
                >
                  <For each={r.lines}>
                    {(line: string) => (
                      <div class="server-reply-modal-line" data-testid="server-reply-modal-line">
                        {/* #175 — MOTD/INFO/VERSION lines are server free-text and
                            carry mIRC control bytes (colored banners); route them
                            through the shared renderer instead of dumping raw. */}
                        <MircBody body={line} />
                      </div>
                    )}
                  </For>
                </Show>
              </div>
              <footer class="server-reply-modal-footer">
                <span class="server-reply-modal-cursor" aria-hidden="true">
                  ▮
                </span>{" "}
                {r.lines.length} {r.lines.length === 1 ? "line" : "lines"}
              </footer>
            </div>
          </div>
        );
      }}
    </Show>
  );
};

export default ServerReplyModal;
