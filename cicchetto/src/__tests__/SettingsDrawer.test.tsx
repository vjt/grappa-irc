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
    | { kind: "visitor"; id: string; nick: string; network_slug: string }
    | null,
}));
vi.mock("../lib/auth", () => ({
  logout: vi.fn().mockResolvedValue(undefined),
  token: () => "test-bearer",
  getSubject: () => subjectHolder.current,
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
    | { kind: "visitor"; id: string; nick: string; network_slug: string; expires_at: string }
    | null,
}));
vi.mock("../lib/networks", () => ({
  user: () => meHolder.current,
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

import { getKeyboardPref } from "../lib/keyboardPref";
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

  it("logout button calls auth.logout", async () => {
    const auth = await import("../lib/auth");
    wrap(true);
    fireEvent.click(screen.getByText(/log out/i));
    expect(auth.logout).toHaveBeenCalled();
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
      network_slug: "azzurra",
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

  it("renders theme + single 'log out' for visitor (notif/theme chrome same as user)", () => {
    wrap(true);
    expect(screen.getByLabelText(/auto/i)).toBeInTheDocument();
    // Theme chrome is shared; the logout affordance is NOT — visitors get
    // the single "log out" (the detach/quit split is user-only, issue #43).
    expect(screen.getByText(/log out/i)).toBeInTheDocument();
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
      network_slug: "azzurra",
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
      network_slug: "azzurra",
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
      network_slug: "azzurra",
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

// Issue #43 — split the single "log out" into two affordances for
// registered users: "detach" (today's logout — leave IRC connected) and
// "quit" (park ALL networks + logout — bouncer offline). Visitors keep
// the single "log out" (no persistent bouncer binding; the split is
// meaningless). The split is gated on subject.kind === "user", so the
// not-yet-loaded (null subject) state stays on the safe single button.
describe("SettingsDrawer (issue #43 — split logout)", () => {
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

  it("visitor keeps a single 'log out' (no detach/quit split)", () => {
    subjectHolder.current = { kind: "visitor", id: "v1", nick: "guest", network_slug: "libera" };
    wrap(true);
    expect(screen.getByText(/log out/i)).toBeInTheDocument();
    expect(screen.queryByTestId("detach-btn")).toBeNull();
    expect(screen.queryByTestId("quit-irc-btn")).toBeNull();
  });
});

describe("SettingsDrawer IRC keyboard toggle", () => {
  beforeEach(() => localStorage.clear());

  it("persists the keyboard opt-in and reflects it in the checkbox when toggled", () => {
    const { getByTestId } = wrap(true);
    const toggle = getByTestId("irc-keyboard-toggle") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(getKeyboardPref()).toBe(true);
    expect(toggle.checked).toBe(true); // UI reflects the persisted state
    fireEvent.click(toggle); // off again clears the preference
    expect(getKeyboardPref()).toBe(false);
    expect(toggle.checked).toBe(false);
  });
});
