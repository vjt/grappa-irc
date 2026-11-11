import { render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { pressAndClick } from "./helpers/pointerEvents";

// C5.1 — UserContextMenu: right-click submenu on member nick.
//
// Tests assert:
//   1. All 11 items render (op/deop/voice/devoice/kick/ban nick/ban host/
//      kickban/WHOIS/CTCP/query — issue 2346 replaced the bare "ban").
//   2. When own nick has @-mode, op-gated items are enabled.
//   3. When own nick lacks @-mode, op-gated items are disabled (not hidden).
//   4. WHOIS + Query are always enabled regardless of modes; Encrypted query
//      too, unless the nick is our own (issue 2430).
//   5. Clicking an enabled item fires the correct socket push.
//   6. Clicking outside fires onClose.
//   7. Pressing Escape fires onClose.

const mockPushChannelOp = vi.fn();
const mockPushChannelDeop = vi.fn();
const mockPushChannelVoice = vi.fn();
const mockPushChannelDevoice = vi.fn();
const mockPushChannelKick = vi.fn();
const mockPushChannelBan = vi.fn();
const mockPushWhois = vi.fn();
const mockResolveUserhost = vi.fn();
const mockOpenQueryWindowState = vi.fn();
const mockSetSelectedChannel = vi.fn();
const mockSendCtcpQuery = vi.fn();
const mockOpenEncryptedWindow = vi.fn();

vi.mock("../lib/socket", () => ({
  pushChannelOp: (...args: unknown[]) => mockPushChannelOp(...args),
  pushChannelDeop: (...args: unknown[]) => mockPushChannelDeop(...args),
  pushChannelVoice: (...args: unknown[]) => mockPushChannelVoice(...args),
  pushChannelDevoice: (...args: unknown[]) => mockPushChannelDevoice(...args),
  pushChannelKick: (...args: unknown[]) => mockPushChannelKick(...args),
  pushChannelBan: (...args: unknown[]) => mockPushChannelBan(...args),
  pushWhois: (...args: unknown[]) => mockPushWhois(...args),
  resolveUserhost: (...args: unknown[]) => mockResolveUserhost(...args),
}));

// #1192 — the CTCP submenu dispatches through the shared seam; its own
// contract (the #640 source-window echo, the #600 ordering) is pinned in
// ctcpQuery.test.ts, so here it is a boundary spy. Resolves, because the
// production action attaches a `.catch` and an unhandled rejection from a
// bare `vi.fn()` would fail the run for the wrong reason.
vi.mock("../lib/ctcpQuery", () => ({
  sendCtcpQuery: (...args: unknown[]) => mockSendCtcpQuery(...args),
}));

vi.mock("../lib/networks", () => ({
  // #1861 — casemappingForSlug (lib/casemapping.ts) resolves the fold
  // through this map, so the mock has to carry it. It resolves freenode to
  // its id so a test can seed that network's 005 CASEMAPPING (issue 2483);
  // unseeded, the id reads the bahamut default, `ascii`.
  networkIdBySlug: (slug: string) => (slug === "freenode" ? 42 : undefined),
  networks: vi.fn(() => [{ id: 42, slug: "freenode", inserted_at: "x", updated_at: "y" }]),
}));

// issue 2430 — the encrypted window's door is a boundary spy here; what it
// does is pinned in encryptedWindow's own tests.
vi.mock("../lib/encryptedWindow", () => ({
  openEncryptedWindow: (...args: unknown[]) => mockOpenEncryptedWindow(...args),
}));

vi.mock("../lib/queryWindows", () => ({
  openQueryWindowState: (...args: unknown[]) => mockOpenQueryWindowState(...args),
  queryWindowsByNetwork: vi.fn(() => ({})),
  canonicalQueryNick: (_networkId: number, nick: string) => nick,
}));

vi.mock("../lib/selection", () => ({
  setSelectedChannel: (...args: unknown[]) => mockSetSelectedChannel(...args),
  selectedChannel: vi.fn(() => null),
  applySeedEnvelope: vi.fn(),
}));

// We also need to mock pushWhois — UserContextMenu uses pushWhois from socket.ts.
// The mock above covers it.

// issue 2483 — the Ignore/Unignore row runs on the REAL ignoreList store, the
// real REST client and the real auth token, so what these tests assert is what
// the operator sees: the label the store's mirrored list produces. Only
// `fetch` is faked. `serverList` is what the server holds — GET answers it —
// and a test queues the answer the server gives a mutation: what
// `IgnoresController` sends back (the resulting list, the normalised entry and
// the outcome) or a refusal.
type Entry = { mask: string; text_pattern: string | null };
let serverList: Entry[] = [];
let mutationAnswer: (() => Response) | null = null;
const ignoreRequests: Array<{ method: string; url: string; body: unknown }> = [];

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const listBody = (entries: Entry[]) => ({ masks: entries.map((e) => e.mask), entries });

const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (!url.startsWith("/networks/")) throw new Error(`unexpected fetch: ${method} ${url}`);
  ignoreRequests.push({
    method,
    url,
    body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
  });
  if (method === "GET") return jsonResponse(200, listBody(serverList));
  if (mutationAnswer === null) throw new Error(`no answer queued for ${method} ${url}`);
  return mutationAnswer();
};

const requestsOf = (method: string) => ignoreRequests.filter((r) => r.method === method);

import { ApiError } from "../lib/api";
import { setToken } from "../lib/auth";
import { channelKey } from "../lib/channelKey";
import { friendlyError } from "../lib/friendlyError";
import { ignoresBySlug, refreshIgnores } from "../lib/ignoreList";
import { DEFAULT_ISUPPORT, seedIsupport } from "../lib/isupport";
import { seedFromTest } from "../lib/members";
import { dismissOpsMenuToast, opsMenuToasts } from "../lib/opsMenu";
import {
  __resetForTest,
  overlayEscapeDepth,
  runTopmostOverlayEscape,
} from "../lib/overlayScrollLock";
import UserContextMenu from "../UserContextMenu";

const flush = () => new Promise((r) => setTimeout(r, 0));

let fetchSpy: MockInstance<typeof fetch>;

const baseProps = {
  networkSlug: "freenode",
  networkId: 42,
  channelName: "#grappa",
  targetNick: "alice",
  targetHost: null as string | null,
  ownModes: [] as string[],
  // issue 2430 — our own nick on the network gates "Encrypted query".
  ownNick: "Me" as string | null,
  position: { x: 100, y: 200 },
  onClose: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSendCtcpQuery.mockResolvedValue(undefined);
  mockOpenEncryptedWindow.mockResolvedValue(undefined);
  for (const m of [
    mockPushChannelOp,
    mockPushChannelDeop,
    mockPushChannelVoice,
    mockPushChannelDevoice,
    mockPushChannelKick,
    mockPushChannelBan,
  ]) {
    m.mockResolvedValue(undefined);
  }
  seedFromTest(channelKey("freenode", "#grappa"), [{ nick: "alice", modes: [] }]);
  // issue 2483 — nothing ignored yet, no mutation answer queued, and a token:
  // the tests that need more say so.
  serverList = [];
  mutationAnswer = null;
  ignoreRequests.length = 0;
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
  setToken("tok");
  seedIsupport(42, DEFAULT_ISUPPORT);
  // The menu's toast queue is a module singleton that outlives a test.
  for (const t of opsMenuToasts()) dismissOpsMenuToast(t.id);
  __resetForTest();
});

afterEach(() => {
  // Logging out is the store's own reset (identityScopedStore): the next test
  // starts with no list loaded for any network.
  setToken(null);
  fetchSpy.mockRestore();
});

describe("UserContextMenu", () => {
  describe("renders all 13 items", () => {
    it("shows Op, Deop, Voice, Devoice, Kick, Ban nick, Ban host, Kickban, Ignore, WHOIS, CTCP, Encrypted query, Query", () => {
      render(() => <UserContextMenu {...baseProps} />);
      expect(screen.getByRole("button", { name: /^op$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^deop$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^voice$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^devoice$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^kick$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^ban nick$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^ban host$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^kickban$/i })).toBeInTheDocument();
      // issue 2346 — the ambiguous bare "Ban" is gone.
      expect(screen.queryByRole("button", { name: /^ban$/i })).toBeNull();
      // issue 2483 — the nick is not on the list yet, so the row offers Ignore.
      expect(screen.getByRole("button", { name: /^ignore$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^whois$/i })).toBeInTheDocument();
      // #1192 — the shell appends the ▸, so the accessible name carries it.
      expect(screen.getByRole("button", { name: /^ctcp ▸$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^query$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^encrypted query$/i })).toBeInTheDocument();
    });

    // #1192 put CTCP above Query so the LAST row stays an always-enabled verb
    // that closes the menu: the #487 viewport-clamp e2e clicks the last row on
    // our own nick, where "Encrypted query" (issue 2430) is disabled.
    it("keeps Query as the last row, with Encrypted query above it", () => {
      render(() => <UserContextMenu {...baseProps} />);
      const labels = [...document.querySelectorAll(".context-menu-item")].map((b) =>
        b.textContent?.trim(),
      );
      expect(labels.slice(-2)).toEqual(["Encrypted query", "Query"]);
    });
  });

  // issue 2483 — Ignore / Unignore in the nick menu. The row is the same door
  // as `/ignore <nick>`: the ignoreList store, keyed by the network slug, on
  // the `nick!*@*` mask the server itself normalises a bare nick to.
  describe("Ignore / Unignore (issue 2483)", () => {
    // The list the server answered has landed in the store — the barrier that
    // makes a label read after it a statement about the list, not about a
    // fetch still in flight.
    const listLoaded = () => vi.waitFor(() => expect(ignoresBySlug().freenode).toEqual(serverList));

    it("Ignore adds the person entry nick!*@*, and the row then reads Unignore", async () => {
      mutationAnswer = () =>
        jsonResponse(200, {
          ...listBody([{ mask: "alice!*@*", text_pattern: null }]),
          mask: "alice!*@*",
          text_pattern: null,
          outcome: "added",
        });
      render(() => <UserContextMenu {...baseProps} />);
      await listLoaded();
      pressAndClick(screen.getByRole("button", { name: /^ignore$/i }));

      expect(await screen.findByRole("button", { name: /^unignore$/i })).toBeInTheDocument();
      expect(requestsOf("POST")).toEqual([
        {
          method: "POST",
          url: "/networks/freenode/ignores",
          body: { mask: "alice!*@*", text_pattern: null },
        },
      ]);
      expect(requestsOf("DELETE")).toEqual([]);
    });

    it("a nick already on the list reads Unignore once the list arrives, and Unignore removes it", async () => {
      serverList = [{ mask: "alice!*@*", text_pattern: null }];
      mutationAnswer = () =>
        jsonResponse(200, {
          ...listBody([]),
          mask: "alice!*@*",
          text_pattern: null,
          outcome: "removed",
        });
      // Opened before this network's list was ever fetched: the row has to
      // follow the list when it lands, not keep what it read at open.
      render(() => <UserContextMenu {...baseProps} />);
      expect(screen.getByRole("button", { name: /^ignore$/i })).toBeInTheDocument();
      pressAndClick(await screen.findByRole("button", { name: /^unignore$/i }));

      expect(await screen.findByRole("button", { name: /^ignore$/i })).toBeInTheDocument();
      // The pattern-less removal: no `text_pattern` query, so it names the
      // person entry and nothing else.
      expect(requestsOf("DELETE").map((r) => r.url)).toEqual([
        "/networks/freenode/ignores/alice!*%40*",
      ]);
      expect(requestsOf("POST")).toEqual([]);
    });

    it("a targeted entry is not the person: the row offers Ignore, and the round trip leaves it standing", async () => {
      // issue 2294 — an entry is the PAIR (mask, text_pattern). `alice!*@*` +
      // `*spam*` drops only her spam; it does not mean "alice is ignored", and
      // a pattern-less removal would not touch it (`UserSettings.remove_ignore/5`
      // answers `not_ignored`), so offering Unignore here would be a dead row.
      const targeted = { mask: "alice!*@*", text_pattern: "*spam*" };
      const person = { mask: "alice!*@*", text_pattern: null };
      serverList = [targeted];
      render(() => <UserContextMenu {...baseProps} />);
      await listLoaded();
      expect(screen.getByRole("button", { name: /^ignore$/i })).toBeInTheDocument();

      mutationAnswer = () =>
        jsonResponse(200, { ...listBody([person, targeted]), ...person, outcome: "added" });
      pressAndClick(screen.getByRole("button", { name: /^ignore$/i }));
      expect(await screen.findByRole("button", { name: /^unignore$/i })).toBeInTheDocument();
      expect(requestsOf("POST").map((r) => r.body)).toEqual([person]);

      mutationAnswer = () =>
        jsonResponse(200, { ...listBody([targeted]), ...person, outcome: "removed" });
      pressAndClick(screen.getByRole("button", { name: /^unignore$/i }));
      expect(await screen.findByRole("button", { name: /^ignore$/i })).toBeInTheDocument();
      expect(requestsOf("DELETE").map((r) => r.url)).toEqual([
        "/networks/freenode/ignores/alice!*%40*",
      ]);
      expect(ignoresBySlug().freenode).toEqual([targeted]);
    });

    it("matches the stored mask whatever case the nick is shown in", async () => {
      // The server stores the FOLDED mask; the nick on screen keeps its case.
      serverList = [{ mask: "alice!*@*", text_pattern: null }];
      render(() => <UserContextMenu {...baseProps} targetNick="Alice" />);
      expect(await screen.findByRole("button", { name: /^unignore$/i })).toBeInTheDocument();
    });

    it("folds with the network's casemapping: on rfc1459, foo[1] is the stored foo{1}!*@*", async () => {
      // The server folds the nick part with the NETWORK's casemapping before
      // storing it (`Grappa.IRC.Mask.normalize/2`): on solanum/Libera
      // `/ignore foo[1]` stores `foo{1}!*@*`, because the ircd calls them one
      // person.
      seedIsupport(42, { ...DEFAULT_ISUPPORT, casemapping: "rfc1459" });
      serverList = [{ mask: "foo{1}!*@*", text_pattern: null }];
      render(() => <UserContextMenu {...baseProps} targetNick="foo[1]" />);
      await listLoaded();
      expect(screen.getByRole("button", { name: /^unignore$/i })).toBeInTheDocument();
    });

    it("folds ASCII only on an ascii network, where foo[1] and foo{1} are two people", async () => {
      // bahamut (Azzurra, all of prod) leaves `[ ] \ ~` alone: the national
      // fold must not run where the ircd does not run it.
      serverList = [{ mask: "foo{1}!*@*", text_pattern: null }];
      render(() => <UserContextMenu {...baseProps} targetNick="foo[1]" />);
      await listLoaded();
      expect(screen.getByRole("button", { name: /^ignore$/i })).toBeInTheDocument();
    });

    it("an entry for a different nick leaves the row on Ignore", async () => {
      serverList = [{ mask: "bob!*@*", text_pattern: null }];
      render(() => <UserContextMenu {...baseProps} />);
      await listLoaded();
      expect(screen.getByRole("button", { name: /^ignore$/i })).toBeInTheDocument();
    });

    // A menu row's action is synchronous and the menu is gone by the time the
    // server answers, so a refusal has nowhere inline to land: it is the
    // menu's toast (`runOpsVerb`), the way a refused Op or Kick is.
    it("a refused Ignore is a toast naming the row, and the row stays Ignore", async () => {
      // `list_full`: the server caps a network's list at 100 entries.
      mutationAnswer = () => jsonResponse(422, { error: "list_full" });
      render(() => <UserContextMenu {...baseProps} />);
      await listLoaded();
      expect(opsMenuToasts()).toEqual([]);
      pressAndClick(screen.getByRole("button", { name: /^ignore$/i }));

      await vi.waitFor(() => expect(opsMenuToasts()).toHaveLength(1));
      expect(opsMenuToasts()[0]?.message).toBe(
        `Ignore: ${friendlyError(new ApiError(422, "list_full"))}`,
      );
      expect(screen.getByRole("button", { name: /^ignore$/i })).toBeInTheDocument();
    });

    it("a refused Unignore is a toast too, and the row stays Unignore", async () => {
      serverList = [{ mask: "alice!*@*", text_pattern: null }];
      mutationAnswer = () => jsonResponse(500, { errors: { detail: "Internal Server Error" } });
      render(() => <UserContextMenu {...baseProps} />);
      pressAndClick(await screen.findByRole("button", { name: /^unignore$/i }));

      await vi.waitFor(() => expect(opsMenuToasts()).toHaveLength(1));
      expect(opsMenuToasts()[0]?.message).toBe(
        `Unignore: ${friendlyError(new ApiError(500, "Internal Server Error"))}`,
      );
      expect(screen.getByRole("button", { name: /^unignore$/i })).toBeInTheDocument();
    });

    it("does not refetch a list the store already holds", async () => {
      await refreshIgnores("tok", "freenode");
      expect(requestsOf("GET")).toHaveLength(1);
      render(() => <UserContextMenu {...baseProps} />);
      await flush();
      expect(requestsOf("GET")).toHaveLength(1);
    });

    it("needs no channel privilege: enabled without @ on someone else", () => {
      render(() => <UserContextMenu {...baseProps} ownModes={[]} />);
      expect(screen.getByRole("button", { name: /^ignore$/i })).not.toBeDisabled();
    });

    it("is disabled on our own nick, in any case", () => {
      // The delivery filter never drops our own lines (`EventRouter.ignored?/2`),
      // so `<me>!*@*` would do nothing to us and silence whoever holds the nick
      // next — after our own /nick, or a Guest rename.
      render(() => <UserContextMenu {...baseProps} targetNick="ME" />);
      expect(screen.getByRole("button", { name: /^ignore$/i })).toBeDisabled();
    });
  });

  describe("permission gating (own nick has no @ mode)", () => {
    it("disables op-gated items when ownModes is empty", () => {
      render(() => <UserContextMenu {...baseProps} ownModes={[]} />);
      expect(screen.getByRole("button", { name: /^op$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^deop$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^voice$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^devoice$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^kick$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^ban nick$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^ban host$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^kickban$/i })).toBeDisabled();
    });

    it("disabled items are NOT hidden (still rendered)", () => {
      render(() => <UserContextMenu {...baseProps} ownModes={[]} />);
      // All 6 op-gated items are in DOM but disabled.
      const opBtn = screen.getByRole("button", { name: /^op$/i });
      expect(opBtn).toBeInTheDocument();
      expect(opBtn).toBeDisabled();
    });

    it("WHOIS and Query are always enabled regardless of ownModes", () => {
      render(() => <UserContextMenu {...baseProps} ownModes={[]} />);
      expect(screen.getByRole("button", { name: /^whois$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^query$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^encrypted query$/i })).not.toBeDisabled();
    });

    it("Encrypted query is disabled on our own nick, in any case", () => {
      render(() => <UserContextMenu {...baseProps} targetNick="ME" />);
      expect(screen.getByRole("button", { name: /^encrypted query$/i })).toBeDisabled();
    });
  });

  describe("permission gating (own nick has @ mode)", () => {
    it("enables op-gated items when ownModes includes @", () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      expect(screen.getByRole("button", { name: /^op$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^deop$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^voice$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^devoice$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^kick$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^ban nick$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^ban host$/i })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /^kickban$/i })).not.toBeDisabled();
    });
  });

  describe("actions dispatch to correct socket helpers (ownModes = [@])", () => {
    it("Op button calls pushChannelOp with networkId, channel, [nick]", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^op$/i }));
      expect(mockPushChannelOp).toHaveBeenCalledWith(42, "#grappa", ["alice"]);
    });

    it("Deop button calls pushChannelDeop", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^deop$/i }));
      expect(mockPushChannelDeop).toHaveBeenCalledWith(42, "#grappa", ["alice"]);
    });

    it("Voice button calls pushChannelVoice", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^voice$/i }));
      expect(mockPushChannelVoice).toHaveBeenCalledWith(42, "#grappa", ["alice"]);
    });

    it("Devoice button calls pushChannelDevoice", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^devoice$/i }));
      expect(mockPushChannelDevoice).toHaveBeenCalledWith(42, "#grappa", ["alice"]);
    });

    it("Kick button calls pushChannelKick with empty reason", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^kick$/i }));
      expect(mockPushChannelKick).toHaveBeenCalledWith(42, "#grappa", "alice", "");
    });

    it("Ban nick bans nick!*@*", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^ban nick$/i }));
      expect(mockPushChannelBan).toHaveBeenCalledWith(42, "#grappa", "alice!*@*");
    });

    it("Ban host with no host from the opener resolves it, then bans *!*@host", async () => {
      mockResolveUserhost.mockResolvedValue({ user: "ident", host: "alice.example.net" });
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^ban host$/i }));
      await flush();
      expect(mockResolveUserhost).toHaveBeenCalledWith(42, "alice");
      expect(mockPushChannelBan).toHaveBeenCalledWith(42, "#grappa", "*!*@alice.example.net");
    });

    it("Ban host with the opener's host bans it without a lookup", async () => {
      render(() => (
        <UserContextMenu {...baseProps} ownModes={["@"]} targetHost="row.example.net" />
      ));
      pressAndClick(screen.getByRole("button", { name: /^ban host$/i }));
      await flush();
      expect(mockResolveUserhost).not.toHaveBeenCalled();
      expect(mockPushChannelBan).toHaveBeenCalledWith(42, "#grappa", "*!*@row.example.net");
    });

    it("Kickban bans the CURRENT holder's host FIRST, then kicks — never the row's", async () => {
      mockResolveUserhost.mockResolvedValue({ user: "ident", host: "now.example.net" });
      render(() => (
        <UserContextMenu {...baseProps} ownModes={["@"]} targetHost="row.example.net" />
      ));
      pressAndClick(screen.getByRole("button", { name: /^kickban$/i }));
      await flush();
      expect(mockPushChannelBan).toHaveBeenCalledWith(42, "#grappa", "*!*@now.example.net");
      expect(mockPushChannelKick).toHaveBeenCalledWith(42, "#grappa", "alice", "");
      const [banOrder] = mockPushChannelBan.mock.invocationCallOrder;
      const [kickOrder] = mockPushChannelKick.mock.invocationCallOrder;
      if (banOrder === undefined || kickOrder === undefined) throw new Error("both must fire");
      expect(banOrder).toBeLessThan(kickOrder);
    });

    it("Kickban is disabled for a nick no longer in the channel", () => {
      seedFromTest(channelKey("freenode", "#grappa"), [{ nick: "bob", modes: [] }]);
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      expect(screen.getByRole("button", { name: /^kickban$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^ban host$/i })).not.toBeDisabled();
    });

    it("Query button calls openQueryWindowState and setSelectedChannel", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^query$/i }));
      expect(mockOpenQueryWindowState).toHaveBeenCalledWith(42, "alice", expect.any(String));
      expect(mockSetSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "alice",
        kind: "query",
      });
    });

    it("Encrypted query opens the encrypted window with the nick", async () => {
      render(() => <UserContextMenu {...baseProps} />);
      pressAndClick(screen.getByRole("button", { name: /^encrypted query$/i }));
      expect(mockOpenEncryptedWindow).toHaveBeenCalledWith("freenode", "alice");
    });

    it("CTCP drills into the six verbs instead of acting", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^ctcp ▸$/i }));

      // The whole point of the group: six verbs behind ONE row, so the nick
      // menu does not grow to fourteen.
      for (const verb of ["VERSION", "TIME", "PING", "CLIENTINFO", "USERINFO", "SOURCE"]) {
        expect(
          screen.getByRole("button", { name: new RegExp(`^${verb}$`, "i") }),
        ).not.toBeDisabled();
      }
      expect(mockSendCtcpQuery).not.toHaveBeenCalled();
    });

    it("a CTCP verb dispatches against the SOURCE window, with no invented args", async () => {
      vi.spyOn(Date, "now").mockReturnValue(1706743200000);
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^ctcp ▸$/i }));
      pressAndClick(screen.getByRole("button", { name: /^version$/i }));

      // `sourceChannel` is the window the operator is looking at (#640) and the
      // recipient travels separately — the probe must not mint a query tab.
      // `args: ""` because a menu row has nowhere to type one, and because a
      // BARE ping is what the #637 token-less fallback correlates.
      expect(mockSendCtcpQuery).toHaveBeenCalledWith({
        networkSlug: "freenode",
        networkId: 42,
        sourceChannel: "#grappa",
        targetNick: "alice",
        verb: "VERSION",
        args: "",
        sentAtMs: 1706743200000,
      });
      vi.mocked(Date.now).mockRestore();
    });

    it("PING goes through the same door as every other verb", async () => {
      // No special case at the call site is the point: the seam decides what
      // correlates, off the VERB. A menu that hand-rolled PING here is exactly
      // the drift #1192 moved the ordering into the seam to prevent.
      vi.spyOn(Date, "now").mockReturnValue(1706743200000);
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^ctcp ▸$/i }));
      pressAndClick(screen.getByRole("button", { name: /^ping$/i }));

      expect(mockSendCtcpQuery).toHaveBeenCalledWith({
        networkSlug: "freenode",
        networkId: 42,
        sourceChannel: "#grappa",
        targetNick: "alice",
        verb: "PING",
        args: "",
        sentAtMs: 1706743200000,
      });
      vi.mocked(Date.now).mockRestore();
    });

    it("WHOIS button calls pushWhois with networkId and nick (server null)", async () => {
      render(() => <UserContextMenu {...baseProps} ownModes={["@"]} />);
      pressAndClick(screen.getByRole("button", { name: /^whois$/i }));
      // #198 — context-menu WHOIS is single-nick: null target-server.
      expect(mockPushWhois).toHaveBeenCalledWith(42, "alice", null);
    });
  });

  describe("close behaviour", () => {
    it("calls onClose when backdrop is clicked", async () => {
      const onClose = vi.fn();
      render(() => <UserContextMenu {...baseProps} onClose={onClose} />);
      const backdrop = document.querySelector(".context-menu-backdrop");
      expect(backdrop).toBeInTheDocument();
      if (backdrop) pressAndClick(backdrop);
      expect(onClose).toHaveBeenCalled();
    });

    // #1411 — this used to fire a keydown at `document` and catch the menu's
    // own private listener. That listener is gone: Escape now arrives through
    // the ONE shared ESC stack, so the host-level assertion is that the menu
    // ENROLLED. The full door (real keypress → keybindings → stack, and the
    // drawer that no longer closes with it) is driven in cardEscape.test.tsx.
    it("enrols in the shared ESC stack, and dismisses when it is run", async () => {
      const onClose = vi.fn();
      render(() => <UserContextMenu {...baseProps} onClose={onClose} />);

      expect(overlayEscapeDepth()).toBe(1);
      expect(runTopmostOverlayEscape()).toBe(true);

      expect(onClose).toHaveBeenCalled();
    });
  });
});
