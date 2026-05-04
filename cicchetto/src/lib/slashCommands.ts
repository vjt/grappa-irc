// Pure slash-command parser for cicchetto's compose box.
//
// Discriminated union: callers `switch` on `result.kind` and TypeScript
// narrows to the right field set. Adding a new command kind = one extra
// arm in this module + one extra arm in `compose.ts`'s submit verb (the
// `default: assertNever` makes the addition compile-loud).
//
// Slash escape: a body starting with `//` is a literal privmsg whose
// first character is `/` (mIRC convention — lets you say "/me" without
// the action). Two-slash prefix is consumed; the rest passes through.
//
// Empty / whitespace-only body is a no-op marker (`{kind: "empty"}`)
// so consumers can short-circuit submission without a separate guard.
//
// Unknown commands surface as `{kind: "unknown", verb, rest}` rather
// than throwing — lets the UI render an inline error like "unknown
// command: /whois" without losing what the user typed.
//
// T32 verbs — /quit /disconnect /connect:
//
// `/disconnect [network] [reason]` heuristic: the first whitespace-
// delimited token is ALWAYS treated as the network slug (no state
// lookup, no ambiguity). Bare `/disconnect` (no args) returns
// `network: null` so the handler resolves the active-window's network.
// If the user wants a reason without specifying a network they must use
// `/disconnect <activenet> reason` explicitly. This keeps the parser
// pure (zero state dependency).
//
// S3.4 — /away verb:
//
// `/away :reason` AND `/away reason text` → set (action: "set",
// reason: "..."). The leading `:` is stripped if present (irssi
// convention). Bare `/away` (no args) → unset (action: "unset").
// reason is always a plain string — callers do not need to handle the
// `:` prefix variant after this parser strips it.

export type SlashCommand =
  | { kind: "empty" }
  | { kind: "privmsg"; body: string }
  | { kind: "me"; body: string }
  | { kind: "join"; channel: string }
  | { kind: "part"; channel: string | null; reason: string | null }
  | { kind: "topic"; body: string }
  | { kind: "nick"; nick: string }
  | { kind: "msg"; target: string; body: string }
  | { kind: "quit"; reason: string | null }
  | { kind: "disconnect"; network: string | null; reason: string | null }
  | { kind: "connect"; network: string }
  | { kind: "connect-error"; error: string }
  | { kind: "away"; action: "set"; reason: string }
  | { kind: "away"; action: "unset" }
  | { kind: "unknown"; verb: string; rest: string };

export function parseSlash(input: string): SlashCommand {
  const trimmed = input.trim();
  if (trimmed === "") return { kind: "empty" };

  // Literal-/ escape: //foo → privmsg with body /foo.
  if (trimmed.startsWith("//")) {
    return { kind: "privmsg", body: trimmed.slice(1) };
  }

  if (!trimmed.startsWith("/")) {
    return { kind: "privmsg", body: trimmed };
  }

  // Strip leading /, split on first whitespace into verb + rest.
  const stripped = trimmed.slice(1);
  const spaceIdx = stripped.search(/\s/);
  const verb = spaceIdx === -1 ? stripped : stripped.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : stripped.slice(spaceIdx + 1).trim();

  switch (verb) {
    case "me":
      return { kind: "me", body: rest };
    case "join": {
      // Take first whitespace-delimited token as channel; ignore the rest.
      const [channel] = rest.split(/\s+/);
      if (!channel) return { kind: "unknown", verb, rest };
      return { kind: "join", channel };
    }
    case "part": {
      if (rest === "") return { kind: "part", channel: null, reason: null };
      const sp = rest.search(/\s/);
      if (sp === -1) return { kind: "part", channel: rest, reason: null };
      return {
        kind: "part",
        channel: rest.slice(0, sp),
        reason: rest.slice(sp + 1).trim(),
      };
    }
    case "topic":
      return { kind: "topic", body: rest };
    case "nick": {
      const [nick] = rest.split(/\s+/);
      if (!nick) return { kind: "unknown", verb, rest };
      return { kind: "nick", nick };
    }
    case "msg": {
      const sp = rest.search(/\s/);
      if (sp === -1) return { kind: "unknown", verb, rest };
      return {
        kind: "msg",
        target: rest.slice(0, sp),
        body: rest.slice(sp + 1).trim(),
      };
    }
    case "quit":
      // Nuclear: park all networks + close WS + clear auth + redirect.
      // reason is optional free-text (everything after the verb).
      return { kind: "quit", reason: rest === "" ? null : rest };
    case "disconnect": {
      // Heuristic: first arg is ALWAYS the network slug (see module comment).
      // Bare /disconnect → network: null (handler resolves active-window network).
      if (rest === "") return { kind: "disconnect", network: null, reason: null };
      const sp = rest.search(/\s/);
      if (sp === -1) return { kind: "disconnect", network: rest, reason: null };
      return {
        kind: "disconnect",
        network: rest.slice(0, sp),
        reason: rest.slice(sp + 1).trim(),
      };
    }
    case "connect": {
      // Network arg is required — bare /connect is a parser-level error.
      if (rest === "") return { kind: "connect-error", error: "/connect requires <network>" };
      const [network] = rest.split(/\s+/);
      if (!network) return { kind: "connect-error", error: "/connect requires <network>" };
      return { kind: "connect", network };
    }
    case "away": {
      // Bare /away → unset explicit away status.
      if (rest === "") return { kind: "away", action: "unset" };
      // /away :reason (irssi style) or /away reason — strip leading : if present.
      const reason = rest.startsWith(":") ? rest.slice(1).trim() : rest;
      return { kind: "away", action: "set", reason };
    }
    default:
      return { kind: "unknown", verb, rest };
  }
}
