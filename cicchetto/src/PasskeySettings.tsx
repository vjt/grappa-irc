import { type Component, createSignal, For, onMount, Show } from "solid-js";
import InlineConfirmButton from "./InlineConfirmButton";
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
import { copyText } from "./lib/clipboard";
import { errorMessage } from "./lib/friendlyApiError";
import { createPasskey, getPasskey } from "./lib/passkeys";

const PasskeySettings: Component = () => {
  const [status, setStatus] = createSignal<PasskeyStatus | null>(null);
  const [password, setPassword] = createSignal("");
  const [name, setName] = createSignal("");
  const [codes, setCodes] = createSignal<string[]>([]);
  const [recoveryToken, setRecoveryToken] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  // #735 — deleting a passkey is irreversible and, in passwordless mode, can
  // lock the account out entirely, so removal goes through the drawer's
  // existing two-tap InlineConfirmButton rather than firing on first tap.
  // One armed id across the whole list: arming a row disarms its siblings.
  const [armedRemoval, setArmedRemoval] = createSignal<string | null>(null);

  const currentToken = (): string => {
    const value = token();
    if (value === null) throw new Error("missing auth token");
    return value;
  };
  const reload = async (): Promise<void> => {
    setStatus(await getPasskeyStatus(currentToken()));
  };
  onMount(() => void reload().catch((value) => setError(errorMessage(value))));

  // #729 — FIVE privileged actions consume the account password, and only one
  // of them (add) used to sit inside the form that visually owned the field.
  // The other four read the signal from elsewhere in the pane with no prompt
  // of their own, so a user who never filled that form sent `""` and got a
  // bare 401 back; and a password typed to ADD a passkey stayed live in the
  // signal, silently re-usable to change how the account authenticates.
  //
  // One gate for all five: refuse locally when the field is empty (naming the
  // blocker instead of spending a doomed request AND a slot in the server's
  // login-throttle window), and clear the field in the `finally` — on success
  // AND on failure, so neither a good password nor a wrong one lingers for
  // the next click to reuse. Re-typing IS the per-action re-confirmation the
  // pane owes for a change of this weight.
  const withPassword = async (run: (accountPassword: string) => Promise<void>): Promise<void> => {
    setError(null);
    const accountPassword = password();
    if (accountPassword === "") {
      setError("Enter your account password to confirm this change.");
      return;
    }
    setBusy(true);
    try {
      await run(accountPassword);
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
      setPassword("");
    }
  };

  const register = async (event: Event): Promise<void> => {
    event.preventDefault();
    await withPassword(async (accountPassword) => {
      const options = await startPasskeyRegistration(currentToken(), accountPassword, name());
      await finishPasskeyRegistration(currentToken(), await createPasskey(options));
      setName("");
      await reload();
    });
  };

  const enableSecondFactor = async (): Promise<void> =>
    withPassword(async (accountPassword) => {
      const options = await startPasskeyModeChange(
        currentToken(),
        accountPassword,
        "second_factor",
      );
      await finishPasskeyModeChange(currentToken(), await getPasskey(options));
      await reload();
    });

  const disablePasskeyLogin = async (): Promise<void> =>
    withPassword(async (accountPassword) => {
      const options = await startPasskeyModeChange(currentToken(), accountPassword, "disabled");
      await finishPasskeyModeChange(currentToken(), await getPasskey(options));
      setCodes([]);
      setRecoveryToken(null);
      await reload();
    });

  const preparePasswordlessMode = async (): Promise<void> =>
    withPassword(async (accountPassword) => {
      const prepared = await preparePasswordless(currentToken(), accountPassword);
      setCodes(prepared.recovery_codes);
      setRecoveryToken(prepared.recovery_token);
    });

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
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  };

  const copyRecoveryCodes = async (): Promise<void> => {
    setError(null);
    try {
      await copyText(codes().join("\n"));
    } catch (value) {
      setError(errorMessage(value));
    }
  };

  const remove = async (id: string): Promise<void> => {
    await withPassword(async (accountPassword) => {
      await deletePasskey(currentToken(), id, accountPassword);
      await reload();
    });
    setArmedRemoval(null);
  };

  return (
    <div class="settings-section settings-section-card" data-testid="passkey-settings">
      <h4 class="settings-section-heading">passkeys</h4>
      <p>Passkeys belong to this instance domain and cannot be used on another Grappa instance.</p>
      <Show when={status()} keyed>
        {(current) => (
          <>
            <p>Mode: {current.mode}</p>
            {/* #729 — ONE explicitly-labelled re-auth field, above every
                control that consumes it, instead of a field nested in the
                add-passkey form that four sibling buttons read behind the
                user's back. It is cleared after each action (see
                `withPassword`), so each one re-confirms. */}
            <label for="passkey-password">Account password</label>
            <input
              id="passkey-password"
              type="password"
              autocomplete="current-password"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
            <p role="note">
              Every change below needs your account password. It is cleared after each one.
            </p>
            <ul>
              <For each={current.passkeys}>
                {(passkey) => (
                  <li>
                    {passkey.name}{" "}
                    <InlineConfirmButton
                      idleLabel={`remove ${passkey.name}`}
                      confirmLabel={`confirm removing ${passkey.name}`}
                      testId={`passkey-remove-${passkey.id}`}
                      disabled={busy()}
                      armed={armedRemoval() === passkey.id}
                      onArm={() => setArmedRemoval(passkey.id)}
                      onConfirm={() => void remove(passkey.id)}
                    />
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
            <Show when={current.mode !== "disabled"}>
              <button type="button" disabled={busy()} onClick={() => void disablePasskeyLogin()}>
                return to password login
              </button>
              <p role="note">
                Requires your account password and current passkey. Passwordless recovery codes are
                removed.
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
