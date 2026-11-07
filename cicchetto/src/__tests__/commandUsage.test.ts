import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ByKey, keysOf, noKeys } from "../lib/byKey";

// issue 2584 — which commands the `/` menu offers, in which order, and the
// per-subject counts that order is built from. The counts live on the
// server (vjt's ruling, comment 6694918014: synced across devices,
// incremented on send); this store mirrors them and is the one thing that
// talks to `GET`/`POST /me/settings/command-counts` (CLIENT_PROTOCOL.md §8f).

let mockAliases: ByKey<string> = noKeys();
vi.mock("../lib/aliasList", () => ({ aliases: () => mockAliases }));

import { setToken } from "../lib/auth";
import {
  commandCounts,
  countCommand,
  DEFAULT_COMMAND_ORDER,
  rankCommands,
  rankVerbs,
  refreshCommandCounts,
} from "../lib/commandUsage";
import { __resetServerProtocolForTests, setServerProtocol } from "../lib/serverProtocol";
import { BUILTIN_VERBS } from "../lib/slashCommands";

const TOKEN = "command-usage-tok";

const counted = (rec: Record<string, number>) => keysOf(rec);

describe("rankVerbs (issue 2584)", () => {
  const verbs = ["away", "join", "me", "msg", "nick", "part", "query", "quit", "topic", "whois"];

  it("with no counts at all, the order IS the default list (vjt's ruling, Q2)", () => {
    expect(rankVerbs("", 10, noKeys(), verbs)).toEqual([...DEFAULT_COMMAND_ORDER]);
    expect(DEFAULT_COMMAND_ORDER).toEqual([
      "join",
      "msg",
      "me",
      "query",
      "whois",
      "part",
      "nick",
      "away",
      "topic",
      "quit",
    ]);
  });

  it("a verb outside the default list comes after it, alphabetically", () => {
    expect(rankVerbs("", 12, noKeys(), [...verbs, "zline", "ban"])).toEqual([
      ...DEFAULT_COMMAND_ORDER,
      "ban",
      "zline",
    ]);
  });

  it("most used first: a count outranks the default list", () => {
    expect(rankVerbs("", 3, counted({ topic: 2, ban: 1 }), [...verbs, "ban"])).toEqual([
      "topic",
      "ban",
      "join",
    ]);
  });

  it("equal counts fall back to the default list, then to the alphabet", () => {
    const counts = counted({ whois: 3, join: 3, zline: 3, ban: 3 });
    expect(rankVerbs("", 4, counts, [...verbs, "zline", "ban"])).toEqual([
      "join",
      "whois",
      "ban",
      "zline",
    ]);
  });

  it("filters by prefix, case-insensitively", () => {
    const all = ["who", "whois", "whowas", "join"];
    expect(rankVerbs("wh", 10, noKeys(), all)).toEqual(["whois", "who", "whowas"]);
    expect(rankVerbs("WH", 10, noKeys(), all)).toEqual(["whois", "who", "whowas"]);
    expect(rankVerbs("x", 10, noKeys(), all)).toEqual([]);
  });

  it("shows at most `limit` entries", () => {
    expect(rankVerbs("", 5, noKeys(), verbs)).toEqual(["join", "msg", "me", "query", "whois"]);
    expect(rankVerbs("", 1, noKeys(), verbs)).toEqual(["join"]);
  });

  it("a verb is offered once however many sources name it", () => {
    expect(rankVerbs("j", 10, noKeys(), ["join", "j", "join"])).toEqual(["join", "j"]);
  });

  it("a count for a verb that is no longer a candidate is not offered", () => {
    expect(rankVerbs("", 10, counted({ gone: 50 }), ["join"])).toEqual(["join"]);
  });
});

describe("rankCommands (issue 2584)", () => {
  afterEach(() => {
    mockAliases = noKeys();
  });

  it("offers every builtin verb", () => {
    expect(rankCommands("", 1000)).toEqual(expect.arrayContaining([...BUILTIN_VERBS]));
    expect(rankCommands("", 1000)).toHaveLength(BUILTIN_VERBS.length);
  });

  it("offers the user's aliases beside the builtins, an alias shadowing a builtin once", () => {
    mockAliases = keysOf({ wii: "whois $1 $1", join: "whois" });
    const all = rankCommands("", 1000);
    expect(all).toContain("wii");
    expect(all.filter((v) => v === "join")).toEqual(["join"]);
    expect(all).toHaveLength(BUILTIN_VERBS.length + 1);
  });
});

describe("command counts store (issue 2584)", () => {
  beforeEach(() => {
    setToken(TOKEN);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetServerProtocolForTests();
    setToken(null);
  });

  const respond = (body: unknown, status = 200) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it("hydrates from GET on a server that counts (v61+)", async () => {
    setServerProtocol(61);
    const spy = respond({ command_counts: { whois: 4, j: 1 } });

    await refreshCommandCounts();

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/me/settings/command-counts");
    expect(init.method ?? "GET").toBe("GET");
    expect(commandCounts()).toEqual({ whois: 4, j: 1 });
    expect(rankCommands("", 2)).toEqual(["whois", "j"]);
  });

  // CLIENT_PROTOCOL.md §8f — below v61 the GET answers the SPA page with
  // 200 text/html, so a 404 never says "no route": the number does.
  it.each([60, null])("asks nothing of a server at protocol %s", async (version) => {
    if (version !== null) setServerProtocol(version);
    const spy = vi.spyOn(globalThis, "fetch");

    await refreshCommandCounts();
    countCommand("whois");

    expect(spy).not.toHaveBeenCalled();
  });

  it("posts the verb and nothing else, and mirrors the map the server answers", async () => {
    setServerProtocol(61);
    const spy = respond({ command_counts: { ns: 1 } });

    countCommand("ns");
    await vi.waitFor(() => expect(commandCounts()).toEqual({ ns: 1 }));

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/me/settings/command-counts");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"verb":"ns"}');
  });

  it("a refused count is lost, logged, and never thrown at the sender", async () => {
    setServerProtocol(61);
    respond({ command_counts: { whois: 2 } });
    await refreshCommandCounts();
    vi.restoreAllMocks();
    respond({ error: "rate_limited" }, 429);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => countCommand("whois")).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));

    expect(commandCounts()).toEqual({ whois: 2 });
  });

  it("posts nothing without a session", () => {
    setServerProtocol(61);
    setToken(null);
    const spy = vi.spyOn(globalThis, "fetch");

    countCommand("whois");

    expect(spy).not.toHaveBeenCalled();
  });

  it("an account switch empties the mirror; the next join hydrates the new account", async () => {
    setServerProtocol(61);
    respond({ command_counts: { whois: 9 } });
    await refreshCommandCounts();
    expect(commandCounts()).toEqual({ whois: 9 });

    setToken("another-account");

    expect(commandCounts()).toEqual({});
  });
});
