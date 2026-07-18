import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

// windowState mock — TopicBar gates the members hamburger AND (since #263) the
// modal ✏️ edit toggle on `windowIsJoined(key)` (via canEditTopic). Default the
// predicate to `true` so the joined-state UI (hamburger + editable topic) is
// exercised; the not-joined branch is set explicitly where tested.
const mockWindowIsJoined = vi.fn((_key: string) => true);
vi.mock("../lib/windowState", () => ({
  windowIsJoined: (key: string) => mockWindowIsJoined(key),
}));

// channelTopic mock — stubs the reactive signals so the test controls what
// topic/modes the TopicBar sees, but keeps the REAL pure helpers
// (`flattenTopicNewlines`, `compactModeString`) via importOriginal so the
// newline-flatten wiring is exercised with production code (CLAUDE.md: use
// production code in tests, never re-implement logic).
const mockTopicByChannel = vi.fn(() => ({}));
const mockModesByChannel = vi.fn(() => ({}));
vi.mock("../lib/channelTopic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/channelTopic")>();
  return {
    ...actual,
    topicByChannel: () => mockTopicByChannel(),
    modesByChannel: () => mockModesByChannel(),
    seedTopic: vi.fn(),
    seedModes: vi.fn(),
  };
});

// #263 — the modal editor's ✅ save reuses the EXISTING send doors: `postTopic`
// (REST, non-empty set) and `pushChannelTopicClear` (WS verb, empty = clear).
// The ✏️ toggle is gated by the same editor-sigil derivation ModeModal uses
// (`ownHoldsChannelEditorSigil`). All three are mocked so the component test
// asserts the wiring, not the live network / permission derivation (each has
// its own coverage; the visible outcome has the Playwright e2e).
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

import {
  overlayCount,
  overlayEscapeDepth,
  __resetForTest as resetOverlayLock,
  runTopmostOverlayEscape,
} from "../lib/overlayScrollLock";
import TopicBar from "../TopicBar";

const baseProps = () => ({
  networkSlug: "freenode",
  channelName: "#italia",
  onToggleMembers: vi.fn(),
});

// A resolved-promise + macrotask drain: lets an awaited postTopic/clear settle
// AND its synchronous success continuation (setSaving(false) → closeModal) run.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

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

  // #263 — tapping the strip ALWAYS opens the read-only modal, for EVERYONE
  // (the #74 inline in-place editor is gone). The modal shows the full topic,
  // setter + timestamp. An op additionally sees a ✏️ toggle (tested in the
  // "modal topic edit" block below); a non-op sees a read-only modal only.
  describe("read-only topic modal (C3.1)", () => {
    it("does NOT show modal initially (modal starts closed)", () => {
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": { text: "A topic", set_by: "alice", set_at: "2026-05-04T10:00:00Z" },
      });
      render(() => <TopicBar {...baseProps()} />);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("clicking the topic strip opens the modal with full topic + setter + timestamp", () => {
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": {
          text: "A full topic text",
          set_by: "vjt",
          set_at: "2026-05-04T10:00:00Z",
        },
      });
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByTestId("topic-strip"));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByRole("dialog")).toHaveTextContent("A full topic text");
      expect(screen.getByRole("dialog")).toHaveTextContent("vjt");
      // The retired #74 inline strip editor must not exist anymore.
      expect(screen.queryByTestId("topic-editor")).toBeNull();
      // Read-only first: no textarea until ✏️ is pressed.
      expect(screen.queryByTestId("topic-modal-editor")).toBeNull();
    });

    it("modal opens when set_by is null", () => {
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": { text: "A topic", set_by: null, set_at: null },
      });
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByTestId("topic-strip"));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("clicking close button in modal dismisses it", () => {
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": { text: "A topic", set_by: "vjt", set_at: null },
      });
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByTestId("topic-strip"));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText(/close topic/i));
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("a non-op (+t-locked, not an editor) sees NO ✏️ edit toggle", () => {
      mockModesByChannel.mockReturnValue({ "freenode #italia": { modes: ["t"], params: {} } });
      mockEditorSigil.mockReturnValue(false);
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": { text: "Locked topic", set_by: "vjt", set_at: null },
      });
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByTestId("topic-strip"));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.queryByTestId("topic-modal-edit")).toBeNull();
    });

    it("a not-joined window sees NO ✏️ edit toggle", () => {
      mockWindowIsJoined.mockReturnValue(false);
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": { text: "A topic", set_by: "vjt", set_at: null },
      });
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByTestId("topic-strip"));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.queryByTestId("topic-modal-edit")).toBeNull();
    });
  });

  // #263 — topic editing lives INSIDE the modal. Tapping the strip opens the
  // read-only modal; an op sees a ✏️ toggle → the topic text swaps for a
  // multi-line <textarea> + ❌ cancel + ✅ save. ❌ reverts + stays open + ✏️
  // returns; ✅ flattens newlines + submits via the existing doors + closes on
  // success; a reject preserves the draft + editing + open (S21). cic mirrors
  // the server: NO optimistic write — the strip repaints on the relayed
  // topic_changed only.
  describe("modal topic edit (#263)", () => {
    const withTopic = (text: string | null) =>
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": { text, set_by: "vjt", set_at: null },
      });

    // Open the modal (read-only) then click ✏️ to enter edit mode.
    const enterEdit = () => {
      fireEvent.click(screen.getByTestId("topic-strip"));
      fireEvent.click(screen.getByTestId("topic-modal-edit"));
    };

    it("✏️ enters edit mode: textarea seeded with the raw topic, ❌/✅ appear, ✏️ disappears", () => {
      withTopic("Old topic");
      render(() => <TopicBar {...baseProps()} />);
      enterEdit();
      const editor = screen.getByTestId("topic-modal-editor") as HTMLTextAreaElement;
      expect(editor).toBeInTheDocument();
      expect(editor.value).toBe("Old topic");
      expect(screen.getByTestId("topic-modal-cancel")).toBeInTheDocument();
      expect(screen.getByTestId("topic-modal-save")).toBeInTheDocument();
      // ✏️ is gone in edit mode.
      expect(screen.queryByTestId("topic-modal-edit")).toBeNull();
    });

    it("entering edit focuses the textarea (so the tap gesture raises the mobile keyboard)", () => {
      withTopic("Old topic");
      render(() => <TopicBar {...baseProps()} />);
      enterEdit();
      expect(document.activeElement).toBe(screen.getByTestId("topic-modal-editor"));
    });

    it("✏️ on a channel with no topic opens an empty editor", () => {
      withTopic(null);
      render(() => <TopicBar {...baseProps()} />);
      enterEdit();
      expect((screen.getByTestId("topic-modal-editor") as HTMLTextAreaElement).value).toBe("");
    });

    it("❌ cancel reverts the draft, restores read-only + ✏️, keeps the modal open, sends nothing", () => {
      withTopic("Old topic");
      render(() => <TopicBar {...baseProps()} />);
      enterEdit();
      const editor = screen.getByTestId("topic-modal-editor") as HTMLTextAreaElement;
      fireEvent.input(editor, { target: { value: "discard me" } });
      fireEvent.click(screen.getByTestId("topic-modal-cancel"));
      // Back to read-only, modal STILL OPEN, ✏️ back.
      expect(screen.queryByTestId("topic-modal-editor")).toBeNull();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByTestId("topic-modal-edit")).toBeInTheDocument();
      expect(postTopicMock).not.toHaveBeenCalled();
      expect(clearTopicMock).not.toHaveBeenCalled();
      // Re-entering edit shows the ORIGINAL topic, not the discarded draft.
      fireEvent.click(screen.getByTestId("topic-modal-edit"));
      expect((screen.getByTestId("topic-modal-editor") as HTMLTextAreaElement).value).toBe(
        "Old topic",
      );
    });

    it("✅ save calls postTopic with (token, slug, channel, FLATTENED text) and closes the modal", async () => {
      withTopic("Old topic");
      render(() => <TopicBar {...baseProps()} />);
      enterEdit();
      const editor = screen.getByTestId("topic-modal-editor") as HTMLTextAreaElement;
      // Multi-line draft → the flatten must collapse newlines to single spaces
      // (an IRC topic is one wire line; raw \r/\n is rejected upstream).
      fireEvent.input(editor, { target: { value: "line one\nline two" } });
      fireEvent.click(screen.getByTestId("topic-modal-save"));
      expect(postTopicMock).toHaveBeenCalledWith(
        "tok-test",
        "freenode",
        "#italia",
        "line one line two",
      );
      expect(clearTopicMock).not.toHaveBeenCalled();
      // Save CLOSES the modal on success.
      await settle();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("✅ save flattens CRLF, lone CR, and blank-line runs to single spaces", async () => {
      withTopic("Old topic");
      render(() => <TopicBar {...baseProps()} />);
      enterEdit();
      const editor = screen.getByTestId("topic-modal-editor") as HTMLTextAreaElement;
      fireEvent.input(editor, { target: { value: "a\r\nb\rc\n\nd" } });
      fireEvent.click(screen.getByTestId("topic-modal-save"));
      expect(postTopicMock).toHaveBeenCalledWith("tok-test", "freenode", "#italia", "a b c d");
      await settle();
    });

    it("empty save on a channel WITH a topic clears via pushChannelTopicClear + closes", async () => {
      withTopic("Old topic");
      render(() => <TopicBar {...baseProps()} />);
      enterEdit();
      const editor = screen.getByTestId("topic-modal-editor") as HTMLTextAreaElement;
      fireEvent.input(editor, { target: { value: "   " } });
      fireEvent.click(screen.getByTestId("topic-modal-save"));
      expect(clearTopicMock).toHaveBeenCalledWith(1, "#italia");
      expect(postTopicMock).not.toHaveBeenCalled();
      await settle();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("empty save on a channel with NO topic is a no-op: reverts to read-only, modal stays open", () => {
      withTopic(null);
      render(() => <TopicBar {...baseProps()} />);
      enterEdit();
      fireEvent.click(screen.getByTestId("topic-modal-save"));
      expect(clearTopicMock).not.toHaveBeenCalled();
      expect(postTopicMock).not.toHaveBeenCalled();
      // Reverted to read-only, modal still open.
      expect(screen.queryByTestId("topic-modal-editor")).toBeNull();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByTestId("topic-modal-edit")).toBeInTheDocument();
    });

    it("a rejected save surfaces an inline error, keeps the editor + draft + open modal (S21)", async () => {
      postTopicMock.mockRejectedValueOnce(new Error("boom"));
      withTopic("Old topic");
      render(() => <TopicBar {...baseProps()} />);
      enterEdit();
      const editor = screen.getByTestId("topic-modal-editor") as HTMLTextAreaElement;
      fireEvent.input(editor, { target: { value: "rejected topic" } });
      fireEvent.click(screen.getByTestId("topic-modal-save"));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveClass("topic-modal-edit-error");
      expect(alert).toHaveTextContent("that didn't work");
      // Editor + draft survive so the operator can retry without retyping;
      // the modal stays open.
      expect((screen.getByTestId("topic-modal-editor") as HTMLTextAreaElement).value).toBe(
        "rejected topic",
      );
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("closing the modal DURING an in-flight save is a no-op — the submit owns teardown (S21)", () => {
      // A never-resolving postTopic keeps saving() true, so a ✕ that races the
      // in-flight send must NOT tear down the editor + discard the draft.
      let release: () => void = () => {};
      postTopicMock.mockReturnValueOnce(
        new Promise<void>((r) => {
          release = () => r();
        }),
      );
      withTopic("Old topic");
      render(() => <TopicBar {...baseProps()} />);
      enterEdit();
      const editor = screen.getByTestId("topic-modal-editor") as HTMLTextAreaElement;
      fireEvent.input(editor, { target: { value: "in flight" } });
      fireEvent.click(screen.getByTestId("topic-modal-save"));
      // ✕ during the in-flight save is guarded — editor + draft survive.
      fireEvent.click(screen.getByLabelText(/close topic/i));
      const stillThere = screen.getByTestId("topic-modal-editor") as HTMLTextAreaElement;
      expect(stillThere).toBeInTheDocument();
      expect(stillThere.value).toBe("in flight");
      release(); // cleanup the pending promise
    });

    it("closing the modal resets edit state — the next open is read-only", () => {
      withTopic("Old topic");
      render(() => <TopicBar {...baseProps()} />);
      enterEdit();
      fireEvent.input(screen.getByTestId("topic-modal-editor"), {
        target: { value: "abandoned" },
      });
      // ✕ closes the whole modal (discards the draft).
      fireEvent.click(screen.getByLabelText(/close topic/i));
      expect(screen.queryByRole("dialog")).toBeNull();
      // Re-open → read-only (no textarea), ✏️ offered again.
      fireEvent.click(screen.getByTestId("topic-strip"));
      expect(screen.queryByTestId("topic-modal-editor")).toBeNull();
      expect(screen.getByTestId("topic-modal-edit")).toBeInTheDocument();
    });
  });

  // #219-general — the topic modal COVERS the ScrollbackPane (fixed
  // full-viewport backdrop, .topic-modal-backdrop) and must register with the
  // shared overlay refcount so the pane's freeze gate engages while it is up.
  // Opening bumps overlayCount, closing drains it.
  describe("#219-general — topic modal registers the overlay scroll-lock", () => {
    beforeEach(() => {
      resetOverlayLock();
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

      fireEvent.click(screen.getByTestId("topic-strip"));
      await flushMicrotask();
      expect(overlayCount()).toBe(1);

      fireEvent.click(screen.getByLabelText(/close topic/i));
      await flushMicrotask();
      expect(overlayCount()).toBe(0);
    });

    // #232 — the topic modal joins the shared Esc-close stack. In READ-ONLY the
    // Esc verb closes the whole modal (the same as × / backdrop).
    it("Esc closes the read-only modal via the shared overlay stack (#232)", async () => {
      mockWindowIsJoined.mockReturnValue(false); // not-joined → read-only, no ✏️
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": { text: "A topic", set_by: "vjt", set_at: null },
      });
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByTestId("topic-strip"));
      await flushMicrotask();
      expect(overlayEscapeDepth()).toBe(1);

      expect(runTopmostOverlayEscape()).toBe(true);
      await flushMicrotask();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(overlayEscapeDepth()).toBe(0);
    });

    // #232 + #263 — the Esc verb is EDIT-AWARE: while editing, Esc runs
    // cancelEdit (revert the draft, stay open, ✏️ back), NOT closeModal — a
    // naive close would discard the draft, violating #263's cancel contract.
    it("Esc while editing reverts the draft + stays open (edit-aware, #263)", async () => {
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": { text: "Old topic", set_by: "vjt", set_at: null },
      });
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByTestId("topic-strip"));
      fireEvent.click(screen.getByTestId("topic-modal-edit"));
      fireEvent.input(screen.getByTestId("topic-modal-editor"), {
        target: { value: "abandon me" },
      });
      await flushMicrotask();

      expect(runTopmostOverlayEscape()).toBe(true);
      await flushMicrotask();
      // Reverted to read-only, modal STILL OPEN, ✏️ back — NOT closed.
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.queryByTestId("topic-modal-editor")).toBeNull();
      expect(screen.getByTestId("topic-modal-edit")).toBeInTheDocument();
      expect(postTopicMock).not.toHaveBeenCalled();
    });
  });

  // #220 — the topic bar NEVER navigates a link directly: the strip's MircBody
  // uses "surface-wins" so an anchor click suppresses navigation and bubbles to
  // the strip's onClick, which opens the (read-only) modal. The link is
  // clickable INSIDE the modal (default navigate policy).
  describe("link in topic bar defers to the surface (#220)", () => {
    const LINKED = {
      "freenode #italia": {
        text: "docs at https://example.com/x",
        set_by: "vjt",
        set_at: null,
      },
    };

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

      fireEvent.click(screen.getByTestId("topic-strip"));
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

  // #305 — the two topic-bar chrome buttons (members hamburger + presence
  // toggle) ADOPT the shared `.shell-chrome-btn` base class instead of
  // re-declaring size/border/font per-selector, so the size tokens
  // (--chrome-icon-size / --chrome-tap-min) drive both uniformly. jsdom is
  // blind to the CSS pixels (the tap-target-floor + glyph-size proof lives
  // in the Playwright e2e); the unit test pins the CLASS WIRING that carries
  // the tokens onto the elements.
  describe("chrome-button base-class adoption (#305)", () => {
    it("the members hamburger wears the shared .shell-chrome-btn base", () => {
      const { container } = render(() => <TopicBar {...baseProps()} />);
      const ham = container.querySelector(".topic-bar-hamburger");
      expect(ham).not.toBeNull();
      expect(ham).toHaveClass("shell-chrome-btn");
    });

    it("the presence toggle wears the shared .shell-chrome-btn base (keeps its own class too)", () => {
      const { container } = render(() => <TopicBar {...baseProps()} />);
      const toggle = container.querySelector(".topic-bar-presence-toggle");
      expect(toggle).not.toBeNull();
      expect(toggle).toHaveClass("shell-chrome-btn");
    });

    it("the presence toggle keeps its .presence-hidden accent state alongside the base", () => {
      // Default (small channel, pref unset) → shown → no accent. Toggling to
      // hide flips the class, which must COEXIST with the shared base class.
      const { container } = render(() => <TopicBar {...baseProps()} />);
      const toggle = container.querySelector(".topic-bar-presence-toggle") as HTMLElement;
      expect(toggle).not.toHaveClass("presence-hidden");
      try {
        fireEvent.click(toggle);
        expect(toggle).toHaveClass("shell-chrome-btn");
        expect(toggle).toHaveClass("presence-hidden");
      } finally {
        // togglePresence persists an explicit "hide" pref in localStorage —
        // clear it so it can't leak into sibling tests reading the same key.
        localStorage.clear();
      }
    });
  });

  // #307 — the topic strip is a <button>; WebKit/Blink wrap a button's
  // children in an internal box, so `-webkit-line-clamp` never engaged on
  // `.topic-bar-topic` itself (only the #262 max-height clipped, with NO
  // ellipsis). The fix moves the clamp onto a NON-button inner span whose
  // direct children are the MircBody runs. jsdom can't judge the pixel clamp
  // (that's the @webkit e2e), but it can pin the STRUCTURE the clamp needs.
  describe("topic strip clamp structure (#307)", () => {
    it("wraps the topic runs in a non-button .topic-bar-topic-text span", () => {
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": { text: "A clamped topic", set_by: "vjt", set_at: null },
      });
      const { container } = render(() => <TopicBar {...baseProps()} />);
      const strip = container.querySelector(".topic-bar-topic");
      expect(strip).not.toBeNull();
      const clampSpan = strip?.querySelector(".topic-bar-topic-text");
      expect(clampSpan).not.toBeNull();
      // MUST be a non-button element (a <button> defeats the clamp).
      expect(clampSpan?.tagName).toBe("SPAN");
      expect(clampSpan).toHaveTextContent("A clamped topic");
    });

    it("renders the '(no topic set)' placeholder inside the clamp span too", () => {
      mockTopicByChannel.mockReturnValue({});
      const { container } = render(() => <TopicBar {...baseProps()} />);
      const clampSpan = container.querySelector(".topic-bar-topic .topic-bar-topic-text");
      expect(clampSpan).toHaveTextContent("(no topic set)");
    });

    it("still opens the read-only topic modal on strip click after the restructure", () => {
      mockTopicByChannel.mockReturnValue({
        "freenode #italia": { text: "A topic", set_by: "vjt", set_at: null },
      });
      render(() => <TopicBar {...baseProps()} />);
      fireEvent.click(screen.getByTestId("topic-strip"));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });
});
