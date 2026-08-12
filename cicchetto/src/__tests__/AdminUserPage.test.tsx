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
// #1157 reshaped it: no bind flow, one section per CONFIGURED network,
// and a checkbox that says whether this user has access. So the suite's
// central fixture is a server with TWO networks where the user is on
// ONE — the page must render both sections and disagree about them.
//
// The invariants defended here:
//
//   * a section is ticked for THIS user's credential and no one else's
//     (the list endpoint is unfiltered — see the `filters` note in the
//     page). The foreign credential in every mount fetch sits on the
//     second network, so a missing owner filter ticks a box;
//   * the checkbox is not a write: enabling reveals the form and calls
//     nothing, disabling a bound network ARMS a removal and calls
//     nothing. Only Save and the confirm reach the server;
//   * `session_action` is per-SECTION state carrying all FOUR values.
//     The tab this page replaced surfaced two, and only for PATCH:
//     `onBind` dropped the POST reply on the floor, so `spawned` /
//     `not_spawned` had no operator surface at all;
//   * a bound section shows the DB state AND the live state side by
//     side, which is the two-sources rule and the witness
//     `issue1163-admin-bind-dials` reads.

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

// Same shape, different OWNER, on the network this user is NOT on.
// Present in every mount fetch, so a missing owner filter shows up as a
// ticked box rather than as nothing at all.
const FOREIGN_CRED: AdminCredential = {
  ...CRED,
  user_id: OTHER_USER_ID,
  network_id: OTHER_NETWORK.id,
  network_slug: OTHER_NETWORK.slug,
  nick: "bob",
};

// This user, on the second network, with no pid behind it.
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
  await waitFor(() => expect(screen.queryByTestId("admin-user-networks-card")).not.toBeNull());
}

function checkbox(networkId: number): HTMLInputElement {
  return screen.getByTestId(`admin-user-network-enabled-${networkId}`) as HTMLInputElement;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(adminListCredentials).mockResolvedValue([CRED, FOREIGN_CRED]);
  vi.mocked(adminListNetworks).mockResolvedValue([NETWORK, OTHER_NETWORK]);
});

describe("AdminUserPage — a section per configured network (#1157)", () => {
  it("renders every configured network, not only the ones the user is on", async () => {
    mountPage();
    await pageReady();

    expect(screen.queryByTestId(`admin-user-network-${NETWORK.id}`)).not.toBeNull();
    expect(screen.queryByTestId(`admin-user-network-${OTHER_NETWORK.id}`)).not.toBeNull();
  });

  it("ticks this user's networks and never another user's", async () => {
    mountPage();
    await pageReady();

    expect(checkbox(NETWORK.id).checked).toBe(true);
    // `FOREIGN_CRED` is a credential on this very network, owned by
    // someone else. Ticked here means the owner filter is gone.
    expect(checkbox(OTHER_NETWORK.id).checked).toBe(false);
  });

  it("shows the settings form only for an enabled network", async () => {
    mountPage();
    await pageReady();

    expect(screen.queryByTestId(`admin-user-network-form-${NETWORK.id}`)).not.toBeNull();
    expect(screen.queryByTestId(`admin-user-network-form-${OTHER_NETWORK.id}`)).toBeNull();
  });

  it("seeds an enabled section's form from the credential", async () => {
    mountPage();
    await pageReady();

    const nick = screen.getByTestId(`admin-user-network-nick-${NETWORK.id}`) as HTMLInputElement;
    expect(nick.value).toBe(CRED.nick);
  });

  it("shows the DB state and the live state side by side", async () => {
    vi.mocked(adminListCredentials).mockResolvedValue([CRED, ORPHAN_CRED]);
    mountPage();
    await pageReady();

    expect(screen.getByTestId(`admin-user-network-connection-${NETWORK.id}`).textContent).toBe(
      "connected",
    );
    expect(screen.getByTestId(`admin-user-network-live-${NETWORK.id}`).textContent).toBe("alive");

    // U-0: a section whose DB says connected while the BEAM has no pid
    // must say so, rather than inherit its neighbour's honesty.
    expect(screen.getByTestId(`admin-user-network-live-${OTHER_NETWORK.id}`).textContent).toBe(
      "BEAM has no pid",
    );
  });

  it("blames the server, not the user, when no network is configured at all", async () => {
    vi.mocked(adminListNetworks).mockResolvedValue([]);
    mountPage();

    await waitFor(() => expect(screen.queryByTestId("admin-user-networks-empty")).not.toBeNull());
  });

  it("calls onBack from the back control", async () => {
    const onBack = vi.fn();
    mountPage(onBack);
    await pageReady();

    fireEvent.click(screen.getByTestId("admin-user-page-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("AdminUserPage — the checkbox is not a write (#1157)", () => {
  it("reveals the form on enable without calling the server", async () => {
    mountPage();
    await pageReady();

    fireEvent.click(checkbox(OTHER_NETWORK.id));

    expect(screen.queryByTestId(`admin-user-network-form-${OTHER_NETWORK.id}`)).not.toBeNull();
    // A bind needs a nick; a checkbox cannot supply one, so nothing goes
    // out until Save.
    expect(adminBindCredential).not.toHaveBeenCalled();
  });

  it("will not save a newly enabled network until it has a nick", async () => {
    mountPage();
    await pageReady();
    fireEvent.click(checkbox(OTHER_NETWORK.id));

    const save = screen.getByTestId(
      `admin-user-network-save-${OTHER_NETWORK.id}`,
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.input(screen.getByTestId(`admin-user-network-nick-${OTHER_NETWORK.id}`), {
      target: { value: "newnick" },
    });
    expect(save.disabled).toBe(false);
  });

  it("binds with the page's user and the section's network", async () => {
    vi.mocked(adminBindCredential).mockResolvedValue({
      ...CRED,
      network_id: OTHER_NETWORK.id,
      network_slug: OTHER_NETWORK.slug,
    });
    mountPage();
    await pageReady();

    fireEvent.click(checkbox(OTHER_NETWORK.id));
    fireEvent.input(screen.getByTestId(`admin-user-network-nick-${OTHER_NETWORK.id}`), {
      target: { value: "newnick" },
    });
    fireEvent.click(screen.getByTestId(`admin-user-network-save-${OTHER_NETWORK.id}`));

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
  // restore rides `last_joined_channels` (`session_plan.ex`,
  // `merge_autojoin/2`), so the admin field was never the mechanism the
  // bouncer actually uses.
  it("offers no autojoin control, and never sends one", async () => {
    vi.mocked(adminBindCredential).mockResolvedValue({
      ...CRED,
      network_id: OTHER_NETWORK.id,
      network_slug: OTHER_NETWORK.slug,
    });
    mountPage();
    await pageReady();
    expect(screen.queryByTestId(`admin-user-network-autojoin-${NETWORK.id}`)).toBeNull();

    fireEvent.click(checkbox(OTHER_NETWORK.id));
    fireEvent.input(screen.getByTestId(`admin-user-network-nick-${OTHER_NETWORK.id}`), {
      target: { value: "newnick" },
    });
    fireEvent.click(screen.getByTestId(`admin-user-network-save-${OTHER_NETWORK.id}`));

    // The KEY, not the value: the removed form used to send an explicit
    // `undefined` for an empty box, and `objectContaining` cannot tell
    // that apart from an absent field.
    await waitFor(() => expect(adminBindCredential).toHaveBeenCalled());
    const body = vi.mocked(adminBindCredential).mock.calls[0]?.[1];
    expect(Object.keys(body ?? {})).not.toContain("autojoin_channels");
  });

  it("arms a removal on disable instead of performing one", async () => {
    mountPage();
    await pageReady();

    fireEvent.click(checkbox(NETWORK.id));

    expect(adminUnbindCredential).not.toHaveBeenCalled();
    expect(checkbox(NETWORK.id).checked).toBe(false);
    expect(screen.queryByTestId(`admin-user-network-remove-${NETWORK.id}`)).not.toBeNull();
    // The form goes with the tick: leaving it up would invite an edit to
    // a credential the operator has just asked to delete.
    expect(screen.queryByTestId(`admin-user-network-form-${NETWORK.id}`)).toBeNull();
  });

  it("removes the credential once the armed removal is confirmed", async () => {
    vi.mocked(adminUnbindCredential).mockResolvedValue(undefined);
    mountPage();
    await pageReady();

    fireEvent.click(checkbox(NETWORK.id));
    fireEvent.click(screen.getByTestId(`admin-user-network-remove-${NETWORK.id}`));

    await waitFor(() => {
      expect(adminUnbindCredential).toHaveBeenCalledWith("test-bearer", USER.id, NETWORK.id);
    });
    await waitFor(() => expect(checkbox(NETWORK.id).checked).toBe(false));
    expect(screen.queryByTestId(`admin-user-network-remove-${NETWORK.id}`)).toBeNull();
  });

  it("puts the tick back when the armed removal is cancelled", async () => {
    mountPage();
    await pageReady();

    fireEvent.click(checkbox(NETWORK.id));
    fireEvent.click(screen.getByTestId(`admin-user-network-keep-${NETWORK.id}`));

    expect(adminUnbindCredential).not.toHaveBeenCalled();
    expect(checkbox(NETWORK.id).checked).toBe(true);
    expect(screen.queryByTestId(`admin-user-network-form-${NETWORK.id}`)).not.toBeNull();
  });
});

describe("AdminUserPage — editing a bound network", () => {
  it("sends only the fields the operator changed", async () => {
    vi.mocked(adminUpdateCredential).mockResolvedValue({
      ...CRED,
      realname: "Alice Smith",
      session_action: "left_alone",
    });
    mountPage();
    await pageReady();

    fireEvent.input(screen.getByTestId(`admin-user-network-realname-${NETWORK.id}`), {
      target: { value: "Alice Smith" },
    });
    fireEvent.click(screen.getByTestId(`admin-user-network-save-${NETWORK.id}`));

    await waitFor(() => {
      expect(adminUpdateCredential).toHaveBeenCalledWith("test-bearer", USER.id, NETWORK.id, {
        realname: "Alice Smith",
      });
    });
  });

  it("refuses to save a bound network nothing has changed on", async () => {
    mountPage();
    await pageReady();

    // An empty PATCH would ask the server to decide whether to stop a
    // live session over nothing.
    const save = screen.getByTestId(`admin-user-network-save-${NETWORK.id}`) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  // #410 LOCK, carried over from the deleted Credentials tab suite: the
  // auth-method dropdown enumerates the codegen-emitted closed set, in
  // array order. A server-side rename or reorder regenerates wireTypes.ts
  // and must fail HERE, not reshuffle the dropdown in silence.
  it("renders the auth-method dropdown with the closed method set in order", async () => {
    mountPage();
    await pageReady();

    const select = screen.getByTestId(
      `admin-user-network-auth-method-${NETWORK.id}`,
    ) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["auto", "sasl", "server_pass", "nickserv_identify", "none"]);
  });
});

describe("AdminUserPage — session_action is per-section state", () => {
  it("reports a bind that dialled, on the section it belongs to", async () => {
    vi.mocked(adminBindCredential).mockResolvedValue({
      ...CRED,
      network_id: OTHER_NETWORK.id,
      network_slug: OTHER_NETWORK.slug,
      session_action: "spawned",
    });
    mountPage();
    await pageReady();

    fireEvent.click(checkbox(OTHER_NETWORK.id));
    fireEvent.input(screen.getByTestId(`admin-user-network-nick-${OTHER_NETWORK.id}`), {
      target: { value: "newnick" },
    });
    fireEvent.click(screen.getByTestId(`admin-user-network-save-${OTHER_NETWORK.id}`));

    const note = await screen.findByTestId(`admin-user-network-session-action-${OTHER_NETWORK.id}`);
    expect(note.textContent).toContain("spawned");
    // On the section it belongs to, and on no other.
    expect(screen.queryByTestId(`admin-user-network-session-action-${NETWORK.id}`)).toBeNull();
  });

  it("reports a bind that did not dial, with the refusal", async () => {
    vi.mocked(adminBindCredential).mockResolvedValue({
      ...CRED,
      network_id: OTHER_NETWORK.id,
      network_slug: OTHER_NETWORK.slug,
      session_action: "not_spawned",
      session_error: "resolve_failed",
    });
    mountPage();
    await pageReady();

    fireEvent.click(checkbox(OTHER_NETWORK.id));
    fireEvent.input(screen.getByTestId(`admin-user-network-nick-${OTHER_NETWORK.id}`), {
      target: { value: "newnick" },
    });
    fireEvent.click(screen.getByTestId(`admin-user-network-save-${OTHER_NETWORK.id}`));

    const note = await screen.findByTestId(`admin-user-network-session-action-${OTHER_NETWORK.id}`);
    expect(note.textContent).toContain("not_spawned");
    // The only field that says WHY, and the reason this is not a toast.
    expect(note.textContent).toContain("resolve_failed");
  });

  it("reports a stopped session on the edited section", async () => {
    vi.mocked(adminUpdateCredential).mockResolvedValue({
      ...CRED,
      session_action: "stopped",
    });
    mountPage();
    await pageReady();

    fireEvent.input(screen.getByTestId(`admin-user-network-realname-${NETWORK.id}`), {
      target: { value: "Alice Smith" },
    });
    fireEvent.click(screen.getByTestId(`admin-user-network-save-${NETWORK.id}`));

    const note = await screen.findByTestId(`admin-user-network-session-action-${NETWORK.id}`);
    expect(note.textContent).toContain("stopped");
  });
});
