import { createRoot, createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { E2eRequestsWireRequest } from "../lib/wireTypes";

// issue 2486 — the mirror of grappa's requests to start an encrypted chat.
// REST (the api module), the encrypted chats and the window are the
// boundaries: spies here. The store is a page singleton, so every test gets
// a network of its own.

const listE2eRequests = vi.hoisted(() => vi.fn());
const askE2eRequest = vi.hoisted(() => vi.fn());
const answerE2eRequest = vi.hoisted(() => vi.fn());
const dismissE2eRequest = vi.hoisted(() => vi.fn());
const askEncryptedKeys = vi.hoisted(() => vi.fn());
const encryptedDevice = vi.hoisted(() => vi.fn());
const openEncryptedChat = vi.hoisted(() => vi.fn());
const openEncryptedWindow = vi.hoisted(() => vi.fn());

vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return {
    ApiError: real.ApiError,
    listE2eRequests,
    askE2eRequest,
    answerE2eRequest,
    dismissE2eRequest,
  };
});
vi.mock("../lib/encryptedChats", () => ({ askEncryptedKeys, encryptedDevice, openEncryptedChat }));
vi.mock("../lib/encryptedWindow", () => ({ openEncryptedWindow }));

type Sel = { networkSlug: string; channelName: string; kind: string } | null;
const [bearer, setBearer] = createSignal<string | null>("tok");
const [list, setList] = createSignal<{ slug: string }[] | undefined>(undefined);
const [selected, setSelected] = createSignal<Sel>(null);
vi.mock("../lib/auth", () => ({ token: () => bearer() }));
vi.mock("../lib/networks", () => ({ networks: () => list() }));
vi.mock("../lib/selection", () => ({ selectedChannel: () => selected() }));

const { ApiError } = await import("../lib/api");
const store = await import("../lib/e2eRequests");

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-01T12:00:00Z");
const DEADLINE = new Date(T0 + 24 * HOUR).toISOString();

let slug: string;
let netCount = 0;
let nextId = 0;

function req(over: Partial<E2eRequestsWireRequest>): E2eRequestsWireRequest {
  nextId += 1;
  return {
    id: nextId,
    peer: "Bob",
    state: "outgoing",
    payload: null,
    at: new Date(T0).toISOString(),
    expires_at: DEADLINE,
    ...over,
  };
}

const LINE = { from: "dev-1", payload: JSON.stringify({ v: 2, master: "M4ST3R" }) };

beforeEach(() => {
  vi.resetAllMocks();
  netCount += 1;
  slug = `net${netCount}`;
  setSelected(null);
  setBearer("tok");
  encryptedDevice.mockResolvedValue({ did: "dev-1", master: "M4ST3R" });
  openEncryptedChat.mockResolvedValue(undefined);
  openEncryptedWindow.mockResolvedValue(undefined);
  askEncryptedKeys.mockResolvedValue(undefined);
  dismissE2eRequest.mockResolvedValue(undefined);
});

describe("requestView", () => {
  const before = T0 + HOUR;
  const after = T0 + 25 * HOUR;

  it.each([
    ["incoming", before, "incoming"],
    ["incoming", after, null],
    ["outgoing", before, "pending"],
    ["outgoing", after, "expired"],
    ["accepted", after, "accepted"],
    ["refused", after, "refused"],
    ["expired", before, "expired"],
  ] as const)("a request %s, read at %i, shows %s", (state, now, kind) => {
    const expires_at = state === "accepted" || state === "refused" ? null : DEADLINE;
    const view = store.requestView(req({ state, expires_at }), now);
    expect(view?.kind ?? null).toBe(kind);
  });

  it("no request shows nothing", () => {
    expect(store.requestView(undefined, T0)).toBeNull();
  });
});

describe("the mirror", () => {
  it("finds the request with a nick folded the IRC way, and the newest when two are held", () => {
    const old = req({ peer: "bob" });
    const fresh = req({ peer: "BOB", state: "incoming" });
    store.putE2eRequest(slug, fresh);
    store.putE2eRequest(slug, old);

    expect(store.e2eRequestWith(slug, "Bob")).toEqual(fresh);
    expect(store.e2eRequestWith(slug, "Carol")).toBeUndefined();
    expect(store.e2eRequestWith(`${slug}-other`, "Bob")).toBeUndefined();
  });

  it("a fetch replaces what the network held, and leaves other networks alone", async () => {
    const stale = req({ peer: "Carol" });
    const elsewhere = req({});
    store.putE2eRequest(slug, stale);
    store.putE2eRequest(`${slug}-other`, elsewhere);
    const listed = req({ state: "incoming" });
    listE2eRequests.mockResolvedValue([listed]);

    await store.loadE2eRequests(slug);

    expect(listE2eRequests).toHaveBeenCalledWith("tok", slug);
    expect(store.e2eRequestWith(slug, "Carol")).toBeUndefined();
    expect(store.e2eRequestWith(slug, "Bob")).toEqual(listed);
    expect(store.e2eRequestWith(`${slug}-other`, "Bob")).toEqual(elsewhere);
  });

  // A fetch whose answer is held until `change` has run, then the next read.
  async function fetchAcross(
    first: E2eRequestsWireRequest[],
    next: E2eRequestsWireRequest[],
    change: () => void,
  ): Promise<void> {
    let answer: (listed: E2eRequestsWireRequest[]) => void = () => undefined;
    listE2eRequests.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    listE2eRequests.mockResolvedValueOnce(next);
    const loading = store.loadE2eRequests(slug);
    change();
    answer(first);
    await loading;
  }

  it("a request gone while a fetch is out is not brought back by it: the network is read again", async () => {
    const answered = req({});
    store.putE2eRequest(slug, answered);

    // Another device answered it; the read was taken before.
    await fetchAcross([answered], [], () => store.dropE2eRequest(slug, answered.id));

    expect(listE2eRequests).toHaveBeenCalledTimes(2);
    expect(store.e2eRequestWith(slug, "Bob")).toBeUndefined();
  });

  it("a request asked while a fetch is out is not wiped by it: the network is read again", async () => {
    const asked = req({});

    await fetchAcross([], [asked], () => store.putE2eRequest(slug, asked));

    expect(listE2eRequests).toHaveBeenCalledTimes(2);
    expect(store.e2eRequestWith(slug, "Bob")).toEqual(asked);
  });

  it("a push that the request is gone drops it, and only it", () => {
    const bob = req({});
    const carol = req({ peer: "Carol" });
    store.putE2eRequest(slug, bob);
    store.putE2eRequest(slug, carol);

    store.dropE2eRequest(slug, bob.id);

    expect(store.e2eRequestWith(slug, "Bob")).toBeUndefined();
    expect(store.e2eRequestWith(slug, "Carol")).toEqual(carol);
  });
});

describe("an accepted request", () => {
  it("opens the chat, asks the peer's keys, then dismisses the request: grappa's job is done", async () => {
    const accepted = req({ state: "accepted", expires_at: null });

    store.putE2eRequest(slug, accepted);

    await vi.waitFor(() => expect(store.e2eRequestWith(slug, "Bob")).toBeUndefined());
    expect(openEncryptedChat).toHaveBeenCalledWith(slug, "Bob");
    expect(openEncryptedWindow).not.toHaveBeenCalled();
    expect(askEncryptedKeys).toHaveBeenCalledWith(slug, "Bob");
    expect(dismissE2eRequest).toHaveBeenCalledWith("tok", slug, accepted.id, null);
  });

  it("is opened once when the push and a fetch both bring it", async () => {
    const accepted = req({ state: "accepted", expires_at: null });
    let release: () => void = () => undefined;
    openEncryptedChat.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
    listE2eRequests.mockResolvedValue([accepted]);

    store.putE2eRequest(slug, accepted);
    await store.loadE2eRequests(slug);
    release();

    await vi.waitFor(() => expect(dismissE2eRequest).toHaveBeenCalled());
    await vi.waitFor(() => expect(store.e2eRequestWith(slug, "Bob")).toBeUndefined());
    expect(openEncryptedChat).toHaveBeenCalledTimes(1);
    expect(askEncryptedKeys).toHaveBeenCalledTimes(1);
    expect(dismissE2eRequest).toHaveBeenCalledTimes(1);
  });

  it("is dropped when another device of the account dismissed it first (404)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    dismissE2eRequest.mockRejectedValue(new ApiError(404, "not_found"));

    store.putE2eRequest(slug, req({ state: "accepted", expires_at: null }));

    await vi.waitFor(() => expect(store.e2eRequestWith(slug, "Bob")).toBeUndefined());
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("stays offered when the chat could not be opened", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    openEncryptedChat.mockRejectedValue(new Error("IndexedDB is gone"));
    const accepted = req({ state: "accepted", expires_at: null });

    store.putE2eRequest(slug, accepted);

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(dismissE2eRequest).not.toHaveBeenCalled();
    expect(store.e2eRequestWith(slug, "Bob")).toEqual(accepted);
    warn.mockRestore();
  });

  it("Open, from the banner, says what failed once the automatic attempt has", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failure = new Error("IndexedDB is gone");
    openEncryptedChat.mockRejectedValue(failure);
    const accepted = req({ state: "accepted", expires_at: null });
    store.putE2eRequest(slug, accepted);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    await expect(store.openAcceptedChat(slug, accepted)).rejects.toBe(failure);

    expect(store.e2eRequestWith(slug, "Bob")).toEqual(accepted);
    warn.mockRestore();
  });

  it("moves the focus only from the query with that peer, where the user asked", async () => {
    setSelected({ networkSlug: slug, channelName: "bob", kind: "query" });

    store.putE2eRequest(slug, req({ state: "accepted", expires_at: null }));

    await vi.waitFor(() => expect(dismissE2eRequest).toHaveBeenCalled());
    expect(openEncryptedWindow).toHaveBeenCalledWith(slug, "Bob");
    expect(openEncryptedChat).not.toHaveBeenCalled();
  });

  it.each([
    ["another query", { channelName: "Carol", kind: "query" }],
    ["a channel named like the peer", { channelName: "Bob", kind: "channel" }],
  ])("anywhere else (%s) the chat just appears", async (_label, sel) => {
    setSelected({ networkSlug: slug, ...sel });

    store.putE2eRequest(slug, req({ state: "accepted", expires_at: null }));

    await vi.waitFor(() => expect(dismissE2eRequest).toHaveBeenCalled());
    expect(openEncryptedChat).toHaveBeenCalledWith(slug, "Bob");
    expect(openEncryptedWindow).not.toHaveBeenCalled();
  });
});

describe("the doors", () => {
  it("asking sends a consent line from this device, our master as the hint, and holds the answer", async () => {
    const asked = req({});
    askE2eRequest.mockResolvedValue(asked);

    await store.askEncryptedChat(slug, "Bob");

    expect(askE2eRequest).toHaveBeenCalledWith("tok", slug, "Bob", LINE);
    expect(store.e2eRequestWith(slug, "Bob")).toEqual(asked);
  });

  it("asking a peer whose own request waits lands on accepted, and opens the chat", async () => {
    askE2eRequest.mockResolvedValue(req({ state: "accepted", expires_at: null }));

    await store.askEncryptedChat(slug, "Bob");

    await vi.waitFor(() => expect(askEncryptedKeys).toHaveBeenCalledWith(slug, "Bob"));
  });

  it("accepting answers yes with a line, opens the window and asks the keys", async () => {
    const incoming = req({ state: "incoming" });
    store.putE2eRequest(slug, incoming);
    answerE2eRequest.mockResolvedValue({ msgid: "m1" });

    await store.acceptEncryptedChat(slug, incoming);

    expect(answerE2eRequest).toHaveBeenCalledWith("tok", slug, incoming.id, "accept", LINE);
    expect(openEncryptedWindow).toHaveBeenCalledWith(slug, "Bob");
    expect(askEncryptedKeys).toHaveBeenCalledWith(slug, "Bob");
    expect(store.e2eRequestWith(slug, "Bob")).toBeUndefined();
  });

  it("accepting: what fails once grappa took the yes is warned, not thrown, for the request is gone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const incoming = req({ state: "incoming" });
    store.putE2eRequest(slug, incoming);
    answerE2eRequest.mockResolvedValue({ msgid: "m1" });
    askEncryptedKeys.mockRejectedValue(new ApiError(429, "rate_limited"));

    await expect(store.acceptEncryptedChat(slug, incoming)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    expect(openEncryptedWindow).toHaveBeenCalledWith(slug, "Bob");
    expect(store.e2eRequestWith(slug, "Bob")).toBeUndefined();
    warn.mockRestore();
  });

  it("an accept grappa cannot send opens nothing and keeps the request", async () => {
    const incoming = req({ state: "incoming" });
    store.putE2eRequest(slug, incoming);
    answerE2eRequest.mockRejectedValue(new ApiError(429, "rate_limited"));

    await expect(store.acceptEncryptedChat(slug, incoming)).rejects.toThrow("429");

    expect(openEncryptedWindow).not.toHaveBeenCalled();
    expect(askEncryptedKeys).not.toHaveBeenCalled();
    expect(listE2eRequests).not.toHaveBeenCalled();
    expect(store.e2eRequestWith(slug, "Bob")).toEqual(incoming);
  });

  it("a door grappa answers 404 or 409 reads the network again, and still says why", async () => {
    const doors = [
      ["accept", "incoming", new ApiError(404, "not_found")],
      ["refuse", "incoming", new ApiError(409, "request_state")],
      ["dismiss", "outgoing", new ApiError(404, "not_found")],
    ] as const;
    for (const [door, state, refusal] of doors) {
      const request = req({ state });
      store.putE2eRequest(slug, request);
      (door === "dismiss" ? dismissE2eRequest : answerE2eRequest).mockRejectedValueOnce(refusal);
      // Answered or withdrawn elsewhere: grappa lists it no more.
      listE2eRequests.mockResolvedValueOnce([]);

      const work =
        door === "accept"
          ? store.acceptEncryptedChat(slug, request)
          : door === "refuse"
            ? store.refuseEncryptedChat(slug, request)
            : store.dismissEncryptedChatRequest(slug, request);

      await expect(work).rejects.toBe(refusal);
      await vi.waitFor(() => expect(store.e2eRequestWith(slug, "Bob")).toBeUndefined());
    }
    expect(listE2eRequests).toHaveBeenCalledTimes(3);
    expect(openEncryptedWindow).not.toHaveBeenCalled();
  });

  it("refusing answers no with a line, and opens nothing", async () => {
    const incoming = req({ state: "incoming" });
    store.putE2eRequest(slug, incoming);
    answerE2eRequest.mockResolvedValue({ msgid: "m1" });

    await store.refuseEncryptedChat(slug, incoming);

    expect(answerE2eRequest).toHaveBeenCalledWith("tok", slug, incoming.id, "refuse", LINE);
    expect(openEncryptedWindow).not.toHaveBeenCalled();
    expect(openEncryptedChat).not.toHaveBeenCalled();
    expect(store.e2eRequestWith(slug, "Bob")).toBeUndefined();
  });

  it("cancelling our asking sends the line its CANCEL goes as, even past the deadline here", async () => {
    const ours = req({ expires_at: new Date(T0 - HOUR).toISOString() });
    store.putE2eRequest(slug, ours);

    await store.dismissEncryptedChatRequest(slug, ours);

    expect(dismissE2eRequest).toHaveBeenCalledWith("tok", slug, ours.id, LINE);
    expect(store.e2eRequestWith(slug, "Bob")).toBeUndefined();
  });

  it.each(["refused", "expired"] as const)(
    "dismissing a %s request sends no line",
    async (state) => {
      const shown = req({ state, expires_at: null });
      store.putE2eRequest(slug, shown);

      await store.dismissEncryptedChatRequest(slug, shown);

      expect(dismissE2eRequest).toHaveBeenCalledWith("tok", slug, shown.id, null);
      expect(encryptedDevice).not.toHaveBeenCalled();
      expect(store.e2eRequestWith(slug, "Bob")).toBeUndefined();
    },
  );
});

describe("the account changing while a door is out", () => {
  // A promise resolved by hand, for the await that spans the change.
  function held<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  it("a fetch answered after it writes nothing and reads nothing more", async () => {
    const answer = held<E2eRequestsWireRequest[]>();
    listE2eRequests.mockReturnValueOnce(answer.promise);

    const loading = store.loadE2eRequests(slug);
    setBearer("tok2");
    answer.resolve([req({ state: "accepted", expires_at: null })]);
    await loading;

    expect(store.e2eRequestWith(slug, "Bob")).toBeUndefined();
    expect(listE2eRequests).toHaveBeenCalledTimes(1);
    expect(openEncryptedChat).not.toHaveBeenCalled();
  });

  it("an asking answered after it holds nothing", async () => {
    const answer = held<E2eRequestsWireRequest>();
    askE2eRequest.mockReturnValueOnce(answer.promise);

    const asking = store.askEncryptedChat(slug, "Bob");
    await vi.waitFor(() => expect(askE2eRequest).toHaveBeenCalled());
    setBearer("tok2");
    answer.resolve(req({}));
    await asking;

    expect(store.e2eRequestWith(slug, "Bob")).toBeUndefined();
  });

  it("an accept whose line comes after it sends nothing", async () => {
    const device = held<{ did: string; master: string }>();
    encryptedDevice.mockReturnValueOnce(device.promise);
    const incoming = req({ state: "incoming" });
    store.putE2eRequest(slug, incoming);

    const accepting = store.acceptEncryptedChat(slug, incoming);
    setBearer("tok2");
    device.resolve({ did: "dev-1", master: "M4ST3R" });
    await accepting;

    expect(answerE2eRequest).not.toHaveBeenCalled();
  });

  it("an accept answered after it opens nothing and asks no keys", async () => {
    const answer = held<{ msgid: string }>();
    answerE2eRequest.mockReturnValueOnce(answer.promise);
    const incoming = req({ state: "incoming" });
    store.putE2eRequest(slug, incoming);

    const accepting = store.acceptEncryptedChat(slug, incoming);
    await vi.waitFor(() => expect(answerE2eRequest).toHaveBeenCalled());
    setBearer("tok2");
    answer.resolve({ msgid: "m1" });
    await accepting;

    expect(openEncryptedWindow).not.toHaveBeenCalled();
    expect(askEncryptedKeys).not.toHaveBeenCalled();
  });

  // Each await a request follows: the request must not go once the account changed.
  const before = [
    ["asking", "its line", () => encryptedDevice, () => askE2eRequest],
    ["refusing", "its line", () => encryptedDevice, () => answerE2eRequest],
    ["cancelling", "its line", () => encryptedDevice, () => dismissE2eRequest],
    ["accepting", "the window", () => openEncryptedWindow, () => askEncryptedKeys],
  ] as const;
  it.each(before)("%s sends nothing when %s comes after it", async (verb, _, awaited, next) => {
    const wait = held<unknown>();
    awaited().mockReturnValueOnce(wait.promise);
    answerE2eRequest.mockResolvedValue({ msgid: "m1" });
    const request = req({ state: verb === "cancelling" ? "outgoing" : "incoming" });
    store.putE2eRequest(slug, request);

    const work =
      verb === "asking"
        ? store.askEncryptedChat(slug, "Bob")
        : verb === "refusing"
          ? store.refuseEncryptedChat(slug, request)
          : verb === "cancelling"
            ? store.dismissEncryptedChatRequest(slug, request)
            : store.acceptEncryptedChat(slug, request);
    await vi.waitFor(() => expect(awaited()).toHaveBeenCalled());
    setBearer("tok2");
    wait.resolve(awaited() === encryptedDevice ? { did: "dev-1", master: "M4ST3R" } : undefined);
    await work;

    expect(next()).not.toHaveBeenCalled();
  });

  it("an accepted chat whose keys are asked after it dismisses nothing", async () => {
    const asked = held<undefined>();
    askEncryptedKeys.mockReturnValueOnce(asked.promise);

    store.putE2eRequest(slug, req({ state: "accepted", expires_at: null }));
    await vi.waitFor(() => expect(askEncryptedKeys).toHaveBeenCalled());
    setBearer("tok2");
    asked.resolve(undefined);
    await vi.waitFor(() => expect(askEncryptedKeys).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    await Promise.resolve();

    expect(dismissE2eRequest).not.toHaveBeenCalled();
  });

  // The last await before a drop: a drop of the old account counts as a
  // change, and would send a fetch of the new one back to read again.
  const lastly = [
    ["refusing", () => answerE2eRequest, "incoming"],
    ["cancelling", () => dismissE2eRequest, "outgoing"],
    ["opening an accepted chat", () => dismissE2eRequest, "accepted"],
  ] as const;
  it.each(lastly)(
    "%s answered after it leaves the new account's fetch alone",
    async (verb, awaited, state) => {
      const answer = held<unknown>();
      awaited().mockReturnValueOnce(answer.promise);
      const request = req({ state, expires_at: state === "accepted" ? null : DEADLINE });

      store.putE2eRequest(slug, request);
      const work =
        verb === "refusing"
          ? store.refuseEncryptedChat(slug, request)
          : verb === "cancelling"
            ? store.dismissEncryptedChatRequest(slug, request)
            : Promise.resolve();
      await vi.waitFor(() => expect(awaited()).toHaveBeenCalled());
      setBearer("tok2");
      const read = held<E2eRequestsWireRequest[]>();
      listE2eRequests.mockReturnValueOnce(read.promise);
      const loading = store.loadE2eRequests(slug);
      answer.resolve(verb === "refusing" ? { msgid: "m1" } : undefined);
      await work;
      await Promise.resolve();
      read.resolve([]);
      await loading;

      expect(listE2eRequests).toHaveBeenCalledTimes(1);
    },
  );

  it("a door refused 404 after it reads nothing again", async () => {
    let refuse: (err: unknown) => void = () => undefined;
    answerE2eRequest.mockReturnValueOnce(new Promise((_, reject) => (refuse = reject)));
    const incoming = req({ state: "incoming" });
    store.putE2eRequest(slug, incoming);

    const refusing = store.refuseEncryptedChat(slug, incoming);
    await vi.waitFor(() => expect(answerE2eRequest).toHaveBeenCalled());
    setBearer("tok2");
    refuse(new ApiError(404, "not_found"));
    await expect(refusing).rejects.toThrow("404");

    expect(listE2eRequests).not.toHaveBeenCalled();
  });

  it("an accepted chat opened after it asks no keys and dismisses nothing", async () => {
    const opened = held<undefined>();
    openEncryptedChat.mockReturnValueOnce(opened.promise);

    store.putE2eRequest(slug, req({ state: "accepted", expires_at: null }));
    await vi.waitFor(() => expect(openEncryptedChat).toHaveBeenCalled());
    setBearer("tok2");
    opened.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(askEncryptedKeys).not.toHaveBeenCalled();
    expect(dismissE2eRequest).not.toHaveBeenCalled();
  });
});

describe("loading", () => {
  it("every (re)join reads every network's requests", async () => {
    setList([{ slug }, { slug: `${slug}-b` }]);
    listE2eRequests.mockResolvedValue([]);

    store.reloadE2eRequests();

    await vi.waitFor(() => expect(listE2eRequests).toHaveBeenCalledTimes(2));
    expect(listE2eRequests).toHaveBeenCalledWith("tok", slug);
    expect(listE2eRequests).toHaveBeenCalledWith("tok", `${slug}-b`);
  });

  it("the mount reads each network once, as the list brings it", async () => {
    listE2eRequests.mockResolvedValue([]);
    setList(undefined);
    const dispose = createRoot((d) => {
      store.mountE2eRequests();
      return d;
    });

    setList([{ slug }]);
    await vi.waitFor(() => expect(listE2eRequests).toHaveBeenCalledTimes(1));
    setList([{ slug }, { slug: `${slug}-b` }]);
    await vi.waitFor(() => expect(listE2eRequests).toHaveBeenCalledTimes(2));

    expect(listE2eRequests.mock.calls.map((c) => c[1])).toEqual([slug, `${slug}-b`]);
    dispose();
  });
});
