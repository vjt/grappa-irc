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

// channelTopic mock — controls what topic/modes the TopicBar sees.
// Updated between test groups to exercise different states.
const mockTopicByChannel = vi.fn(() => ({}));
const mockModesByChannel = vi.fn(() => ({}));
vi.mock("../lib/channelTopic", () => ({
  topicByChannel: () => mockTopicByChannel(),
  modesByChannel: () => mockModesByChannel(),
  compactModeString: (modes: string[]) => (modes.length > 0 ? `+${modes.join("")}` : ""),
  seedTopic: vi.fn(),
  seedModes: vi.fn(),
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
  mockTopicByChannel.mockReturnValue({});
  mockModesByChannel.mockReturnValue({});
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

  describe("topic display (C3.1)", () => {
    it("shows placeholder '(no topic set)' when no topic is cached", () => {
      mockTopicByChannel.mockReturnValue({});
      render(() => <TopicBar {...baseProps()} />);
      expect(screen.getByText("(no topic set)")).toBeInTheDocument();
    });

    it("shows topic text when topic is set", () => {
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": { text: "Welcome to #italia!", set_by: "vjt", set_at: null },
      });
      render(() => <TopicBar {...baseProps()} />);
      expect(screen.getByText("Welcome to #italia!")).toBeInTheDocument();
    });

    it("shows placeholder when topic text is null", () => {
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": { text: null, set_by: null, set_at: null },
      });
      render(() => <TopicBar {...baseProps()} />);
      expect(screen.getByText("(no topic set)")).toBeInTheDocument();
    });

    it("does NOT show modal initially (modal starts closed)", () => {
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": { text: "A topic", set_by: "alice", set_at: "2026-05-04T10:00:00Z" },
      });
      render(() => <TopicBar {...baseProps()} />);
      // Modal should not be in the DOM when closed
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("clicking topic text opens modal with full topic + setter + timestamp", () => {
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": {
          text: "A full topic text",
          set_by: "vjt",
          set_at: "2026-05-04T10:00:00Z",
        },
      });
      render(() => <TopicBar {...baseProps()} />);
      // Click the topic area
      const topicEl = screen.getByText("A full topic text");
      fireEvent.click(topicEl);
      // Modal should now appear
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByRole("dialog")).toHaveTextContent("A full topic text");
      expect(screen.getByRole("dialog")).toHaveTextContent("vjt");
    });

    it("modal shows '(no setter info)' when set_by is null", () => {
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": { text: "A topic", set_by: null, set_at: null },
      });
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByText("A topic"));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("clicking close button in modal dismisses it", () => {
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": { text: "A topic", set_by: "vjt", set_at: null },
      });
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByText("A topic"));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText(/close topic/i));
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  describe("mode-string display (C3.1)", () => {
    it("shows compact mode string when modes are cached", () => {
      mockModesByChannel.mockReturnValue({
        "freenode #italia": { modes: ["n", "t"], params: {} },
      });
      render(() => <TopicBar {...baseProps()} />);
      expect(screen.getByText("+nt")).toBeInTheDocument();
    });

    it("does not render mode string when modes list is empty", () => {
      mockModesByChannel.mockReturnValue({
        "freenode #italia": { modes: [], params: {} },
      });
      render(() => <TopicBar {...baseProps()} />);
      // Should not show a + with no letters
      expect(screen.queryByText(/^\+/)).toBeNull();
    });

    it("does not render mode string when no modes are cached", () => {
      mockModesByChannel.mockReturnValue({});
      render(() => <TopicBar {...baseProps()} />);
      expect(screen.queryByText(/^\+/)).toBeNull();
    });
  });
});
