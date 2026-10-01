import { render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Network, WhoisBundle } from "../lib/api";
import type { SelectedChannel } from "../lib/selection";
import type { WindowKind } from "../lib/windowKinds";

// #474 — RailContext is the GENERIC per-window-kind context surface grafted
// as a sibling of the RailActions drawer. It dispatches on the active
// window's kind: server → ServerInfoCard; query → whois context (#606, the
// deferred half of #474). It renders NOTHING for kinds with no context.
// Built as a container so future per-kind content grafts here without
// touching Shell's two rail mounts.

const networkBySlugMock = vi.hoisted(() => vi.fn<(slug: string) => Network | undefined>());
const requestRailWhoisMock = vi.hoisted(() => vi.fn<(slug: string, nick: string) => void>());
const railWhoisForMock = vi.hoisted(() =>
  vi.fn<(slug: string, nick: string) => WhoisBundle | undefined>(),
);

// selection is signal-backed so switching the focused query re-renders the
// container mid-mount, exercising #606's "heading must follow the selected
// nick" contract.
vi.mock("../lib/selection", async () => {
  const { createSignal } = await import("solid-js");
  const [sel, setSel] = createSignal<SelectedChannel | null>(null);
  return { selectedChannel: sel, __setSelected: setSel };
});

vi.mock("../lib/networks", () => ({
  // #1861 — casemappingForSlug (lib/casemapping.ts) resolves the fold
  // through this map, so the mock has to carry it.
  networkIdBySlug: () => undefined,
  networkBySlug: (slug: string) => networkBySlugMock(slug),
}));

vi.mock("../lib/railWhois", () => ({
  requestRailWhois: (slug: string, nick: string) => requestRailWhoisMock(slug, nick),
  railWhoisFor: (slug: string, nick: string) => railWhoisForMock(slug, nick),
}));

const net: Network = {
  kind: "user",
  id: 7,
  slug: "libera",
  services_flavor: "atheme",
  nick: "vjt",
  ident: "vjt",
  realname: "VJT",
  connection_state: "connected",
  connection_state_reason: null,
  connection_state_changed_at: "2026-07-31T08:00:00.000Z",
  connection: {
    server: "89.31.72.10",
    port: 6697,
    tls: true,
    registered: true,
    connected_at: "2026-07-31T08:00:00.000Z",
  },
  age: null,
  gender: null,
  location: null,
  languages: null,
  custom: null,
  avatar_url: null,
  inserted_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

const sel = (kind: WindowKind, channelName: string): SelectedChannel => ({
  networkSlug: "libera",
  channelName,
  kind,
});

async function setSelected(value: SelectedChannel | null): Promise<void> {
  const mod = (await import("../lib/selection")) as unknown as {
    __setSelected: (v: SelectedChannel | null) => void;
  };
  mod.__setSelected(value);
  await Promise.resolve();
}

// `onScreen` is REQUIRED (no default) — Shell's two rail mounts each state
// their own truth, so a test must state one too. Signal-backed so a test can
// drive the off->on transition the mobile drawer performs.
const [onScreen, setOnScreen] = createSignal(false);

async function renderContainer(visible: boolean) {
  setOnScreen(visible);
  const { default: RailContext } = await import("../RailContext");
  const result = render(() => <RailContext onScreen={onScreen()} />);
  await Promise.resolve();
  return result;
}

beforeEach(() => {
  networkBySlugMock.mockReset();
  requestRailWhoisMock.mockReset();
  railWhoisForMock.mockReset();
  railWhoisForMock.mockReturnValue(undefined);
  setOnScreen(false);
});

afterEach(async () => {
  await setSelected(null);
});

describe("RailContext per-kind dispatch", () => {
  it("renders the ServerInfoCard on a server window when the network is live", async () => {
    await setSelected(sel("server", "$server"));
    networkBySlugMock.mockReturnValue(net);
    await renderContainer(true);
    expect(screen.getByTestId("rail-server-info").textContent).toContain("libera");
  });

  it("renders nothing on a server window whose network is not live", async () => {
    await setSelected(sel("server", "$server"));
    networkBySlugMock.mockReturnValue(undefined);
    await renderContainer(true);
    expect(screen.queryByTestId("rail-server-info")).toBeNull();
  });

  it("renders nothing on a channel window", async () => {
    await setSelected(sel("channel", "#italia"));
    networkBySlugMock.mockReturnValue(net);
    await renderContainer(true);
    expect(screen.queryByTestId("rail-server-info")).toBeNull();
    expect(screen.queryByTestId("rail-query-context")).toBeNull();
  });

  it("renders nothing when no window is selected", async () => {
    await setSelected(null);
    await renderContainer(true);
    expect(screen.queryByTestId("rail-server-info")).toBeNull();
    expect(screen.queryByTestId("rail-query-context")).toBeNull();
  });
});

describe("RailContext query context (#606)", () => {
  it("renders the heading 'private conversation with <nick>' on a query window", async () => {
    await setSelected(sel("query", "alice"));
    await renderContainer(true);
    const ctx = screen.getByTestId("rail-query-context");
    expect(ctx.textContent).toContain("private conversation with");
    expect(ctx.textContent).toContain("alice");
    // The server-info card is NOT what a query renders.
    expect(screen.queryByTestId("rail-server-info")).toBeNull();
  });

  it("updates the heading when the focus moves to another query while open", async () => {
    await setSelected(sel("query", "alice"));
    await renderContainer(true);
    expect(screen.getByTestId("rail-query-context").textContent).toContain("alice");
    // The operator switches from the query with alice to the one with alice2.
    await setSelected(sel("query", "alice2"));
    const ctx = screen.getByTestId("rail-query-context");
    expect(ctx.textContent).toContain("alice2");
    expect(ctx.textContent).not.toContain("with alice "); // no stale nick
  });

  it("renders the WhoisCard when a rail bundle exists for the selected nick", async () => {
    railWhoisForMock.mockImplementation((_slug, nick) =>
      nick === "alice"
        ? ({ target: "alice", account: "AliceAcct" } as unknown as WhoisBundle)
        : undefined,
    );
    await setSelected(sel("query", "alice"));
    await renderContainer(true);
    expect(screen.getByTestId("whois-card")).toBeInTheDocument();
    expect(screen.getByTestId("whois-card").textContent).toContain("AliceAcct");
  });

  it("renders the heading but no WhoisCard when no rail bundle exists yet", async () => {
    railWhoisForMock.mockReturnValue(undefined);
    await setSelected(sel("query", "alice"));
    await renderContainer(true);
    expect(screen.getByTestId("rail-query-context")).toBeInTheDocument();
    expect(screen.queryByTestId("whois-card")).toBeNull();
  });
});

// #782 — the trigger is the card being ON SCREEN, not the window being
// selected. #606 fetched on select and so spent an upstream command filling a
// card the mobile user could not see (the rail is collapsed by default);
// #800 measured that cost landing on the operator's NEXT message and removed
// the fetch outright, leaving the card unfillable. Both are wrong at one of
// the two ends. What survives from #800 is the rule that matters — the rail
// must not spend a command on a card nobody is looking at — and these pin
// exactly that boundary. `requestRailWhois`'s own de-dupe (a known nick is
// never re-asked) is the second half and is pinned in railWhois.test.ts; here
// we pin only WHEN the rail is allowed to ask at all.
describe("RailContext whois fetch is gated on the card being on screen (#782)", () => {
  it("issues NO WHOIS while the rail is off screen", async () => {
    // The mobile drawer is closed: `.shell-members` is MOUNTED but sits at
    // translateX(100%), so the card exists in the DOM and is invisible. A
    // mount-time fetch would spend the command anyway — this is the leg that
    // must stay red if the visibility gate is ever removed.
    await setSelected(sel("query", "alice"));
    await renderContainer(false);
    expect(requestRailWhoisMock).not.toHaveBeenCalled();
  });

  it("issues the WHOIS once the card is on screen", async () => {
    await setSelected(sel("query", "alice"));
    await renderContainer(true);
    expect(requestRailWhoisMock).toHaveBeenCalledTimes(1);
    expect(requestRailWhoisMock).toHaveBeenCalledWith("libera", "alice");
  });

  it("asks when the drawer OPENS over an already-selected query", async () => {
    // The mobile sequence, and the one a select-keyed effect gets wrong: the
    // query is focused first, the user opens the rail afterwards. Nothing
    // about the selection changed, so only visibility can be the trigger.
    await setSelected(sel("query", "alice"));
    await renderContainer(false);
    expect(requestRailWhoisMock).not.toHaveBeenCalled();
    setOnScreen(true);
    await Promise.resolve();
    expect(requestRailWhoisMock).toHaveBeenCalledWith("libera", "alice");
  });

  it("does not re-ask when the drawer merely CLOSES", async () => {
    // Closing is not a new demand for data; re-asking on the way out would
    // spend a command for a card being hidden.
    await setSelected(sel("query", "alice"));
    await renderContainer(true);
    expect(requestRailWhoisMock).toHaveBeenCalledTimes(1);
    setOnScreen(false);
    await Promise.resolve();
    expect(requestRailWhoisMock).toHaveBeenCalledTimes(1);
  });

  it("asks for the NEW nick when the focus moves to another query on screen", async () => {
    // Switching the focused query fires the effect with the new identity, and
    // it MUST: the card now shows a nick the rail may not know. (A peer rename
    // no longer swaps the selection since issue 1365, so this is the operator
    // switching windows, not the ircd.)
    await setSelected(sel("query", "alice"));
    await renderContainer(true);
    await setSelected(sel("query", "alice2"));
    expect(requestRailWhoisMock).toHaveBeenCalledWith("libera", "alice");
    expect(requestRailWhoisMock).toHaveBeenCalledWith("libera", "alice2");
  });

  it("issues NO WHOIS for a non-query window, however visible the rail is", async () => {
    networkBySlugMock.mockReturnValue(net);
    await setSelected(sel("server", "$server"));
    await renderContainer(true);
    expect(requestRailWhoisMock).not.toHaveBeenCalled();
    await setSelected(sel("channel", "#italia"));
    expect(requestRailWhoisMock).not.toHaveBeenCalled();
  });
});
