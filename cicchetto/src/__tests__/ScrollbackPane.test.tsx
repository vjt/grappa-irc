import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../lib/api";

// Mock the store boundary, not the REST/WS plumbing — ScrollbackPane is
// a pure projection of `scrollbackByChannel` + `sendMessage`. The store
// itself is exercised in networks.test.ts.
//
// `vi.hoisted` is mandatory: vi.mock is hoisted to the top of the file
// (before non-mock declarations), so anything the factory closes over
// must also be hoisted. Mirrors the pattern in socket.test.ts. The
// scrollback "signal" is mocked as a plain getter (not a real Solid
// signal) — tests that need a value seed it BEFORE render, so reactive
// updates aren't required for the assertions in this file.

const h = vi.hoisted(() => ({
  scrollbackByChannel: vi.fn<() => Record<string, ScrollbackMessage[]>>(() => ({})),
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
  sendMessage: vi.fn(),
}));

vi.mock("../lib/networks", () => ({
  scrollbackByChannel: h.scrollbackByChannel,
  channelKey: h.channelKey,
  sendMessage: h.sendMessage,
}));

import ScrollbackPane from "../ScrollbackPane";

const fixture: ScrollbackMessage[] = [
  {
    id: 1,
    network: "freenode",
    channel: "#grappa",
    server_time: 1_700_000_000_000,
    kind: "privmsg",
    sender: "alice",
    body: "hello",
    meta: {},
  },
  {
    id: 2,
    network: "freenode",
    channel: "#grappa",
    server_time: 1_700_000_001_000,
    kind: "action",
    sender: "bob",
    body: "waves",
    meta: {},
  },
  {
    id: 3,
    network: "freenode",
    channel: "#grappa",
    server_time: 1_700_000_002_000,
    kind: "notice",
    sender: "ChanServ",
    body: "topic locked",
    meta: {},
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.scrollbackByChannel.mockReturnValue({});
});

describe("ScrollbackPane", () => {
  it("renders an empty placeholder when no messages exist for the channel", () => {
    render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" />);
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
  });

  it("renders one line per message with kind-specific shape", () => {
    h.scrollbackByChannel.mockReturnValue({ "freenode #grappa": fixture });
    render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" />);
    const lines = screen.getAllByTestId("scrollback-line");
    expect(lines).toHaveLength(3);
    expect(lines[0]?.dataset.kind).toBe("privmsg");
    expect(lines[0]).toHaveTextContent("<alice>");
    expect(lines[0]).toHaveTextContent("hello");
    expect(lines[1]?.dataset.kind).toBe("action");
    expect(lines[1]).toHaveTextContent("* bob waves");
    expect(lines[2]?.dataset.kind).toBe("notice");
    expect(lines[2]).toHaveTextContent("-ChanServ-");
    expect(lines[2]).toHaveTextContent("topic locked");
  });

  it("renders all ten server kinds without falling through to PRIVMSG framing", () => {
    // Server `Grappa.Scrollback.Message.kind()` enum: ten kinds. Phase 5
    // presence-event capture will emit any of them on the wire; the
    // renderer must NOT render presence/op kinds with the `<sender>`
    // PRIVMSG angle-bracket framing. This test pins the contract: each
    // non-message kind renders `* sender <verb>` (irssi-shape) or
    // dash-framed (notice) — never angle-bracketed.
    const allKinds: ScrollbackMessage[] = [
      {
        id: 1,
        network: "n",
        channel: "#c",
        server_time: 1,
        kind: "privmsg",
        sender: "alice",
        body: "hi",
        meta: {},
      },
      {
        id: 2,
        network: "n",
        channel: "#c",
        server_time: 2,
        kind: "notice",
        sender: "ChanServ",
        body: "lock",
        meta: {},
      },
      {
        id: 3,
        network: "n",
        channel: "#c",
        server_time: 3,
        kind: "action",
        sender: "bob",
        body: "waves",
        meta: {},
      },
      {
        id: 4,
        network: "n",
        channel: "#c",
        server_time: 4,
        kind: "join",
        sender: "carol",
        body: null,
        meta: {},
      },
      {
        id: 5,
        network: "n",
        channel: "#c",
        server_time: 5,
        kind: "part",
        sender: "dave",
        body: "bye",
        meta: {},
      },
      {
        id: 6,
        network: "n",
        channel: "#c",
        server_time: 6,
        kind: "quit",
        sender: "eve",
        body: "ping timeout",
        meta: {},
      },
      {
        id: 7,
        network: "n",
        channel: "#c",
        server_time: 7,
        kind: "nick_change",
        sender: "frank",
        body: null,
        meta: { new_nick: "frank2" },
      },
      {
        id: 8,
        network: "n",
        channel: "#c",
        server_time: 8,
        kind: "mode",
        sender: "grace",
        body: null,
        meta: { modes: "+o", args: ["heidi"] },
      },
      {
        id: 9,
        network: "n",
        channel: "#c",
        server_time: 9,
        kind: "topic",
        sender: "ivan",
        body: "new topic",
        meta: {},
      },
      {
        id: 10,
        network: "n",
        channel: "#c",
        server_time: 10,
        kind: "kick",
        sender: "judy",
        body: "spam",
        meta: { target: "mallory" },
      },
    ];
    h.scrollbackByChannel.mockReturnValue({ "n #c": allKinds });
    render(() => <ScrollbackPane networkSlug="n" channelName="#c" />);
    const lines = screen.getAllByTestId("scrollback-line");
    expect(lines).toHaveLength(10);

    // PRIVMSG: angle-bracket sender
    expect(lines[0]).toHaveTextContent("<alice>");
    // NOTICE: dash-framed sender
    expect(lines[1]).toHaveTextContent("-ChanServ-");
    expect(lines[1]).not.toHaveTextContent("<ChanServ>");
    // ACTION: irssi `* sender body`
    expect(lines[2]).toHaveTextContent("* bob waves");
    expect(lines[2]).not.toHaveTextContent("<bob>");

    // Presence + op kinds: NEVER angle-bracket framing.
    for (let i = 3; i < 10; i++) {
      expect(lines[i]).not.toHaveTextContent(`<${allKinds[i]?.sender}>`);
    }

    expect(lines[3]).toHaveTextContent("carol");
    expect(lines[3]).toHaveTextContent("#c");
    expect(lines[4]).toHaveTextContent("dave");
    expect(lines[5]).toHaveTextContent("eve");
    expect(lines[6]).toHaveTextContent("frank2");
    // Pin args adjacency to the modes flag — a refactor that rendered
    // `sets mode +o on #c heidi` (args at wrong position) would still
    // include both tokens but break readability.
    expect(lines[7]).toHaveTextContent("+o heidi");
    expect(lines[8]).toHaveTextContent("new topic");
    expect(lines[9]).toHaveTextContent("mallory");
  });

  it("scopes scrollback to the (slug, channel) pair via channelKey", () => {
    h.scrollbackByChannel.mockReturnValue({
      "freenode #grappa": fixture,
      "freenode #cicchetto": [
        {
          id: 99,
          network: "freenode",
          channel: "#cicchetto",
          server_time: 1,
          kind: "privmsg",
          sender: "x",
          body: "different channel",
          meta: {},
        },
      ],
    });
    render(() => <ScrollbackPane networkSlug="freenode" channelName="#cicchetto" />);
    const lines = screen.getAllByTestId("scrollback-line");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent("different channel");
  });

  it("submitting a non-empty draft calls store.sendMessage and clears the textarea", async () => {
    h.sendMessage.mockResolvedValue(undefined);
    render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" />);
    const textarea = screen.getByLabelText(/compose message/i) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "yo" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => {
      expect(h.sendMessage).toHaveBeenCalledWith("freenode", "#grappa", "yo");
    });
    await waitFor(() => {
      expect(textarea.value).toBe("");
    });
  });

  it("Enter key submits; Shift+Enter does not", async () => {
    h.sendMessage.mockResolvedValue(undefined);
    render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" />);
    const textarea = screen.getByLabelText(/compose message/i) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "shift" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(h.sendMessage).not.toHaveBeenCalled();
    fireEvent.input(textarea, { target: { value: "plain" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => {
      expect(h.sendMessage).toHaveBeenCalledWith("freenode", "#grappa", "plain");
    });
  });

  it("does not submit a whitespace-only draft", () => {
    render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" />);
    const textarea = screen.getByLabelText(/compose message/i) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("renders a compose error when sendMessage rejects", async () => {
    h.sendMessage.mockRejectedValue(new Error("no_session"));
    render(() => <ScrollbackPane networkSlug="freenode" channelName="#grappa" />);
    const textarea = screen.getByLabelText(/compose message/i) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "boom" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/no_session/);
    });
  });
});
