import { render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { E2eRequestsWireRequest } from "../lib/wireTypes";

// issue 2486 — the banner over the plaintext query with the peer, for the
// peer's asking only (vjt's ruling R4: ours is a card in the chat,
// `E2eRequestCard.test.tsx`). The requests mirror is real (it is what the
// banner reads, deadline included); its doors are spies.

const acceptEncryptedChat = vi.hoisted(() => vi.fn());
const refuseEncryptedChat = vi.hoisted(() => vi.fn());

vi.mock("../lib/e2eRequests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/e2eRequests")>()),
  acceptEncryptedChat,
  refuseEncryptedChat,
}));
// What the store reaches on its own (an accepted request opens the chat).
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
  for (const verb of [acceptEncryptedChat, refuseEncryptedChat]) {
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

  it("the query switched to another peer starts clean: no error and no door held from the last", async () => {
    acceptEncryptedChat.mockRejectedValueOnce(new ApiError(409, "request_state"));
    refuseEncryptedChat.mockReturnValueOnce(new Promise(() => undefined));
    hold({ state: "incoming" });
    hold({ state: "incoming", peer: "Carol" });
    hold({ state: "incoming", peer: "Dave" });
    const [peer, setPeer] = createSignal("bob");
    render(() => <E2eRequestBanner networkSlug={slug} peer={peer()} />);

    screen.getByTestId("e2e-request-accept").click();
    await vi.waitFor(() => expect(screen.queryByTestId("e2e-request-error")).not.toBeNull());
    setPeer("carol");
    expect(screen.queryByTestId("e2e-request-error")).toBeNull();

    screen.getByTestId("e2e-request-reject").click();
    setPeer("dave");
    expect((screen.getByTestId("e2e-request-accept") as HTMLButtonElement).disabled).toBe(false);
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

  it("our own asking, waiting or answered, is no banner: it is a card in the chat", () => {
    hold({});
    hold({ peer: "Carol", state: "refused", expires_at: null });
    hold({ peer: "Dave", expires_at: new Date(T0 - HOUR).toISOString() });
    const [peer, setPeer] = createSignal("bob");
    render(() => <E2eRequestBanner networkSlug={slug} peer={peer()} />);

    expect(banner()).toBeNull();
    setPeer("carol");
    expect(banner()).toBeNull();
    setPeer("dave");
    expect(banner()).toBeNull();
  });
});
