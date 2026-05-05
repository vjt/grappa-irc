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
// Unknown commands and validation failures surface as `{kind: "error",
// verb, message}` so the UI can render an inline error like
// "unknown command: /whois" without losing what the user typed.
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
//
// /topic verb branches:
//   - `/topic`         → topic-show (render cached topic inline)
//   - `/topic -delete` → topic-clear (irssi convention for unsetting topic)
//   - `/topic <text>`  → topic-set (set channel topic to text)
//
// Aliases:
//   - `/q` == `/query` (both produce {kind: "query"})
//   - `/watch` == `/highlight` (both produce {kind: "watchlist"})
//
// /watch /highlight subverbs: `add <pattern>` / `del <pattern>` / `list`.
// Server-side /user_settings API is not yet implemented — handlers in
// compose.ts emit inline "not yet implemented" errors as TODO stubs.

export type SlashCommand =
  | { kind: "empty" }
  | { kind: "privmsg"; body: string }
  | { kind: "me"; body: string }
  | { kind: "join"; channel: string }
  | { kind: "part"; channel: string | null; reason: string | null }
  | { kind: "topic-show" }
  | { kind: "topic-set"; text: string }
  | { kind: "topic-clear" }
  | { kind: "nick"; nick: string }
  | { kind: "msg"; target: string; body: string }
  | { kind: "query"; target: string }
  | { kind: "quit"; reason: string | null }
  | { kind: "disconnect"; network: string | null; reason: string | null }
  | { kind: "connect"; network: string }
  | { kind: "away"; action: "set"; reason: string }
  | { kind: "away"; action: "unset" }
  | { kind: "op"; nicks: string[] }
  | { kind: "deop"; nicks: string[] }
  | { kind: "voice"; nicks: string[] }
  | { kind: "devoice"; nicks: string[] }
  | { kind: "kick"; nick: string; reason: string }
  | { kind: "ban"; mask: string }
  | { kind: "unban"; mask: string }
  | { kind: "banlist" }
  | { kind: "invite"; nick: string; channel: string | null }
  | { kind: "umode"; modes: string }
  | { kind: "mode"; target: string; modes: string; params: string[] }
  | { kind: "who"; target: string | null }
  | { kind: "names"; target: string | null }
  | { kind: "list"; pattern: string | null }
  | { kind: "links"; pattern: string | null }
  | { kind: "watchlist"; action: "add"; pattern: string }
  | { kind: "watchlist"; action: "del"; pattern: string }
  | { kind: "watchlist"; action: "list" }
  | { kind: "error"; verb: string; message: string };

function err(verb: string, message: string): SlashCommand {
  return { kind: "error", verb, message };
}

// Parse a list of whitespace-delimited tokens from `rest`.
function tokens(rest: string): string[] {
  return rest === "" ? [] : rest.split(/\s+/).filter((t) => t.length > 0);
}

// Parse nicks-requiring ops verbs (/op /deop /voice /devoice).
function parseNicksVerb(verb: string, rest: string): SlashCommand {
  const nicks = tokens(rest);
  if (nicks.length === 0) return err(verb, `/${verb} requires at least one nick`);
  return { kind: verb as "op" | "deop" | "voice" | "devoice", nicks };
}

// Parse /watch and /highlight (alias) — same output shape.
function parseWatchlist(verb: string, rest: string): SlashCommand {
  const toks = tokens(rest);
  if (toks.length === 0)
    return err(verb, `/${verb} requires a subverb: add <pattern> | del <pattern> | list`);
  const subverb = toks[0];
  if (subverb === "list") {
    return { kind: "watchlist", action: "list" };
  }
  if (subverb === "add") {
    if (toks.length < 2) return err(verb, `/${verb} add requires a pattern`);
    return { kind: "watchlist", action: "add", pattern: toks.slice(1).join(" ") };
  }
  if (subverb === "del") {
    if (toks.length < 2) return err(verb, `/${verb} del requires a pattern`);
    return { kind: "watchlist", action: "del", pattern: toks.slice(1).join(" ") };
  }
  return err(
    verb,
    `/${verb} unknown subverb '${subverb}' — use: add <pattern> | del <pattern> | list`,
  );
}

// Dispatch table: verb (lowercased) → handler(verb, rest) → SlashCommand.
// Every registered verb must appear here; unknown verbs produce {kind: "error"}.
type Handler = (verb: string, rest: string) => SlashCommand;

const DISPATCH: Readonly<Record<string, Handler>> = {
  me: (_verb, rest) => ({ kind: "me", body: rest }),

  join: (verb, rest) => {
    const [channel] = tokens(rest);
    if (!channel) return err(verb, "/join requires a channel name");
    return { kind: "join", channel };
  },

  part: (_verb, rest) => {
    if (rest === "") return { kind: "part", channel: null, reason: null };
    const sp = rest.search(/\s/);
    if (sp === -1) return { kind: "part", channel: rest, reason: null };
    return { kind: "part", channel: rest.slice(0, sp), reason: rest.slice(sp + 1).trim() };
  },

  topic: (_verb, rest) => {
    if (rest === "") return { kind: "topic-show" };
    if (rest.trim() === "-delete") return { kind: "topic-clear" };
    return { kind: "topic-set", text: rest };
  },

  nick: (verb, rest) => {
    const [nick] = tokens(rest);
    if (!nick) return err(verb, "/nick requires a new nick");
    return { kind: "nick", nick };
  },

  msg: (verb, rest) => {
    const sp = rest.search(/\s/);
    if (sp === -1 || sp === 0) {
      if (rest === "") return err(verb, "/msg requires <nick> <text>");
      return err(verb, "/msg requires message text after nick");
    }
    const target = rest.slice(0, sp);
    const body = rest.slice(sp + 1).trim();
    if (body === "") return err(verb, "/msg requires message text after nick");
    return { kind: "msg", target, body };
  },

  query: (verb, rest) => {
    const [target] = tokens(rest);
    if (!target) return err(verb, `/${verb} requires a nick`);
    return { kind: "query", target };
  },

  // /q is an alias for /query — registered as separate key below.

  quit: (_verb, rest) => ({ kind: "quit", reason: rest === "" ? null : rest }),

  disconnect: (_verb, rest) => {
    if (rest === "") return { kind: "disconnect", network: null, reason: null };
    const sp = rest.search(/\s/);
    if (sp === -1) return { kind: "disconnect", network: rest, reason: null };
    return {
      kind: "disconnect",
      network: rest.slice(0, sp),
      reason: rest.slice(sp + 1).trim(),
    };
  },

  connect: (verb, rest) => {
    const [network] = tokens(rest);
    if (!network) return err(verb, "/connect requires a network slug");
    return { kind: "connect", network };
  },

  away: (_verb, rest) => {
    if (rest === "") return { kind: "away", action: "unset" };
    const reason = rest.startsWith(":") ? rest.slice(1).trim() : rest;
    return { kind: "away", action: "set", reason };
  },

  op: (verb, rest) => parseNicksVerb(verb, rest),
  deop: (verb, rest) => parseNicksVerb(verb, rest),
  voice: (verb, rest) => parseNicksVerb(verb, rest),
  devoice: (verb, rest) => parseNicksVerb(verb, rest),

  kick: (verb, rest) => {
    const sp = rest.search(/\s/);
    if (rest === "") return err(verb, "/kick requires a nick");
    const nick = sp === -1 ? rest : rest.slice(0, sp);
    const reason = sp === -1 ? "" : rest.slice(sp + 1).trim();
    return { kind: "kick", nick, reason };
  },

  ban: (verb, rest) => {
    const [mask] = tokens(rest);
    if (!mask) return err(verb, "/ban requires a nick or mask");
    return { kind: "ban", mask };
  },

  unban: (verb, rest) => {
    const [mask] = tokens(rest);
    if (!mask) return err(verb, "/unban requires a mask");
    return { kind: "unban", mask };
  },

  banlist: (_verb, _rest) => ({ kind: "banlist" }),

  invite: (verb, rest) => {
    const toks = tokens(rest);
    if (toks.length === 0) return err(verb, "/invite requires a nick");
    const nick = toks[0] as string;
    const channel = toks[1] ?? null;
    return { kind: "invite", nick, channel };
  },

  umode: (verb, rest) => {
    if (rest === "") return err(verb, "/umode requires mode string (e.g. +i)");
    return { kind: "umode", modes: rest };
  },

  mode: (verb, rest) => {
    const toks = tokens(rest);
    if (toks.length === 0) return err(verb, "/mode requires a target");
    if (toks.length < 2) return err(verb, "/mode requires target and mode string");
    const target = toks[0] as string;
    const modes = toks[1] as string;
    const params = toks.slice(2);
    return { kind: "mode", target, modes, params };
  },

  who: (_verb, rest) => {
    const [target] = tokens(rest);
    return { kind: "who", target: target ?? null };
  },

  names: (_verb, rest) => {
    const [target] = tokens(rest);
    return { kind: "names", target: target ?? null };
  },

  list: (_verb, rest) => {
    const [pattern] = tokens(rest);
    return { kind: "list", pattern: pattern ?? null };
  },

  links: (_verb, rest) => {
    const [pattern] = tokens(rest);
    return { kind: "links", pattern: pattern ?? null };
  },

  watch: (verb, rest) => parseWatchlist(verb, rest),
  highlight: (verb, rest) => parseWatchlist(verb, rest),
};

// /q is an alias for /query — same handler, but error messages use verb "q".
// DISPATCH.query is always defined (it's a key in the initializer above).
const queryHandler = DISPATCH.query;
if (queryHandler) {
  (DISPATCH as Record<string, Handler>).q = queryHandler;
}

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

  const verbLower = verb.toLowerCase();
  const handler = DISPATCH[verbLower];
  if (!handler) {
    return err(verb, `unknown command: /${verb}`);
  }

  return handler(verb, rest);
}
