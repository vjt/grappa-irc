import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@solidjs/router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../lib/theme", () => ({
  getTheme: vi.fn(() => "auto"),
  setTheme: vi.fn(),
}));

vi.mock("../lib/fontSize", () => ({
  getFontSize: vi.fn(() => "M"),
  setFontSize: vi.fn(),
}));

const subjectHolder = vi.hoisted(() => ({
  current: null as
    | { kind: "user"; id: string; name: string }
    | {
        kind: "visitor";
        id: string;
        nick: string;
        registered?: boolean;
      }
    | null,
}));
vi.mock("../lib/auth", () => ({
  logout: vi.fn().mockResolvedValue(undefined),
  token: () => "test-bearer",
  getSubject: () => subjectHolder.current,
}));

// #126 — the drawer routes detach/quit through lib/lifecycle. The
// lifecycle module is NOT mocked here (so the existing detach→logout /
// quit→quitAll wiring assertions still hold via the underlying auth/quit
// mocks); lifecycle's own per-subject routing has dedicated coverage in
// lib/lifecycle.test.ts. We mock the api verbs the drawer touches
// (updateIdentity) so a click doesn't hit the network.
vi.mock("../lib/api", () => ({
  // #211 phase 7 — the identity editor PATCHes /networks/:slug/identity via
  // lib/lifecycle's updateIdentity, which calls api.updateNetworkIdentity.
  // Stub so the click doesn't hit the network + the call is observable.
  updateNetworkIdentity: vi.fn().mockResolvedValue({
    network: "azzurra",
    nick: "vjt",
    ident: "grp",
    realname: "Real Name",
    auth_method: "none",
  }),
  // The drawer imports ApiError for the identity-save catch (instanceof
  // narrowing). A minimal class stand-in keeps the import resolvable.
  ApiError: class ApiError extends Error {},
  // #157 — the drawer derives the delete-account confirm text from
  // displayNick(me) (user) / visitorAnchorNick(networks) (visitor).
  displayNick: (me: { kind: "user"; name: string } | { kind: "visitor" }) =>
    me.kind === "user" ? me.name : "Visitor",
  visitorAnchorNick: (nets: Array<{ kind: string; id: number; nick: string }>) =>
    nets
      .filter((n) => n.kind === "visitor")
      .reduce<{ id: number; nick: string } | null>(
        (lo, n) => (lo == null || n.id < lo.id ? n : lo),
        null,
      )?.nick ?? null,
}));

// Issue #43 — "quit IRC" composite (park all user-networks + logout)
// already ships in lib/quit.ts; the drawer wires the destructive button
// to it. Mock the composite so the drawer test asserts the wiring, not
// the park/logout fan-out (quit.ts has its own coverage).
vi.mock("../lib/quit", () => ({
  quitAll: vi.fn().mockResolvedValue(undefined),
}));

// M-cluster M-7 — admin gate. SettingsDrawer reads `isAdmin()` from
// `lib/networks` (UX-4 bucket N hoisted the predicate there as the
// single source of truth shared with Shell.tsx pane dispatcher +
// Sidebar.tsx admin row). Mock returns a mutable holder so individual
// tests can flip subject + admin flag; isAdmin computed from the
// hoisted me to keep the existing assertions semantically intact.
const meHolder = vi.hoisted(() => ({
  current: null as
    | { kind: "user"; id: string; name: string; is_admin: boolean; inserted_at: string }
    | {
        kind: "visitor";
        id: string;
        nick: string;
        expires_at: string;
        ident?: string | null;
        realname?: string | null;
        registered?: boolean;
      }
    | null,
}));
// #211 phase 7 — the visitor's network rows (identity editor anchor +
// delete-confirm nick source). Default: one azzurra visitor row.
const networksHolder = vi.hoisted(() => ({
  current: [
    {
      kind: "visitor" as const,
      id: 1,
      slug: "azzurra",
      nick: "vjt",
      ident: null as string | null,
      realname: null as string | null,
      connection_state: "connected" as const,
      connection_state_reason: null as string | null,
      connection_state_changed_at: null as string | null,
      inserted_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ] as unknown[],
}));
vi.mock("../lib/networks", () => ({
  user: () => meHolder.current,
  // #211 phase 7 — the identity editor + delete-confirm read the visitor's
  // network rows (anchor nick + per-network ident/realname seed). Stub a
  // single azzurra visitor row so the editor has an anchor to target.
  networks: () => networksHolder.current,
  // #126 — disconnect/reconnect refetch /me; the drawer imports this via
  // lib/lifecycle. Stub so the import resolves + the verb is observable.
  refetchUser: vi.fn(),
  isAdmin: () => {
    const u = meHolder.current;
    return u?.kind === "user" && u.is_admin === true;
  },
}));

vi.mock("../lib/push", () => ({
  enablePush: vi.fn().mockResolvedValue({ status: "enabled", subscriptionId: "sub-1" }),
  disablePush: vi.fn().mockResolvedValue(true),
  listPushDevices: vi.fn().mockResolvedValue([]),
  deletePushSubscription: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/userSettings", async () => {
  const actual = await vi.importActual<typeof import("../lib/userSettings")>("../lib/userSettings");
  return {
    ...actual,
    getNotificationPrefs: vi.fn().mockResolvedValue(actual.DEFAULT_NOTIFICATION_PREFS),
    putNotificationPrefs: vi
      .fn()
      .mockImplementation((_t: string, prefs: unknown) => Promise.resolve(prefs)),
    getUploadTtlSeconds: vi.fn().mockResolvedValue(null),
    putUploadTtlSeconds: vi
      .fn()
      .mockImplementation((_t: string, seconds: number | null) => Promise.resolve(seconds)),
  };
});

// UX-4 bucket M (2026-05-19) — SettingsDrawer imports the upload-TTL
// signal accessors from the orchestrator. The orchestrator's signal
// behaviour is exercised in `uploadOrchestrator.test.ts`; here
// we mock the public surface so the drawer test stays focused on
// drawer rendering + event wiring.
const uploadTtlHolder = vi.hoisted(() => ({ current: null as number | null }));
vi.mock("../lib/uploadOrchestrator", () => ({
  loadUploadTtlSeconds: vi.fn(async () => {
    /* no-op; SettingsDrawer test asserts on the call only */
  }),
  saveUploadTtlSeconds: vi.fn(async (_t: string, seconds: number | null) => {
    uploadTtlHolder.current = seconds;
  }),
  uploadTtlSecondsValue: () => uploadTtlHolder.current,
}));

// Visitor session-sharing — drawer mounts ShareSessionModal as a
// sibling. Mock to a passthrough so the drawer tests don't reach into
// fetch/clipboard for the mint flow (ShareSessionModal has its own
// test file). The reactive `<Show>` wrapping is load-bearing — a
// `props.open ? ... : null` ternary is evaluated ONCE at component
// construction and never re-runs when the parent toggles the signal.
vi.mock("../ShareSessionModal", async () => {
  const { Show } = await import("solid-js");
  return {
    default: (props: { open: boolean; onClose: () => void }) => (
      <Show when={props.open}>
        <div data-testid="share-modal-stub">
          <button type="button" onClick={props.onClose}>
            stub close
          </button>
        </div>
      </Show>
    ),
  };
});

// #157 — the drawer mounts DeleteAccountModal as a sibling. Stub it (its
// own confirm-gate behaviour is covered in DeleteAccountModal.test.tsx);
// here we assert the drawer's gating + that clicking the entry OPENS it.
vi.mock("../DeleteAccountModal", async () => {
  const { Show } = await import("solid-js");
  return {
    default: (props: { open: boolean; onClose: () => void; confirmationText: string }) => (
      <Show when={props.open}>
        <div data-testid="delete-account-modal-stub">{props.confirmationText}</div>
      </Show>
    ),
  };
});

import SettingsDrawer from "../SettingsDrawer";

const wrap = (open: boolean, onClose = vi.fn(), onOpenAdmin = vi.fn()) =>
  render(() => <SettingsDrawer open={open} onClose={onClose} onOpenAdmin={onOpenAdmin} />);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no subject loaded yet — covers the pre-login / loading
  // state where me() returns null. Admin entry MUST be hidden.
  meHolder.current = null;
  uploadTtlHolder.current = null;
  subjectHolder.current = null;
});

describe("SettingsDrawer", () => {
  it("renders theme radios", () => {
    wrap(true);
    expect(screen.getByLabelText(/auto/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/mirc light/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/irssi dark/i)).toBeInTheDocument();
  });

  it("changing radio fires setTheme", async () => {
    const theme = await import("../lib/theme");
    wrap(true);
    fireEvent.click(screen.getByLabelText(/mirc light/i));
    expect(theme.setTheme).toHaveBeenCalledWith("mirc-light");
  });

  it("null subject (loading) shows quit alone (no 'log out', no detach); two-tap detaches", async () => {
    // #126 — "log out" is retired. The not-yet-loaded null subject gets
    // only the universal quit verb; clicking through the two-tap routes
    // to quit() → (null subject) logout().
    const auth = await import("../lib/auth");
    wrap(true);
    expect(screen.queryByText(/^log out$/i)).toBeNull();
    expect(screen.queryByTestId("detach-btn")).toBeNull();
    fireEvent.click(screen.getByTestId("quit-irc-btn")); // arm
    fireEvent.click(screen.getByTestId("quit-irc-btn")); // confirm
    await waitFor(() => {
      expect(auth.logout).toHaveBeenCalled();
    });
  });

  it("backdrop click fires onClose", () => {
    const onClose = vi.fn();
    wrap(true, onClose);
    const backdrop = screen.getByTestId("settings-drawer-backdrop");
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it("open=true gives the drawer the .open class", () => {
    wrap(true);
    const drawer = screen.getByRole("dialog", { name: /settings/i });
    expect(drawer.classList.contains("open")).toBe(true);
  });

  it("open=false withholds the .open class", () => {
    wrap(false);
    const drawer = screen.getByRole("dialog", { name: /settings/i });
    expect(drawer.classList.contains("open")).toBe(false);
  });
});

describe("SettingsDrawer notifications section", () => {
  it("renders the master toggle + 4 prefs checkboxes + 2 whitelist inputs", () => {
    wrap(true);
    expect(screen.getByTestId("push-master-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("pref-channel-all")).toBeInTheDocument();
    expect(screen.getByTestId("pref-channel-mentions")).toBeInTheDocument();
    expect(screen.getByTestId("pref-private-all")).toBeInTheDocument();
    expect(screen.getByTestId("pref-channels-only")).toBeInTheDocument();
    expect(screen.getByTestId("pref-nicks-only")).toBeInTheDocument();
  });

  it("loads prefs on mount via getNotificationPrefs", async () => {
    const userSettings = await import("../lib/userSettings");
    wrap(true);
    await waitFor(() => {
      expect(userSettings.getNotificationPrefs).toHaveBeenCalledWith("test-bearer");
    });
  });

  it("clicking master toggle calls enablePush", async () => {
    const push = await import("../lib/push");
    wrap(true);
    const toggle = screen.getByTestId("push-master-toggle") as HTMLInputElement;
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(push.enablePush).toHaveBeenCalledWith("test-bearer");
    });
  });

  it("toggling a pref checkbox calls putNotificationPrefs", async () => {
    const userSettings = await import("../lib/userSettings");
    wrap(true);
    await waitFor(() => {
      expect(userSettings.getNotificationPrefs).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByTestId("pref-channel-all"));
    await waitFor(() => {
      expect(userSettings.putNotificationPrefs).toHaveBeenCalled();
    });
    const lastCall = (userSettings.putNotificationPrefs as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, unknown];
    expect(lastCall[1]).toMatchObject({ channel_messages_all: true });
  });

  it("whitelist input is disabled when corresponding _all is true", async () => {
    const userSettings = await import("../lib/userSettings");
    (userSettings.getNotificationPrefs as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...userSettings.DEFAULT_NOTIFICATION_PREFS,
      channel_messages_all: true,
    });
    wrap(true);
    await waitFor(() => {
      const input = screen.getByTestId("pref-channels-only") as HTMLInputElement;
      expect(input.disabled).toBe(true);
    });
  });

  it("renders permission_denied banner when enablePush rejects", async () => {
    const push = await import("../lib/push");
    (push.enablePush as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "permission_denied",
    });
    wrap(true);
    fireEvent.click(screen.getByTestId("push-master-toggle"));
    await waitFor(() => {
      expect(screen.getByTestId("push-banner")).toBeInTheDocument();
    });
  });
});

// V6 visitor-parity: the NOTIFICATIONS + theme surface is subject-
// agnostic — identical for visitor and user. This describe block pins
// that invariant: if a visitor-gated branch ever sneaks into the push /
// prefs / theme chrome (e.g. "hide push toggle for visitors") the
// assertions below break loudly. The drawer DOES read getSubject() for
// the subject-gated affordances (issue #43 logout split, share-session,
// admin entry) — those have their own describe blocks; this one asserts
// everything ELSE stays the same. Seeds the visitor into the mocked
// `subjectHolder` (the source getSubject() actually reads — a localStorage
// seed is inert under the auth mock), so the surface is exercised as a
// real visitor, not the null/loading fallback.
describe("SettingsDrawer (visitor subject)", () => {
  beforeEach(() => {
    subjectHolder.current = {
      kind: "visitor",
      id: "v1",
      nick: "anon-vjt",
    };
  });

  it("renders the same notifications surface for visitor as for user", () => {
    wrap(true);
    expect(screen.getByTestId("push-master-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("pref-channel-all")).toBeInTheDocument();
    expect(screen.getByTestId("pref-channel-mentions")).toBeInTheDocument();
    expect(screen.getByTestId("pref-private-all")).toBeInTheDocument();
    expect(screen.getByTestId("pref-channels-only")).toBeInTheDocument();
    expect(screen.getByTestId("pref-nicks-only")).toBeInTheDocument();
  });

  it("loads notification prefs on mount for visitor (server returns 200, no 403 gate)", async () => {
    const userSettings = await import("../lib/userSettings");
    wrap(true);
    await waitFor(() => {
      expect(userSettings.getNotificationPrefs).toHaveBeenCalledWith("test-bearer");
    });
  });

  it("clicking master toggle calls enablePush for visitor (no client-side hide)", async () => {
    const push = await import("../lib/push");
    wrap(true);
    fireEvent.click(screen.getByTestId("push-master-toggle"));
    await waitFor(() => {
      expect(push.enablePush).toHaveBeenCalledWith("test-bearer");
    });
  });

  it("renders theme + the universal quit verb for the loading null subject", () => {
    wrap(true);
    expect(screen.getByLabelText(/auto/i)).toBeInTheDocument();
    // #126 — theme chrome is shared; the lifecycle affordance is quit
    // alone for the not-yet-loaded subject ("log out" retired).
    expect(screen.getByTestId("quit-irc-btn")).toBeInTheDocument();
    expect(screen.queryByText(/^log out$/i)).toBeNull();
  });
});

// M-cluster M-7 — admin console entry gate. Per
// `feedback_e2e_user_class_parity_matrix`: the admin entry is
// admin-gated EXEMPT (only one of the three subject classes sees it).
// The vitest covers visibility polarity; the Playwright e2e covers
// end-to-end login → drawer-open → entry-visibility per subject class.
describe("SettingsDrawer (M-7 admin console entry)", () => {
  it("hides admin entry when subject is non-admin user", () => {
    meHolder.current = {
      kind: "user",
      id: "u1",
      name: "alice",
      is_admin: false,
      inserted_at: "x",
    };
    wrap(true);
    expect(screen.queryByTestId("admin-console-entry")).toBeNull();
    expect(screen.queryByText(/admin console/i)).toBeNull();
  });

  it("hides admin entry when subject is a visitor", () => {
    meHolder.current = {
      kind: "visitor",
      id: "v1",
      nick: "anon-vjt",
      expires_at: "2026-05-17T00:00:00Z",
    };
    wrap(true);
    expect(screen.queryByTestId("admin-console-entry")).toBeNull();
  });

  it("hides admin entry when subject is not yet loaded (me() === null)", () => {
    meHolder.current = null;
    wrap(true);
    expect(screen.queryByTestId("admin-console-entry")).toBeNull();
  });

  it("shows admin entry when user is admin", () => {
    meHolder.current = {
      kind: "user",
      id: "u1",
      name: "vjt",
      is_admin: true,
      inserted_at: "x",
    };
    wrap(true);
    const entry = screen.getByTestId("admin-console-entry");
    expect(entry).toBeInTheDocument();
    // textContent guard per
    // `feedback_css_block_button_wraps_inline_prefix` — pseudo-element
    // sigils / inline prefixes can clip the visible label even when
    // the button itself is present.
    expect(entry.textContent).toContain("admin console");
  });

  it("clicking admin entry fires onClose THEN onOpenAdmin (drawer dismiss → pane mount handoff)", () => {
    meHolder.current = {
      kind: "user",
      id: "u1",
      name: "vjt",
      is_admin: true,
      inserted_at: "x",
    };
    const onClose = vi.fn();
    const onOpenAdmin = vi.fn();
    wrap(true, onClose, onOpenAdmin);
    fireEvent.click(screen.getByTestId("admin-console-entry"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenAdmin).toHaveBeenCalledTimes(1);
    // Order matters — drawer dismisses BEFORE pane mounts so the two
    // overlays don't briefly co-exist. Assert call-order via mock
    // invocation ordinals.
    const closeOrder = onClose.mock.invocationCallOrder[0];
    const openOrder = onOpenAdmin.mock.invocationCallOrder[0];
    expect(closeOrder !== undefined && openOrder !== undefined && closeOrder < openOrder).toBe(
      true,
    );
  });
});

describe("SettingsDrawer (bucket L — chrome polish)", () => {
  it("renders × close button in the header (desktop parity)", () => {
    wrap(true, vi.fn(), vi.fn());
    expect(screen.getByTestId("settings-drawer-close")).toBeInTheDocument();
  });

  it("clicking × close fires onClose", () => {
    const onClose = vi.fn();
    wrap(true, onClose, vi.fn());
    fireEvent.click(screen.getByTestId("settings-drawer-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders bottom done button (mobile thumb-reach)", () => {
    wrap(true, vi.fn(), vi.fn());
    expect(screen.getByTestId("settings-drawer-done")).toBeInTheDocument();
  });

  it("clicking done fires onClose", () => {
    const onClose = vi.fn();
    wrap(true, onClose, vi.fn());
    fireEvent.click(screen.getByTestId("settings-drawer-done"));
    expect(onClose).toHaveBeenCalled();
  });
});

// UX-4 bucket M (2026-05-19) — upload-TTL fieldset migrated out of
// ComposeBox. Server-pref (integer seconds) round-trips via the
// orchestrator's REST wrapper; cic translates to/from host token at
// this boundary.
describe("SettingsDrawer (bucket M — upload-TTL fieldset)", () => {
  it("renders the upload-TTL select with the active host's ladder", () => {
    wrap(true);
    const select = screen.getByTestId("upload-ttl-select") as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    const opts = Array.from(select.querySelectorAll("option")).map((o) => o.value);
    // "" = use site default; rest mirror activeHost().ttlOptions.
    // UX-6-B2 (2026-05-21): activeHost() defaults to embeddedHost
    // (values: "3600" | "43200" | "86400" | "259200" — integer
    // seconds strings). Pre-B2 default was litterboxHost ("1h" etc).
    expect(opts).toContain("");
    expect(opts).toContain("3600");
    expect(opts).toContain("86400");
  });

  // #206 — the "use site default" option must render the default TTL's
  // human-readable label (embeddedHost's 86400s entry → "24 hours"), not
  // the raw seconds value. The label is looked up from the SAME
  // ttlOptions ladder the other options use — no bespoke formatter.
  it("renders the site-default option with a human label, not raw seconds", () => {
    wrap(true);
    const select = screen.getByTestId("upload-ttl-select") as HTMLSelectElement;
    const defaultOpt = Array.from(select.querySelectorAll("option")).find((o) => o.value === "");
    expect(defaultOpt).toBeDefined();
    // embeddedHost.defaultTtl === "86400", whose ttlOptions label is "24 hours".
    expect(defaultOpt?.textContent).toContain("24 hours");
    expect(defaultOpt?.textContent).not.toContain("86400");
  });

  // #170 — the fieldset is type-agnostic (class upload-ttl-fieldset,
  // control "upload duration", server stores plain integer seconds), so
  // the legend must read "upload retention", not "image upload retention"
  // (multi-type uploads on the roadmap). Locks the rename against regression.
  it("labels the fieldset 'upload retention' (type-agnostic legend)", () => {
    wrap(true);
    const legend = screen.getByText("upload retention");
    expect(legend).toBeInTheDocument();
    expect(legend.tagName).toBe("LEGEND");
    expect(legend.closest("fieldset")).toHaveClass("upload-ttl-fieldset");
  });

  it("loads the server preference on mount", async () => {
    const orch = await import("../lib/uploadOrchestrator");
    wrap(true);
    await waitFor(() => {
      expect(orch.loadUploadTtlSeconds).toHaveBeenCalledWith("test-bearer");
    });
  });

  it("reflects the cached preference in the select value", () => {
    // 86_400 = 24h. UX-6-B2: embeddedHost's "24h" entry has
    // `value: "86400"` (integer-seconds string, mirrors server-side
    // allowed_ttl_seconds whitelist).
    uploadTtlHolder.current = 86_400;
    wrap(true);
    const select = screen.getByTestId("upload-ttl-select") as HTMLSelectElement;
    expect(select.value).toBe("86400");
  });

  it("selecting an option PUTs the matching seconds", async () => {
    const orch = await import("../lib/uploadOrchestrator");
    wrap(true);
    const select = screen.getByTestId("upload-ttl-select") as HTMLSelectElement;
    // UX-6-B2: embeddedHost option value is "3600" (integer-seconds).
    fireEvent.change(select, { target: { value: "3600" } });
    await waitFor(() => {
      expect(orch.saveUploadTtlSeconds).toHaveBeenCalledWith("test-bearer", 3600);
    });
  });

  it("selecting 'use site default' PUTs null (clear preference)", async () => {
    const orch = await import("../lib/uploadOrchestrator");
    uploadTtlHolder.current = 3600;
    wrap(true);
    const select = screen.getByTestId("upload-ttl-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => {
      expect(orch.saveUploadTtlSeconds).toHaveBeenCalledWith("test-bearer", null);
    });
  });
});

// Visitor session-sharing — the "share session" entry is
// visitor-only. Server still 403s for user subjects, but the cic UI
// hides the entry point so users never see a button that would just
// fail. Tests three subject states: user (hide), visitor (show),
// not-loaded (hide).
describe("SettingsDrawer (share session — visitor only)", () => {
  it("hides share-session entry when subject is a user", () => {
    subjectHolder.current = { kind: "user", id: "u1", name: "alice" };
    wrap(true);
    expect(screen.queryByTestId("share-session-entry")).toBeNull();
  });

  it("shows share-session entry when subject is a visitor", () => {
    subjectHolder.current = {
      kind: "visitor",
      id: "v1",
      nick: "alice",
    };
    wrap(true);
    expect(screen.getByTestId("share-session-entry")).toBeInTheDocument();
  });

  it("hides share-session entry when subject is not loaded", () => {
    subjectHolder.current = null;
    wrap(true);
    expect(screen.queryByTestId("share-session-entry")).toBeNull();
  });

  it("clicking the share-session entry mounts the modal", async () => {
    subjectHolder.current = {
      kind: "visitor",
      id: "v1",
      nick: "alice",
    };
    wrap(true);
    // Closed by default — modal stub absent.
    expect(screen.queryByTestId("share-modal-stub")).toBeNull();

    fireEvent.click(screen.getByTestId("share-session-entry"));

    await waitFor(() => {
      expect(screen.getByTestId("share-modal-stub")).toBeInTheDocument();
    });
  });
});

// Issue #43 / #126 — a registered user gets "detach" (leave cic, KEEP
// the bouncer) + a destructive two-tap "quit" (park ALL networks +
// detach). Under #126 "log out" is retired and the same persistent
// -identity verbs extend to the NickServ visitor (separate describe
// below); ephemeral visitors + the loading null subject get quit alone.
describe("SettingsDrawer (issue #43 — detach + quit for a user)", () => {
  beforeEach(() => {
    subjectHolder.current = { kind: "user", id: "u1", name: "alice" };
  });

  it("renders detach + quit for a registered user (no bare 'log out')", () => {
    wrap(true);
    expect(screen.getByTestId("detach-btn")).toHaveTextContent(/^detach$/i);
    expect(screen.getByTestId("quit-irc-btn")).toHaveTextContent(/^quit$/i);
    expect(screen.queryByText(/log out/i)).toBeNull();
  });

  it("clicking detach calls auth.logout, NOT quit.quitAll", async () => {
    const auth = await import("../lib/auth");
    const quit = await import("../lib/quit");
    wrap(true);
    fireEvent.click(screen.getByTestId("detach-btn"));
    expect(auth.logout).toHaveBeenCalled();
    expect(quit.quitAll).not.toHaveBeenCalled();
  });

  it("a single tap on quit arms it (shows confirm copy) but does NOT quit", async () => {
    const quit = await import("../lib/quit");
    wrap(true);
    fireEvent.click(screen.getByTestId("quit-irc-btn"));
    expect(screen.getByTestId("quit-irc-btn")).toHaveTextContent(/really quit IRC/i);
    expect(quit.quitAll).not.toHaveBeenCalled();
  });

  it("two-tap on quit calls quit.quitAll", async () => {
    const quit = await import("../lib/quit");
    wrap(true);
    fireEvent.click(screen.getByTestId("quit-irc-btn")); // arm
    fireEvent.click(screen.getByTestId("quit-irc-btn")); // confirm
    await waitFor(() => {
      expect(quit.quitAll).toHaveBeenCalled();
    });
  });

  it("closing the drawer disarms an armed quit button", async () => {
    const [open, setOpen] = createSignal(true);
    render(() => <SettingsDrawer open={open()} onClose={vi.fn()} onOpenAdmin={vi.fn()} />);
    fireEvent.click(screen.getByTestId("quit-irc-btn")); // arm
    expect(screen.getByTestId("quit-irc-btn")).toHaveTextContent(/really quit IRC/i);
    setOpen(false); // close
    await Promise.resolve();
    setOpen(true); // reopen
    await Promise.resolve();
    expect(screen.getByTestId("quit-irc-btn")).toHaveTextContent(/^quit$/i);
  });

  it("ephemeral visitor gets quit alone — no detach, no disconnect/reconnect, no 'log out'", () => {
    // #126 — an ephemeral (non-registered) visitor has no persistent
    // identity, so the persistent-identity verbs are withheld; quit is
    // the only (universal) verb. registered omitted = not registered.
    subjectHolder.current = { kind: "visitor", id: "v1", nick: "guest" };
    wrap(true);
    expect(screen.getByTestId("quit-irc-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("detach-btn")).toBeNull();
    expect(screen.queryByTestId("disconnect-btn")).toBeNull();
    expect(screen.queryByTestId("reconnect-btn")).toBeNull();
    expect(screen.queryByText(/^log out$/i)).toBeNull();
  });
});

// #126 — a registered (NickServ-identified) visitor is a persistent
// identity, so it gets the SAME persistent-identity verbs as a user
// (detach + disconnect ⇄ reconnect) PLUS the universal quit. The
// disconnect/reconnect button face follows the whereis-derived
// `connected` flag from /me.
describe("SettingsDrawer (#126 — registered-visitor lifecycle verbs)", () => {
  beforeEach(() => {
    subjectHolder.current = {
      kind: "visitor",
      id: "v1",
      nick: "vjt",
      registered: true,
    };
  });

  it("#211 phase 6 — detach + quit, NO disconnect/reconnect toggle", () => {
    meHolder.current = {
      kind: "visitor",
      id: "v1",
      nick: "vjt",
      expires_at: "2099-01-01T00:00:00Z",
      registered: true,
    };
    wrap(true);
    expect(screen.getByTestId("detach-btn")).toHaveTextContent(/^detach$/i);
    expect(screen.getByTestId("quit-irc-btn")).toHaveTextContent(/^quit$/i);
    // The disconnect ⇄ reconnect toggle is RETIRED — per-network
    // park/reconnect lives on the home page now (ruling D).
    expect(screen.queryByTestId("disconnect-btn")).toBeNull();
    expect(screen.queryByTestId("reconnect-btn")).toBeNull();
    expect(screen.queryByText(/^log out$/i)).toBeNull();
  });

  it("#211 phase 7 — identity editor seeds from the anchor network row, two-tap apply calls api.updateNetworkIdentity", async () => {
    const api = await import("../lib/api");
    meHolder.current = {
      kind: "visitor",
      id: "v1",
      nick: "vjt",
      expires_at: "2099-01-01T00:00:00Z",
      registered: true,
    };
    // Seed the anchor network row's identity fields.
    networksHolder.current = [
      {
        kind: "visitor" as const,
        id: 1,
        slug: "azzurra",
        nick: "vjt",
        ident: "grp" as string | null,
        realname: "Seed Name" as string | null,
        connection_state: "connected" as const,
        connection_state_reason: null as string | null,
        connection_state_changed_at: null as string | null,
        inserted_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];
    wrap(true);

    // Fields seed from the anchor network row on open.
    const nickInput = screen.getByLabelText(/^nick$/i) as HTMLInputElement;
    const identInput = screen.getByLabelText(/^ident$/i) as HTMLInputElement;
    const realnameInput = screen.getByLabelText(/real name/i) as HTMLInputElement;
    expect(nickInput.value).toBe("vjt");
    expect(identInput.value).toBe("grp");
    expect(realnameInput.value).toBe("Seed Name");

    // Edit + two-tap apply (arm, then confirm).
    fireEvent.input(nickInput, { target: { value: "vjt2" } });
    fireEvent.input(identInput, { target: { value: "newid" } });
    fireEvent.input(realnameInput, { target: { value: "New Name" } });
    const applyBtn = screen.getByTestId("settings-identity-apply");
    fireEvent.click(applyBtn); // arm
    fireEvent.click(applyBtn); // confirm

    await waitFor(() => {
      expect(api.updateNetworkIdentity).toHaveBeenCalledWith("test-bearer", "azzurra", {
        nick: "vjt2",
        ident: "newid",
        realname: "New Name",
      });
    });
  });

  it("#152 — identity editor is NOT shown for a user subject", () => {
    meHolder.current = {
      kind: "user",
      id: "u1",
      name: "alice",
      is_admin: false,
      inserted_at: "2026-06-29T00:00:00Z",
    };
    subjectHolder.current = { kind: "user", id: "u1", name: "alice" };
    wrap(true);
    expect(screen.queryByTestId("settings-identity")).toBeNull();
  });
});

describe("SettingsDrawer delete-account gating (#157)", () => {
  it("registered NON-admin user → shows the delete-account entry", () => {
    meHolder.current = {
      kind: "user",
      id: "u1",
      name: "alice",
      is_admin: false,
      inserted_at: "2026-06-29T00:00:00Z",
    };
    wrap(true);
    expect(screen.getByTestId("delete-account-btn")).toBeInTheDocument();
  });

  it("admin user → WITHHOLDS the delete-account entry (issue #157: not for admins)", () => {
    meHolder.current = {
      kind: "user",
      id: "u1",
      name: "admin",
      is_admin: true,
      inserted_at: "2026-06-29T00:00:00Z",
    };
    wrap(true);
    expect(screen.queryByTestId("delete-account-btn")).toBeNull();
  });

  it("registered visitor → shows the delete-account entry", () => {
    meHolder.current = {
      kind: "visitor",
      id: "v1",
      nick: "vjt",
      expires_at: "2026-06-30T00:00:00Z",
      registered: true,
    };
    wrap(true);
    expect(screen.getByTestId("delete-account-btn")).toBeInTheDocument();
  });

  it("anon visitor → WITHHOLDS the delete-account entry (quit-only)", () => {
    meHolder.current = {
      kind: "visitor",
      id: "v2",
      nick: "guest",
      expires_at: "2026-06-30T00:00:00Z",
      registered: false,
    };
    wrap(true);
    expect(screen.queryByTestId("delete-account-btn")).toBeNull();
  });

  it("null subject (loading) → WITHHOLDS the delete-account entry", () => {
    meHolder.current = null;
    wrap(true);
    expect(screen.queryByTestId("delete-account-btn")).toBeNull();
  });

  it("clicking the entry opens the confirm modal seeded with the account name", () => {
    meHolder.current = {
      kind: "user",
      id: "u1",
      name: "alice",
      is_admin: false,
      inserted_at: "2026-06-29T00:00:00Z",
    };
    wrap(true);
    expect(screen.queryByTestId("delete-account-modal-stub")).toBeNull();
    fireEvent.click(screen.getByTestId("delete-account-btn"));
    const stub = screen.getByTestId("delete-account-modal-stub");
    expect(stub).toBeInTheDocument();
    expect(stub).toHaveTextContent("alice");
  });
});

describe("SettingsDrawer — IRC keyboard toggle removed (#177)", () => {
  beforeEach(() => localStorage.clear());

  // #177 removed the custom on-screen IRC keyboard (failed experiment;
  // gestures replaced it). The per-device opt-in toggle is gone, so there
  // is no longer any way to enable the widget. Negative assertion paired
  // with a positive twin (the notifications master toggle, a stable
  // settings row) so a testid typo can't silently green the absence.
  it("no longer offers an IRC keyboard toggle (native keyboard is the only input)", () => {
    const { queryByTestId } = wrap(true);
    expect(queryByTestId("push-master-toggle")).not.toBeNull();
    expect(queryByTestId("irc-keyboard-toggle")).toBeNull();
  });
});
