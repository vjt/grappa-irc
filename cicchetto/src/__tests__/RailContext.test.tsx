import { render, screen } from "@solidjs/testing-library";
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

// selection is signal-backed so a live NICK change (followQueryNick swapping
// selectedChannel) re-renders the container mid-mount, exercising #606's
// "heading must follow the nick" contract.
vi.mock("../lib/selection", async () => {
  const { createSignal } = await import("solid-js");
  const [sel, setSel] = createSignal<SelectedChannel | null>(null);
  return { selectedChannel: sel, __setSelected: setSel };
});

vi.mock("../lib/networks", () => ({
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
  connection: { server: "89.31.72.10", port: 6697, tls: true, registered: true },
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

async function renderContainer() {
  const { default: RailContext } = await import("../RailContext");
  const result = render(() => <RailContext />);
  await Promise.resolve();
  return result;
}

beforeEach(() => {
  networkBySlugMock.mockReset();
  requestRailWhoisMock.mockReset();
  railWhoisForMock.mockReset();
  railWhoisForMock.mockReturnValue(undefined);
});

afterEach(async () => {
  await setSelected(null);
});

describe("RailContext per-kind dispatch", () => {
  it("renders the ServerInfoCard on a server window when the network is live", async () => {
    await setSelected(sel("server", "$server"));
    networkBySlugMock.mockReturnValue(net);
    await renderContainer();
    expect(screen.getByTestId("rail-server-info").textContent).toContain("libera");
  });

  it("renders nothing on a server window whose network is not live", async () => {
    await setSelected(sel("server", "$server"));
    networkBySlugMock.mockReturnValue(undefined);
    await renderContainer();
    expect(screen.queryByTestId("rail-server-info")).toBeNull();
  });

  it("renders nothing on a channel window", async () => {
    await setSelected(sel("channel", "#italia"));
    networkBySlugMock.mockReturnValue(net);
    await renderContainer();
    expect(screen.queryByTestId("rail-server-info")).toBeNull();
    expect(screen.queryByTestId("rail-query-context")).toBeNull();
  });

  it("renders nothing when no window is selected", async () => {
    await setSelected(null);
    await renderContainer();
    expect(screen.queryByTestId("rail-server-info")).toBeNull();
    expect(screen.queryByTestId("rail-query-context")).toBeNull();
  });
});

describe("RailContext query context (#606)", () => {
  it("renders the heading 'private conversation with <nick>' on a query window", async () => {
    await setSelected(sel("query", "alice"));
    await renderContainer();
    const ctx = screen.getByTestId("rail-query-context");
    expect(ctx.textContent).toContain("private conversation with");
    expect(ctx.textContent).toContain("alice");
    // The server-info card is NOT what a query renders.
    expect(screen.queryByTestId("rail-server-info")).toBeNull();
  });

  // #800 — THE RULE: the rail never spends an upstream command on its own.
  // #606 shipped a fetch-on-select here; a WHOIS costs bahamut fake-lag
  // (`since += 2 + len/120`, recvQ parse gated on `since - now < 10`), so it
  // landed head-of-line in front of the operator's next PRIVMSG and pushed it
  // past the ircd's parse gate — main went red on nick-follow-query. cic
  // cannot see that budget, so it must not decide to spend it. These two pin
  // the rule against the next prefetch surface; #782 adds a user-driven
  // button, which is a different thing entirely.
  it("issues NO WHOIS when a query window is selected", async () => {
    await setSelected(sel("query", "alice"));
    await renderContainer();
    expect(requestRailWhoisMock).not.toHaveBeenCalled();
  });

  it("updates the heading when the query's nick changes while open (followQueryNick)", async () => {
    await setSelected(sel("query", "alice"));
    await renderContainer();
    expect(screen.getByTestId("rail-query-context").textContent).toContain("alice");
    // A peer NICK alice→alice2 swaps selectedChannel in place (#373).
    await setSelected(sel("query", "alice2"));
    const ctx = screen.getByTestId("rail-query-context");
    expect(ctx.textContent).toContain("alice2");
    expect(ctx.textContent).not.toContain("with alice "); // no stale nick
  });

  it("issues NO WHOIS when a rename swaps the focused query's nick", async () => {
    await setSelected(sel("query", "alice"));
    await renderContainer();
    await setSelected(sel("query", "alice2"));
    expect(requestRailWhoisMock).not.toHaveBeenCalled();
  });

  it("renders the WhoisCard when a rail bundle exists for the selected nick", async () => {
    railWhoisForMock.mockImplementation((_slug, nick) =>
      nick === "alice"
        ? ({ target: "alice", account: "AliceAcct" } as unknown as WhoisBundle)
        : undefined,
    );
    await setSelected(sel("query", "alice"));
    await renderContainer();
    expect(screen.getByTestId("whois-card")).toBeInTheDocument();
    expect(screen.getByTestId("whois-card").textContent).toContain("AliceAcct");
  });

  it("renders the heading but no WhoisCard when no rail bundle exists yet", async () => {
    railWhoisForMock.mockReturnValue(undefined);
    await setSelected(sel("query", "alice"));
    await renderContainer();
    expect(screen.getByTestId("rail-query-context")).toBeInTheDocument();
    expect(screen.queryByTestId("whois-card")).toBeNull();
  });
});
