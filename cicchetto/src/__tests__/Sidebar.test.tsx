import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/networks", () => ({
  networks: () => [{ id: 1, slug: "freenode", inserted_at: "", updated_at: "" }],
  channelsBySlug: () => ({
    freenode: [
      { name: "#italia", joined: true, source: "autojoin" },
      { name: "#azzurra", joined: false, source: "autojoin" },
      { name: "#bnc", joined: true, source: "joined" },
    ],
  }),
}));

vi.mock("../lib/selection", () => ({
  selectedChannel: () => null,
  setSelectedChannel: vi.fn(),
  unreadCounts: () => ({ "freenode #bnc": 3 }),
}));

vi.mock("../lib/mentions", () => ({
  mentionCounts: () => ({ "freenode #italia": 2 }),
}));

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

import Sidebar from "../Sidebar";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Sidebar", () => {
  it("renders all channels grouped by network", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    expect(screen.getByText("#italia")).toBeInTheDocument();
    expect(screen.getByText("#azzurra")).toBeInTheDocument();
    expect(screen.getByText("#bnc")).toBeInTheDocument();
    expect(screen.getByText("freenode")).toBeInTheDocument();
  });

  it("parted channels (joined: false) get the .parted class", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const parted = screen.getByText("#azzurra");
    expect(parted.classList.contains("parted")).toBe(true);
  });

  it("joined channels do NOT get the .parted class", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const joined = screen.getByText("#italia");
    expect(joined.classList.contains("parted")).toBe(false);
  });

  it("renders unread count for channels with messages while away", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const unread = document.querySelector(".sidebar-unread");
    expect(unread?.textContent).toBe("3");
  });

  it("renders mention badge with @-prefix for channels with mentions", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const mention = document.querySelector(".sidebar-mention");
    expect(mention?.textContent).toBe("@2");
  });

  it("clicking a channel calls setSelectedChannel + onSelect", async () => {
    const sel = await import("../lib/selection");
    const onSelect = vi.fn();
    render(() => <Sidebar onSelect={onSelect} />);
    fireEvent.click(screen.getByText("#italia"));
    expect(sel.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "#italia",
    });
    expect(onSelect).toHaveBeenCalled();
  });

  it("renders 'no networks' fallback when networks list is empty", async () => {
    vi.resetModules();
    vi.doMock("../lib/networks", () => ({
      networks: () => [],
      channelsBySlug: () => ({}),
    }));
    vi.doMock("../lib/selection", () => ({
      selectedChannel: () => null,
      setSelectedChannel: vi.fn(),
      unreadCounts: () => ({}),
    }));
    vi.doMock("../lib/mentions", () => ({ mentionCounts: () => ({}) }));
    const { default: SidebarFresh } = await import("../Sidebar");
    render(() => <SidebarFresh onSelect={vi.fn()} />);
    expect(screen.getByText(/no networks/i)).toBeInTheDocument();
  });
});
