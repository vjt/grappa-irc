import { type Component, createSignal, For, onMount, Show } from "solid-js";
import {
  deletePasskey,
  finishPasskeyModeChange,
  finishPasskeyRegistration,
  getPasskeyStatus,
  type PasskeyStatus,
  preparePasswordless,
  startPasskeyModeChange,
  startPasskeyRegistration,
  startPasswordlessActivation,
} from "./lib/api";
import { token } from "./lib/auth";
import { createPasskey, getPasskey } from "./lib/passkeys";

const PasskeySettings: Component = () => {
  const [status, setStatus] = createSignal<PasskeyStatus | null>(null);
  const [password, setPassword] = createSignal("");
  const [name, setName] = createSignal("");
  const [codes, setCodes] = createSignal<string[]>([]);
  const [recoveryToken, setRecoveryToken] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const currentToken = (): string => {
    const value = token();
    if (value === null) throw new Error("missing auth token");
    return value;
  };
  const reload = async (): Promise<void> => {
    setStatus(await getPasskeyStatus(currentToken()));
  };
  onMount(() => void reload().catch((value) => setError(String(value))));

  const register = async (event: Event): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const options = await startPasskeyRegistration(currentToken(), password(), name());
      await finishPasskeyRegistration(currentToken(), await createPasskey(options));
      setName("");
      await reload();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const enableSecondFactor = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const options = await startPasskeyModeChange(currentToken(), password(), "second_factor");
      await finishPasskeyModeChange(currentToken(), await getPasskey(options));
      await reload();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const preparePasswordlessMode = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const prepared = await preparePasswordless(currentToken(), password());
      setCodes(prepared.recovery_codes);
      setRecoveryToken(prepared.recovery_token);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const activatePasswordless = async (): Promise<void> => {
    const pending = recoveryToken();
    if (pending === null) return;
    setBusy(true);
    setError(null);
    try {
      const options = await startPasswordlessActivation(currentToken(), pending);
      await finishPasskeyModeChange(currentToken(), await getPasskey(options));
      setRecoveryToken(null);
      await reload();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const copyRecoveryCodes = async (): Promise<void> => {
    setError(null);
    try {
      await navigator.clipboard.writeText(codes().join("\n"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const remove = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await deletePasskey(currentToken(), id, password());
      await reload();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="settings-section settings-section-card" data-testid="passkey-settings">
      <h4 class="settings-section-heading">passkeys</h4>
      <p>Passkeys belong to this instance domain and cannot be used on another Grappa instance.</p>
      <Show when={status()} keyed>
        {(current) => (
          <>
            <p>Mode: {current.mode}</p>
            <ul>
              <For each={current.passkeys}>
                {(passkey) => (
                  <li>
                    {passkey.name}{" "}
                    <button type="button" disabled={busy()} onClick={() => void remove(passkey.id)}>
                      remove
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <form onSubmit={register}>
              <label for="passkey-name">Passkey name</label>
              <input
                id="passkey-name"
                autocomplete="off"
                data-1p-ignore
                data-bwignore="true"
                data-lpignore="true"
                data-protonpass-ignore="true"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                required
              />
              <label for="passkey-password">Account password</label>
              <input
                id="passkey-password"
                type="password"
                autocomplete="current-password"
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
                required
              />
              <button type="submit" disabled={busy()}>
                add passkey
              </button>
            </form>
            <Show when={current.passkeys.length > 0}>
              <button type="button" disabled={busy()} onClick={() => void enableSecondFactor()}>
                require password + passkey
              </button>
              <button
                type="button"
                disabled={busy()}
                onClick={() => void preparePasswordlessMode()}
              >
                use passkey as primary login
              </button>
              <p role="note">
                Passwordless mode disables password and TOTP login. Losing the passkey requires a
                recovery code; without either, only the instance administrator can restore the
                account. Shottino cannot log in.
              </p>
            </Show>
          </>
        )}
      </Show>
      <Show when={codes().length > 0}>
        <div role="status">
          <p>Save these mandatory recovery codes now. They are shown once.</p>
          <ul>
            <For each={codes()}>
              {(code) => (
                <li>
                  <code>{code}</code>
                </li>
              )}
            </For>
          </ul>
          <button type="button" onClick={() => void copyRecoveryCodes()}>
            Copy all recovery codes
          </button>
          <Show when={recoveryToken() !== null}>
            <button type="button" disabled={busy()} onClick={() => void activatePasswordless()}>
              I saved these codes, activate passwordless
            </button>
            <p>Until this confirmation succeeds, login mode remains unchanged.</p>
          </Show>
        </div>
      </Show>
      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
    </div>
  );
};

export default PasskeySettings;
