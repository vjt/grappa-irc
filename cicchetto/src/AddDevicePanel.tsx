import { type Component, createSignal, onCleanup, onMount, Show } from "solid-js";
import AddDeviceQr from "./AddDeviceQr";
import { token } from "./lib/auth";
import { pairingDeps } from "./lib/e2e/pairingDeps";
import { type HolderState, holderPairing } from "./lib/e2e/pairingSession";
import { errorMessage } from "./lib/friendlyApiError";
import PairResults from "./PairResults";

// issue 2430, X1-crypto — the master's side of a pairing, shown inline in the
// encrypted pane's keys block: the QR for the new browser to scan, then the
// two-digit code the new browser shows, TYPED here (the typing is this
// screen's confirmation: someone who joined first has no code to type), then
// what became of each network. All the logic is the session's
// (lib/e2e/pairingSession); this renders its state and forwards the verbs.

type Holder = ReturnType<typeof holderPairing>;

// Why a pairing ended, the one copy of it: the QR component it holds says
// none of its own.
const ENDED: Record<Exclude<HolderState["ended"], "code-mismatch" | null>, string> = {
  closed: "The new device ended the pairing.",
  expired: "The code expired. Start again to show a new one.",
  replaced: "A newer pairing replaced this one.",
  gone: "The pairing is no longer available. Start again to show a new code.",
  "nothing-to-offer": "There is no network this browser can add the new device to.",
  failed: "The pairing failed. Start again to show a new code.",
};

// An ended stage always says why; a null would be the session's bug, shown as a failure.
const endedCopy = (ended: HolderState["ended"]): string =>
  ended === null || ended === "code-mismatch" ? ENDED.failed : ENDED[ended];

const TWO_DIGITS = /^\d{2}$/;

const AddDevicePanel: Component<{ onClose: () => void }> = (props) => {
  const [session, setSession] = createSignal<Holder | null>(null);
  const [failed, setFailed] = createSignal<string | null>(null);
  const [typed, setTyped] = createSignal("");
  let gone = false;
  let made: Holder | null = null;

  onMount(async () => {
    const bearer = token();
    if (bearer === null) {
      setFailed("Log in first.");
      return;
    }
    try {
      const deps = await pairingDeps(bearer);
      // Left the screen while the deps were loading: nothing was started.
      if (gone) return;
      made = holderPairing(deps);
      setSession(made);
    } catch (err) {
      console.warn("[e2e] could not prepare this browser for pairing", err);
      setFailed(`Could not prepare this browser for pairing: ${errorMessage(err)}`);
    }
  });

  onCleanup(() => {
    gone = true;
    made?.cancel();
  });

  const state = () => session()?.state();
  const code = () => typed().trim();
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (TWO_DIGITS.test(code())) session()?.submitCode(code());
  };

  const results = (s: HolderState) => (
    <>
      <PairResults results={s.results} />
      <Show when={s.full.length > 0}>
        <p class="muted" data-testid="pair-full">
          Not offered, already 4 devices: {s.full.join(", ")}
        </p>
      </Show>
      <Show when={s.notMaster.length > 0}>
        <p class="muted" data-testid="pair-not-master">
          Not added, this browser did not start these identities: {s.notMaster.join(", ")}
        </p>
      </Show>
    </>
  );

  return (
    <section class="add-device-panel" data-testid="add-device-panel">
      <Show when={failed()}>
        {(message) => (
          <p role="alert" data-testid="pair-failed">
            {message()}
          </p>
        )}
      </Show>
      <Show when={session()}>
        {(holder) => (
          <>
            {/* Kept mounted while the pairing lives: leaving the screen closes its channel. */}
            <div data-testid="qr-slot" hidden={state()?.stage !== "waiting"}>
              <AddDeviceQr
                curve={holder().curve}
                onChannel={(channel) => holder().attach(channel)}
                onMessage={(payload) => holder().onPayload(payload)}
                onClosed={(reason) => holder().onClosed(reason)}
              />
            </div>
            <Show when={state()?.stage === "code"}>
              <form class="pair-code" onSubmit={submit}>
                <label>
                  Type the code shown on the new device
                  <input
                    type="text"
                    class="pair-code-input"
                    data-testid="pair-code-input"
                    inputmode="numeric"
                    maxlength={2}
                    autocomplete="off"
                    value={typed()}
                    onInput={(event) => setTyped(event.currentTarget.value)}
                  />
                </label>
                <button
                  type="submit"
                  data-testid="pair-code-submit"
                  disabled={!TWO_DIGITS.test(code())}
                >
                  Continue
                </button>
              </form>
            </Show>
            <Show when={state()?.stage === "offered"}>
              <p>Waiting for the new browser to confirm…</p>
            </Show>
            <Show when={state()?.stage === "signing"}>
              <p>Adding the new device…</p>
            </Show>
            <Show when={state()?.stage === "done" ? state() : undefined}>
              {(s) => (
                <>
                  {results(s())}
                  <Show when={s().ended !== null}>
                    <p data-testid="pair-unconfirmed">
                      The new browser did not confirm. If it shows an error, pair it again.
                    </p>
                  </Show>
                </>
              )}
            </Show>
            <Show when={state()?.stage === "ended" ? state() : undefined}>
              {(s) => (
                <>
                  <Show
                    when={s().ended !== "code-mismatch"}
                    fallback={
                      <p data-testid="code-mismatch">The codes did not match. Nothing was added.</p>
                    }
                  >
                    <p data-testid="pair-ended">{endedCopy(s().ended)}</p>
                  </Show>
                  {results(s())}
                </>
              )}
            </Show>
          </>
        )}
      </Show>
      <button type="button" data-testid="add-device-close" onClick={() => props.onClose()}>
        Close
      </button>
    </section>
  );
};

export default AddDevicePanel;
