import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  deletePasskey: vi.fn(),
  finishPasskeyModeChange: vi.fn(),
  finishPasskeyRegistration: vi.fn(),
  getPasskeyStatus: vi.fn(),
  preparePasswordless: vi.fn(),
  startPasskeyModeChange: vi.fn(),
  startPasskeyRegistration: vi.fn(),
}));

// #726 — spread from the real module (mirroring TotpSettings.test.tsx) so
// `ApiError` stays the genuine class. The pane's error reporting narrows on
// `instanceof ApiError` to pick friendly copy over the raw `<status> <code>`
// wire token, and a hand-rolled stand-in silently takes the wrong arm.
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    deletePasskey: api.deletePasskey,
    finishPasskeyModeChange: api.finishPasskeyModeChange,
    finishPasskeyRegistration: api.finishPasskeyRegistration,
    getPasskeyStatus: api.getPasskeyStatus,
    preparePasswordless: api.preparePasswordless,
    startPasskeyModeChange: api.startPasskeyModeChange,
    startPasskeyRegistration: api.startPasskeyRegistration,
    startPasswordlessActivation: vi.fn(),
  };
});

vi.mock("../lib/auth", () => ({ token: () => "test-token" }));

const passkeys = vi.hoisted(() => ({
  createPasskey: vi.fn(),
  getPasskey: vi.fn(),
}));

vi.mock("../lib/passkeys", () => ({
  createPasskey: passkeys.createPasskey,
  getPasskey: passkeys.getPasskey,
}));

import { ApiError } from "../lib/api";
import PasskeySettings from "../PasskeySettings";

describe("PasskeySettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.deletePasskey.mockResolvedValue(undefined);
    api.preparePasswordless.mockResolvedValue({
      recovery_codes: ["aaa-111", "bbb-222"],
      recovery_token: "recovery-1",
    });
    api.getPasskeyStatus.mockResolvedValue({
      mode: "passwordless",
      passkeys: [
        {
          id: "passkey-1",
          name: "phone",
          inserted_at: "2026-08-03T00:00:00Z",
          last_used_at: null,
        },
      ],
    });
    api.startPasskeyModeChange.mockResolvedValue({ challenge_id: "challenge" });
    api.finishPasskeyModeChange.mockResolvedValue({ mode: "disabled" });
    api.startPasskeyRegistration.mockResolvedValue({ challenge_id: "challenge", public_key: {} });
    api.finishPasskeyRegistration.mockResolvedValue(undefined);
    passkeys.createPasskey.mockResolvedValue({ attestation: true });
    passkeys.getPasskey.mockResolvedValue({ assertion: true });
  });

  const addPasskey = async (): Promise<void> => {
    await fireEvent.input(screen.getByLabelText("Passkey name"), { target: { value: "phone" } });
    await fireEvent.input(screen.getByLabelText("Account password"), {
      target: { value: "correct horse battery staple" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "add passkey" }));
  };

  it("registers a passkey with the name and password entered", async () => {
    render(() => <PasskeySettings />);

    await screen.findByText("Mode: passwordless");
    await addPasskey();

    await waitFor(() =>
      expect(api.startPasskeyRegistration).toHaveBeenCalledWith(
        "test-token",
        "correct horse battery staple",
        "phone",
      ),
    );
    expect(api.finishPasskeyRegistration).toHaveBeenCalledWith("test-token", {
      attestation: true,
    });
  });

  // #736 — a dismissed WebAuthn prompt rejects mid-`register()`. The pane
  // must NAME the reason and stay usable: `busy` is set before the ceremony
  // and only the `finally` clears it, so a regression there leaves every
  // button in the pane permanently disabled with no way back but a reload.
  it("reports a cancelled ceremony and leaves the pane usable for a retry", async () => {
    passkeys.createPasskey.mockRejectedValue(new Error("Passkey creation cancelled"));
    render(() => <PasskeySettings />);

    await screen.findByText("Mode: passwordless");
    await addPasskey();

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Passkey creation cancelled"),
    );
    expect(api.finishPasskeyRegistration).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "add passkey" })).not.toBeDisabled();
    // The typed name survives — the retry does not start from a blank form.
    expect((screen.getByLabelText("Passkey name") as HTMLInputElement).value).toBe("phone");
  });

  // #726 — `ApiError.message` is the literal `${status} ${code}`, so a pane
  // that reports `value.message` prints a wire token at the user. The sibling
  // TOTP pane already routes through `friendlyApiError`; this one did not.
  it("renders friendly copy for a server error instead of the raw wire token", async () => {
    api.startPasskeyRegistration.mockRejectedValue(new ApiError(401, "invalid_credentials"));
    render(() => <PasskeySettings />);

    await screen.findByText("Mode: passwordless");
    await addPasskey();

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Invalid name or password."),
    );
    expect(screen.queryByText(/401 invalid_credentials/)).toBeNull();
  });

  it("renders friendly copy when a removal is refused, not the raw wire token", async () => {
    // #696's `passkey_required` 409 is the removal a user is most likely to
    // trip — the last passkey while passkey sign-in is still on.
    api.deletePasskey.mockRejectedValue(new ApiError(409, "passkey_required"));
    render(() => <PasskeySettings />);

    await screen.findByText("Mode: passwordless");
    await fireEvent.input(screen.getByLabelText("Account password"), {
      target: { value: "correct horse battery staple" },
    });
    await fireEvent.click(screen.getByTestId("passkey-remove-passkey-1"));
    await fireEvent.click(screen.getByTestId("passkey-remove-passkey-1"));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/only passkey/i));
    expect(screen.queryByText(/409 passkey_required/)).toBeNull();
  });

  it("returns a passwordless account to password login with password and passkey", async () => {
    render(() => <PasskeySettings />);

    await screen.findByText("Mode: passwordless");
    await fireEvent.input(screen.getByLabelText("Account password"), {
      target: { value: "correct horse battery staple" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "return to password login" }));

    await waitFor(() =>
      expect(api.startPasskeyModeChange).toHaveBeenCalledWith(
        "test-token",
        "correct horse battery staple",
        "disabled",
      ),
    );
    expect(api.finishPasskeyModeChange).toHaveBeenCalledWith("test-token", { assertion: true });
  });
});
