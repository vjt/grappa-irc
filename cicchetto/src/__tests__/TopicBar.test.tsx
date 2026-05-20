import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

// windowState mock — TopicBar gates the nick-count + members hamburger
// on `windowIsJoined(key)`. Default the predicate to `true` so existing
// behavior tests (count + hamburger always visible for the active
// #italia channel) continue to assert the joined-state UI; the
// not-joined branch is covered by its own block below.
const mockWindowIsJoined = vi.fn((_key: string) => true);
vi.mock("../lib/windowState", () => ({
  windowIsJoined: (key: string) => mockWindowIsJoined(key),
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
  onToggleMembers: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  mockTopicByChannel.mockReturnValue({});
  mockModesByChannel.mockReturnValue({});
  mockWindowIsJoined.mockReturnValue(true);
});

describe("TopicBar", () => {
  it("renders the selected channel name", () => {
    render(() => <TopicBar {...baseProps()} />);
    expect(screen.getByText("#italia")).toBeInTheDocument();
  });

  // UX-5 bucket BT (2026-05-19) — the "X nicks" count strip was
  // dropped from the topic-bar (vjt 2026-05-19 dogfood — "useless";
  // the MembersPane on the right is the canonical surface). The pre-
  // bucket "renders the nick count" test became a mirror — replaced
  // with a negative assertion pinning the absence so a future
  // resurrection trips a guard.
  it("UX-5 bucket BT — does NOT render a '.topic-bar-count' nick count strip", () => {
    const { container } = render(() => <TopicBar {...baseProps()} />);
    expect(container.querySelector(".topic-bar-count")).toBeNull();
    expect(screen.queryByText(/\d+ nicks/i)).not.toBeInTheDocument();
  });

  // UX-4 bucket L (2026-05-19): TopicBar's left sidebar hamburger
  // moved to ShellChrome (always-visible toolbar). TopicBar no longer
  // renders a "open channel sidebar" affordance — the corresponding
  // test moved to ShellChrome.test.tsx.

  it("clicking right hamburger fires onToggleMembers", () => {
    const props = baseProps();
    render(() => <TopicBar {...props} />);
    fireEvent.click(screen.getByLabelText(/open members sidebar/i));
    expect(props.onToggleMembers).toHaveBeenCalled();
  });

  // UX-4 bucket L (2026-05-19): the settings cog moved out of TopicBar
  // into ShellChrome (covered in Shell.test.tsx). TopicBar no longer
  // renders ⚙ — the corresponding test moved to ShellChrome.test.tsx.

  describe("members hamburger + nick count visibility (joined-only)", () => {
    it("hides the right hamburger when the channel is not joined", () => {
      mockWindowIsJoined.mockReturnValue(false);
      render(() => <TopicBar {...baseProps()} />);
      expect(screen.queryByLabelText(/open members sidebar/i)).not.toBeInTheDocument();
    });

    // UX-5 bucket BT (2026-05-19) — "X nicks" strip was dropped. The
    // joined-gated visibility test is now redundant; the strip is
    // gone everywhere. Kept as negative guard for the not-joined
    // path so a resurrection would surface.
    it("UX-5 bucket BT — never renders nick count, joined or not", () => {
      mockWindowIsJoined.mockReturnValue(false);
      render(() => <TopicBar {...baseProps()} />);
      expect(screen.queryByText(/\d+ nicks/i)).not.toBeInTheDocument();
    });
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

  // UX-5 bucket BM (2026-05-20) — `inlineChromeSlot` prop dropped.
  // BT inlined archive + cog into the topic-bar via this slot; BM
  // moves them into the mobile members drawer footer as launchers, so
  // the slot no longer has a caller. The tests that exercised the
  // slot were dropped with the prop.
});
