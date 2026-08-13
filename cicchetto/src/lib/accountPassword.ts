import { errorMessage } from "./friendlyApiError";

// The security pane's re-auth gate, shared by every control that spends the
// account password.
//
// #729 wrote it for the passkey pane's five privileged verbs, after four of
// them read the add-passkey form's field behind the user's back: a user who
// never filled that form sent `""` and earned a bare 401, and a password
// typed to ADD a passkey stayed live in the signal, silently re-usable to
// change how the account authenticates.
//
// #1283 gave the TOTP section its second and third consumers (enrolment now
// re-authenticates too), which is why the gate moved out of the component:
// two copies of "refuse an empty field, clear it afterwards" would drift,
// and the refusal a user reads must not depend on which section they are in.
export const ACCOUNT_PASSWORD_REQUIRED = "Enter your account password to confirm this change.";

// The four signal accessors the gate drives. Each section keeps its own
// field — one shared field across the pane would let a password typed for
// one section be spent by another.
export type AccountPasswordGate = {
  password: () => string;
  setPassword: (value: string) => void;
  setBusy: (value: boolean) => void;
  setError: (value: string | null) => void;
};

// Runs `action` with the typed password, or refuses locally when the field
// is empty — naming the blocker instead of spending a doomed request.
//
// The field is cleared in the `finally`: on success AND on failure, so
// neither a good password nor a wrong one lingers for the next click to
// reuse. Re-typing IS the per-action re-confirmation a pane that changes how
// the account authenticates owes its user.
export async function withAccountPassword(
  gate: AccountPasswordGate,
  action: (accountPassword: string) => Promise<void>,
): Promise<void> {
  gate.setError(null);
  const accountPassword = gate.password();
  if (accountPassword === "") {
    gate.setError(ACCOUNT_PASSWORD_REQUIRED);
    return;
  }
  gate.setBusy(true);
  try {
    await action(accountPassword);
  } catch (value) {
    gate.setError(errorMessage(value));
  } finally {
    gate.setBusy(false);
    gate.setPassword("");
  }
}
