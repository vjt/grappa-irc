import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAlias, aliases, delAlias, editAlias, refreshAliases } from "../lib/aliasList";
import { setToken } from "../lib/auth";

// #385 — aliasList store. The compose expander reads its alias map from this
// store, so the store's server-mirroring behaviour is load-bearing:
//   * refreshAliases hydrates the signal from GET — the mechanism the
//     userTopic-join hydration relies on so a persisted alias works after a
//     page reload (without opening the settings sub-page first).
//   * add/del do a fresh-read-before-write against the SERVER map, so a stale
//     local mirror never clobbers sibling aliases, and the merge key is
//     lowercased (names are case-insensitive).

const TOKEN = "alias-store-tok";

function mockFetchSequence(responses: Array<Record<string, unknown>>) {
  const spy = vi.spyOn(globalThis, "fetch");
  for (const r of responses) {
    spy.mockResolvedValueOnce(new Response(JSON.stringify(r), { status: 200 }));
  }
  return spy;
}

beforeEach(() => {
  setToken(TOKEN);
});

afterEach(() => {
  vi.restoreAllMocks();
  setToken(null);
});

describe("aliasList store — #385", () => {
  it("refreshAliases hydrates the signal from GET (the reload-hydration fix)", async () => {
    mockFetchSequence([{ aliases: { wii: "whois $1 $1" } }]);
    const map = await refreshAliases();
    expect(map).toEqual({ wii: "whois $1 $1" });
    expect(aliases()).toEqual({ wii: "whois $1 $1" });
  });

  it("addAlias fresh-reads the server map then PUTs the merge (no sibling clobber)", async () => {
    const spy = mockFetchSequence([
      { aliases: { a: "join $*" } }, // GET — the server's current map
      { aliases: { a: "join $*", wii: "whois $1 $1" } }, // PUT echo (normalized)
    ]);

    const map = await addAlias("wii", "whois $1 $1");
    expect(map).toEqual({ a: "join $*", wii: "whois $1 $1" });
    expect(aliases()).toEqual({ a: "join $*", wii: "whois $1 $1" });

    // The PUT body carried BOTH the pre-existing alias AND the new one —
    // proving fresh-read-before-write did not clobber the sibling.
    const [, init] = spy.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      aliases: { a: "join $*", wii: "whois $1 $1" },
    });
  });

  it("addAlias lowercases the merge key (case-insensitive names)", async () => {
    const spy = mockFetchSequence([
      { aliases: { wii: "old" } }, // GET
      { aliases: { wii: "whois $1 $1" } }, // PUT echo
    ]);

    await addAlias("WII", "whois $1 $1");

    // Merged under the lowercase key — overwrites, not a second `WII` key.
    const [, init] = spy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ aliases: { wii: "whois $1 $1" } });
  });

  // #409 — in-place edit. One fresh-read-then-PUT (same discipline as add/del),
  // rename-aware: drop the old key, set the new one, PUT the whole map.
  it("editAlias renames (drops old key, sets new) in ONE PUT, siblings preserved", async () => {
    const spy = mockFetchSequence([
      { aliases: { wii: "whois $1 $1", a: "join $*" } }, // GET — current server map
      { aliases: { w: "whois $1", a: "join $*" } }, // PUT echo (normalized)
    ]);

    const map = await editAlias("wii", "w", "whois $1");
    expect(map).toEqual({ w: "whois $1", a: "join $*" });
    expect(aliases()).toEqual({ w: "whois $1", a: "join $*" });

    // The PUT dropped `wii`, added `w`, and kept the sibling `a`.
    const [, init] = spy.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      aliases: { w: "whois $1", a: "join $*" },
    });
  });

  // issue 2453 — an alias name is the user's to choose, and `constructor` and
  // `__proto__` are valid ones; "bob" runs first as the control.
  it.each(["bob", "constructor", "__proto__"])(
    "editAlias renames an alias to %s in the PUT, siblings preserved",
    async (name) => {
      const spy = mockFetchSequence([
        { aliases: { wii: "whois $1 $1", a: "join $*" } }, // GET
        { aliases: { a: "join $*", [name]: "whois $1" } }, // PUT echo
      ]);

      await editAlias("wii", name, "whois $1");

      const [, init] = spy.mock.calls[1] as [string, RequestInit];
      const sent = JSON.parse(init.body as string) as { aliases: Record<string, string> };
      expect(Object.entries(sent.aliases)).toEqual([
        ["a", "join $*"],
        [name, "whois $1"],
      ]);
    },
  );

  it("editAlias with an unchanged name overwrites the expansion (no duplicate key)", async () => {
    const spy = mockFetchSequence([
      { aliases: { wii: "old", a: "join $*" } }, // GET
      { aliases: { wii: "whois $1 $1", a: "join $*" } }, // PUT echo
    ]);

    await editAlias("wii", "wii", "whois $1 $1");

    const [, init] = spy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      aliases: { wii: "whois $1 $1", a: "join $*" },
    });
  });

  it("editAlias lowercases BOTH the old and new keys (case-insensitive names)", async () => {
    const spy = mockFetchSequence([
      { aliases: { wii: "old" } }, // GET
      { aliases: { w: "whois $1" } }, // PUT echo
    ]);

    // Old typed as `WII`, new typed as `W` — both fold to lowercase so the old
    // key is actually dropped and the new key is not a stray uppercase dupe.
    await editAlias("WII", "W", "whois $1");

    const [, init] = spy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ aliases: { w: "whois $1" } });
  });

  it("delAlias fresh-reads then PUTs the map without the removed key", async () => {
    const spy = mockFetchSequence([
      { aliases: { wii: "whois $1 $1", a: "join $*" } }, // GET
      { aliases: { a: "join $*" } }, // PUT echo
    ]);

    const map = await delAlias("WII");
    expect(map).toEqual({ a: "join $*" });

    const [, init] = spy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ aliases: { a: "join $*" } });
  });
});
