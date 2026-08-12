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
    adminListNetworks: vi.fn(),
    adminBindCredential: vi.fn(),
    adminUpdateCredential: vi.fn(),
    adminUnbindCredential: vi.fn(),
  };
});

import AdminUserPage from "../AdminUserPage";
import {
  adminBindCredential,
  adminListCredentials,
  adminListNetworks,
  adminUnbindCredential,
  adminUpdateCredential,
} from "../lib/api";

// #1158 — the per-user admin page, the ONE surface that owns a user's
// network access now that the Credentials tab is gone.
//
// The page is per-USER, so the invariants this suite defends are the ones
// the deleted tab never had to hold:
//
//   * it renders THIS user's networks and no one else's (the list endpoint
//     is unfiltered — see the `filters` note in the page);
//   * the user is the page, so adding a network asks for a network, never
//     for a user;
//   * `session_action` is per-ROW state carrying all FOUR values. The tab
//     it replaces surfaced two, and only for PATCH: `onBind` dropped the
//     POST reply on the floor, so `spawned` / `not_spawned` had no operator
//     surface at all;
//   * a row shows the DB state AND the live state side by side, which is
//     the two-sources rule and the witness `issue1163-admin-bind-dials`
//     reads.

const USER: AdminUser = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "alice",
  is_admin: false,
  inserted_at: "2026-05-31T00:00:00Z",
  updated_at: "2026-05-31T00:00:00Z",
  live_session_count: 0,
};

const OTHER_USER_ID = "00000000-0000-0000-0000-000000000002";

const NETWORK: AdminNetwork = {
  id: 7,
  slug: "azzurra",
  services_flavor: null,
  visitor_enabled: false,
  visitor_autoconnect: false,
  max_concurrent_visitor_sessions: null,
  max_concurrent_user_sessions: null,
  max_per_ip: null,
  inserted_at: "2026-05-31T00:00:00Z",
  updated_at: "2026-05-31T00:00:00Z",
  circuit_state: null,
  live_counts: { visitors: 0, users: 0 },
};

const OTHER_NETWORK: AdminNetwork = { ...NETWORK, id: 9, slug: "libera" };

const CRED: AdminCredential = {
  last_seen_at: null,
  user_id: USER.id,
  network_id: NETWORK.id,
  network_slug: NETWORK.slug,
  nick: "alice",
  ident: null,
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
    nick: "alice",
    alive: true,
    pid_inspect: "#PID<0.1.0>",
    mailbox_len: 0,
    memory_bytes: 100,
    joined_channels: ["#a"],
    introspection_degraded: [],
  },
};

// Same shape, different OWNER. Present in every mount fetch, so any test
// that finds it on the page has caught a missing owner filter.
const FOREIGN_CRED: AdminCredential = {
  ...CRED,
  user_id: OTHER_USER_ID,
  network_id: OTHER_NETWORK.id,
  network_slug: OTHER_NETWORK.slug,
  nick: "bob",
};

const ORPHAN_CRED: AdminCredential = {
  ...CRED,
  network_id: OTHER_NETWORK.id,
  network_slug: OTHER_NETWORK.slug,
  nick: "ghost",
  live_state: null,
};

function mountPage(onBack: () => void = () => {}): void {
  render(() => <AdminUserPage user={USER} onBack={onBack} />);
}

async function pageReady(): Promise<void> {
  await waitFor(() => expect(screen.queryByTestId("admin-user-networks-table")).not.toBeNull());
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(adminListCredentials).mockResolvedValue([CRED, FOREIGN_CRED]);
  vi.mocked(adminListNetworks).mockResolvedValue([NETWORK, OTHER_NETWORK]);
});

describe("AdminUserPage — the user's networks", () => {
  it("renders this user's networks and never another user's", async () => {
    mountPage();
    await pageReady();

    expect(screen.queryByTestId(`admin-user-network-row-${NETWORK.id}`)).not.toBeNull();
    expect(screen.queryByTestId(`admin-user-network-row-${OTHER_NETWORK.id}`)).toBeNull();
  });

  it("shows the DB state and the live state side by side", async () => {
    vi.mocked(adminListCredentials).mockResolvedValue([CRED, ORPHAN_CRED]);
    mountPage();
    await pageReady();

    const connected = screen.getByTestId(`admin-user-network-row-${NETWORK.id}`);
    expect(connected.textContent).toContain("connected");
    expect(connected.textContent).toContain("alive");

    // U-0: a row whose DB says connected while the BEAM has no pid must say
    // so, rather than inherit the neighbouring row's honesty.
    const orphan = screen.getByTestId(`admin-user-network-row-${OTHER_NETWORK.id}`);
    expect(orphan.textContent).toContain("BEAM has no pid");
  });

  it("says the user has no networks rather than rendering an empty table", async () => {
    vi.mocked(adminListCredentials).mockResolvedValue([FOREIGN_CRED]);
    mountPage();

    await waitFor(() => expect(screen.queryByTestId("admin-user-networks-empty")).not.toBeNull());
    expect(screen.queryByTestId("admin-user-networks-table")).toBeNull();
  });

  it("calls onBack from the back control", async () => {
    const onBack = vi.fn();
    mountPage(onBack);
    await pageReady();

    fireEvent.click(screen.getByTestId("admin-user-page-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("AdminUserPage — adding a network", () => {
  it("keeps the add form closed until + is pressed", async () => {
    mountPage();
    await pageReady();

    expect(screen.queryByTestId("admin-user-network-add-form")).toBeNull();
    fireEvent.click(screen.getByTestId("admin-user-network-add"));
    expect(screen.queryByTestId("admin-user-network-add-form")).not.toBeNull();
  });

  it("asks for a network, never for a user — the user IS the page", async () => {
    mountPage();
    await pageReady();
    fireEvent.click(screen.getByTestId("admin-user-network-add"));

    expect(screen.queryByTestId("admin-user-network-add-network")).not.toBeNull();
    expect(screen.queryByTestId("admin-user-network-add-user")).toBeNull();
  });

  it("offers only networks the user is not already on", async () => {
    mountPage();
    await pageReady();
    fireEvent.click(screen.getByTestId("admin-user-network-add"));

    const select = screen.getByTestId("admin-user-network-add-network") as HTMLSelectElement;
    const values = Array.from(select.options)
      .map((o) => o.value)
      .filter((v) => v !== "");
    expect(values).toEqual([String(OTHER_NETWORK.id)]);
  });

  it("binds with the page's user and the parsed network id", async () => {
    vi.mocked(adminBindCredential).mockResolvedValue({
      ...CRED,
      network_id: OTHER_NETWORK.id,
      network_slug: OTHER_NETWORK.slug,
      session_action: "spawned",
    });
    mountPage();
    await pageReady();
    fireEvent.click(screen.getByTestId("admin-user-network-add"));

    fireEvent.change(screen.getByTestId("admin-user-network-add-network"), {
      target: { value: String(OTHER_NETWORK.id) },
    });
    fireEvent.input(screen.getByTestId("admin-user-network-add-nick"), {
      target: { value: "newnick" },
    });
    fireEvent.click(screen.getByTestId("admin-user-network-add-submit"));

    await waitFor(() => {
      expect(adminBindCredential).toHaveBeenCalledWith(
        "test-bearer",
        expect.objectContaining({
          user_id: USER.id,
          network_id: OTHER_NETWORK.id,
          nick: "newnick",
        }),
      );
    });
  });

  // #1157 — vjt: *"`autojoin` makes no sense — remove it."* Channel
  // restore rides `last_joined_channels`
  // (`session_plan.ex`, `merge_autojoin/2`), so the admin field was never
  // the mechanism the bouncer actually uses; offering it invited the
  // operator to set a list that the next reconnect overwrites.
  it("offers no autojoin control, on either form", async () => {
    mountPage();
    await pageReady();

    fireEvent.click(screen.getByTestId(`admin-user-network-edit-${NETWORK.id}`));
    expect(screen.queryByTestId(`admin-user-network-edit-autojoin-${NETWORK.id}`)).toBeNull();

    fireEvent.click(screen.getByTestId("admin-user-network-add"));
    expect(screen.queryByTestId("admin-user-network-add-autojoin")).toBeNull();
  });

  it("never puts autojoin_channels on a bind", async () => {
    vi.mocked(adminBindCredential).mockResolvedValue({
      ...CRED,
      network_id: OTHER_NETWORK.id,
      network_slug: OTHER_NETWORK.slug,
    });
    mountPage();
    await pageReady();
    fireEvent.click(screen.getByTestId("admin-user-network-add"));

    fireEvent.change(screen.getByTestId("admin-user-network-add-network"), {
      target: { value: String(OTHER_NETWORK.id) },
    });
    fireEvent.input(screen.getByTestId("admin-user-network-add-nick"), {
      target: { value: "newnick" },
    });
    fireEvent.click(screen.getByTestId("admin-user-network-add-submit"));

    // The KEY, not the value: the removed form used to send an explicit
    // `undefined` for an empty box, and `objectContaining` cannot tell
    // that apart from an absent field.
    await waitFor(() => expect(adminBindCredential).toHaveBeenCalled());
    const body = vi.mocked(adminBindCredential).mock.calls[0]?.[1];
    expect(Object.keys(body ?? {})).not.toContain("autojoin_channels");
  });

  // #410 LOCK, carried over from the deleted Credentials tab suite: the
  // auth-method dropdown enumerates the codegen-emitted closed set, in
  // array order. A server-side rename or reorder regenerates wireTypes.ts
  // and must fail HERE, not reshuffle the dropdown in silence.
  it("renders the auth-method dropdown with the closed method set in order", async () => {
    mountPage();
    await pageReady();
    fireEvent.click(screen.getByTestId("admin-user-network-add"));

    const select = screen.getByTestId("admin-user-network-add-auth-method") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["auto", "sasl", "server_pass", "nickserv_identify", "none"]);
  });
});

describe("AdminUserPage — session_action is per-row state", () => {
  it("reports a bind that dialled, on the row it belongs to", async () => {
    vi.mocked(adminBindCredential).mockResolvedValue({
      ...CRED,
      network_id: OTHER_NETWORK.id,
      network_slug: OTHER_NETWORK.slug,
      session_action: "spawned",
    });
    vi.mocked(adminListCredentials)
      .mockResolvedValueOnce([CRED, FOREIGN_CRED])
      .mockResolvedValue([CRED, FOREIGN_CRED, { ...ORPHAN_CRED, live_state: CRED.live_state }]);
    mountPage();
    await pageReady();
    fireEvent.click(screen.getByTestId("admin-user-network-add"));
    fireEvent.change(screen.getByTestId("admin-user-network-add-network"), {
      target: { value: String(OTHER_NETWORK.id) },
    });
    fireEvent.input(screen.getByTestId("admin-user-network-add-nick"), {
      target: { value: "newnick" },
    });
    fireEvent.click(screen.getByTestId("admin-user-network-add-submit"));

    await waitFor(() => {
      const state = screen.queryByTestId(`admin-user-network-session-action-${OTHER_NETWORK.id}`);
      expect(state).not.toBeNull();
      expect(state?.textContent).toContain("spawned");
    });
  });

  // The half the deleted tab dropped entirely: a bind that did NOT dial
  // still created the row, and `session_error` is the only thing that says
  // why. Rendering the action without the reason would be a worse lie than
  // rendering nothing.
  it("reports a bind that did not dial, with the refusal", async () => {
    vi.mocked(adminBindCredential).mockResolvedValue({
      ...CRED,
      network_id: OTHER_NETWORK.id,
      network_slug: OTHER_NETWORK.slug,
      connection_state: "parked",
      live_state: null,
      session_action: "not_spawned",
      session_error: "user_cap_exceeded",
    });
    vi.mocked(adminListCredentials)
      .mockResolvedValueOnce([CRED, FOREIGN_CRED])
      .mockResolvedValue([CRED, FOREIGN_CRED, ORPHAN_CRED]);
    mountPage();
    await pageReady();
    fireEvent.click(screen.getByTestId("admin-user-network-add"));
    fireEvent.change(screen.getByTestId("admin-user-network-add-network"), {
      target: { value: String(OTHER_NETWORK.id) },
    });
    fireEvent.input(screen.getByTestId("admin-user-network-add-nick"), {
      target: { value: "newnick" },
    });
    fireEvent.click(screen.getByTestId("admin-user-network-add-submit"));

    await waitFor(() => {
      const state = screen.queryByTestId(`admin-user-network-session-action-${OTHER_NETWORK.id}`);
      expect(state?.textContent).toContain("not_spawned");
      expect(state?.textContent).toContain("user_cap_exceeded");
    });
  });

  it("reports a stopped session on the edited row, and leaves the others alone", async () => {
    vi.mocked(adminListCredentials).mockResolvedValue([CRED, ORPHAN_CRED]);
    vi.mocked(adminUpdateCredential).mockResolvedValue({
      ...CRED,
      session_action: "stopped",
    });
    mountPage();
    await pageReady();

    fireEvent.click(screen.getByTestId(`admin-user-network-edit-${NETWORK.id}`));
    fireEvent.input(screen.getByTestId(`admin-user-network-edit-password-${NETWORK.id}`), {
      target: { value: "new-irc-pass" },
    });
    fireEvent.click(screen.getByTestId(`admin-user-network-edit-submit-${NETWORK.id}`));

    await waitFor(() => {
      expect(adminUpdateCredential).toHaveBeenCalledWith("test-bearer", USER.id, NETWORK.id, {
        password: "new-irc-pass",
      });
    });
    await waitFor(() => {
      const state = screen.queryByTestId(`admin-user-network-session-action-${NETWORK.id}`);
      expect(state?.textContent).toContain("stopped");
    });
    expect(
      screen.queryByTestId(`admin-user-network-session-action-${OTHER_NETWORK.id}`),
    ).toBeNull();
  });
});

describe("AdminUserPage — editing and removing a network", () => {
  it("sends only the fields the operator changed", async () => {
    vi.mocked(adminUpdateCredential).mockResolvedValue({
      ...CRED,
      realname: "Alice Smith",
      session_action: "left_alone",
    });
    mountPage();
    await pageReady();

    fireEvent.click(screen.getByTestId(`admin-user-network-edit-${NETWORK.id}`));
    fireEvent.input(screen.getByTestId(`admin-user-network-edit-realname-${NETWORK.id}`), {
      target: { value: "Alice Smith" },
    });
    fireEvent.click(screen.getByTestId(`admin-user-network-edit-submit-${NETWORK.id}`));

    await waitFor(() => {
      expect(adminUpdateCredential).toHaveBeenCalledWith("test-bearer", USER.id, NETWORK.id, {
        realname: "Alice Smith",
      });
    });
  });

  it("removes a network behind an inline confirm", async () => {
    vi.mocked(adminUnbindCredential).mockResolvedValue(undefined);
    mountPage();
    await pageReady();

    const btn = screen.getByTestId(`admin-user-network-remove-${NETWORK.id}`);
    expect(btn.textContent).toBe("Remove");
    fireEvent.click(btn);
    expect(btn.textContent).toBe("Confirm remove");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(adminUnbindCredential).toHaveBeenCalledWith("test-bearer", USER.id, NETWORK.id);
    });
    await waitFor(() => {
      expect(screen.queryByTestId(`admin-user-network-row-${NETWORK.id}`)).toBeNull();
    });
  });
});
