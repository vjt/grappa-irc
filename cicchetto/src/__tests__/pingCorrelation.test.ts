import { describe, expect, it } from "vitest";
import { channelKey } from "../lib/channelKey";
import {
  PENDING_TTL_MS,
  registerCtcpQuery,
  registerPing,
  resolveCtcpReply,
  resolvePing,
} from "../lib/pingCorrelation";

// #591 — the /ping reply-correlation table. Pure register/resolve with time
// passed in explicitly (sentAtMs at register, nowMs at resolve) so the RTT
// math is testable WITHOUT touching the wall clock (spec requirement). Tests
// use distinct (network, nick, token) triples so the shared identity-scoped
// store can't cross-contaminate. sourceKey is a branded ChannelKey built via
// channelKey(slug, name) (the SSOT encoder), never a hand-spelled string.
describe("pingCorrelation", () => {
  it("resolves a matching ping with the RTT delta and source window", () => {
    registerPing(1, "bob", "tok-a", channelKey("freenode", "#chan"), "#chan", 1000);

    expect(resolvePing(1, "bob", "tok-a", 1042)).toEqual({
      sourceKey: channelKey("freenode", "#chan"),
      sourceChannel: "#chan",
      rttMs: 42,
    });
  });

  it("returns null when nothing matches", () => {
    expect(resolvePing(1, "nobody", "tok-none", 5000)).toBeNull();
  });

  it("folds the nick (CASEMAPPING=ascii) — register Bob, resolve bob", () => {
    registerPing(1, "Bob", "tok-b", channelKey("freenode", "#room"), "#room", 2000);

    expect(resolvePing(1, "bob", "tok-b", 2100)).toEqual({
      sourceKey: channelKey("freenode", "#room"),
      sourceChannel: "#room",
      rttMs: 100,
    });
  });

  it("is one-shot: a second resolve of the same reply is null", () => {
    registerPing(1, "carol", "tok-c", channelKey("freenode", "carol"), "carol", 3000);

    expect(resolvePing(1, "carol", "tok-c", 3050)).not.toBeNull();
    expect(resolvePing(1, "carol", "tok-c", 3060)).toBeNull();
  });

  it("does not match across networks or NON-EMPTY tokens", () => {
    registerPing(1, "dave", "tok-d", channelKey("freenode", "dave"), "dave", 4000);

    // Wrong network id.
    expect(resolvePing(2, "dave", "tok-d", 4010)).toBeNull();
    // Wrong (but present) token still misses — the token invariant holds for a
    // well-behaved peer; only a TOKEN-LESS reply falls back (see #637 below).
    expect(resolvePing(1, "dave", "tok-other", 4010)).toBeNull();
    // The real one still resolves.
    expect(resolvePing(1, "dave", "tok-d", 4010)).not.toBeNull();
  });

  // #637 — Azzurra services (NickServ) echo a CTCP PING as a BARE `\x01PING\x01`,
  // dropping the token, so grappa hands cic an EMPTY ctcp_args. A token-less
  // reply must still correlate: fall back to the most-recent pending ping to
  // that (network, folded-nick).
  it("resolves a TOKEN-LESS reply against the most-recent pending ping to that nick (#637)", () => {
    registerPing(1, "NickServ", "1706743200000", channelKey("azzurra", "#bofh"), "#bofh", 7000);

    // Reply carries no token (empty string), sender folds to the same nick.
    expect(resolvePing(1, "nickserv", "", 7050)).toEqual({
      sourceKey: channelKey("azzurra", "#bofh"),
      sourceChannel: "#bofh",
      rttMs: 50,
    });
    // One-shot: the fallback deleted it.
    expect(resolvePing(1, "nickserv", "", 7060)).toBeNull();
  });

  it("token-less fallback picks the MOST-RECENT ping to the same nick", () => {
    registerPing(1, "helpserv", "t-old", channelKey("azzurra", "helpserv"), "helpserv", 8000);
    registerPing(1, "helpserv", "t-new", channelKey("azzurra", "#ops"), "#ops", 8500);

    // Token-less reply resolves the newer entry (source = #ops, rtt from 8500).
    expect(resolvePing(1, "helpserv", "", 8600)).toEqual({
      sourceKey: channelKey("azzurra", "#ops"),
      sourceChannel: "#ops",
      rttMs: 100,
    });
    // The older entry survives (a second token-less reply resolves it).
    expect(resolvePing(1, "helpserv", "", 8700)).toEqual({
      sourceKey: channelKey("azzurra", "helpserv"),
      sourceChannel: "helpserv",
      rttMs: 700,
    });
  });

  it("token-less fallback is nick-scoped — cannot claim another nick's pending entry", () => {
    registerPing(1, "chanserv", "t-cs", channelKey("azzurra", "#bofh"), "#bofh", 9000);

    // A token-less reply from a DIFFERENT nick we never pinged matches nothing.
    expect(resolvePing(1, "operserv", "", 9100)).toBeNull();
    // The real target's own token-less reply still resolves.
    expect(resolvePing(1, "chanserv", "", 9100)).not.toBeNull();
  });

  // #637 — the leak guard. Pre-fix the pending entry was one-shot but cleared
  // ONLY by a matching reply or an identity change, so every unmatched /ping (a
  // service that never echoes CTCP PING, a typo'd nick, a reply lost to a
  // netsplit) left an inert entry behind until logout — an unbounded growth
  // path. registerPing now sweeps entries older than PENDING_TTL_MS, using the
  // caller-supplied sentAtMs (no wall clock in this module — the spec).
  it("sweeps a stale pending entry on the next register (leak guard)", () => {
    registerPing(1, "eve", "tok-e1", channelKey("freenode", "eve"), "eve", 5000);

    // A later /ping registered exactly at the TTL horizon evicts the stale one.
    registerPing(
      1,
      "frank",
      "tok-f1",
      channelKey("freenode", "frank"),
      "frank",
      5000 + PENDING_TTL_MS,
    );

    // The stale entry's reply can no longer be correlated (it was swept).
    expect(resolvePing(1, "eve", "tok-e1", 5000 + PENDING_TTL_MS + 10)).toBeNull();
    // The fresh one still resolves.
    expect(resolvePing(1, "frank", "tok-f1", 5000 + PENDING_TTL_MS + 20)).not.toBeNull();
  });

  it("keeps a pending entry still within the TTL horizon on a later register", () => {
    registerPing(1, "grace", "tok-g1", channelKey("freenode", "grace"), "grace", 6000);

    // A second register ONE ms inside the horizon must NOT evict the first.
    registerPing(
      1,
      "heidi",
      "tok-h1",
      channelKey("freenode", "heidi"),
      "heidi",
      6000 + PENDING_TTL_MS - 1,
    );

    expect(resolvePing(1, "grace", "tok-g1", 6000 + PENDING_TTL_MS)).not.toBeNull();
  });
});

// #719 — the VERB-keyed sibling table. A non-PING CTCP reply echoes no token,
// so the only thing that can attribute it back to the question is the verb the
// question asked. Same store, same TTL, same one-shot resolve; it returns no
// RTT because there is no token to time against and the reply renders as the
// answer it is, not as a round trip.
describe("pingCorrelation — CTCP query correlation (#719)", () => {
  it("resolves a non-PING reply to the window the query was sent from", () => {
    registerCtcpQuery(1, "bob", "VERSION", channelKey("freenode", "#chan"), "#chan", 1000);

    expect(resolveCtcpReply(1, "bob", "VERSION")).toEqual({
      sourceKey: channelKey("freenode", "#chan"),
      sourceChannel: "#chan",
    });
  });

  it("returns null when nothing matches", () => {
    expect(resolveCtcpReply(1, "nobody", "VERSION")).toBeNull();
  });

  it("folds the nick (CASEMAPPING=ascii) — ask Bob, resolve bob", () => {
    registerCtcpQuery(1, "Bob", "TIME", channelKey("freenode", "#room"), "#room", 2000);

    expect(resolveCtcpReply(1, "bob", "TIME")).toEqual({
      sourceKey: channelKey("freenode", "#room"),
      sourceChannel: "#room",
    });
  });

  // The verb reaches the table from two directions — a parser that upper-cases
  // and a menu literal on the way in, a peer's own spelling on the way back.
  // Neither end controls the other's case, so both fold.
  it("folds the verb — register lower-case, resolve upper-case and back", () => {
    registerCtcpQuery(1, "carol", "version", channelKey("freenode", "carol"), "carol", 3000);
    expect(resolveCtcpReply(1, "carol", "VERSION")).not.toBeNull();

    registerCtcpQuery(1, "carol", "USERINFO", channelKey("freenode", "carol"), "carol", 3100);
    expect(resolveCtcpReply(1, "carol", "userinfo")).not.toBeNull();
  });

  it("is one-shot: a second reply to the same query is null", () => {
    registerCtcpQuery(1, "dave", "SOURCE", channelKey("freenode", "dave"), "dave", 4000);

    expect(resolveCtcpReply(1, "dave", "SOURCE")).not.toBeNull();
    expect(resolveCtcpReply(1, "dave", "SOURCE")).toBeNull();
  });

  // The whole point of keying on the verb: a peer answering a question we did
  // not ask must not be able to claim a window. Otherwise an unsolicited probe
  // reply would be filed into whatever conversation happened to have an entry.
  it("does not match across networks, nicks, or verbs", () => {
    registerCtcpQuery(1, "eve", "CLIENTINFO", channelKey("freenode", "#ops"), "#ops", 5000);

    expect(resolveCtcpReply(2, "eve", "CLIENTINFO")).toBeNull();
    expect(resolveCtcpReply(1, "mallory", "CLIENTINFO")).toBeNull();
    expect(resolveCtcpReply(1, "eve", "TIME")).toBeNull();
    expect(resolveCtcpReply(1, "eve", "CLIENTINFO")).not.toBeNull();
  });

  // Two tables, not one map with a three-part key: a PING token is opaque
  // operator-supplied text and could BE a verb. Sharing one map would let
  // `/ping frank VERSION` be claimed by frank's VERSION reply, filing an RTT
  // question's answer under the wrong entry. Pinned in both directions.
  it("cannot cross-claim between the token table and the verb table", () => {
    registerPing(1, "frank", "VERSION", channelKey("freenode", "#a"), "#a", 6000);
    registerCtcpQuery(1, "grace", "TIME", channelKey("freenode", "#b"), "#b", 6000);

    // A VERSION reply must not eat frank's pending ping whose TOKEN is "VERSION".
    expect(resolveCtcpReply(1, "frank", "VERSION")).toBeNull();
    // A PING reply carrying the token "TIME" must not eat grace's TIME query.
    expect(resolvePing(1, "grace", "TIME", 6050)).toBeNull();
    // Both originals survive untouched.
    expect(resolvePing(1, "frank", "VERSION", 6050)).not.toBeNull();
    expect(resolveCtcpReply(1, "grace", "TIME")).not.toBeNull();
  });

  // Same leak guard as the ping table, and it must work ACROSS the two: a
  // session that only ever runs /ctcp would otherwise never sweep the ping
  // table, and vice versa. The bound is "queries issued in the last TTL",
  // whichever door they came through.
  it("sweeps stale entries in BOTH tables on either register (leak guard)", () => {
    registerPing(1, "ivan", "tok-i", channelKey("freenode", "ivan"), "ivan", 7000);
    registerCtcpQuery(1, "judy", "FINGER", channelKey("freenode", "judy"), "judy", 7000);

    // A CTCP query at the horizon must evict the stale entry in EITHER table.
    registerCtcpQuery(
      1,
      "ken",
      "TIME",
      channelKey("freenode", "ken"),
      "ken",
      7000 + PENDING_TTL_MS,
    );

    expect(resolvePing(1, "ivan", "tok-i", 7000 + PENDING_TTL_MS + 10)).toBeNull();
    expect(resolveCtcpReply(1, "judy", "FINGER")).toBeNull();
    expect(resolveCtcpReply(1, "ken", "TIME")).not.toBeNull();
  });

  it("keeps an entry still within the TTL horizon on a later register", () => {
    registerCtcpQuery(1, "laura", "SOURCE", channelKey("freenode", "laura"), "laura", 8000);

    registerCtcpQuery(
      1,
      "mike",
      "TIME",
      channelKey("freenode", "mike"),
      "mike",
      8000 + PENDING_TTL_MS - 1,
    );

    expect(resolveCtcpReply(1, "laura", "SOURCE")).not.toBeNull();
  });
});
