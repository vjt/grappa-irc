import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminUser } from "../lib/api";

vi.mock("../lib/auth", () => ({
  token: () => "test-bearer",
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    adminListUsers: vi.fn(),
    adminCreateUser: vi.fn(),
    adminUpdateUserAdmin: vi.fn(),
    adminUpdateUserPassword: vi.fn(),
    adminDeleteUser: vi.fn(),
  };
});

import AdminUsersTab from "../AdminUsersTab";
import {
  adminCreateUser,
  adminDeleteUser,
  adminListUsers,
  adminUpdateUserAdmin,
  adminUpdateUserPassword,
} from "../lib/api";

// Admin-panel bucket 5 — Users tab unit suite. Covers:
//   * list render from a successful GET /admin/users
//   * create flow: form populated → submit → adminCreateUser called → refresh
//   * Promote/Demote inline toggle round-trip
//   * Rotate-password inline form open/cancel/submit
//   * Delete InlineConfirm splice flow
//   * Error surfaces (banner + retry instruction)
//
// Server-side bucket 4 emits :user_* admin events; this suite does
// NOT verify the WS broadcast (that's covered by adminEvents.test.ts
// + the controller_test ExUnit suites). It verifies the REST round-
// trip + UI behavior.

const ALICE: AdminUser = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "alice",
  is_admin: false,
  inserted_at: "2026-05-31T00:00:00Z",
  updated_at: "2026-05-31T00:00:00Z",
  live_session_count: 0,
};

const BOB_ADMIN: AdminUser = {
  id: "00000000-0000-0000-0000-000000000002",
  name: "bob",
  is_admin: true,
  inserted_at: "2026-05-31T00:00:00Z",
  updated_at: "2026-05-31T00:00:00Z",
  live_session_count: 2,
};

beforeEach(() => {
  vi.resetAllMocks();
  (adminListUsers as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([ALICE, BOB_ADMIN]);
});

describe("AdminUsersTab — list render", () => {
  it("renders one row per user with name + is_admin badge + live count", async () => {
    render(() => <AdminUsersTab />);
    await waitFor(() => expect(screen.queryByTestId("admin-users-table")).not.toBeNull());

    expect(screen.queryByTestId(`admin-user-row-${ALICE.id}`)).not.toBeNull();
    expect(screen.queryByTestId(`admin-user-row-${BOB_ADMIN.id}`)).not.toBeNull();
    expect(screen.getByText("alice")).toBeDefined();
    expect(screen.getByText("bob")).toBeDefined();
  });

  it("renders empty state when no users", async () => {
    (adminListUsers as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    render(() => <AdminUsersTab />);
    await waitFor(() => expect(screen.queryByTestId("admin-users-empty")).not.toBeNull());
  });

  it("renders error banner when the fetch fails", async () => {
    (adminListUsers as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("net down"),
    );
    render(() => <AdminUsersTab />);
    await waitFor(() => expect(screen.queryByTestId("admin-users-error")).not.toBeNull());
  });
});

describe("AdminUsersTab — create flow", () => {
  it("submits the create form and refetches", async () => {
    (adminCreateUser as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...ALICE,
      id: "new",
      name: "carol",
    });
    render(() => <AdminUsersTab />);
    await waitFor(() => expect(screen.queryByTestId("admin-users-table")).not.toBeNull());

    const name = screen.getByTestId("admin-users-create-name") as HTMLInputElement;
    const pw = screen.getByTestId("admin-users-create-password") as HTMLInputElement;
    fireEvent.input(name, { target: { value: "carol" } });
    fireEvent.input(pw, { target: { value: "secret-pass-1234" } });
    fireEvent.click(screen.getByTestId("admin-users-create-submit"));

    await waitFor(() => {
      expect(adminCreateUser).toHaveBeenCalledWith(
        "test-bearer",
        expect.objectContaining({ name: "carol", password: "secret-pass-1234", is_admin: false }),
      );
    });
    // Refetch fired
    await waitFor(() => expect(adminListUsers).toHaveBeenCalledTimes(2));
  });

  it("includes is_admin: true when the checkbox is set", async () => {
    (adminCreateUser as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...ALICE,
      id: "new",
    });
    render(() => <AdminUsersTab />);
    await waitFor(() => expect(screen.queryByTestId("admin-users-table")).not.toBeNull());

    fireEvent.input(screen.getByTestId("admin-users-create-name"), {
      target: { value: "dora" },
    });
    fireEvent.input(screen.getByTestId("admin-users-create-password"), {
      target: { value: "secret-pass-1234" },
    });
    fireEvent.click(screen.getByTestId("admin-users-create-is-admin"));
    fireEvent.click(screen.getByTestId("admin-users-create-submit"));

    await waitFor(() => {
      expect(adminCreateUser).toHaveBeenCalledWith(
        "test-bearer",
        expect.objectContaining({ is_admin: true }),
      );
    });
  });
});

describe("AdminUsersTab — admin toggle", () => {
  it("flips is_admin via Promote/Demote button", async () => {
    (adminUpdateUserAdmin as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...ALICE,
      is_admin: true,
    });
    render(() => <AdminUsersTab />);
    await waitFor(() => expect(screen.queryByTestId("admin-users-table")).not.toBeNull());

    fireEvent.click(screen.getByTestId(`admin-user-toggle-admin-${ALICE.id}`));

    await waitFor(() => {
      expect(adminUpdateUserAdmin).toHaveBeenCalledWith("test-bearer", ALICE.id, true);
    });
  });
});

describe("AdminUsersTab — password rotation", () => {
  it("opens form on click, submits to update endpoint, then closes", async () => {
    (adminUpdateUserPassword as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ALICE);
    render(() => <AdminUsersTab />);
    await waitFor(() => expect(screen.queryByTestId("admin-users-table")).not.toBeNull());

    fireEvent.click(screen.getByTestId(`admin-user-rotate-password-${ALICE.id}`));
    const input = screen.getByTestId(`admin-user-rotate-input-${ALICE.id}`) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "new-pass-1234567890" } });
    fireEvent.click(screen.getByTestId(`admin-user-rotate-submit-${ALICE.id}`));

    await waitFor(() => {
      expect(adminUpdateUserPassword).toHaveBeenCalledWith(
        "test-bearer",
        ALICE.id,
        "new-pass-1234567890",
      );
    });
    // After success, form closes (refetch fires).
    await waitFor(() => expect(adminListUsers).toHaveBeenCalledTimes(2));
  });

  it("Cancel closes the form without calling the API", async () => {
    render(() => <AdminUsersTab />);
    await waitFor(() => expect(screen.queryByTestId("admin-users-table")).not.toBeNull());

    fireEvent.click(screen.getByTestId(`admin-user-rotate-password-${ALICE.id}`));
    expect(screen.queryByTestId(`admin-user-rotate-form-${ALICE.id}`)).not.toBeNull();
    fireEvent.click(screen.getByTestId(`admin-user-rotate-cancel-${ALICE.id}`));
    await waitFor(() => {
      expect(screen.queryByTestId(`admin-user-rotate-form-${ALICE.id}`)).toBeNull();
    });
    expect(adminUpdateUserPassword).not.toHaveBeenCalled();
  });
});

describe("AdminUsersTab — delete flow", () => {
  it("inline-confirm arms then deletes and splices the row", async () => {
    (adminDeleteUser as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    render(() => <AdminUsersTab />);
    await waitFor(() => expect(screen.queryByTestId("admin-users-table")).not.toBeNull());

    const btn = screen.getByTestId(`admin-user-delete-${ALICE.id}`);
    expect(btn.textContent).toBe("Delete");
    fireEvent.click(btn);
    expect(btn.textContent).toBe("Confirm delete?");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(adminDeleteUser).toHaveBeenCalledWith("test-bearer", ALICE.id);
    });
    // Row spliced out.
    await waitFor(() => {
      expect(screen.queryByTestId(`admin-user-row-${ALICE.id}`)).toBeNull();
    });
  });

  it("surfaces last_admin error when server refuses", async () => {
    const err = Object.assign(new Error("last_admin"), {
      status: 422,
      code: "last_admin",
      info: {},
    });
    // Reach in via instanceof ApiError class — re-import to dodge mock.
    const api = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    const apiErr = new api.ApiError(422, "last_admin", {});
    (adminDeleteUser as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(apiErr);
    void err; // shape kept for parity; mock uses apiErr

    render(() => <AdminUsersTab />);
    await waitFor(() => expect(screen.queryByTestId("admin-users-table")).not.toBeNull());

    const btn = screen.getByTestId(`admin-user-delete-${BOB_ADMIN.id}`);
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(screen.queryByTestId("admin-users-error")).not.toBeNull());
    expect(screen.getByTestId("admin-users-error").textContent).toContain("last_admin");
  });
});

// #943 — the three write verbs whose controller `@spec` admits an
// `Ecto.Changeset.t()` (create / update / update_password) can answer 422
// `validation_failed` with per-field detail in `field_errors`. The banner
// rendered `err.code` alone, so "must start with a letter…" — the only text
// that says WHAT to type instead — never reached the operator.
//
// The raw wire token STAYS: that is written operator-console policy
// (AdminSettingsTab lines 33-35), not an oversight. The detail is APPENDED.
// `delete` and the list GET are deliberately absent: neither can produce a
// changeset (users_controller.ex:53 / :176), so a branch there is dead code.
describe("AdminUsersTab — 422 field_errors detail (#943)", () => {
  const NAME_MSG = "must start with a letter, then alphanumeric/_/-";

  const validationError = async (info: Record<string, unknown>) => {
    // Re-import to dodge the module mock: the component narrows on
    // `instanceof ApiError`, so the rejection must be the real class.
    const api = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    return new api.ApiError(422, "validation_failed", info);
  };

  const submitCreate = (name: string): void => {
    fireEvent.input(screen.getByTestId("admin-users-create-name"), { target: { value: name } });
    fireEvent.input(screen.getByTestId("admin-users-create-password"), {
      target: { value: "secret-pass-1234" },
    });
    fireEvent.click(screen.getByTestId("admin-users-create-submit"));
  };

  it("create surfaces the wire token AND the offending field", async () => {
    (adminCreateUser as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      await validationError({ field_errors: { name: [NAME_MSG] } }),
    );
    render(() => <AdminUsersTab />);
    await waitFor(() => expect(screen.queryByTestId("admin-users-table")).not.toBeNull());

    submitCreate("9bad");

    await waitFor(() => expect(screen.queryByTestId("admin-users-error")).not.toBeNull());
    const banner = screen.getByTestId("admin-users-error").textContent ?? "";
    expect(banner).toContain("create: validation_failed");
    expect(banner).toContain(`name: ${NAME_MSG}`);
  });

  it("create with no field_errors renders exactly today's bare-token banner", async () => {
    (adminCreateUser as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      await validationError({}),
    );
    render(() => <AdminUsersTab />);
    await waitFor(() => expect(screen.queryByTestId("admin-users-table")).not.toBeNull());

    submitCreate("carol");

    await waitFor(() => expect(screen.queryByTestId("admin-users-error")).not.toBeNull());
    expect(screen.getByTestId("admin-users-error").textContent).toBe(
      "failed: create: validation_failed — click ↻ refresh to retry",
    );
  });

  it("admin toggle surfaces the wire token AND the offending field", async () => {
    (adminUpdateUserAdmin as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      await validationError({ field_errors: { is_admin: ["is invalid"] } }),
    );
    render(() => <AdminUsersTab />);
    await waitFor(() => expect(screen.queryByTestId("admin-users-table")).not.toBeNull());

    fireEvent.click(screen.getByTestId(`admin-user-toggle-admin-${ALICE.id}`));

    await waitFor(() => expect(screen.queryByTestId("admin-users-error")).not.toBeNull());
    const banner = screen.getByTestId("admin-users-error").textContent ?? "";
    expect(banner).toContain("toggle admin (alice): validation_failed");
    expect(banner).toContain("is_admin: is invalid");
  });

  it("password rotation surfaces the wire token AND the offending field", async () => {
    (adminUpdateUserPassword as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      await validationError({ field_errors: { password: ["should be at least 8 character(s)"] } }),
    );
    render(() => <AdminUsersTab />);
    await waitFor(() => expect(screen.queryByTestId("admin-users-table")).not.toBeNull());

    fireEvent.click(screen.getByTestId(`admin-user-rotate-password-${ALICE.id}`));
    fireEvent.input(screen.getByTestId(`admin-user-rotate-input-${ALICE.id}`), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByTestId(`admin-user-rotate-submit-${ALICE.id}`));

    await waitFor(() => expect(screen.queryByTestId("admin-users-error")).not.toBeNull());
    const banner = screen.getByTestId("admin-users-error").textContent ?? "";
    expect(banner).toContain("rotate password (alice): validation_failed");
    expect(banner).toContain("password: should be at least 8 character(s)");
  });
});
