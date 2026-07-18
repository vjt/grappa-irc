import { type Component, createEffect, createSignal, For, Show } from "solid-js";
import { channelKey } from "./lib/channelKey";
import { sendBodyLines } from "./lib/compose";
import { friendlyError } from "./lib/friendlyError";
import { nickEquals } from "./lib/nickEquals";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { scrollbackByChannel } from "./lib/scrollback";
import { closeServiceModal, serviceModalState } from "./lib/serviceModal";
import { SERVER_WINDOW_NAME } from "./lib/windowKinds";
import { MircBody } from "./MircText";

// #290 — dedicated services console modal. Opened ONLY by a bare services
// command (`/ns`, `/cs`, `/ms`, …) via compose.ts's `service-modal` arm
// (which also fires `help`). Titled by the service; the body is a
// notice-mirror derived from the $server scrollback (where the server routes
// services-sender NOTICEs), filtered CLIENT-SIDE to THIS service and to
// while-open arrivals (`id > sinceId`). Nick is stripped per line — the
// service name lives in the title, not repeated on every row. A bottom `>`
// prompt sends raw commands to the service (same wire path as `/ns <cmd>`),
// whose reply NOTICEs mirror back into the body. The notices ALSO stay in the
// $server window (mirror, not move — nothing lost); this is a filtered view.
//
// Display-only, content untrusted (spec hard rule): the modal NEVER drives an
// auth action off notice content. The source nick is spoofable on a network
// without nick protection, so a network could let a user nick to the service
// name and phish through the modal — opening only on a user command AND
// capturing only while open shrinks that surface, and nothing here reads a
// notice to trigger a side effect. Mounted once per Shell branch (mobile +
// desktop); only one branch is live, so a single instance exists.

const ServiceModal: Component = () => {
  const state = () => serviceModalState();
  const close = (): void => closeServiceModal();

  // Refcounted overlay scroll-lock + shared Esc-to-close (topmost-first),
  // same wiring as ServerReplyModal / ModeModal. A new pane-covering modal
  // MUST push the overlay refcount or the iOS scroll-freeze mis-counts.
  createOverlayLock(() => state() !== null, ".service-modal-body", close);

  return (
    <Show when={state()} keyed>
      {(st) => {
        // Prompt draft is scoped to THIS open (fresh per keyed remount): a
        // close+reopen — or switching services — never carries a half-typed
        // line across.
        const [draft, setDraft] = createSignal("");
        // Inline send-error, scoped per open. The `>` prompt mirrors the
        // compose-box contract: the draft clears ONLY on a successful send; a
        // failure preserves the (possibly credential-bearing) line and surfaces
        // the reason inline — never a silent console-only swallow (CLAUDE.md
        // "no silent-swallow at boundaries"; same posture as ComposeBox).
        const [sendError, setSendError] = createSignal<string | null>(null);

        // Notice-mirror: the $server rows for this network, filtered to this
        // service's notices that arrived AFTER open. Reactive on the
        // scrollback signal — live NOTICEs append and appear here.
        const lines = () => {
          const rows = scrollbackByChannel()[channelKey(st.networkSlug, SERVER_WINDOW_NAME)] ?? [];
          return rows.filter(
            (m) => m.id > st.sinceId && m.kind === "notice" && nickEquals(m.sender, st.service),
          );
        };

        const send = (): void => {
          const line = draft().trim();
          if (line === "") return;
          setSendError(null);
          // Clear the draft ONLY once the send resolves; on failure keep the
          // typed line (retry without re-typing) and show the reason inline.
          sendBodyLines(st.networkSlug, st.service, line, false)
            .then(() => setDraft(""))
            .catch((e: unknown) => setSendError(friendlyError(e)));
        };

        // Auto-scroll the mirror to the newest line as notices arrive (the
        // help wall + prompt replies land at the tail). scrollHeight is 0 in
        // jsdom (no layout) — harmless there; real browsers pin to bottom.
        let bodyRef: HTMLDivElement | undefined;
        createEffect(() => {
          lines().length;
          if (bodyRef) bodyRef.scrollTop = bodyRef.scrollHeight;
        });

        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc via the shared overlay stack (keybindings → runTopmostOverlayEscape)
          // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim
          <div class="service-modal-backdrop" onClick={close}>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: inner dialog onClick only stops backdrop-click propagation; Esc closes via the shared overlay stack */}
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="service-modal-title"
              class="service-modal"
              data-testid="service-modal"
              data-service={st.service}
              onClick={(e) => e.stopPropagation()}
              tabIndex={-1}
            >
              <header class="service-modal-header">
                <h2 id="service-modal-title">
                  <span class="service-modal-sigil" aria-hidden="true">
                    ▚
                  </span>
                  {st.service}
                </h2>
                <button
                  type="button"
                  class="service-modal-close"
                  aria-label="close"
                  onClick={close}
                >
                  ×
                </button>
              </header>
              <div class="service-modal-body" ref={bodyRef}>
                <Show
                  when={lines().length > 0}
                  fallback={
                    <div class="service-modal-empty">(waiting for {st.service} to reply…)</div>
                  }
                >
                  <For each={lines()}>
                    {(m) => (
                      <div class="service-modal-line" data-testid="service-modal-line">
                        {/* Nick stripped — render ONLY the body (service name is
                            in the title). Service NOTICEs carry mIRC control
                            bytes (colored banners); route through the shared
                            renderer instead of dumping raw. */}
                        <MircBody body={m.body ?? ""} />
                      </div>
                    )}
                  </For>
                </Show>
              </div>
              <Show when={sendError()} keyed>
                {(msg) => (
                  <div
                    class="service-modal-prompt-error"
                    data-testid="service-modal-prompt-error"
                    role="alert"
                  >
                    {msg}
                  </div>
                )}
              </Show>
              <footer class="service-modal-prompt">
                <span class="service-modal-prompt-sigil" aria-hidden="true">
                  &gt;
                </span>
                <input
                  class="service-modal-prompt-input"
                  data-testid="service-modal-input"
                  type="text"
                  autocomplete="off"
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck={false}
                  aria-label={`send a command to ${st.service}`}
                  placeholder={`send a command to ${st.service}`}
                  value={draft()}
                  onInput={(e) => {
                    setSendError(null);
                    setDraft(e.currentTarget.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
              </footer>
            </div>
          </div>
        );
      }}
    </Show>
  );
};

export default ServiceModal;
