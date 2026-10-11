import { type Component, createEffect, createSignal, For, onMount, Show } from "solid-js";
import { createBackdropDismiss } from "./lib/backdropDismiss";
import { casemappingForSlug } from "./lib/casemapping";
import { type ChannelKey, channelKey } from "./lib/channelKey";
import { placeCaretInView } from "./lib/composeCaret";
import { trapTabKey } from "./lib/focusTrap";
import { friendlyError } from "./lib/friendlyError";
import { isComposingKeystroke } from "./lib/imeComposition";
import { nickEquals } from "./lib/nickEquals";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { selectedChannel } from "./lib/selection";
import { sendBodyLines } from "./lib/sendPipeline";
import { closeServiceModal, serviceMirrorRows, serviceModalState } from "./lib/serviceModal";
import { type TabCycle, tabCompleteStep } from "./lib/tabCompletion";
import { SERVER_WINDOW_NAME } from "./lib/windowKinds";
import { MircBody } from "./MircText";

// #290 — dedicated services console modal. Opened ONLY by a bare services
// command (`/ns`, `/cs`, `/ms`, …) via compose.ts's `service-modal` arm
// (which also fires `help`). Titled by the service; the body is a
// notice-mirror derived from the scrollback windows the server routes
// services-sender NOTICEs to (`$server`, or the service's own query window
// when one is open — #400/#661, `serviceMirrorRows`), filtered CLIENT-SIDE to
// THIS service and to while-open arrivals (`id > sinceId`). Nick is stripped per line — the
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

  // issue 1982 — the scrim dismisses on the press it began, not on any click
  // that happens to land on it. `serviceModalCommand` opens FIRST and awaits
  // `sendBodyLines` after (an ordering #1518 pinned: the $server high-water
  // mark must be taken before the POST), so a tap on send provably mounts this
  // backdrop before the tap's synthesised click is hit-tested. Same defect and
  // same cure as issue 1831 on BanlistModal and ModeModal — see
  // lib/backdropDismiss.ts. Created at component scope, not inside the keyed
  // `Show`, so switching services cannot reset the arm mid-gesture.
  const backdropDismiss = createBackdropDismiss(close);

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

        // Notice-mirror: this network's rows from wherever the server routes
        // this service's arrivals — `$server`, or the service's own query
        // window when the operator has one open (#400; see
        // `serviceMirrorRows`) — filtered to this service's notices that
        // arrived AFTER open. Reactive on the scrollback signal, so live
        // NOTICEs append and appear here whichever window they land in.
        const lines = () =>
          serviceMirrorRows(st.networkSlug, st.service).filter(
            (m) =>
              m.id > st.sinceId &&
              m.kind === "notice" &&
              nickEquals(m.sender, st.service, casemappingForSlug(st.networkSlug)),
          );

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

        // issue 2375 — the console opens from a bare `/ns`, so the next
        // keystroke belongs to the `>` prompt. Per open, like the draft: the
        // keyed remount re-runs it when a second service replaces the first.
        // iOS, UNMEASURED: WebKit raises the on-screen keyboard for a
        // programmatic focus only inside a user gesture, and whether the
        // compose Enter / send tap that opened us still counts is not known.
        // If it does not, the prompt is focused with the keyboard down — the
        // same one tap as before this change, never more.
        let inputRef: HTMLTextAreaElement | undefined;
        onMount(() => inputRef?.focus({ preventScroll: true }));

        // issue 2375 item 2 — the prompt is the second door onto the ONE
        // completion engine (lib/tabCompletion; the compose box is the first).
        // Candidates come from the KEY: the window selected behind the modal
        // when it is on this network (its members, plus the network's joined
        // channels), else `$server`, which has no members and so offers the
        // channels alone. Read at Tab time, not captured at open, so the set
        // is the one the user is looking at. The cycle lives here, per open
        // like the draft, and typing drops it — the compose door's rule.
        let tabCycle: TabCycle | null = null;
        const completionKey = (): ChannelKey => {
          const sel = selectedChannel();
          const target =
            sel !== null && sel.networkSlug === st.networkSlug
              ? sel.channelName
              : SERVER_WINDOW_NAME;
          return channelKey(st.networkSlug, target);
        };
        const complete = (ta: HTMLTextAreaElement, forward: boolean): void => {
          const step = tabCompleteStep({
            key: completionKey(),
            input: draft(),
            cursor: ta.selectionStart,
            forward,
            cycle: tabCycle,
            // The line opens with a command (`INFO vjt`), never an addressee.
            addressee: false,
          });
          if (step === null) return;
          tabCycle = step.cycle;
          setDraft(step.newInput);
          // #1113 — the compose doors' caret placement: the completion can land
          // on a wrapped line the one-row box is not showing.
          queueMicrotask(() => placeCaretInView(ta, step.newCursor));
        };

        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc via the shared overlay stack (keybindings → runTopmostOverlayEscape)
          // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim
          <div
            class="modal-backdrop modal-backdrop-viewport service-modal-backdrop"
            onPointerDown={backdropDismiss.onPointerDown}
            onClick={backdropDismiss.onClick}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="service-modal-title"
              class="service-modal"
              data-testid="service-modal"
              data-service={st.service}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => trapTabKey(e, e.currentTarget)}
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
                  class="modal-chrome-button service-modal-close"
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
                {/* issue 2375 item 4 — a one-row textarea, the composer's own
                    shape, because iOS offered Contacts addresses in the
                    QuickType bar over the `<input type=text>` this replaced
                    and the composer never shows them. vjt's ruling, NOT
                    verified on a device: if the AutoFill survives, the shape
                    was not the trigger. A textarea keeps line breaks, so the
                    two handlers below hold the old single-line contract. */}
                <textarea
                  ref={inputRef}
                  rows={1}
                  class="service-modal-prompt-input"
                  data-testid="service-modal-input"
                  autocomplete="off"
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck={false}
                  aria-label={`send a command to ${st.service}`}
                  placeholder={`send a command to ${st.service}`}
                  value={draft()}
                  onInput={(e) => {
                    setSendError(null);
                    tabCycle = null;
                    // A pasted line break would ride into sendBodyLines as a
                    // SECOND command to the service; it becomes a space, as
                    // the old single-line field effectively did.
                    const el = e.currentTarget;
                    const flat = el.value.replace(/\r\n|\r|\n/g, " ");
                    if (flat !== el.value) el.value = flat;
                    setDraft(flat);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      // issue 2041 — the Enter that commits an IME candidate
                      // is not a send.
                      if (isComposingKeystroke(e)) return;
                      // Every Enter sends, Shift+Enter included: there is no
                      // second line to open.
                      e.preventDefault();
                      send();
                    } else if (e.key === "Tab") {
                      // Consumed even with nothing to complete, as at the
                      // compose box; lib/focusTrap leaves a prevented Tab alone.
                      e.preventDefault();
                      complete(e.currentTarget, !e.shiftKey);
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
