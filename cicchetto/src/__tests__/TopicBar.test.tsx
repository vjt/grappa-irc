import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/members", () => ({
  membersByChannel: () => ({
    "freenode #italia": [
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: [] },
    ],
  }),
}));

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

import TopicBar from "../TopicBar";

const baseProps = () => ({
  networkSlug: "freenode",
  channelName: "#italia",
  onToggleSidebar: vi.fn(),
  onToggleMembers: vi.fn(),
  onOpenSettings: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TopicBar", () => {
  it("renders the selected channel name", () => {
    render(() => <TopicBar {...baseProps()} />);
    expect(screen.getByText("#italia")).toBeInTheDocument();
  });

  it("renders the nick count from members store", () => {
    render(() => <TopicBar {...baseProps()} />);
    expect(screen.getByText(/2 nicks/i)).toBeInTheDocument();
  });

  it("clicking left hamburger fires onToggleSidebar", () => {
    const props = baseProps();
    render(() => <TopicBar {...props} />);
    fireEvent.click(screen.getByLabelText(/open channel sidebar/i));
    expect(props.onToggleSidebar).toHaveBeenCalled();
  });

  it("clicking right hamburger fires onToggleMembers", () => {
    const props = baseProps();
    render(() => <TopicBar {...props} />);
    fireEvent.click(screen.getByLabelText(/open members sidebar/i));
    expect(props.onToggleMembers).toHaveBeenCalled();
  });

  it("clicking ⚙ settings fires onOpenSettings", () => {
    const props = baseProps();
    render(() => <TopicBar {...props} />);
    fireEvent.click(screen.getByLabelText(/open settings/i));
    expect(props.onOpenSettings).toHaveBeenCalled();
  });
});
