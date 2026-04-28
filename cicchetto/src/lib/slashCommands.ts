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

export type SlashCommand =
  | { kind: "empty" }
  | { kind: "privmsg"; body: string }
  | { kind: "me"; body: string }
  | { kind: "join"; channel: string }
  | { kind: "part"; channel: string | null; reason: string | null }
  | { kind: "topic"; body: string }
  | { kind: "nick"; nick: string }
  | { kind: "msg"; target: string; body: string }
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
    default:
      return { kind: "unknown", verb, rest };
  }
}
