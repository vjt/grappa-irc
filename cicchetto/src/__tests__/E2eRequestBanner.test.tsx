import { render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { E2eRequestsWireRequest } from "../lib/wireTypes";

// issue 2486 — the banner over the plaintext query with the peer. The
// requests mirror is real (it is what the banner reads, deadline included);
// its doors are spies, and so is everything an accepted request would reach.

const acceptEncryptedChat = vi.hoisted(() => vi.fn());
const refuseEncryptedChat = vi.hoisted(() => vi.fn());
const dismissEncryptedChatRequest = vi.hoisted(() => vi.fn());
const askEncryptedChat = vi.hoisted(() => vi.fn());
const openAcceptedChat = vi.hoisted(() => vi.fn());

vi.mock("../lib/e2eRequests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/e2eRequests")>()),
  acceptEncryptedChat,
  refuseEncryptedChat,
  dismissEncryptedChatRequest,
  askEncryptedChat,
  openAcceptedChat,
}));
// What the store reaches on its own (an accepted request opens the chat):
// held open here, so an accepted request stays on the banner.
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
const { default: E2eRequestBanner } = await import("../E2eRequestBanner");

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

const banner = () => screen.queryByTestId("e2e-request-banner");
const show = () => render(() => <E2eRequestBanner networkSlug={slug} peer="bob" />);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(T0);
  netCount += 1;
  slug = `net${netCount}`;
  for (const verb of [
    acceptEncryptedChat,
    refuseEncryptedChat,
    dismissEncryptedChatRequest,
    askEncryptedChat,
    openAcceptedChat,
  ]) {
    verb.mockReset();
    verb.mockResolvedValue(undefined);
  }
});

afterEach(() => {
  for (const request of held) dropE2eRequest(slug, request.id);
  held = [];
  vi.useRealTimers();
});

describe("E2eRequestBanner", () => {
  it("shows nothing with no request from or to the peer", () => {
    hold({ peer: "Carol" });
    show();
    expect(banner()).toBeNull();
  });

  it("the peer's asking: Accept and Reject answer it, each with its own door", () => {
    const request = hold({ state: "incoming" });
    show();

    expect(banner()?.dataset.state).toBe("incoming");
    expect(banner()?.textContent).toContain("bob would like to start an encrypted chat with you");
    screen.getByTestId("e2e-request-accept").click();
    expect(acceptEncryptedChat).toHaveBeenCalledWith(slug, request);
    expect(refuseEncryptedChat).not.toHaveBeenCalled();
    // A live asking of theirs is answered, never dismissed (grappa: 409).
    expect(screen.queryByTestId("e2e-request-dismiss")).toBeNull();
  });

  it("Reject refuses the peer's asking", () => {
    const request = hold({ state: "incoming" });
    show();

    screen.getByTestId("e2e-request-reject").click();

    expect(refuseEncryptedChat).toHaveBeenCalledWith(slug, request);
    expect(acceptEncryptedChat).not.toHaveBeenCalled();
  });

  it("our asking waits with a spinner, and Cancel withdraws it", () => {
    const request = hold({});
    const { container } = show();

    expect(banner()?.dataset.state).toBe("pending");
    expect(banner()?.textContent).toContain("Waiting for bob to accept the encrypted chat");
    expect(container.querySelector(".e2e-request-banner-spinner")).not.toBeNull();
    expect(screen.queryByTestId("e2e-request-dismiss")).toBeNull();
    screen.getByTestId("e2e-request-cancel").click();
    expect(dismissEncryptedChatRequest).toHaveBeenCalledWith(slug, request);
  });

  it("a refusal is said, and dismissed with the ×; there is nothing to retry", () => {
    const request = hold({ state: "refused", expires_at: null });
    show();

    expect(banner()?.dataset.state).toBe("refused");
    expect(banner()?.textContent).toContain("bob refused the encrypted chat");
    expect(screen.queryByTestId("e2e-request-retry")).toBeNull();
    screen.getByTestId("e2e-request-dismiss").click();
    expect(dismissEncryptedChatRequest).toHaveBeenCalledWith(slug, request);
  });

  it("our asking unanswered for 24 hours offers Retry, which asks again", () => {
    hold({ expires_at: new Date(T0 - HOUR).toISOString() });
    show();

    expect(banner()?.dataset.state).toBe("expired");
    expect(banner()?.textContent).toContain("did not answer the encrypted chat request within");
    screen.getByTestId("e2e-request-retry").click();
    expect(askEncryptedChat).toHaveBeenCalledWith(slug, "bob");
    expect(screen.getByTestId("e2e-request-dismiss")).not.toBeNull();
  });

  it("an accepted request still held offers to open the chat, or to dismiss it with the ×", async () => {
    const request = hold({ state: "accepted", expires_at: null });
    show();

    expect(banner()?.dataset.state).toBe("accepted");
    screen.getByTestId("e2e-request-open").click();
    expect(openAcceptedChat).toHaveBeenCalledWith(slug, request);
    // An identity held on another device never opens here: the × lets it go.
    const dismiss = screen.getByTestId("e2e-request-dismiss") as HTMLButtonElement;
    await vi.waitFor(() => expect(dismiss.disabled).toBe(false));
    dismiss.click();
    expect(dismissEncryptedChatRequest).toHaveBeenCalledWith(slug, request);
  });

  it("a door that fails says why in the banner, and the buttons work again", async () => {
    const refusal = new ApiError(409, "request_state");
    acceptEncryptedChat.mockRejectedValue(refusal);
    hold({ state: "incoming" });
    show();

    screen.getByTestId("e2e-request-accept").click();

    await vi.waitFor(() =>
      expect(screen.getByTestId("e2e-request-error").textContent).toBe(errorMessage(refusal)),
    );
    expect((screen.getByTestId("e2e-request-accept") as HTMLButtonElement).disabled).toBe(false);
  });

  it("while a door runs, a second click sends nothing", () => {
    acceptEncryptedChat.mockReturnValue(new Promise(() => undefined));
    hold({ state: "incoming" });
    show();

    screen.getByTestId("e2e-request-accept").click();
    screen.getByTestId("e2e-request-reject").click();

    expect(acceptEncryptedChat).toHaveBeenCalledTimes(1);
    expect(refuseEncryptedChat).not.toHaveBeenCalled();
  });

  it("the peer's asking goes at its deadline, without waiting for grappa", () => {
    hold({ state: "incoming" });
    show();
    expect(banner()).not.toBeNull();

    vi.advanceTimersByTime(24 * HOUR - 1);
    expect(banner()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(banner()).toBeNull();
  });

  it("a request that arrives already past its deadline here reads expired at once", () => {
    show();
    // The clock moves on while nothing is shown, then a fetch brings our asking.
    vi.setSystemTime(T0 + 25 * HOUR);
    hold({});

    expect(banner()?.dataset.state).toBe("expired");
  });

  it("our asking reads expired when its wake-up comes, on a wall clock a hair behind the timers", () => {
    hold({});
    show();
    // Shifts the wall clock alone: the wake-up still comes 24 h after it was armed.
    vi.setSystemTime(T0 - 5);

    vi.advanceTimersByTime(24 * HOUR);

    expect(banner()?.dataset.state).toBe("expired");
  });

  it("our asking reads expired at its deadline", () => {
    hold({});
    show();

    vi.advanceTimersByTime(24 * HOUR);

    expect(banner()?.dataset.state).toBe("expired");
    expect(screen.getByTestId("e2e-request-retry")).not.toBeNull();
  });
});
