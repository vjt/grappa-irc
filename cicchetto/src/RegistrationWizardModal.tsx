import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { sendBodyLines } from "./lib/compose";
import { friendlyError } from "./lib/friendlyError";
import { networkBySlug, networkIdBySlug } from "./lib/networks";
import { nickEquals } from "./lib/nickEquals";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { flavorForSlug, templateForFlavor } from "./lib/registrationTemplates";
import {
  closeRegistrationWizard,
  registrationWizardState,
  setStepSince,
  setWizardCode,
  setWizardEmail,
  setWizardError,
  setWizardPassword,
  setWizardPending,
  type WizardStep,
  wizardBack,
  wizardNext,
} from "./lib/registrationWizard";
import { serviceMirrorRows } from "./lib/serviceModal";
import { umodesForNetwork } from "./lib/umodes";
import { MircBody } from "./MircText";

// #349 — guided NickServ registration wizard. Launched from the Home
// pane's ConnectedRow ("📝 Register nick"), one per network, gated on a
// registerable services_flavor AND no live +r (see HomePane + the launch
// button's Show guard).
//
// Six steps (see registrationWizard.ts). The wizard mirrors the proven
// ServiceModal shell (backdrop scrim + role=dialog + createOverlayLock +
// $server NOTICE mirror) but is DRIVEN BY `step` instead of a free prompt.
//
// NO-PARSE / NEVER-ORIGINATE-STATE (CLAUDE.md + #91):
//   * The wizard NEVER scrapes NickServ NOTICE text. It DISPLAYS the raw
//     replies (via MircBody, id > stepSinceId) and gates step success on
//     STRUCTURE only.
//   * Step 4 (REGISTER) has no structural terminator (register-accepted ≠
//     +r), so it is USER-advanced with a bounded timeout guard — never an
//     auto-detected success/fail.
//   * Step 6 (verify) auto-completes ONLY on the server-pushed +r umode
//     flip (`umodesForNetwork(id).includes("r")`) — the same signal that
//     reactively hides the launch button. No optimistic success.
//
// SECURITY: email + password are held in the store for the modal lifetime
// only and dropped on close. The REGISTER/verify sends go wire-only (the
// server's services-target path persists nothing) — never logged, never
// echoed to scrollback.
//
// Mounted once per Shell branch (mobile + desktop); only one branch is
// live, so a single instance exists.

const STEP_EMAIL: WizardStep = 2;
const STEP_PASSWORD: WizardStep = 3;
const STEP_REGISTER: WizardStep = 4;
const STEP_CODE: WizardStep = 5;
const STEP_VERIFY: WizardStep = 6;

// Naive email shape check (local@domain.tld) — a client-side foolproof
// guard, NOT authoritative validation (NickServ / the mail server is).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 5;
const MAX_PASSWORD = 32;
// Bounded per-step reply wait (mirror #347 "a silent NickServ must never
// hang the flow"): if no reply / no +r lands in this window, surface a
// "no reply yet — retry / continue" affordance instead of a forever
// spinner.
const STEP_TIMEOUT_MS = 15_000;

const RegistrationWizardModal: Component = () => {
  const state = () => registrationWizardState();
  const close = (): void => closeRegistrationWizard();

  // Refcounted overlay scroll-lock + shared Esc-to-close, same wiring as
  // ServiceModal. onEscape MUST equal the ×/backdrop close verb.
  createOverlayLock(() => state() !== null, ".registration-wizard-body", close);

  return (
    <Show when={state()}>
      {(st) => {
        // `st` is a stable accessor to the non-null state — the block
        // mounts ONCE per open (NOT keyed), so per-field edits update in
        // place and local signals survive step changes.
        const template = () => templateForFlavor(flavorForSlug(st().networkSlug));
        const ownNick = () => networkBySlug(st().networkSlug)?.nick ?? "";

        const [timedOut, setTimedOut] = createSignal(false);
        const [succeeded, setSucceeded] = createSignal(false);

        let timer: ReturnType<typeof setTimeout> | undefined;
        const clearTimer = (): void => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
        };
        onCleanup(clearTimer);

        // NickServ NOTICE mirror for the current send-step: this network's
        // rows from wherever the server routes the service's replies —
        // `$server`, or the service's own query window when the operator has
        // one open (#400/#661, `serviceMirrorRows`) — with id > stepSinceId,
        // raw via MircBody. Zero content parsing — a structural (id) bound
        // only. Reading `$server` alone left the wizard's mirror permanently
        // empty for an operator with a NickServ query open, and step 4 is
        // USER-advanced off reading that reply: not cosmetic, unadvanceable.
        const lines = () => {
          const s = st();
          const nick = template()?.servicesNick ?? "NickServ";
          return serviceMirrorRows(s.networkSlug, nick).filter(
            (m) => m.id > s.stepSinceId && m.kind === "notice" && nickEquals(m.sender, nick),
          );
        };

        // Fire the current step's services command (REGISTER on step 4,
        // verify on step 6). Captures a fresh stepSinceId BEFORE the send
        // so the mirror shows only THIS attempt's replies, then arms the
        // timeout guard once the POST resolves.
        const runSendStep = (): void => {
          const s = st();
          const tmpl = template();
          if (tmpl === null) {
            setWizardError("This network doesn't support in-app registration.");
            return;
          }
          const body =
            s.step === STEP_VERIFY
              ? tmpl.buildVerify(ownNick(), s.code.trim())
              : tmpl.buildRegister(s.password, s.email.trim());
          setTimedOut(false);
          clearTimer();
          setWizardError(null);
          setStepSince(tmpl.servicesNick);
          setWizardPending(true);
          sendBodyLines(s.networkSlug, tmpl.servicesNick, body, false)
            .then(() => {
              setWizardPending(false);
              timer = setTimeout(() => setTimedOut(true), STEP_TIMEOUT_MS);
            })
            .catch((e: unknown) => {
              setWizardPending(false);
              setWizardError(friendlyError(e));
            });
        };

        // Send once on entry to a send-step. The step is MEMOIZED so the
        // effect re-runs ONLY when the step value actually changes: Solid's
        // `on` does NOT value-dedupe (it re-invokes on every change to a
        // tracked signal), and reading `st().step` inline tracks the WHOLE
        // wizard-state signal — so without the memo, every state patch
        // runSendStep makes (pending / stepSince / error) would re-fire
        // runSendStep in a runaway loop (hundreds of REGISTER sends). The
        // memo notifies only on a distinct step value, which also means
        // per-field edits (email/password/code) never re-fire the send.
        const currentStep = createMemo(() => st().step);
        createEffect(
          on(currentStep, (step) => {
            if (step === STEP_REGISTER || step === STEP_VERIFY) runSendStep();
          }),
        );

        // Step-6 auto-complete: the ONLY success terminator is the server
        // +r umode flip (no NickServ text parse). Memoized (same reason as
        // currentStep — `on` doesn't value-dedupe) so the effect fires only
        // on a real +r change; when it flips false→true, celebrate +
        // auto-close (the launch button is already reactively hidden by the
        // same signal).
        const registeredNow = createMemo(() => {
          const id = networkIdBySlug(st().networkSlug);
          return id !== undefined && umodesForNetwork(id).includes("r");
        });
        createEffect(
          on(registeredNow, (isReg) => {
            if (isReg && st().step === STEP_VERIFY && !succeeded()) {
              setSucceeded(true);
              clearTimer();
              const t = setTimeout(close, 1600);
              onCleanup(() => clearTimeout(t));
            }
          }),
        );

        const onNext = (): void => {
          const s = st();
          if (s.step === STEP_EMAIL) {
            if (!EMAIL_RE.test(s.email.trim())) {
              setWizardError("Enter a valid email address.");
              return;
            }
          } else if (s.step === STEP_PASSWORD) {
            const len = s.password.length;
            if (len < MIN_PASSWORD || len > MAX_PASSWORD) {
              setWizardError(`Password must be ${MIN_PASSWORD}–${MAX_PASSWORD} characters.`);
              return;
            }
          } else if (s.step === STEP_CODE) {
            if (s.code.trim() === "") {
              setWizardError("Paste the confirmation code from your email.");
              return;
            }
          }
          wizardNext();
        };

        const enterAdvances = (e: KeyboardEvent): void => {
          if (e.key === "Enter") {
            e.preventDefault();
            onNext();
          }
        };

        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc via the shared overlay stack (keybindings → runTopmostOverlayEscape)
          // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim
          <div
            class="modal-backdrop modal-backdrop-viewport registration-wizard-backdrop"
            onClick={close}
          >
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: inner dialog onClick only stops backdrop-click propagation; Esc closes via the shared overlay stack */}
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="registration-wizard-title"
              class="registration-wizard"
              data-testid="registration-wizard"
              data-step={st().step}
              data-network={st().networkSlug}
              onClick={(e) => e.stopPropagation()}
              tabIndex={-1}
            >
              <header class="registration-wizard-header">
                <h2 id="registration-wizard-title">
                  <span class="registration-wizard-sigil" aria-hidden="true">
                    📝
                  </span>
                  Register your nick
                </h2>
                <button
                  type="button"
                  class="modal-chrome-button registration-wizard-close"
                  aria-label="close"
                  onClick={close}
                >
                  ×
                </button>
              </header>

              <div class="registration-wizard-steps" aria-hidden="true">
                Step {st().step} of {STEP_VERIFY}
              </div>

              <div class="registration-wizard-body">
                <Switch>
                  {/* 1 — intro */}
                  <Match when={st().step === 1}>
                    <p class="registration-wizard-copy">
                      Registering your nick reserves it so nobody else can use it, protects your
                      identity, and unlocks registered-only channels on <b>{st().networkSlug}</b>.
                    </p>
                    <p class="registration-wizard-copy muted">
                      It takes a minute: we'll send your details to the network's NickServ, then you
                      confirm with a code emailed to you.
                    </p>
                  </Match>

                  {/* 2 — email */}
                  <Match when={st().step === STEP_EMAIL}>
                    <label class="registration-wizard-label" for="registration-wizard-email">
                      Email address
                    </label>
                    <p class="registration-wizard-copy muted">
                      NickServ emails your confirmation code here.
                    </p>
                    <input
                      id="registration-wizard-email"
                      class="registration-wizard-input"
                      data-testid="registration-wizard-email"
                      type="email"
                      autocomplete="email"
                      autocapitalize="none"
                      autocorrect="off"
                      spellcheck={false}
                      placeholder="you@example.com"
                      value={st().email}
                      onInput={(e) => setWizardEmail(e.currentTarget.value)}
                      onKeyDown={enterAdvances}
                    />
                  </Match>

                  {/* 3 — password */}
                  <Match when={st().step === STEP_PASSWORD}>
                    <label class="registration-wizard-label" for="registration-wizard-password">
                      Choose a password
                    </label>
                    <p class="registration-wizard-copy muted">
                      You'll use this to identify to NickServ from now on. {MIN_PASSWORD}–
                      {MAX_PASSWORD} characters.
                    </p>
                    <input
                      id="registration-wizard-password"
                      class="registration-wizard-input"
                      data-testid="registration-wizard-password"
                      type="password"
                      autocomplete="new-password"
                      autocapitalize="none"
                      autocorrect="off"
                      spellcheck={false}
                      placeholder="password"
                      value={st().password}
                      onInput={(e) => setWizardPassword(e.currentTarget.value)}
                      onKeyDown={enterAdvances}
                    />
                  </Match>

                  {/* 4 — REGISTER sent; raw reply mirror + user-advance */}
                  <Match when={st().step === STEP_REGISTER}>
                    <p class="registration-wizard-copy">
                      Sending your registration to NickServ. Read its reply below — it usually says
                      to check your email.
                    </p>
                    <NoticeMirror lines={lines()} />
                    <Show when={timedOut()}>
                      <p class="registration-wizard-hint" data-testid="registration-wizard-timeout">
                        No reply yet. Retry, or continue if you've received an email.
                      </p>
                    </Show>
                  </Match>

                  {/* 5 — confirmation code */}
                  <Match when={st().step === STEP_CODE}>
                    <label class="registration-wizard-label" for="registration-wizard-code">
                      Confirmation code
                    </label>
                    <p class="registration-wizard-copy muted">
                      Check your email for a code from NickServ and paste it below.
                    </p>
                    <input
                      id="registration-wizard-code"
                      class="registration-wizard-input"
                      data-testid="registration-wizard-code"
                      type="text"
                      autocomplete="off"
                      autocapitalize="none"
                      autocorrect="off"
                      spellcheck={false}
                      placeholder="confirmation code"
                      value={st().code}
                      onInput={(e) => setWizardCode(e.currentTarget.value)}
                      onKeyDown={enterAdvances}
                    />
                  </Match>

                  {/* 6 — verify sent; auto-complete on +r */}
                  <Match when={st().step === STEP_VERIFY}>
                    <Show
                      when={succeeded()}
                      fallback={
                        <>
                          <p class="registration-wizard-copy">
                            Confirming your registration with NickServ…
                          </p>
                          <NoticeMirror lines={lines()} />
                          <Show when={timedOut()}>
                            <p
                              class="registration-wizard-hint"
                              data-testid="registration-wizard-timeout"
                            >
                              No confirmation yet. Retry, or finish verification via the emailed
                              link.
                            </p>
                          </Show>
                        </>
                      }
                    >
                      <p
                        class="registration-wizard-success"
                        data-testid="registration-wizard-success"
                        role="status"
                      >
                        🎉 Your nick is registered on {st().networkSlug}!
                      </p>
                    </Show>
                  </Match>
                </Switch>
              </div>

              <Show when={st().error} keyed>
                {(msg) => (
                  <div
                    class="registration-wizard-error"
                    data-testid="registration-wizard-error"
                    role="alert"
                  >
                    {msg}
                  </div>
                )}
              </Show>

              <footer class="registration-wizard-footer">
                <Show
                  when={
                    st().step === STEP_EMAIL ||
                    st().step === STEP_PASSWORD ||
                    st().step === STEP_CODE
                  }
                >
                  <button
                    type="button"
                    class="registration-wizard-back"
                    data-testid="registration-wizard-back"
                    onClick={wizardBack}
                  >
                    Back
                  </button>
                </Show>
                <Show when={st().step === STEP_REGISTER || st().step === STEP_VERIFY}>
                  <button
                    type="button"
                    class="registration-wizard-retry"
                    data-testid="registration-wizard-retry"
                    disabled={st().pending}
                    onClick={runSendStep}
                  >
                    {st().pending ? "Sending…" : "Retry"}
                  </button>
                </Show>
                <Show when={st().step !== STEP_VERIFY}>
                  <button
                    type="button"
                    class="registration-wizard-next"
                    data-testid="registration-wizard-next"
                    onClick={onNext}
                  >
                    Next
                  </button>
                </Show>
              </footer>
            </div>
          </div>
        );
      }}
    </Show>
  );
};

// The raw NickServ NOTICE mirror shared by the two send-steps. Renders
// each reply body via MircBody (mIRC colours) — nick stripped (NickServ
// is named in the copy above). A waiting placeholder shows before the
// first reply lands.
const NoticeMirror: Component<{ lines: { id: number; body: string | null }[] }> = (props) => (
  <div class="registration-wizard-mirror">
    <Show
      when={props.lines.length > 0}
      fallback={
        <div class="registration-wizard-mirror-empty">(waiting for NickServ to reply…)</div>
      }
    >
      <For each={props.lines}>
        {(m) => (
          <div class="registration-wizard-line" data-testid="registration-wizard-line">
            <MircBody body={m.body ?? ""} />
          </div>
        )}
      </For>
    </Show>
  </div>
);

export default RegistrationWizardModal;
