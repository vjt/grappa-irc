import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminCredential, AdminNetwork, AdminUser } from "../lib/api";

vi.mock("../lib/auth", () => ({
  token: () => "test-bearer",
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    adminListCredentials: vi.fn(),
    adminListUsers: vi.fn(),
    adminListNetworks: vi.fn(),
    adminBindCredential: vi.fn(),
    adminUpdateCredential: vi.fn(),
    adminUnbindCredential: vi.fn(),
  };
});

import AdminCredentialsTab from "../AdminCredentialsTab";
import {
  adminBindCredential,
  adminListCredentials,
  adminListNetworks,
  adminListUsers,
  adminUnbindCredential,
  adminUpdateCredential,
} from "../lib/api";

// Admin-panel bucket 5 — Credentials tab unit suite. Covers:
//   * triple-fetch on mount (credentials + users + networks)
//   * bind form round-trip (POST /admin/credentials)
//   * edit form with patch-diff: only changed fields go on the wire
//   * session_action toast surfaces :stopped vs :left_alone
//   * unbind splice via InlineConfirm
//   * U-0 honesty signal (live_state null → "BEAM has no pid")
//
// Backend admin-event emission verified in adminEvents.test.ts +
// credentials_controller_test.exs.

const USER: AdminUser = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "alice",
  is_admin: false,
  inserted_at: "2026-05-31T00:00:00Z",
  updated_at: "2026-05-31T00:00:00Z",
  live_session_count: 0,
};

const NETWORK: AdminNetwork = {
  id: 7,
  slug: "azzurra",
  max_concurrent_visitor_sessions: null,
  max_concurrent_user_sessions: null,
  max_per_client: null,
  inserted_at: "2026-05-31T00:00:00Z",
  updated_at: "2026-05-31T00:00:00Z",
  circuit_state: null,
  live_counts: { visitors: 0, users: 0 },
};

const CRED: AdminCredential = {
  user_id: USER.id,
  network_id: NETWORK.id,
  network_slug: NETWORK.slug,
  nick: "alice",
  realname: null,
  sasl_user: null,
  auth_method: "none",
  auth_command_template: null,
  autojoin_channels: ["#a"],
  last_joined_channels: [],
  connection_state: "connected",
  connection_state_reason: null,
  connection_state_changed_at: null,
  inserted_at: "2026-05-31T00:00:00Z",
  updated_at: "2026-05-31T00:00:00Z",
  live_state: {
    alive: true,
    pid_inspect: "#PID<0.1.0>",
    mailbox_len: 0,
    memory_bytes: 100,
    joined_channels: ["#a"],
    introspection_degraded: [],
  },
};

const ORPHAN_CRED: AdminCredential = {
  ...CRED,
  user_id: "00000000-0000-0000-0000-000000000002",
  nick: "ghost",
  live_state: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  (adminListCredentials as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
    CRED,
    ORPHAN_CRED,
  ]);
  (adminListUsers as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([USER]);
  (adminListNetworks as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([NETWORK]);
});

describe("AdminCredentialsTab — list render", () => {
  it("renders one row per credential with U-0 honesty signal for orphans", async () => {
    render(() => <AdminCredentialsTab />);
    await waitFor(() => expect(screen.queryByTestId("admin-credentials-table")).not.toBeNull());

    expect(screen.queryByTestId(`admin-credential-row-${CRED.user_id}:${CRED.network_id}`)).not
      .toBeNull();
    expect(
      screen.queryByTestId(`admin-credential-row-${ORPHAN_CRED.user_id}:${ORPHAN_CRED.network_id}`),
    ).not.toBeNull();
    expect(screen.getByText("BEAM has no pid")).toBeDefined();
  });
});

describe("AdminCredentialsTab — bind flow", () => {
  it("submits the bind form with parsed network_id", async () => {
    (adminBindCredential as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(CRED);
    render(() => <AdminCredentialsTab />);
    await waitFor(() => expect(screen.queryByTestId("admin-credentials-table")).not.toBeNull());

    fireEvent.change(screen.getByTestId("admin-credentials-bind-user"), {
      target: { value: USER.id },
    });
    fireEvent.change(screen.getByTestId("admin-credentials-bind-network"), {
      target: { value: String(NETWORK.id) },
    });
    fireEvent.input(screen.getByTestId("admin-credentials-bind-nick"), {
      target: { value: "newnick" },
    });
    fireEvent.click(screen.getByTestId("admin-credentials-bind-submit"));

    await waitFor(() => {
      expect(adminBindCredential).toHaveBeenCalledWith(
        "test-bearer",
        expect.objectContaining({
          user_id: USER.id,
          network_id: NETWORK.id,
          nick: "newnick",
        }),
      );
    });
  });
});

describe("AdminCredentialsTab — edit flow", () => {
  it("opens edit form, sends only changed fields, surfaces left_alone toast", async () => {
    (adminUpdateCredential as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...CRED,
      realname: "Alice Smith",
      session_action: "left_alone",
    });
    render(() => <AdminCredentialsTab />);
    await waitFor(() => expect(screen.queryByTestId("admin-credentials-table")).not.toBeNull());

    fireEvent.click(screen.getByTestId(`admin-credential-edit-${CRED.user_id}:${CRED.network_id}`));
    fireEvent.input(
      screen.getByTestId(`admin-credential-edit-realname-${CRED.user_id}:${CRED.network_id}`),
      { target: { value: "Alice Smith" } },
    );
    fireEvent.click(
      screen.getByTestId(`admin-credential-edit-submit-${CRED.user_id}:${CRED.network_id}`),
    );

    await waitFor(() => {
      expect(adminUpdateCredential).toHaveBeenCalledWith(
        "test-bearer",
        CRED.user_id,
        CRED.network_id,
        { realname: "Alice Smith" },
      );
    });
    await waitFor(() =>
      expect(screen.queryByTestId("admin-credentials-session-action-toast")).not.toBeNull(),
    );
  });

  it("password-touching edit surfaces stopped toast", async () => {
    (adminUpdateCredential as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...CRED,
      session_action: "stopped",
    });
    render(() => <AdminCredentialsTab />);
    await waitFor(() => expect(screen.queryByTestId("admin-credentials-table")).not.toBeNull());

    fireEvent.click(screen.getByTestId(`admin-credential-edit-${CRED.user_id}:${CRED.network_id}`));
    fireEvent.input(
      screen.getByTestId(`admin-credential-edit-password-${CRED.user_id}:${CRED.network_id}`),
      { target: { value: "new-irc-pass" } },
    );
    fireEvent.click(
      screen.getByTestId(`admin-credential-edit-submit-${CRED.user_id}:${CRED.network_id}`),
    );

    await waitFor(() => {
      expect(adminUpdateCredential).toHaveBeenCalledWith(
        "test-bearer",
        CRED.user_id,
        CRED.network_id,
        { password: "new-irc-pass" },
      );
    });
    await waitFor(() => {
      const toast = screen.queryByTestId("admin-credentials-session-action-toast");
      expect(toast).not.toBeNull();
      expect(toast?.textContent).toContain("stopped");
    });
  });
});

describe("AdminCredentialsTab — unbind flow", () => {
  it("inline-confirm unbinds and splices the row", async () => {
    (adminUnbindCredential as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    render(() => <AdminCredentialsTab />);
    await waitFor(() => expect(screen.queryByTestId("admin-credentials-table")).not.toBeNull());

    const btn = screen.getByTestId(`admin-credential-unbind-${CRED.user_id}:${CRED.network_id}`);
    expect(btn.textContent).toBe("Unbind");
    fireEvent.click(btn);
    expect(btn.textContent).toBe("Confirm unbind?");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(adminUnbindCredential).toHaveBeenCalledWith(
        "test-bearer",
        CRED.user_id,
        CRED.network_id,
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId(`admin-credential-row-${CRED.user_id}:${CRED.network_id}`))
        .toBeNull();
    });
  });
});
