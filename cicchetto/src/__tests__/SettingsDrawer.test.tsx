import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@solidjs/router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../lib/fontSize", () => ({
  getFontSize: vi.fn(() => "M"),
  setFontSize: vi.fn(),
}));

vi.mock("../lib/timeFormat", () => ({
  getTimeFormat: vi.fn(() => "hms"),
  setTimeFormat: vi.fn(),
}));

vi.mock("../lib/colorNicklist", () => ({
  getColoredNicklist: vi.fn(() => false),
  setColoredNicklist: vi.fn(),
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
// Spread the REAL auth module so `showDetach`'s `isPersistentIdentity`
// predicate runs for real against the stubbed getSubject (the drawer +
// lib/lifecycle both route on it now). Only side-effecting exports stubbed.
vi.mock("../lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/auth")>()),
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
  // #157 / #478 — the drawer derives the delete-account confirm text from
  // displayNick(me) (user) / visitorNetworkNick(selectedNetwork) (visitor).
  // #478 retired the lowest-id "anchor" pick: the visitor's confirm nick is
  // now the SELECTED network row's nick (kind==="visitor" narrow retained).
  displayNick: (me: { kind: "user"; name: string } | { kind: "visitor" }) =>
    me.kind === "user" ? me.name : "Visitor",
  visitorNetworkNick: (net: { kind: string; nick: string } | null) =>
    net?.kind === "visitor" ? net.nick : null,
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
  // #476 — a REACTIVE bump so a test can simulate a live `/networks` refetch
  // (production `networks()` is a createResource; here it's a stubbed getter).
  // Wired by the async mock factory below to a Solid signal. Tests that set
  // `.current` before wrap() never call this and see no behaviour change;
  // the no-clobber test mutates `.current` then bump()s to re-fire the
  // component's effects, so it can prove a refetch does NOT overwrite an
  // in-progress edit (rather than passing vacuously against a dead getter).
  bump: null as null | (() => void),
}));
vi.mock("../lib/networks", async () => {
  const { createSignal } = await import("solid-js");
  const [refetchVersion, setRefetchVersion] = createSignal(0);
  networksHolder.bump = () => setRefetchVersion((v) => v + 1);
  return {
    user: () => meHolder.current,
    // #211 phase 7 — the identity editor + delete-confirm read the visitor's
    // network rows (anchor nick + per-network ident/realname seed). Stub a
    // single azzurra visitor row so the editor has an anchor to target.
    // Reading `refetchVersion()` makes every tracked consumer re-run on
    // bump() — the reactive twin of a live resource refetch.
    networks: () => {
      refetchVersion();
      return networksHolder.current;
    },
    // #126 — disconnect/reconnect refetch /me; the drawer imports this via
    // lib/lifecycle. Stub so the import resolves + the verb is observable.
    refetchUser: vi.fn(),
    isAdmin: () => {
      const u = meHolder.current;
      return u?.kind === "user" && u.is_admin === true;
    },
  };
});

// #476 — the per-network identity editor defaults its target to the
// currently-focused network. The drawer reads `selectedChannel()` from
// lib/selection to resolve that default; a mutable holder lets a test pin
// the focused network (or null for "no focus → first network").
const selectedChannelHolder = vi.hoisted(() => ({
  current: null as { networkSlug: string; channelName: string; kind: string } | null,
}));
vi.mock("../lib/selection", () => ({
  selectedChannel: () => selectedChannelHolder.current,
}));

// #866 — the mute picker offers exactly the sidebar's window universe, which
// `activeWindows.windowCandidates` derives from networks × channels × query
// windows. Mocked at THAT boundary rather than by stubbing its three upstream
// stores: the drawer's contract is "whatever the shared projection returns
// becomes an option", and a test that rebuilt the projection would be
// asserting its own arithmetic.
const windowCandidatesHolder = vi.hoisted(() => ({
  current: [] as { networkSlug: string; channelName: string; kind: "channel" | "query" }[],
}));
vi.mock("../lib/activeWindows", () => ({
  windowCandidates: () => windowCandidatesHolder.current,
}));

vi.mock("../lib/push", () => ({
  enablePush: vi.fn().mockResolvedValue({ status: "enabled", subscriptionId: "sub-1" }),
  disablePush: vi.fn().mockResolvedValue(true),
  listPushDevices: vi.fn().mockResolvedValue([]),
  deletePushSubscription: vi.fn().mockResolvedValue(undefined),
  // #459 — the toggle now gates on availability up-front; default available so
  // the existing enable/disable tests exercise the live toggle path.
  pushAvailable: vi.fn(() => true),
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
    // #252 — the drawer loads the vhost view on mount; stub it so the
    // "source address (vhost)" nav row renders (the sub-page's own widget
    // logic is covered in VhostSettingsPage.test.tsx).
    getVhostSettings: vi.fn().mockResolvedValue({
      available: [
        { address: "2001:db8::1", in_pool: true, granted: false, name: "pool-one.cloak" },
      ],
      selection: [],
    }),
    putVhostSelection: vi.fn().mockImplementation((_t: string, selection: string[]) =>
      Promise.resolve({
        available: [
          { address: "2001:db8::1", in_pool: true, granted: false, name: "pool-one.cloak" },
        ],
        selection,
      }),
    ),
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

// #392 — the share surface is now a MODAL mounted in Shell (not in the
// drawer). The drawer's "share session" button just flips the shared open
// signal via openShareModal(); mock it so the click is observable here
// without mounting the modal (its own behaviour lives in
// ShareSessionModal.test.tsx).
const shareModalHolder = { opened: 0 };
vi.mock("../lib/shareModal", () => ({
  openShareModal: () => {
    shareModalHolder.opened += 1;
  },
}));

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

// #460 — the settings main page is an index of nav rows; general / display /
// push (notifications) content now lives in dedicated sub-pages reached by
// tapping the owning row. Content assertions navigate into the sub-page first.
const openSub = (entryTestId: string) => fireEvent.click(screen.getByTestId(entryTestId));

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no subject loaded yet — covers the pre-login / loading
  // state where me() returns null. Admin entry MUST be hidden.
  meHolder.current = null;
  uploadTtlHolder.current = null;
  subjectHolder.current = null;
  selectedChannelHolder.current = null;
  windowCandidatesHolder.current = [];
});

describe("SettingsDrawer", () => {
  it("does not render the legacy theme selector radios (#299 removed it)", () => {
    wrap(true);
    // The auto/mirc-light/irssi-dark radio selector was superseded by the
    // #75 gallery (cog → themes) and removed. It must be gone from the
    // settings main page.
    expect(screen.queryByLabelText(/mirc light/i)).toBeNull();
    expect(screen.queryByLabelText(/irssi dark/i)).toBeNull();
  });

  it("renders the #217 timestamp-format radios (default with-seconds checked)", () => {
    wrap(true);
    openSub("display-settings-entry");
    const hms = screen.getByTestId("time-format-hms") as HTMLInputElement;
    const hm = screen.getByTestId("time-format-hm") as HTMLInputElement;
    expect(hms).toBeInTheDocument();
    expect(hm).toBeInTheDocument();
    // getTimeFormat mock returns "hms" → the with-seconds radio is checked.
    expect(hms.checked).toBe(true);
    expect(hm.checked).toBe(false);
  });

  it("picking a timestamp format fires setTimeFormat", async () => {
    const timeFormat = await import("../lib/timeFormat");
    wrap(true);
    openSub("display-settings-entry");
    fireEvent.click(screen.getByTestId("time-format-hm"));
    expect(timeFormat.setTimeFormat).toHaveBeenCalledWith("hm");
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

describe("SettingsDrawer display options section (#443)", () => {
  it("groups text size, timestamp format and the colored-nicklist toggle under one section", () => {
    wrap(true);
    // #460 — the display section moved VERBATIM into the display sub-page; the
    // three controls still live grouped in ONE .settings-section-display block.
    openSub("display-settings-entry");
    const section = screen.getByTestId("settings-section-display");
    expect(section).toBeInTheDocument();
    expect(section.textContent).toContain("display options");
    expect(section.querySelector('[data-testid="font-size-M"]')).not.toBeNull();
    expect(section.querySelector('[data-testid="time-format-hms"]')).not.toBeNull();
    expect(section.querySelector('[data-testid="colored-nicklist-toggle"]')).not.toBeNull();
  });

  it("renders the colored-nicklist toggle unchecked by default", () => {
    wrap(true);
    openSub("display-settings-entry");
    const toggle = screen.getByTestId("colored-nicklist-toggle") as HTMLInputElement;
    // getColoredNicklist mock returns false → off by default (current behavior).
    expect(toggle.checked).toBe(false);
  });

  it("toggling the colored-nicklist checkbox fires setColoredNicklist(true)", async () => {
    const colorNicklist = await import("../lib/colorNicklist");
    wrap(true);
    openSub("display-settings-entry");
    fireEvent.click(screen.getByTestId("colored-nicklist-toggle"));
    expect(colorNicklist.setColoredNicklist).toHaveBeenCalledWith(true);
  });
});

describe("SettingsDrawer notifications section", () => {
  it("renders the master toggle + 4 prefs checkboxes + 2 whitelist inputs", () => {
    wrap(true);
    openSub("push-settings-entry");
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
    openSub("push-settings-entry");
    const toggle = screen.getByTestId("push-master-toggle") as HTMLInputElement;
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(push.enablePush).toHaveBeenCalledWith("test-bearer");
    });
  });

  // #459 — availability discovered up-front: on a platform that cannot deliver
  // push (no Push API / iOS browser tab) the toggle is disabled and a hint
  // explains why, instead of the old click-then-fail `unsupported` banner.
  it("disables the master toggle and shows a hint when push is unavailable", async () => {
    const push = await import("../lib/push");
    vi.mocked(push.pushAvailable).mockReturnValue(false);
    try {
      wrap(true);
      openSub("push-settings-entry");
      const toggle = screen.getByTestId("push-master-toggle") as HTMLInputElement;
      expect(toggle.disabled).toBe(true);
      expect(screen.getByTestId("push-unavailable")).toBeInTheDocument();
    } finally {
      vi.mocked(push.pushAvailable).mockReturnValue(true);
    }
  });

  it("toggling a pref checkbox calls putNotificationPrefs", async () => {
    const userSettings = await import("../lib/userSettings");
    wrap(true);
    openSub("push-settings-entry");
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
    openSub("push-settings-entry");
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
    openSub("push-settings-entry");
    fireEvent.click(screen.getByTestId("push-master-toggle"));
    await waitFor(() => {
      expect(screen.getByTestId("push-banner")).toBeInTheDocument();
    });
  });
});

// #866 — the mute surface. vjt's Q5 ruled OUT a free-text field ("a long
// free-text line of channel names is bad UX") in favour of a picker over the
// conversations you actually have, with each mute rendered as its own
// removable row.
describe("SettingsDrawer muted conversations — #866", () => {
  const optionValues = (): string[] =>
    [...(screen.getByTestId("pref-mute-picker") as HTMLSelectElement).options].map((o) => o.value);

  const lastPutPrefs = async (): Promise<Record<string, unknown>> => {
    const userSettings = await import("../lib/userSettings");
    const calls = (userSettings.putNotificationPrefs as ReturnType<typeof vi.fn>).mock.calls;
    const last = calls[calls.length - 1] as [string, Record<string, unknown>];
    return last[1];
  };

  const openPush = async () => {
    const userSettings = await import("../lib/userSettings");
    wrap(true);
    openSub("push-settings-entry");
    await waitFor(() => {
      expect(userSettings.getNotificationPrefs).toHaveBeenCalled();
    });
  };

  beforeEach(() => {
    windowCandidatesHolder.current = [
      { networkSlug: "azzurra", channelName: "#Sbiffo", kind: "channel" },
      { networkSlug: "azzurra", channelName: "alice", kind: "query" },
    ];
  });

  it("offers the conversations you are in, keyed by the folded name", async () => {
    await openPush();

    // "#Sbiffo" is offered under its FOLDED key — that is what gets stored and
    // what the predicate compares against — while the option still READS as
    // the operator typed it.
    expect(optionValues()).toEqual(["", "#sbiffo", "alice"]);
    expect(screen.getByRole("option", { name: "#Sbiffo" })).toBeInTheDocument();
  });

  it("collapses the same conversation on two networks into one option", async () => {
    windowCandidatesHolder.current = [
      { networkSlug: "azzurra", channelName: "#grappa", kind: "channel" },
      { networkSlug: "libera", channelName: "#Grappa", kind: "channel" },
    ];

    await openPush();

    // muted_targets is per-subject and carries no network, so offering the
    // name twice would promise a per-network mute the store cannot keep.
    expect(optionValues()).toEqual(["", "#grappa"]);
    // And the surviving LABEL is the first candidate's spelling, i.e. the one
    // the sidebar is showing highest. Measured: without this assertion the
    // dedupe guard was unconstrained — the Map collapses the key on its own,
    // so dropping the guard only flipped which spelling won and nothing went
    // red. The guard now has to earn its line.
    expect(screen.getByRole("option", { name: "#grappa" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "#Grappa" })).toBeNull();
  });

  it("picking a conversation persists a permanent mute and adopts the server echo", async () => {
    await openPush();

    fireEvent.change(screen.getByTestId("pref-mute-picker"), { target: { value: "#sbiffo" } });

    await waitFor(async () => {
      expect(await lastPutPrefs()).toMatchObject({
        muted_targets: { "#sbiffo": { until: null } },
      });
    });
    // The row appears because the PUT's echo came back, not because the click
    // optimistically drew it: the mock echoes what it was sent, and the store
    // rule is that cic adopts the server's normalized map.
    await waitFor(() => {
      expect(screen.getByTestId("pref-muted-#sbiffo")).toBeInTheDocument();
    });
  });

  it("drops an already-muted conversation from the picker", async () => {
    const userSettings = await import("../lib/userSettings");
    (userSettings.getNotificationPrefs as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...userSettings.DEFAULT_NOTIFICATION_PREFS,
      muted_targets: { "#sbiffo": { until: null } },
    });

    await openPush();

    await waitFor(() => {
      expect(optionValues()).toEqual(["", "alice"]);
    });
  });

  it("the × removes just that mute and leaves the others stored", async () => {
    const userSettings = await import("../lib/userSettings");
    (userSettings.getNotificationPrefs as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...userSettings.DEFAULT_NOTIFICATION_PREFS,
      muted_targets: { "#sbiffo": { until: null }, alice: { until: null } },
    });

    await openPush();
    await waitFor(() => {
      expect(screen.getByTestId("pref-muted-#sbiffo")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Unmute #sbiffo"));

    await waitFor(async () => {
      expect(await lastPutPrefs()).toMatchObject({ muted_targets: { alice: { until: null } } });
    });
    // The removed key is ABSENT, not present-with-a-falsy-value: the predicate
    // decides on key presence alone.
    expect((await lastPutPrefs()).muted_targets).not.toHaveProperty("#sbiffo");
  });

  it("disables the picker when every conversation is already muted", async () => {
    const userSettings = await import("../lib/userSettings");
    (userSettings.getNotificationPrefs as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...userSettings.DEFAULT_NOTIFICATION_PREFS,
      muted_targets: { "#sbiffo": { until: null }, alice: { until: null } },
    });

    await openPush();

    await waitFor(() => {
      expect((screen.getByTestId("pref-mute-picker") as HTMLSelectElement).disabled).toBe(true);
    });
  });

  it("tolerates a server response with no muted_targets at all", async () => {
    const userSettings = await import("../lib/userSettings");
    const legacy = { ...userSettings.DEFAULT_NOTIFICATION_PREFS };
    delete legacy.muted_targets;
    (userSettings.getNotificationPrefs as ReturnType<typeof vi.fn>).mockResolvedValueOnce(legacy);

    await openPush();

    expect(optionValues()).toEqual(["", "#sbiffo", "alice"]);
    expect(screen.queryByTestId("pref-muted-list")).toBeNull();
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
    openSub("push-settings-entry");
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
    openSub("push-settings-entry");
    fireEvent.click(screen.getByTestId("push-master-toggle"));
    await waitFor(() => {
      expect(push.enablePush).toHaveBeenCalledWith("test-bearer");
    });
  });

  it("renders the universal quit verb for the loading null subject", () => {
    wrap(true);
    // #126 — the lifecycle affordance is quit alone for the not-yet-loaded
    // subject ("log out" retired). (#299 removed the theme radio selector.)
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
    openSub("general-settings-entry");
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
    openSub("general-settings-entry");
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
    openSub("general-settings-entry");
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
    openSub("general-settings-entry");
    const select = screen.getByTestId("upload-ttl-select") as HTMLSelectElement;
    expect(select.value).toBe("86400");
  });

  it("selecting an option PUTs the matching seconds", async () => {
    const orch = await import("../lib/uploadOrchestrator");
    wrap(true);
    openSub("general-settings-entry");
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
    openSub("general-settings-entry");
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

  it("shows the identity section (general sub-page) + share button (main) when subject is a visitor", () => {
    subjectHolder.current = {
      kind: "visitor",
      id: "v1",
      nick: "alice",
    };
    wrap(true);
    // #460 — the share entry STAYS on the main page (split out of the old
    // isVisitor block); the identity card MOVED into the general sub-page.
    expect(screen.getByTestId("share-session-entry")).toBeInTheDocument();
    openSub("general-settings-entry");
    // #335 identity card stays; #392 dropped the share wrapper card — the
    // share entry is now a bare muted-subtitle button.
    expect(screen.getByTestId("settings-section-identity")).toBeInTheDocument();
  });

  it("hides share-session entry when subject is not loaded", () => {
    subjectHolder.current = null;
    wrap(true);
    expect(screen.queryByTestId("share-session-entry")).toBeNull();
  });

  it("clicking the share-session entry opens the share modal (#392)", () => {
    subjectHolder.current = {
      kind: "visitor",
      id: "v1",
      nick: "alice",
    };
    shareModalHolder.opened = 0;
    wrap(true);
    // Rendering the drawer must NOT open the modal — only the click does.
    expect(shareModalHolder.opened).toBe(0);

    fireEvent.click(screen.getByTestId("share-session-entry"));

    expect(shareModalHolder.opened).toBe(1);
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

  it("#211 phase 7 — identity editor seeds from the selected (only) network row, two-tap apply calls api.updateNetworkIdentity", async () => {
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
    openSub("general-settings-entry");

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

  it("#476 — identity editor IS shown for a user subject (visitor-gate relic removed)", () => {
    meHolder.current = {
      kind: "user",
      id: "u1",
      name: "alice",
      is_admin: false,
      inserted_at: "2026-06-29T00:00:00Z",
    };
    subjectHolder.current = { kind: "user", id: "u1", name: "alice" };
    // A user carries per-network identity on the GET /networks rows (both
    // subjects converged, ruling A). Seed a single USER network row.
    networksHolder.current = [
      {
        kind: "user" as const,
        id: 1,
        slug: "bahamut-test",
        nick: "vjt-grappa",
        ident: "grp" as string | null,
        realname: "Real Name" as string | null,
        connection_state: "connected" as const,
        connection_state_reason: null as string | null,
        connection_state_changed_at: null as string | null,
        inserted_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];
    wrap(true);
    // #476 — the visitor-only gate (retired premise: "users have no
    // per-network identity") is gone; the editor shows for a user too, seeded
    // from the user's network row.
    openSub("general-settings-entry");
    expect(screen.getByTestId("settings-section-identity")).toBeInTheDocument();
    expect((screen.getByLabelText(/^nick$/i) as HTMLInputElement).value).toBe("vjt-grappa");
  });
});

// #497 — general sub-page: identity outranks the rarely-touched upload knob,
// and a one-option network picker is noise (hidden entirely on a single
// network — the common visitor case).
describe("SettingsDrawer (#497 — general ordering + single-network selector)", () => {
  const userMe = {
    kind: "user" as const,
    id: "u1",
    name: "alice",
    is_admin: false,
    inserted_at: "2026-06-29T00:00:00Z",
  };
  const netRow = (id: number, slug: string, nick: string) => ({
    kind: "user" as const,
    id,
    slug,
    nick,
    ident: null as string | null,
    realname: null as string | null,
    connection_state: "connected" as const,
    connection_state_reason: null as string | null,
    connection_state_changed_at: null as string | null,
    inserted_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });

  it("renders the identity section BEFORE the upload-retention fieldset", () => {
    meHolder.current = userMe;
    subjectHolder.current = { kind: "user", id: "u1", name: "alice" };
    networksHolder.current = [netRow(1, "bahamut-test", "vjt-grappa")];
    wrap(true);
    openSub("general-settings-entry");

    const identity = screen.getByTestId("settings-section-identity");
    const upload = screen.getByTestId("upload-ttl-select");
    // Identity is what a user looks for; upload retention is a rarely-touched
    // knob — identity must precede it (upload FOLLOWS identity in the DOM).
    expect(
      identity.compareDocumentPosition(upload) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("hides the whole Network row when the subject holds exactly one network", () => {
    meHolder.current = userMe;
    subjectHolder.current = { kind: "user", id: "u1", name: "alice" };
    networksHolder.current = [netRow(1, "bahamut-test", "vjt-grappa")];
    wrap(true);
    openSub("general-settings-entry");

    // The identity editor still renders (nick/realname/ident fields) …
    expect(screen.getByTestId("settings-section-identity")).toBeInTheDocument();
    // … but a one-option picker is noise: neither the <select> nor the
    // static network label is rendered (the whole row is gone).
    expect(screen.queryByTestId("settings-identity-network-select")).toBeNull();
    expect(screen.queryByTestId("settings-identity-network-label")).toBeNull();
  });

  it("shows the Network selector when the subject holds more than one network", () => {
    meHolder.current = userMe;
    subjectHolder.current = { kind: "user", id: "u1", name: "alice" };
    networksHolder.current = [netRow(1, "bahamut-test", "vjt-grappa"), netRow(2, "azzurra", "vjt")];
    wrap(true);
    openSub("general-settings-entry");

    expect(screen.getByTestId("settings-identity-network-select")).toBeInTheDocument();
    // The "Network" label is reinstated alongside the picker (the `for`
    // association restored — no dangling label when the row IS shown).
    expect(screen.getByText("Network")).toBeInTheDocument();
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

// #252 — the vhost settings sub-page nav. The drawer owns the
// main↔vhost page signal + the load/save wiring; the sub-page widget
// (bucketing, toggle, tap→PUT, NAME render) is covered in
// VhostSettingsPage.test.tsx. Here we assert the drawer-level nav.
describe("SettingsDrawer (#252 — vhost sub-page nav)", () => {
  it("shows the vhost nav row on the main page once the view loads", async () => {
    wrap(true);
    await waitFor(() => {
      expect(screen.getByTestId("vhost-settings-entry")).toBeInTheDocument();
    });
  });

  it("clicking the nav row enters the sub-page and hides the main content", async () => {
    wrap(true);
    await waitFor(() => screen.getByTestId("vhost-settings-entry"));
    fireEvent.click(screen.getByTestId("vhost-settings-entry"));
    await waitFor(() => {
      expect(screen.getByTestId("vhost-subpage")).toBeInTheDocument();
    });
    // #460 — main-page chrome (a stable index nav row) is gone while on the
    // sub-page. (The notifications toggle now lives in its own push sub-page,
    // so it is no longer a main-page marker.)
    expect(screen.queryByTestId("themes-settings-entry")).toBeNull();
  });

  it("the sub-page back button returns to the main page", async () => {
    wrap(true);
    await waitFor(() => screen.getByTestId("vhost-settings-entry"));
    fireEvent.click(screen.getByTestId("vhost-settings-entry"));
    await waitFor(() => screen.getByTestId("vhost-subpage"));
    fireEvent.click(screen.getByTestId("vhost-back"));
    await waitFor(() => {
      expect(screen.getByTestId("themes-settings-entry")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("vhost-subpage")).toBeNull();
  });

  it("tapping a vhost (customize ON) PUTs the selection through the drawer", async () => {
    const userSettings = await import("../lib/userSettings");
    wrap(true);
    await waitFor(() => screen.getByTestId("vhost-settings-entry"));
    fireEvent.click(screen.getByTestId("vhost-settings-entry"));
    await waitFor(() => screen.getByTestId("vhost-subpage"));
    // Empty selection → customize starts OFF; turn it ON to reveal the sections.
    fireEvent.click(screen.getByTestId("vhost-customize-toggle"));
    fireEvent.click(screen.getByTestId("vhost-option-2001:db8::1"));
    await waitFor(() => {
      expect(userSettings.putVhostSelection).toHaveBeenCalledWith("test-bearer", ["2001:db8::1"]);
    });
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
    // #460 — positive twin is a stable main-page index row (the push toggle
    // moved into its own sub-page).
    expect(queryByTestId("themes-settings-entry")).not.toBeNull();
    expect(queryByTestId("irc-keyboard-toggle")).toBeNull();
  });
});

// #460 — the settings main page is now an INDEX of nav rows; general
// (upload-retention + identity), display (text size / timestamp / colored
// nicklist), and push (notifications) content moved into dedicated sub-pages
// reached by tapping the owning row. This block pins the index IA + the
// index↔sub-page↔back navigation; the per-page content assertions live in the
// sub-page-specific describes above (navigate-then-assert).
describe("SettingsDrawer (#460 — settings index)", () => {
  const rowIds = (container: HTMLElement): (string | null)[] =>
    Array.from(container.querySelectorAll(".settings-nav-row")).map((el) =>
      el.getAttribute("data-testid"),
    );

  it("renders the index nav rows in order; the vhost row appends LAST once its view loads", async () => {
    const { container } = wrap(true);
    // The always-present index rows, in the #460 order (perform right after
    // aliases; source-address last).
    expect(rowIds(container)).toEqual([
      "general-settings-entry",
      "display-settings-entry",
      "themes-settings-entry",
      "push-settings-entry",
      "watchlists-settings-entry",
      "aliases-settings-entry",
      "perform-settings-entry",
    ]);
    // The vhost row is gated on the async view load; it appends at the end.
    await waitFor(() => expect(screen.getByTestId("vhost-settings-entry")).toBeInTheDocument());
    expect(rowIds(container)).toEqual([
      "general-settings-entry",
      "display-settings-entry",
      "themes-settings-entry",
      "push-settings-entry",
      "watchlists-settings-entry",
      "aliases-settings-entry",
      "perform-settings-entry",
      "vhost-settings-entry",
    ]);
  });

  it("every index nav row carries a non-empty subtitle (self-explaining index)", async () => {
    const { container } = wrap(true);
    // Wait for the async vhost row so all eight rows are present.
    await waitFor(() => screen.getByTestId("vhost-settings-entry"));
    const rows = Array.from(container.querySelectorAll(".settings-nav-row"));
    expect(rows.length).toBe(8);
    for (const row of rows) {
      const subtitle = row.querySelector(".settings-nav-row-subtitle");
      expect(subtitle).not.toBeNull();
      expect((subtitle?.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("#476 — the general subtitle omits identity when there are no networks (no false promise)", () => {
    // No networks (loading / empty-bind account): the general page shows only
    // the host-gated upload retention — identity needs a network row to edit —
    // so the subtitle must NOT promise identity the subject can't reach.
    networksHolder.current = [];
    wrap(true);
    const sub = screen
      .getByTestId("general-settings-entry")
      .querySelector(".settings-nav-row-subtitle");
    expect(sub?.textContent).toContain("upload retention");
    expect(sub?.textContent).not.toContain("identity");
  });

  it("#476 — the general subtitle names per-network identity whenever there are networks (any subject)", () => {
    // The editor is subject-agnostic now (visitor-gate relic removed); the
    // subtitle promises identity for a USER with a network too, driven by the
    // presence of a Network row, not the subject class.
    subjectHolder.current = { kind: "user", id: "u1", name: "alice" };
    networksHolder.current = [
      {
        kind: "user" as const,
        id: 1,
        slug: "bahamut-test",
        nick: "vjt-grappa",
        ident: null as string | null,
        realname: null as string | null,
        connection_state: "connected" as const,
        connection_state_reason: null as string | null,
        connection_state_changed_at: null as string | null,
        inserted_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];
    wrap(true);
    const sub = screen
      .getByTestId("general-settings-entry")
      .querySelector(".settings-nav-row-subtitle");
    expect(sub?.textContent).toContain("upload retention");
    expect(sub?.textContent).toContain("per-network identity");
  });

  it("tapping the display row opens the display sub-page; back returns to the index", () => {
    wrap(true);
    openSub("display-settings-entry");
    expect(screen.getByTestId("settings-section-display")).toBeInTheDocument();
    // The index chrome is replaced while on the sub-page.
    expect(screen.queryByTestId("themes-settings-entry")).toBeNull();
    fireEvent.click(screen.getByTestId("display-back"));
    expect(screen.getByTestId("themes-settings-entry")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-section-display")).toBeNull();
  });

  it("tapping the notifications row opens the push sub-page; back returns to the index", () => {
    wrap(true);
    openSub("push-settings-entry");
    expect(screen.getByTestId("push-master-toggle")).toBeInTheDocument();
    expect(screen.queryByTestId("themes-settings-entry")).toBeNull();
    fireEvent.click(screen.getByTestId("push-back"));
    expect(screen.getByTestId("themes-settings-entry")).toBeInTheDocument();
    expect(screen.queryByTestId("push-master-toggle")).toBeNull();
  });

  it("tapping the general row opens the general sub-page (visitor: identity + upload retention); back returns", () => {
    subjectHolder.current = { kind: "visitor", id: "v1", nick: "alice" };
    networksHolder.current = [
      {
        kind: "visitor" as const,
        id: 1,
        slug: "azzurra",
        nick: "alice",
        ident: null as string | null,
        realname: null as string | null,
        connection_state: "connected" as const,
        connection_state_reason: null as string | null,
        connection_state_changed_at: null as string | null,
        inserted_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];
    wrap(true);
    openSub("general-settings-entry");
    expect(screen.getByTestId("settings-section-identity")).toBeInTheDocument();
    expect(screen.getByTestId("upload-ttl-select")).toBeInTheDocument();
    expect(screen.queryByTestId("themes-settings-entry")).toBeNull();
    fireEvent.click(screen.getByTestId("general-back"));
    expect(screen.getByTestId("themes-settings-entry")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-section-identity")).toBeNull();
  });

  it("a pending deep-link request lands the drawer directly on that sub-page (index deep-links survive)", async () => {
    // The deep-link machinery (requestSettingsPage → consume on open) is
    // unchanged by #460; assert it still lands the drawer on a sub-page (here
    // the NEW push page) instead of the index.
    const nav = await import("../lib/settingsNav");
    nav.requestSettingsPage("push");
    wrap(true);
    await waitFor(() => expect(screen.getByTestId("push-master-toggle")).toBeInTheDocument());
    expect(screen.queryByTestId("themes-settings-entry")).toBeNull();
  });

  it("share session, quit + done stay on the main index page (not moved into a sub-page)", () => {
    subjectHolder.current = { kind: "visitor", id: "v1", nick: "alice" };
    wrap(true);
    // These affordances live BELOW the index on the main page.
    expect(screen.getByTestId("share-session-entry")).toBeInTheDocument();
    expect(screen.getByTestId("quit-irc-btn")).toBeInTheDocument();
    expect(screen.getByTestId("settings-drawer-done")).toBeInTheDocument();
  });
});

// #476 / #478 — the per-network identity editor is available to BOTH subjects
// (the visitor-only gate was a relic of the retired "users have no per-network
// identity" premise) and targets the SELECTED network row rather than the
// lowest-id "anchor" (the #478 relic). A row-factory keeps the many-network
// fixtures readable.
describe("SettingsDrawer (#476/#478 — per-network identity, both subjects)", () => {
  type Kind = "user" | "visitor";
  const netRow = (
    kind: Kind,
    id: number,
    slug: string,
    nick: string,
    ident = "",
    realname = "",
  ) => ({
    kind,
    id,
    slug,
    nick,
    ident: (ident === "" ? null : ident) as string | null,
    realname: (realname === "" ? null : realname) as string | null,
    connection_state: "connected" as const,
    connection_state_reason: null as string | null,
    connection_state_changed_at: null as string | null,
    inserted_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });

  const seedUser = () => {
    meHolder.current = {
      kind: "user",
      id: "u1",
      name: "alice",
      is_admin: false,
      inserted_at: "2026-06-29T00:00:00Z",
    };
    subjectHolder.current = { kind: "user", id: "u1", name: "alice" };
  };

  it("#476/#497 — a single network hides the whole network row; the editor still targets the sole net", () => {
    seedUser();
    networksHolder.current = [netRow("user", 1, "bahamut-test", "vjt-grappa", "grp", "Real")];
    wrap(true);
    openSub("general-settings-entry");
    // #497 — a one-option picker is noise: no selector AND no static label
    // (the earlier #476 static label is gone; the whole row is hidden).
    expect(screen.queryByTestId("settings-identity-network-select")).toBeNull();
    expect(screen.queryByTestId("settings-identity-network-label")).toBeNull();
    // …but the identity editor still renders and seeds from the sole network.
    expect((screen.getByLabelText(/^nick$/i) as HTMLInputElement).value).toBe("vjt-grappa");
  });

  it("#476/#478 — >1 network renders a selector; picking one re-seeds fields + targets it on apply", async () => {
    const api = await import("../lib/api");
    seedUser();
    networksHolder.current = [
      netRow("user", 1, "azzurra", "nick-a", "id-a", "Real A"),
      netRow("user", 2, "libera", "nick-b", "id-b", "Real B"),
    ];
    // No focus → default to the FIRST network (azzurra), NOT a lowest-id anchor
    // decision baked into a helper — the selector owns the choice now.
    wrap(true);
    openSub("general-settings-entry");
    const select = screen.getByTestId("settings-identity-network-select") as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(select.value).toBe("azzurra");
    const nick = screen.getByLabelText(/^nick$/i) as HTMLInputElement;
    expect(nick.value).toBe("nick-a");

    // Switch target → fields re-seed from the newly-selected row.
    fireEvent.change(select, { target: { value: "libera" } });
    expect(nick.value).toBe("nick-b");
    expect((screen.getByLabelText(/^ident$/i) as HTMLInputElement).value).toBe("id-b");
    expect((screen.getByLabelText(/real name/i) as HTMLInputElement).value).toBe("Real B");

    // Apply PATCHes the SELECTED network's slug (libera), not the first.
    const applyBtn = screen.getByTestId("settings-identity-apply");
    fireEvent.click(applyBtn);
    fireEvent.click(applyBtn);
    await waitFor(() => {
      expect(api.updateNetworkIdentity).toHaveBeenCalledWith("test-bearer", "libera", {
        nick: "nick-b",
        ident: "id-b",
        realname: "Real B",
      });
    });
  });

  it("#476 — the editor defaults its target to the currently-focused network", () => {
    seedUser();
    networksHolder.current = [
      netRow("user", 1, "azzurra", "nick-a"),
      netRow("user", 2, "libera", "nick-b"),
    ];
    selectedChannelHolder.current = { networkSlug: "libera", channelName: "#x", kind: "channel" };
    wrap(true);
    openSub("general-settings-entry");
    const select = screen.getByTestId("settings-identity-network-select") as HTMLSelectElement;
    expect(select.value).toBe("libera");
    expect((screen.getByLabelText(/^nick$/i) as HTMLInputElement).value).toBe("nick-b");
  });

  it("#476 — general sub-page hides identity entirely when there are no networks", () => {
    meHolder.current = null;
    subjectHolder.current = null;
    networksHolder.current = [];
    wrap(true);
    // The general row still opens (upload retention is host-gated, present).
    openSub("general-settings-entry");
    expect(screen.queryByTestId("settings-section-identity")).toBeNull();
  });

  it("#476 — a same-target /networks refetch does not clobber an in-progress nick edit", () => {
    // The load-bearing reason the re-seed effect uses on(selectedIdentitySlug)
    // (slug-only tracking) + the identitySeeded latch: a background /networks
    // refetch of the SAME target must not overwrite half-typed fields. A naive
    // createEffect tracking networks() would re-seed on every refetch and this
    // test would go red — which is exactly the regression it guards.
    seedUser();
    networksHolder.current = [netRow("user", 1, "bahamut-test", "vjt-grappa", "grp", "Real")];
    wrap(true);
    openSub("general-settings-entry");
    const nick = screen.getByLabelText(/^nick$/i) as HTMLInputElement;
    expect(nick.value).toBe("vjt-grappa");

    // User starts editing the nick.
    fireEvent.input(nick, { target: { value: "half-typed" } });
    expect(nick.value).toBe("half-typed");

    // A live /networks refetch lands for the SAME slug with a different
    // server-side nick — the exact race the design survives.
    networksHolder.current = [netRow("user", 1, "bahamut-test", "server-renamed", "grp", "Real")];
    networksHolder.bump?.();

    // The edit is preserved: the refetch did NOT re-seed the field.
    expect(nick.value).toBe("half-typed");
  });

  it("#478 — visitor delete-confirm uses the SELECTED network's nick, not the lowest-id anchor", () => {
    meHolder.current = {
      kind: "visitor",
      id: "v1",
      nick: "ignored",
      expires_at: "2099-01-01T00:00:00Z",
      registered: true,
    };
    subjectHolder.current = { kind: "visitor", id: "v1", nick: "ignored", registered: true };
    // Lowest-id would pick id=1 (nick-a). Focus id=2 (azzurra2 → nick-b): the
    // confirm text must follow the SELECTION, proving the anchor pick is dead.
    networksHolder.current = [
      netRow("visitor", 1, "azzurra", "nick-a"),
      netRow("visitor", 2, "azzurra2", "nick-b"),
    ];
    selectedChannelHolder.current = { networkSlug: "azzurra2", channelName: "#x", kind: "channel" };
    wrap(true);
    fireEvent.click(screen.getByTestId("delete-account-btn"));
    const stub = screen.getByTestId("delete-account-modal-stub");
    expect(stub).toHaveTextContent("nick-b");
    expect(stub).not.toHaveTextContent("nick-a");
  });
});
