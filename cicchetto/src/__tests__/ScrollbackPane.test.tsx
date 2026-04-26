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
