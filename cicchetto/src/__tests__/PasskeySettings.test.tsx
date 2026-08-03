import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  finishPasskeyModeChange: vi.fn(),
  finishPasskeyRegistration: vi.fn(),
  getPasskeyStatus: vi.fn(),
  startPasskeyModeChange: vi.fn(),
  startPasskeyRegistration: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  deletePasskey: vi.fn(),
  finishPasskeyModeChange: api.finishPasskeyModeChange,
  finishPasskeyRegistration: api.finishPasskeyRegistration,
  getPasskeyStatus: api.getPasskeyStatus,
  preparePasswordless: vi.fn(),
  startPasskeyModeChange: api.startPasskeyModeChange,
  startPasskeyRegistration: api.startPasskeyRegistration,
  startPasswordlessActivation: vi.fn(),
}));

vi.mock("../lib/auth", () => ({ token: () => "test-token" }));

const passkeys = vi.hoisted(() => ({
  createPasskey: vi.fn(),
  getPasskey: vi.fn(),
}));

vi.mock("../lib/passkeys", () => ({
  createPasskey: passkeys.createPasskey,
  getPasskey: passkeys.getPasskey,
}));

import PasskeySettings from "../PasskeySettings";

describe("PasskeySettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
