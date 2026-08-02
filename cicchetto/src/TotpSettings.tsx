import { type Component, createSignal, For, onMount, Show } from "solid-js";
import {
  ApiError,
  confirmTotpEnrollment,
  disableTotp,
  getTotpStatus,
  startTotpEnrollment,
  type TotpEnrollment,
} from "./lib/api";
import { token } from "./lib/auth";
import { friendlyApiError } from "./lib/friendlyApiError";
import { qrSvgWithLabel } from "./lib/qr";
import PasskeySettings from "./PasskeySettings";

type Props = { onBack: () => void };

const TotpSettings: Component<Props> = (props) => {
  const [enabled, setEnabled] = createSignal<boolean | null>(null);
  const [enrollment, setEnrollment] = createSignal<TotpEnrollment | null>(null);
  const [code, setCode] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [recoveryCodes, setRecoveryCodes] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const currentToken = (): string => {
    const value = token();
    if (value === null) throw new Error("missing auth token");
    return value;
  };

  const reportError = (value: unknown): void => {
    setError(value instanceof ApiError ? friendlyApiError(value) : String(value));
  };

  onMount(() => {
    const value = token();
    if (value === null) return;
    void getTotpStatus(value)
      .then((status) => setEnabled(status.enabled))
      .catch(reportError);
  });

  const beginEnrollment = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setEnrollment(await startTotpEnrollment(currentToken()));
    } catch (value) {
      reportError(value);
    } finally {
      setBusy(false);
    }
  };

  const confirmEnrollment = async (event: Event): Promise<void> => {
    event.preventDefault();
    const pending = enrollment();
    if (pending === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await confirmTotpEnrollment(currentToken(), pending.enrollment_token, code());
      setRecoveryCodes(result.recovery_codes);
      setEnrollment(null);
      setEnabled(true);
      setCode("");
    } catch (value) {
      reportError(value);
    } finally {
      setBusy(false);
    }
  };

  const disable = async (event: Event): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await disableTotp(currentToken(), password());
      setEnabled(false);
      setPassword("");
      setRecoveryCodes([]);
    } catch (value) {
      reportError(value);
    } finally {
      setBusy(false);
    }
  };

  const copyRecoveryCodes = async (): Promise<void> => {
    await navigator.clipboard.writeText(recoveryCodes().join("\n"));
  };

  return (
    <section class="settings-subpage" data-testid="security-subpage">
      <header class="settings-subpage-header">
        <button
          type="button"
          class="settings-back"
          data-testid="security-back"
          onClick={props.onBack}
        >
          ‹ back
        </button>
        <h3>security</h3>
      </header>

      <div class="settings-section settings-section-card" data-testid="totp-settings">
        <h4 class="settings-section-heading">two-factor authentication</h4>

        <Show when={enabled() === false && enrollment() === null && recoveryCodes().length === 0}>
          <p>Protect account login with codes from an authenticator app.</p>
          <button type="button" disabled={busy()} onClick={() => void beginEnrollment()}>
            enable TOTP
          </button>
        </Show>

        <Show when={enrollment()} keyed>
          {(pending) => (
            <form onSubmit={confirmEnrollment} data-testid="totp-enrollment-form">
              <p>Scan this QR code, or enter the key manually. Then confirm one code.</p>
              <div
                class="share-qr"
                innerHTML={qrSvgWithLabel(pending.provisioning_uri, "TOTP enrollment QR code")}
              />
              <label for="totp-manual-key">Manual key</label>
              <input id="totp-manual-key" type="text" readonly value={pending.secret} />
              <label for="totp-confirm-code">Authenticator code</label>
              <input
                id="totp-confirm-code"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                value={code()}
                onInput={(event) => setCode(event.currentTarget.value)}
                required
              />
              <button type="submit" disabled={busy()}>
                confirm and enable
              </button>
            </form>
          )}
        </Show>

        <Show when={recoveryCodes().length > 0}>
          <div role="status" data-testid="totp-recovery-codes">
            <p>Save these recovery codes now. Each works once; they will not be shown again.</p>
            <ul>
              <For each={recoveryCodes()}>
                {(recoveryCode) => (
                  <li>
                    <code>{recoveryCode}</code>
                  </li>
                )}
              </For>
            </ul>
            <button type="button" onClick={() => void copyRecoveryCodes()}>
              copy recovery codes
            </button>
          </div>
        </Show>

        <Show when={enabled() === true && recoveryCodes().length === 0}>
          <p>TOTP is enabled.</p>
          <form onSubmit={disable} data-testid="totp-disable-form">
            <label for="totp-disable-password">Account password</label>
            <input
              id="totp-disable-password"
              type="password"
              autocomplete="current-password"
              value={password()}
              onInput={(event) => setPassword(event.currentTarget.value)}
              required
            />
            <button type="submit" disabled={busy()}>
              disable TOTP
            </button>
          </form>
        </Show>

        <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
      </div>
      <PasskeySettings />
    </section>
  );
};

export default TotpSettings;
