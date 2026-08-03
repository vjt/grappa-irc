import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  finishPasskeyModeChange: vi.fn(),
  getPasskeyStatus: vi.fn(),
  startPasskeyModeChange: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  deletePasskey: vi.fn(),
  finishPasskeyModeChange: api.finishPasskeyModeChange,
  finishPasskeyRegistration: vi.fn(),
  getPasskeyStatus: api.getPasskeyStatus,
  preparePasswordless: vi.fn(),
  startPasskeyModeChange: api.startPasskeyModeChange,
  startPasskeyRegistration: vi.fn(),
  startPasswordlessActivation: vi.fn(),
}));

vi.mock("../lib/auth", () => ({ token: () => "test-token" }));

vi.mock("../lib/passkeys", () => ({
  createPasskey: vi.fn(),
  getPasskey: vi.fn().mockResolvedValue({ assertion: true }),
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
