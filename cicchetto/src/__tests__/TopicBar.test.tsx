import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

// windowState mock — TopicBar gates the members hamburger AND (since #74)
// the inline-topic-edit affordance on `windowIsJoined(key)`. Default the
// predicate to `true` so the joined-state UI (hamburger + editable topic)
// is exercised; the not-joined branch is set explicitly where tested.
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

// #74 — inline topic edit. The strip's submit reuses the EXISTING send
// doors: `postTopic` (REST, non-empty set) and `pushChannelTopicClear`
// (WS verb, empty = clear). The edit affordance is gated by the same
// editor-sigil derivation ModeModal uses (`ownHoldsChannelEditorSigil`).
// All three are mocked so the component test asserts the wiring, not the
// live network / permission derivation (the derivation has its own unit
// test; the visible outcome has the Playwright e2e).
const postTopicMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/api", () => ({
  postTopic: (...args: unknown[]) => postTopicMock(...args),
}));
const clearTopicMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/socket", () => ({
  pushChannelTopicClear: (...args: unknown[]) => clearTopicMock(...args),
}));
vi.mock("../lib/auth", () => ({ token: () => "tok-test" }));
vi.mock("../lib/networks", () => ({ networkIdBySlug: (_slug: string) => 1 }));
// `ownHoldsChannelEditorSigil` decides +t-locked editability. Default true
// (own nick is op); flipped false to exercise the topic-lock suppression.
const mockEditorSigil = vi.fn((_slug: string, _key: string, _id: number) => true);
vi.mock("../lib/channelEditPerm", () => ({
  ownHoldsChannelEditorSigil: (...args: [string, string, number]) => mockEditorSigil(...args),
}));
vi.mock("../lib/friendlyError", () => ({ friendlyError: (_e: unknown) => "that didn't work" }));

import { overlayCount, __resetForTest as resetOverlayLock } from "../lib/overlayScrollLock";
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
  mockEditorSigil.mockReturnValue(true);
  postTopicMock.mockResolvedValue(undefined);
  clearTopicMock.mockResolvedValue(undefined);
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

  it("shows topic text when topic is set", () => {
    mockTopicByChannel.mockReturnValue({
      "freenode #italia": { text: "Welcome to #italia!", set_by: "vjt", set_at: null },
    });
    render(() => <TopicBar {...baseProps()} />);
    expect(screen.getByText("Welcome to #italia!")).toBeInTheDocument();
  });

  it("shows placeholder '(no topic set)' when no topic is cached", () => {
    mockTopicByChannel.mockReturnValue({});
    render(() => <TopicBar {...baseProps()} />);
    expect(screen.getByText("(no topic set)")).toBeInTheDocument();
  });

  it("shows placeholder when topic text is null", () => {
    mockTopicByChannel.mockReturnValue({
      "freenode #italia": { text: null, set_by: null, set_at: null },
    });
    render(() => <TopicBar {...baseProps()} />);
    expect(screen.getByText("(no topic set)")).toBeInTheDocument();
  });

  // #74 — the read-only modal is now the FALLBACK for the NON-editable
  // case (not joined, or +t-locked and not op). The editable case swaps
  // in the inline editor instead (see "inline topic edit" below). These
  // modal tests therefore set a non-editable channel (not joined).
  describe("read-only topic modal — non-editable fallback (C3.1)", () => {
    beforeEach(() => {
      // Not joined → cannot edit → the strip opens the read-only modal.
      mockWindowIsJoined.mockReturnValue(false);
    });

    it("does NOT show modal initially (modal starts closed)", () => {
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": { text: "A topic", set_by: "alice", set_at: "2026-05-04T10:00:00Z" },
      });
      render(() => <TopicBar {...baseProps()} />);
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
      fireEvent.click(screen.getByText("A full topic text"));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByRole("dialog")).toHaveTextContent("A full topic text");
      expect(screen.getByRole("dialog")).toHaveTextContent("vjt");
      // No inline editor in the non-editable fallback.
      expect(screen.queryByTestId("topic-editor")).toBeNull();
    });

    it("modal opens when set_by is null", () => {
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

  // #74 — inline topic edit. Click the topic strip on an editable window
  // → an inline <input> seeded with the RAW topic replaces the strip.
  // Enter submits via the existing send doors (postTopic for a non-empty
  // set, pushChannelTopicClear for an empty clear). Escape/blur cancels.
  // cic mirrors the server: NO optimistic write — the strip repaints only
  // when the server's relayed `topic_changed` updates topicByChannel.
  describe("inline topic edit (#74)", () => {
    const withTopic = (text: string | null) =>
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": { text, set_by: "vjt", set_at: null },
      });

    it("clicking the topic on an editable channel swaps in an editor seeded with the raw topic", () => {
      withTopic("Old topic");
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByText("Old topic"));
      const editor = screen.getByTestId("topic-editor") as HTMLInputElement;
      expect(editor).toBeInTheDocument();
      expect(editor.value).toBe("Old topic");
      // Edit mode, not the read-only modal.
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("opening the editor focuses it (so the tap gesture raises the mobile keyboard)", () => {
      withTopic("Old topic");
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByText("Old topic"));
      const editor = screen.getByTestId("topic-editor");
      expect(document.activeElement).toBe(editor);
    });

    it("blur DURING an in-flight submit does NOT cancel — the submit owns the editor (S21)", () => {
      // A never-resolving postTopic keeps saving() true so the blur races
      // an in-flight send; the guard must keep the editor + draft alive.
      let release: () => void = () => {};
      postTopicMock.mockReturnValueOnce(
        new Promise<void>((r) => {
          release = () => r();
        }),
      );
      withTopic("Old topic");
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByText("Old topic"));
      const editor = screen.getByTestId("topic-editor") as HTMLInputElement;
      fireEvent.input(editor, { target: { value: "in flight" } });
      fireEvent.keyDown(editor, { key: "Enter" });
      // Focus leaves mid-flight (desktop click-away / mobile keyboard "Go").
      fireEvent.blur(editor);
      const stillThere = screen.getByTestId("topic-editor") as HTMLInputElement;
      expect(stillThere).toBeInTheDocument();
      expect(stillThere.value).toBe("in flight");
      release(); // cleanup the pending promise
    });

    it("clicking '(no topic set)' on an editable channel opens an empty editor", () => {
      withTopic(null);
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByText("(no topic set)"));
      const editor = screen.getByTestId("topic-editor") as HTMLInputElement;
      expect(editor).toBeInTheDocument();
      expect(editor.value).toBe("");
    });

    it("typing a new topic + Enter calls postTopic with (token, slug, channel, text)", async () => {
      withTopic("Old topic");
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByText("Old topic"));
      const editor = screen.getByTestId("topic-editor") as HTMLInputElement;
      fireEvent.input(editor, { target: { value: "Brand new topic" } });
      fireEvent.keyDown(editor, { key: "Enter" });
      expect(postTopicMock).toHaveBeenCalledWith(
        "tok-test",
        "freenode",
        "#italia",
        "Brand new topic",
      );
      expect(clearTopicMock).not.toHaveBeenCalled();
    });

    it("Enter exits edit mode (no optimistic paint — the server drives the strip)", async () => {
      withTopic("Old topic");
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByText("Old topic"));
      const editor = screen.getByTestId("topic-editor") as HTMLInputElement;
      fireEvent.input(editor, { target: { value: "Brand new topic" } });
      fireEvent.keyDown(editor, { key: "Enter" });
      await Promise.resolve();
      // Editor closed; strip shows the STILL-CACHED old topic (mirrors
      // server — the cache repaints only on the relayed topic_changed).
      expect(screen.queryByTestId("topic-editor")).toBeNull();
      expect(screen.getByText("Old topic")).toBeInTheDocument();
    });

    it("Escape cancels — no send, reverts to the display strip", () => {
      withTopic("Old topic");
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByText("Old topic"));
      const editor = screen.getByTestId("topic-editor") as HTMLInputElement;
      fireEvent.input(editor, { target: { value: "abandoned edit" } });
      fireEvent.keyDown(editor, { key: "Escape" });
      expect(postTopicMock).not.toHaveBeenCalled();
      expect(clearTopicMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId("topic-editor")).toBeNull();
      expect(screen.getByText("Old topic")).toBeInTheDocument();
    });

    it("blur cancels — no send", () => {
      withTopic("Old topic");
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByText("Old topic"));
      const editor = screen.getByTestId("topic-editor") as HTMLInputElement;
      fireEvent.input(editor, { target: { value: "abandoned edit" } });
      fireEvent.blur(editor);
      expect(postTopicMock).not.toHaveBeenCalled();
      expect(clearTopicMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId("topic-editor")).toBeNull();
    });

    it("empty submit on a channel WITH a topic clears via pushChannelTopicClear", () => {
      withTopic("Old topic");
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByText("Old topic"));
      const editor = screen.getByTestId("topic-editor") as HTMLInputElement;
      fireEvent.input(editor, { target: { value: "   " } });
      fireEvent.keyDown(editor, { key: "Enter" });
      expect(clearTopicMock).toHaveBeenCalledWith(1, "#italia");
      expect(postTopicMock).not.toHaveBeenCalled();
    });

    it("empty submit on a channel with NO topic is a no-op (no send)", () => {
      withTopic(null);
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByText("(no topic set)"));
      const editor = screen.getByTestId("topic-editor") as HTMLInputElement;
      fireEvent.keyDown(editor, { key: "Enter" });
      expect(clearTopicMock).not.toHaveBeenCalled();
      expect(postTopicMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId("topic-editor")).toBeNull();
    });

    it("a +t-locked channel where own nick is NOT an editor opens the read-only modal, not the editor", () => {
      mockModesByChannel.mockReturnValue({ "freenode #italia": { modes: ["t"], params: {} } });
      mockEditorSigil.mockReturnValue(false);
      withTopic("Locked topic");
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByText("Locked topic"));
      expect(screen.queryByTestId("topic-editor")).toBeNull();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("a +t-locked channel where own nick IS an editor swaps in the editor", () => {
      mockModesByChannel.mockReturnValue({ "freenode #italia": { modes: ["t"], params: {} } });
      mockEditorSigil.mockReturnValue(true);
      withTopic("Locked topic");
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByText("Locked topic"));
      expect(screen.getByTestId("topic-editor")).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("a failed set surfaces an inline error and keeps the editor + draft (no false success)", async () => {
      postTopicMock.mockRejectedValueOnce(new Error("boom"));
      withTopic("Old topic");
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByText("Old topic"));
      const editor = screen.getByTestId("topic-editor") as HTMLInputElement;
      fireEvent.input(editor, { target: { value: "rejected topic" } });
      fireEvent.keyDown(editor, { key: "Enter" });
      // Let the rejected promise settle.
      await Promise.resolve();
      await Promise.resolve();
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("that didn't work");
      // Editor + draft survive so the operator can retry without retyping.
      const stillThere = screen.getByTestId("topic-editor") as HTMLInputElement;
      expect(stillThere.value).toBe("rejected topic");
    });
  });

  // #219-general — the read-only topic modal COVERS the ScrollbackPane
  // (fixed full-viewport backdrop, .topic-modal-backdrop) and must register
  // with the shared overlay refcount so the pane's freeze gate engages while
  // it is up. Opening bumps overlayCount, closing drains it. The modal is
  // now the non-editable fallback (#74), so this exercises a not-joined
  // window.
  describe("#219-general — topic modal registers the overlay scroll-lock", () => {
    beforeEach(() => {
      resetOverlayLock();
      mockWindowIsJoined.mockReturnValue(false);
    });

    // createOverlayLock defers the push a microtask (it querySelector's the
    // modal element after Solid commits the <Show>); flush before asserting.
    const flushMicrotask = (): Promise<void> =>
      new Promise((r) => queueMicrotask(() => r(undefined)));

    it("opening the topic modal bumps overlayCount; closing drains it", async () => {
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": { text: "A topic", set_by: "vjt", set_at: null },
      });
      render(() => <TopicBar {...baseProps()} />);
      expect(overlayCount()).toBe(0);

      fireEvent.click(screen.getByText("A topic"));
      await flushMicrotask();
      expect(overlayCount()).toBe(1);

      fireEvent.click(screen.getByLabelText(/close topic/i));
      await flushMicrotask();
      expect(overlayCount()).toBe(0);
    });
  });

  // #220 — the topic bar NEVER navigates a link directly: the strip's
  // MircBody uses "surface-wins" so an anchor click suppresses navigation
  // and bubbles to the strip's onClick. On a NON-editable channel that
  // opens the read-only modal (tested here); on an editable channel it
  // enters edit mode (tested in "inline topic edit"). Either way the bar
  // itself never browses.
  describe("link in topic bar defers to the surface (#220)", () => {
    const LINKED = {
      "freenode #italia": {
        text: "docs at https://example.com/x",
        set_by: "vjt",
        set_at: null,
      },
    };

    beforeEach(() => {
      // Non-editable → strip click opens the read-only modal.
      mockWindowIsJoined.mockReturnValue(false);
    });

    it("clicking a link in the topic strip opens the modal and does NOT navigate", () => {
      mockTopicByChannel.mockReturnValue(LINKED);
      const { container } = render(() => <TopicBar {...baseProps()} />);

      const strip = container.querySelector(".topic-bar-topic") as HTMLElement;
      const link = strip.querySelector(".scrollback-link") as HTMLAnchorElement;
      expect(link).not.toBeNull();

      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      link.dispatchEvent(ev);

      // The bar suppresses the link's own navigation …
      expect(ev.defaultPrevented).toBe(true);
      // … and the surface action wins: the modal opens.
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("the modal renders the link at the default navigate policy (link is clickable inside)", () => {
      mockTopicByChannel.mockReturnValue(LINKED);
      render(() => <TopicBar {...baseProps()} />);

      fireEvent.click(screen.getByText(/docs at/i));
      const dialog = screen.getByRole("dialog");
      const modalLink = dialog.querySelector(".scrollback-link") as HTMLAnchorElement;
      expect(modalLink).not.toBeNull();
      expect(modalLink.href).toBe("https://example.com/x");

      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      modalLink.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
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
