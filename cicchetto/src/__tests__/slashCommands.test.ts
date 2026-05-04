import { describe, expect, it } from "vitest";
import { parseSlash } from "../lib/slashCommands";

describe("parseSlash", () => {
  it("non-slash body parses as privmsg", () => {
    expect(parseSlash("hello world")).toEqual({ kind: "privmsg", body: "hello world" });
  });

  it("/me <action>", () => {
    expect(parseSlash("/me waves")).toEqual({ kind: "me", body: "waves" });
  });

  it("/join <channel>", () => {
    expect(parseSlash("/join #grappa")).toEqual({ kind: "join", channel: "#grappa" });
  });

  it("/part with explicit channel", () => {
    expect(parseSlash("/part #grappa")).toEqual({
      kind: "part",
      channel: "#grappa",
      reason: null,
    });
  });

  it("/part with no args parses as part-current (channel: null)", () => {
    expect(parseSlash("/part")).toEqual({
      kind: "part",
      channel: null,
      reason: null,
    });
  });

  it("/part with reason", () => {
    expect(parseSlash("/part #grappa byebye")).toEqual({
      kind: "part",
      channel: "#grappa",
      reason: "byebye",
    });
  });

  it("/topic <body>", () => {
    expect(parseSlash("/topic ciao mondo")).toEqual({
      kind: "topic",
      body: "ciao mondo",
    });
  });

  it("/nick <new>", () => {
    expect(parseSlash("/nick vjt-away")).toEqual({ kind: "nick", nick: "vjt-away" });
  });

  it("/msg <target> <body>", () => {
    expect(parseSlash("/msg alice ciao!")).toEqual({
      kind: "msg",
      target: "alice",
      body: "ciao!",
    });
  });

  it("/msg with body containing spaces preserved", () => {
    expect(parseSlash("/msg #italia ciao a tutti")).toEqual({
      kind: "msg",
      target: "#italia",
      body: "ciao a tutti",
    });
  });

  it("unknown slash command is parsed as :unknown with the original verb", () => {
    expect(parseSlash("/whois alice")).toEqual({ kind: "unknown", verb: "whois", rest: "alice" });
  });

  it("empty body is :empty", () => {
    expect(parseSlash("")).toEqual({ kind: "empty" });
    expect(parseSlash("  ")).toEqual({ kind: "empty" });
  });

  it("body starting with // is a literal privmsg starting with /", () => {
    expect(parseSlash("//me literal")).toEqual({ kind: "privmsg", body: "/me literal" });
  });
});

// T32 verbs: /quit /disconnect /connect
//
// /quit — nuclear: park ALL networks + close WS + clear auth + redirect to login.
//   Parser output: reason is optional free-text (everything after the verb).
//   Handler (in compose.ts) carries out the nuclear flow — parser is pure.
//
// /disconnect — surgical per-network.
//   First arg is ALWAYS treated as the network slug (not a reason), per the
//   deterministic heuristic chosen here: parser never does state lookups, so
//   it cannot distinguish a slug from a reason word. Bare /disconnect
//   (no args) returns network: null — the handler resolves to the
//   active-window's network. This keeps the parser pure (no window-state
//   dependency). If the user wants a reason without specifying a network
//   they must use `/disconnect <activenet> my reason` explicitly.
//
// /connect — requires a named network arg. Bare /connect is a parser-level
//   error (surfaces as {kind: "connect-error", error: "..."}) so the handler
//   can render the error inline without making an empty API call.
describe("parseSlash — T32 verbs", () => {
  it("/quit bare → reason: null", () => {
    expect(parseSlash("/quit")).toEqual({ kind: "quit", reason: null });
  });

  it("/quit with reason text → reason: string", () => {
    expect(parseSlash("/quit going offline")).toEqual({
      kind: "quit",
      reason: "going offline",
    });
  });

  it("/disconnect bare → network: null, reason: null (handler resolves active-window network)", () => {
    expect(parseSlash("/disconnect")).toEqual({
      kind: "disconnect",
      network: null,
      reason: null,
    });
  });

  it("/disconnect <netslug> → network: slug, reason: null (first arg always treated as network slug)", () => {
    // Heuristic: first arg is ALWAYS the network slug. Bare slug, no # prefix.
    expect(parseSlash("/disconnect libera")).toEqual({
      kind: "disconnect",
      network: "libera",
      reason: null,
    });
  });

  it("/disconnect <netslug> <reason...> → network: slug, reason: rest of args", () => {
    expect(parseSlash("/disconnect libera going offline now")).toEqual({
      kind: "disconnect",
      network: "libera",
      reason: "going offline now",
    });
  });

  it("/connect <netslug> → network: slug", () => {
    expect(parseSlash("/connect libera")).toEqual({ kind: "connect", network: "libera" });
  });

  it("/connect bare → error (network arg required)", () => {
    const result = parseSlash("/connect");
    expect(result).toMatchObject({
      kind: "connect-error",
      error: expect.stringContaining("requires"),
    });
  });
});

// S3.4 — /away verb
describe("parseSlash — /away", () => {
  it("/away bare → unset explicit away", () => {
    expect(parseSlash("/away")).toEqual({ kind: "away", action: "unset" });
  });

  it("/away <reason text> → set with reason", () => {
    expect(parseSlash("/away brb coffee")).toEqual({
      kind: "away",
      action: "set",
      reason: "brb coffee",
    });
  });

  it("/away :reason (irssi-style colon prefix) → strips leading colon", () => {
    expect(parseSlash("/away :gone fishing")).toEqual({
      kind: "away",
      action: "set",
      reason: "gone fishing",
    });
  });

  it("/away : (bare colon, no text) → set with empty string reason", () => {
    // A bare colon is an irssi artifact; the stripped reason is empty string.
    // The server-side guard (safe_line_token?) will accept empty string;
    // upstream IRC drops empty AWAY bodies to bare AWAY semantics.
    expect(parseSlash("/away :")).toEqual({
      kind: "away",
      action: "set",
      reason: "",
    });
  });

  it("/away    (only whitespace after verb) → unset (empty rest)", () => {
    // Extra whitespace is trimmed before the rest check.
    expect(parseSlash("/away   ")).toEqual({ kind: "away", action: "unset" });
  });
});
