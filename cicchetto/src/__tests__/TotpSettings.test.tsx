import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

// #736 — the TOTP enrolment surface shipped with no component coverage: the
// only tests over the security pane drove `auth.ts` (the store) or the
// passkey pane. What was missing is the FAILURE half — a wrong or expired
// code — which is the branch a real user hits, and the branch that decides
// whether the pane stays usable or strands them.
//
// `lib/api` is spread from the real module so `ApiError` stays the genuine
// class: `reportError` narrows on `instanceof ApiError` to pick friendly
// copy over `String(value)`, and a hand-rolled stand-in silently takes the
// wrong arm.

const api = vi.hoisted(() => ({
  confirmTotpEnrollment: vi.fn(),
  disableTotp: vi.fn(),
  getPasskeyStatus: vi.fn(),
  getTotpStatus: vi.fn(),
  startTotpEnrollment: vi.fn(),
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, ...api };
});

vi.mock("../lib/auth", () => ({ token: () => "test-token" }));

vi.mock("../lib/passkeys", () => ({
  createPasskey: vi.fn(),
  getPasskey: vi.fn(),
}));

import { ApiError } from "../lib/api";
import TotpSettings from "../TotpSettings";

const ENROLLMENT = {
  enrollment_token: "enrol-1",
  secret: "JBSWY3DPEHPK3PXP",
  provisioning_uri: "otpauth://totp/grappa:alice?secret=JBSWY3DPEHPK3PXP&issuer=grappa",
};

const renderSettings = () => render(() => <TotpSettings onBack={() => undefined} />);

const beginEnrollment = async (): Promise<void> => {
  await fireEvent.click(await screen.findByRole("button", { name: "enable TOTP" }));
  await screen.findByTestId("totp-enrollment-form");
};

const confirmCode = async (code: string): Promise<void> => {
  await fireEvent.input(screen.getByLabelText("Authenticator code"), { target: { value: code } });
  await fireEvent.click(screen.getByRole("button", { name: "confirm and enable" }));
};

describe("TotpSettings — enrolment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getTotpStatus.mockResolvedValue({ enabled: false });
    api.getPasskeyStatus.mockResolvedValue({ mode: "disabled", passkeys: [] });
    api.startTotpEnrollment.mockResolvedValue(ENROLLMENT);
  });

  it("shows the manual key so an unscannable QR is not a dead end", async () => {
    renderSettings();
    await beginEnrollment();

    expect((screen.getByLabelText("Manual key") as HTMLInputElement).value).toBe(ENROLLMENT.secret);
  });

  it("enables TOTP and shows the recovery codes once the code is confirmed", async () => {
    api.confirmTotpEnrollment.mockResolvedValue({ recovery_codes: ["aaa-111", "bbb-222"] });
    renderSettings();
    await beginEnrollment();
    await confirmCode("123456");

    await waitFor(() => expect(screen.getByTestId("totp-recovery-codes")).toBeInTheDocument());
    expect(api.confirmTotpEnrollment).toHaveBeenCalledWith("test-token", "enrol-1", "123456");
    expect(screen.getByText("aaa-111")).toBeInTheDocument();
  });

  // The cancel/failure path: a wrong or already-used code. The enrolment
  // MUST survive it — dropping the pending enrolment here would send the
  // user back to a fresh QR (and a fresh secret) after one typo, silently
  // invalidating the one they already scanned into their authenticator.
  it("keeps the enrolment alive and names the failure on a wrong code", async () => {
    api.confirmTotpEnrollment.mockRejectedValue(new ApiError(401, "invalid_two_factor"));
    renderSettings();
    await beginEnrollment();
    await confirmCode("000000");

    await waitFor(() =>
      expect(within(screen.getByTestId("totp-settings")).getByRole("alert")).toHaveTextContent(
        "Invalid or already-used authenticator/recovery code.",
      ),
    );
    expect(screen.getByTestId("totp-enrollment-form")).toBeInTheDocument();
    expect((screen.getByLabelText("Manual key") as HTMLInputElement).value).toBe(ENROLLMENT.secret);
    expect(screen.getByRole("button", { name: "confirm and enable" })).not.toBeDisabled();
    expect(screen.queryByTestId("totp-recovery-codes")).toBeNull();
  });

  // #726 — the recovery codes are shown EXACTLY once. A copy that fails and
  // says nothing sends the user away believing ten one-shot codes are on the
  // clipboard; the codes are gone the moment the pane re-renders. Both arms
  // are reachable on a plain-http instance, where `navigator.clipboard` is
  // `undefined` (the API is [SecureContext]-only) — not a hypothetical.
  const showRecoveryCodes = async (): Promise<void> => {
    api.confirmTotpEnrollment.mockResolvedValue({ recovery_codes: ["aaa-111", "bbb-222"] });
    renderSettings();
    await beginEnrollment();
    await confirmCode("123456");
    await screen.findByTestId("totp-recovery-codes");
  };

  const withClipboard = (value: unknown): void => {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value, configurable: true });
    onTestFinished(() => {
      if (original === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
      } else {
        Object.defineProperty(navigator, "clipboard", original);
      }
    });
  };

  it("names a rejected clipboard write instead of losing the codes silently", async () => {
    withClipboard({ writeText: vi.fn().mockRejectedValue(new Error("Write permission denied.")) });
    await showRecoveryCodes();

    await fireEvent.click(screen.getByRole("button", { name: "copy recovery codes" }));

    await waitFor(() =>
      expect(within(screen.getByTestId("totp-settings")).getByRole("alert")).toHaveTextContent(
        "Write permission denied.",
      ),
    );
    // The codes stay on screen — the user's fallback is to copy them by hand.
    expect(screen.getByText("aaa-111")).toBeInTheDocument();
  });

  it("names a missing clipboard API instead of throwing a raw TypeError", async () => {
    withClipboard(undefined);
    await showRecoveryCodes();

    await fireEvent.click(screen.getByRole("button", { name: "copy recovery codes" }));

    await waitFor(() =>
      expect(within(screen.getByTestId("totp-settings")).getByRole("alert")).toHaveTextContent(
        /secure/i,
      ),
    );
    expect(screen.getByText("aaa-111")).toBeInTheDocument();
  });

  it("surfaces a rejected password when disabling instead of silently no-opping", async () => {
    api.getTotpStatus.mockResolvedValue({ enabled: true });
    api.disableTotp.mockRejectedValue(new ApiError(401, "invalid_credentials"));
    renderSettings();

    // Scoped: the passkey pane below renders its own "Account password"
    // field, so an unscoped query matches two inputs.
    const form = await screen.findByTestId("totp-disable-form");
    await fireEvent.input(within(form).getByLabelText("Account password"), {
      target: { value: "wrong" },
    });
    await fireEvent.click(within(form).getByRole("button", { name: "disable TOTP" }));

    await waitFor(() =>
      expect(within(screen.getByTestId("totp-settings")).getByRole("alert")).toHaveTextContent(
        "Invalid name or password.",
      ),
    );
    // Still enabled: the pane must not claim a disable that never happened.
    expect(screen.getByTestId("totp-disable-form")).toBeInTheDocument();
  });
});
