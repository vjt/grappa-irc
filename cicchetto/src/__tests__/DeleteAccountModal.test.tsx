import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #157 — the irreversibility gate. The destructive button stays DISABLED
// until the operator types their exact account name / nick; on confirm it
// fires `deleteAccount()` (lib/lifecycle) then navigates to /login. A
// failed wipe surfaces inline and does NOT navigate (the account still
// exists). The lifecycle wiring (calls DELETE /me, clears the bearer) has
// dedicated coverage in lib/lifecycle.test.ts; this owns the GATE.

const navigateMock = vi.fn();
vi.mock("@solidjs/router", () => ({
  useNavigate: () => navigateMock,
}));

const deleteAccountMock = vi.fn();
vi.mock("../lib/lifecycle", () => ({
  deleteAccount: () => deleteAccountMock(),
}));

// #232 — DeleteAccountModal now registers via createOverlayLock (Esc closes
// via the shared overlay stack). No-op it here; the Esc-close is covered
// end-to-end in the issue232 e2e matrix (this modal opens from the settings
// drawer, which the e2e drives).
vi.mock("../lib/overlayScrollLock", () => ({
  createOverlayLock: vi.fn(),
}));

import DeleteAccountModal from "../DeleteAccountModal";

beforeEach(() => {
  vi.clearAllMocks();
  deleteAccountMock.mockResolvedValue(undefined);
});

describe("DeleteAccountModal", () => {
  it("does not render when open=false", () => {
    render(() => <DeleteAccountModal open={false} onClose={vi.fn()} confirmationText="vjt" />);
    expect(screen.queryByTestId("delete-account-modal")).not.toBeInTheDocument();
  });

  it("the destructive button is DISABLED until the typed text matches exactly", async () => {
    render(() => <DeleteAccountModal open={true} onClose={vi.fn()} confirmationText="vjt" />);

    const confirm = screen.getByTestId("delete-account-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    const input = screen.getByTestId("delete-account-confirm-input") as HTMLInputElement;

    // A partial / wrong echo keeps it disabled.
    fireEvent.input(input, { target: { value: "vj" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.input(input, { target: { value: "VJT" } });
    expect(confirm.disabled).toBe(true);

    // Exact match arms it.
    fireEvent.input(input, { target: { value: "vjt" } });
    expect(confirm.disabled).toBe(false);
  });

  it("confirming calls deleteAccount then navigates to /login", async () => {
    render(() => <DeleteAccountModal open={true} onClose={vi.fn()} confirmationText="vjt" />);

    fireEvent.input(screen.getByTestId("delete-account-confirm-input"), {
      target: { value: "vjt" },
    });
    fireEvent.click(screen.getByTestId("delete-account-confirm"));

    await waitFor(() => {
      expect(deleteAccountMock).toHaveBeenCalled();
    });
    expect(navigateMock).toHaveBeenCalledWith("/login", { replace: true });
  });

  it("a failed wipe surfaces an error and does NOT navigate (account still exists)", async () => {
    deleteAccountMock.mockRejectedValueOnce(new Error("forbidden"));
    render(() => <DeleteAccountModal open={true} onClose={vi.fn()} confirmationText="vjt" />);

    fireEvent.input(screen.getByTestId("delete-account-confirm-input"), {
      target: { value: "vjt" },
    });
    fireEvent.click(screen.getByTestId("delete-account-confirm"));

    await waitFor(() => {
      expect(screen.getByTestId("delete-account-error")).toHaveTextContent("forbidden");
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("backdrop click fires onClose", () => {
    const onClose = vi.fn();
    render(() => <DeleteAccountModal open={true} onClose={onClose} confirmationText="vjt" />);
    fireEvent.click(screen.getByTestId("delete-account-backdrop"));
    expect(onClose).toHaveBeenCalled();
  });
});
