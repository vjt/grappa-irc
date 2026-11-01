import { render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { E2eRequestsWireRequest } from "../lib/wireTypes";

// issue 2486 — our asking to start an encrypted chat, as a card in the query
// with the peer (vjt's ruling R4). The requests mirror is real (it is what
// the card reads, deadline included); its doors are spies, and so is
// everything an accepted request would reach.

const dismissEncryptedChatRequest = vi.hoisted(() => vi.fn());
const askEncryptedChat = vi.hoisted(() => vi.fn());
const openAcceptedChat = vi.hoisted(() => vi.fn());

vi.mock("../lib/e2eRequests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/e2eRequests")>()),
  dismissEncryptedChatRequest,
  askEncryptedChat,
  openAcceptedChat,
}));
// What the store reaches on its own (an accepted request opens the chat):
// held open here, so an accepted request stays on the card.
vi.mock("../lib/encryptedChats", () => ({
  askEncryptedKeys: vi.fn(),
  encryptedDevice: vi.fn(),
  openEncryptedChat: () => new Promise(() => undefined),
}));
vi.mock("../lib/encryptedWindow", () => ({ openEncryptedWindow: vi.fn() }));
vi.mock("../lib/auth", () => ({ token: () => "tok" }));
vi.mock("../lib/networks", () => ({ networks: () => [] }));
vi.mock("../lib/selection", () => ({ selectedChannel: () => null }));

const { ApiError } = await import("../lib/api");
const { dropE2eRequest, putE2eRequest } = await import("../lib/e2eRequests");
const { errorMessage } = await import("../lib/friendlyApiError");
const { default: E2eRequestCard } = await import("../E2eRequestCard");

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-01T12:00:00Z");
const DEADLINE = new Date(T0 + 24 * HOUR).toISOString();

let slug: string;
let netCount = 0;
let held: E2eRequestsWireRequest[] = [];

function hold(over: Partial<E2eRequestsWireRequest>): E2eRequestsWireRequest {
  const request: E2eRequestsWireRequest = {
    id: held.length + 1,
    peer: "Bob",
    state: "outgoing",
    payload: null,
    at: new Date(T0).toISOString(),
    expires_at: DEADLINE,
    ...over,
  };
  held.push(request);
  putE2eRequest(slug, request);
  return request;
}

const card = () => screen.queryByTestId("e2e-request-card");
const show = () => render(() => <E2eRequestCard networkSlug={slug} peer="bob" />);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(T0);
  netCount += 1;
  slug = `net${netCount}`;
  for (const verb of [dismissEncryptedChatRequest, askEncryptedChat, openAcceptedChat]) {
    verb.mockReset();
    verb.mockResolvedValue(undefined);
  }
});

afterEach(() => {
  for (const request of held) dropE2eRequest(slug, request.id);
  held = [];
  vi.useRealTimers();
});

describe("E2eRequestCard", () => {
  it("shows nothing with no request with the peer, nor for the peer's own asking: that is the banner's", () => {
    hold({ peer: "Carol" });
    show();
    expect(card()).toBeNull();

    hold({ state: "incoming" });
    expect(card()).toBeNull();
  });

  it("our asking waits with a spinner, and Cancel withdraws it; there is no × while it waits", () => {
    const request = hold({});
    const { container } = show();

    expect(card()?.dataset.state).toBe("pending");
    expect(card()?.textContent).toContain("Waiting for bob to accept the encrypted chat");
    expect(container.querySelector(".e2e-request-card-spinner")).not.toBeNull();
    expect(screen.queryByTestId("e2e-request-dismiss")).toBeNull();
    screen.getByTestId("e2e-request-cancel").click();
    expect(dismissEncryptedChatRequest).toHaveBeenCalledWith(slug, request);
  });

  it("a refusal is said, and dismissed with the ×; there is nothing to retry", () => {
    const request = hold({ state: "refused", expires_at: null });
    show();

    expect(card()?.dataset.state).toBe("refused");
    expect(card()?.textContent).toContain("bob refused the encrypted chat");
    expect(screen.queryByTestId("e2e-request-retry")).toBeNull();
    expect(screen.queryByTestId("e2e-request-cancel")).toBeNull();
    // No empty actions row either: the card is a flex column with a gap, so
    // one would open a blank line under the text.
    expect(card()?.querySelector(".e2e-step-actions")).toBeNull();
    screen.getByTestId("e2e-request-dismiss").click();
    expect(dismissEncryptedChatRequest).toHaveBeenCalledWith(slug, request);
  });

  it("our asking unanswered for 24 hours offers Retry, which asks again, and the ×, which lets it go", async () => {
    const request = hold({ expires_at: new Date(T0 - HOUR).toISOString() });
    show();

    expect(card()?.dataset.state).toBe("expired");
    expect(card()?.textContent).toContain("did not answer the encrypted chat request within");
    screen.getByTestId("e2e-request-retry").click();
    expect(askEncryptedChat).toHaveBeenCalledWith(slug, "bob");

    const dismiss = screen.getByTestId("e2e-request-dismiss") as HTMLButtonElement;
    await vi.waitFor(() => expect(dismiss.disabled).toBe(false));
    dismiss.click();
    expect(dismissEncryptedChatRequest).toHaveBeenCalledWith(slug, request);
  });

  it("an accepted request still held offers to open the chat, or to dismiss it with the ×", async () => {
    const request = hold({ state: "accepted", expires_at: null });
    show();

    expect(card()?.dataset.state).toBe("accepted");
    screen.getByTestId("e2e-request-open").click();
    expect(openAcceptedChat).toHaveBeenCalledWith(slug, request);
    // An identity held on another device never opens here: the × lets it go.
    const dismiss = screen.getByTestId("e2e-request-dismiss") as HTMLButtonElement;
    await vi.waitFor(() => expect(dismiss.disabled).toBe(false));
    dismiss.click();
    expect(dismissEncryptedChatRequest).toHaveBeenCalledWith(slug, request);
  });

  it("the card changes in place as grappa's request does", () => {
    const request = hold({});
    show();
    const first = card();
    expect(first?.dataset.state).toBe("pending");

    putE2eRequest(slug, { ...request, state: "refused", expires_at: null });

    expect(card()?.dataset.state).toBe("refused");
    expect(screen.getAllByTestId("e2e-request-card")).toHaveLength(1);
  });

  it("a door that fails says why in the card, and the buttons work again", async () => {
    const refusal = new ApiError(409, "request_state");
    dismissEncryptedChatRequest.mockRejectedValue(refusal);
    hold({});
    show();

    screen.getByTestId("e2e-request-cancel").click();

    await vi.waitFor(() =>
      expect(screen.getByTestId("e2e-request-error").textContent).toBe(errorMessage(refusal)),
    );
    expect((screen.getByTestId("e2e-request-cancel") as HTMLButtonElement).disabled).toBe(false);
  });

  it("while a door runs, a second click sends nothing", () => {
    askEncryptedChat.mockReturnValue(new Promise(() => undefined));
    hold({ expires_at: new Date(T0 - HOUR).toISOString() });
    show();

    screen.getByTestId("e2e-request-retry").click();
    screen.getByTestId("e2e-request-dismiss").click();

    expect(askEncryptedChat).toHaveBeenCalledTimes(1);
    expect(dismissEncryptedChatRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["a waiting", {}, "e2e-request-cancel"],
    ["an expired", { expires_at: new Date(T0 - HOUR).toISOString() }, "e2e-request-retry"],
    ["an accepted", { state: "accepted", expires_at: null }, "e2e-request-open"],
    ["a refused", { state: "refused", expires_at: null }, "e2e-request-dismiss"],
  ] as const)("while a door runs on %s card, every one of its buttons holds", (_, over, first) => {
    for (const door of [dismissEncryptedChatRequest, askEncryptedChat, openAcceptedChat]) {
      door.mockReturnValue(new Promise(() => undefined));
    }
    hold(over);
    show();

    screen.getByTestId(first).click();

    const buttons = [...(card()?.querySelectorAll("button") ?? [])];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button.disabled, button.dataset.testid).toBe(true);
  });

  it("the query switched to another peer starts clean: no error and no door held from the last", async () => {
    dismissEncryptedChatRequest.mockRejectedValueOnce(new ApiError(409, "request_state"));
    askEncryptedChat.mockReturnValueOnce(new Promise(() => undefined));
    hold({});
    hold({ peer: "Carol", expires_at: new Date(T0 - HOUR).toISOString() });
    hold({ peer: "Dave", expires_at: new Date(T0 - HOUR).toISOString() });
    const [peer, setPeer] = createSignal("bob");
    render(() => <E2eRequestCard networkSlug={slug} peer={peer()} />);

    screen.getByTestId("e2e-request-cancel").click();
    await vi.waitFor(() => expect(screen.queryByTestId("e2e-request-error")).not.toBeNull());
    setPeer("carol");
    expect(screen.queryByTestId("e2e-request-error")).toBeNull();

    screen.getByTestId("e2e-request-retry").click();
    setPeer("dave");
    expect((screen.getByTestId("e2e-request-retry") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a request that arrives already past its deadline here reads expired at once", () => {
    show();
    // The clock moves on while nothing is shown, then a fetch brings our asking.
    vi.setSystemTime(T0 + 25 * HOUR);
    hold({});

    expect(card()?.dataset.state).toBe("expired");
  });

  it("our asking reads expired when its wake-up comes, on a wall clock a hair behind the timers", () => {
    hold({});
    show();
    // Shifts the wall clock alone: the wake-up still comes 24 h after it was armed.
    vi.setSystemTime(T0 - 5);

    vi.advanceTimersByTime(24 * HOUR);

    expect(card()?.dataset.state).toBe("expired");
  });

  it("our asking reads expired at its deadline, with Retry", () => {
    hold({});
    show();

    vi.advanceTimersByTime(24 * HOUR - 1);
    expect(card()?.dataset.state).toBe("pending");
    vi.advanceTimersByTime(1);

    expect(card()?.dataset.state).toBe("expired");
    expect(screen.getByTestId("e2e-request-retry")).not.toBeNull();
  });
});
