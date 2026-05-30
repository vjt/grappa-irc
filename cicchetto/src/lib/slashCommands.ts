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
// /topic verb branches (context-aware, issue #23):
//   - `/topic`                  → topic-show {channel: null}    (current chan)
//   - `/topic -delete`          → topic-clear {channel: null}   (current chan)
//   - `/topic <text>`           → topic-set {channel: null, text}
//   - `/topic #chan`            → topic-show {channel: "#chan"}
//   - `/topic #chan <text>`     → topic-set {channel: "#chan", text}
//   - `/topic #chan -delete`    → topic-clear {channel: "#chan"}
// Parser stays pure — resolving null channel against the focused window
// (and bailing if not on a channel window) is compose.ts's job.
//
// Aliases:
//   - `/q` == `/query` (both produce {kind: "query"})
//   - `/j` == `/join`  (both produce {kind: "join"})
//   - `/watch` == `/highlight` (both produce {kind: "watchlist"})
//
// Services shortcuts (issue #20) — rewrite to {kind: "msg", target}:
//   - `/cs <cmd>` → ChanServ
//   - `/ns <cmd>` → NickServ
//   - `/ms <cmd>` → MemoServ
//   - `/os <cmd>` → OperServ
//   - `/hs <cmd>` → HostServ
//   - `/rs <cmd>` → RootServ
//
// Power-user verbs:
//   - `/quote <line>` → raw IRC frame (escape hatch)
//   - `/oper <name> <password>` → IRC OPER (password redacted in logs)
//
// /watch /highlight subverbs: `add <pattern>` / `del <pattern>` / `list`.
// Server-side /user_settings API is not yet implemented — handlers in
// compose.ts emit inline "not yet implemented" errors as TODO stubs.

export type SlashCommand =
  | { kind: "empty" }
  | { kind: "privmsg"; body: string }
  | { kind: "me"; body: string }
  | { kind: "join"; channel: string; key: string | null }
  | { kind: "part"; channel: string | null; reason: string | null }
  | { kind: "topic-show"; channel: string | null }
  | { kind: "topic-set"; channel: string | null; text: string }
  | { kind: "topic-clear"; channel: string | null }
  | { kind: "nick"; nick: string }
  | { kind: "msg"; target: string; body: string }
  | { kind: "query"; target: string | null }
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
  | { kind: "lusers" }
  | { kind: "whois"; nick: string }
  | { kind: "whowas"; nick: string }
  | { kind: "watchlist"; action: "add"; pattern: string }
  | { kind: "watchlist"; action: "del"; pattern: string }
  | { kind: "watchlist"; action: "list" }
  | { kind: "quote"; line: string }
  | { kind: "oper"; name: string; password: string }
  | { kind: "error"; verb: string; message: string };

function err(verb: string, message: string): SlashCommand {
  return { kind: "error", verb, message };
}

// Parse a list of whitespace-delimited tokens from `rest`.
function tokens(rest: string): string[] {
  return rest === "" ? [] : rest.split(/\s+/).filter((t) => t.length > 0);
}

// Parse nicks-requiring ops verbs (/op /deop /voice /devoice).
// `kind` is passed in as the discriminated-union literal so we never
// re-cast the loosely-typed `string` verb back to the narrow set —
// codebase audit type-A8 (was `verb as "op" | "deop" | "voice" |
// "devoice"`).
type NicksVerbKind = "op" | "deop" | "voice" | "devoice";

function parseNicksVerb(kind: NicksVerbKind, rest: string): SlashCommand {
  const nicks = tokens(rest);
  if (nicks.length === 0) return err(kind, `/${kind} requires at least one nick`);
  return { kind, nicks };
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
    // UX-4 bucket F: `/join #chan` OR `/join #chan key` (+k channel
    // support). Second positional token is the optional key. Tokens
    // beyond the second are rejected — keys per RFC 2812 are a single
    // word (no embedded spaces).
    //
    // Issue #30/-pre / B (this bundle): bare-name UX — `/j sniffo`
    // and `/join sniffo` auto-prepend `#` so users don't have to type
    // the prefix. Names that already carry an RFC channel-prefix
    // [#&+!] are left untouched.
    //
    // Comma-safety: IRC JOIN treats `,` as a multi-channel separator
    // (`JOIN #a,#b` joins both). Auto-prepending `#` to `foo,bar` would
    // yield `#foo,bar` — `#foo` joins, `bar` (unprefixed) yields an
    // unspecified-channel server error. Reject the auto-prepend path
    // when the bare name contains `,`; the user must spell out each
    // channel with its sigil (`/join #foo,#bar`).
    const toks = tokens(rest);
    const raw = toks[0];
    if (!raw) return err(verb, `/${verb} requires a channel name`);
    if (toks.length > 2)
      return err(verb, `/${verb}: too many arguments (expected /${verb} <chan> [key])`);
    if (!/^[#&+!]/.test(raw) && raw.includes(","))
      return err(
        verb,
        `/${verb}: bare names with commas are ambiguous — spell each channel out (e.g. /${verb} #${raw.split(",").join(",#")})`,
      );
    const channel = /^[#&+!]/.test(raw) ? raw : `#${raw}`;
    const key = toks[1] ?? null;
    return { kind: "join", channel, key };
  },

  part: (_verb, rest) => {
    if (rest === "") return { kind: "part", channel: null, reason: null };
    const sp = rest.search(/\s/);
    if (sp === -1) return { kind: "part", channel: rest, reason: null };
    return { kind: "part", channel: rest.slice(0, sp), reason: rest.slice(sp + 1).trim() };
  },

  topic: (_verb, rest) => {
    // Context-aware /topic (issue #23):
    //   /topic                        → show topic of current channel
    //   /topic <text>                 → set current channel's topic to <text>
    //   /topic -delete                → clear current channel's topic
    //   /topic #chan                  → show topic of #chan
    //   /topic #chan <text>           → set #chan's topic to <text>
    //   /topic #chan -delete          → clear #chan's topic
    //   /topic # <text>               → ESCAPE: set current channel's topic
    //                                   to <text> when <text> begins with
    //                                   a channel sigil (so /topic #urgent
    //                                   ... can express "literal #urgent
    //                                   in topic body of current channel")
    //
    // Resolution of "current channel" + bail-if-not-in-channel happens
    // in compose.ts (parser stays pure — no selectedChannel() coupling).
    // The explicit channel is recognized by the RFC channel-prefix set
    // [#&+!]. The bare `#` escape (a single `#` followed by whitespace)
    // is the irssi convention for "the next thing is body, not a
    // channel arg" — required because some topic bodies legitimately
    // begin with `#hashtag`/`!urgent`/etc.
    if (rest === "") return { kind: "topic-show", channel: null };
    if (rest.trim() === "-delete") return { kind: "topic-clear", channel: null };
    // Bare-# escape: `/topic # ...` → current channel, body is the rest.
    if (rest === "#" || rest.startsWith("# ") || rest.startsWith("#\t")) {
      const body = rest.slice(1).trim();
      if (body === "") return { kind: "topic-show", channel: null };
      if (body === "-delete") return { kind: "topic-clear", channel: null };
      return { kind: "topic-set", channel: null, text: body };
    }
    if (/^[#&+!]/.test(rest)) {
      const sp = rest.search(/\s/);
      if (sp === -1) return { kind: "topic-show", channel: rest };
      const channel = rest.slice(0, sp);
      const body = rest.slice(sp + 1).trim();
      if (body === "") return { kind: "topic-show", channel };
      if (body === "-delete") return { kind: "topic-clear", channel };
      return { kind: "topic-set", channel, text: body };
    }
    return { kind: "topic-set", channel: null, text: rest };
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

  query: (_verb, rest) => {
    // /query <nick> opens; bare /query on a query window closes it
    // (handled in compose.ts, which has selectedChannel() context).
    // Parser stays pure — emit {target: null} on bare; compose decides
    // whether the current window kind permits the close-semantics.
    const [target] = tokens(rest);
    return { kind: "query", target: target ?? null };
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

  op: (_verb, rest) => parseNicksVerb("op", rest),
  deop: (_verb, rest) => parseNicksVerb("deop", rest),
  voice: (_verb, rest) => parseNicksVerb("voice", rest),
  devoice: (_verb, rest) => parseNicksVerb("devoice", rest),

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
    // Codebase audit type-A9 — destructure + guard so the index access
    // is narrowed by tsc's flow analysis (was `toks[0] as string` after
    // a `toks.length === 0` length-check that doesn't propagate to
    // individual indices under `noUncheckedIndexedAccess`).
    const [nick, channel] = tokens(rest);
    if (!nick) return err(verb, "/invite requires a nick");
    return { kind: "invite", nick, channel: channel ?? null };
  },

  umode: (verb, rest) => {
    if (rest === "") return err(verb, "/umode requires mode string (e.g. +i)");
    return { kind: "umode", modes: rest };
  },

  mode: (verb, rest) => {
    // Codebase audit type-A9 — destructure both required slots; tsc
    // narrows from the explicit `if (!target || !modes)` guard.
    const [target, modes, ...params] = tokens(rest);
    if (!target) return err(verb, "/mode requires a target");
    if (!modes) return err(verb, "/mode requires target and mode string");
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

  lusers: (_verb, _rest) => ({ kind: "lusers" }),

  whois: (verb, rest) => {
    const [nick] = tokens(rest);
    if (!nick) return err(verb, "/whois requires a nick");
    return { kind: "whois", nick };
  },

  whowas: (verb, rest) => {
    const [nick] = tokens(rest);
    if (!nick) return err(verb, "/whowas requires a nick");
    return { kind: "whowas", nick };
  },

  watch: (verb, rest) => parseWatchlist(verb, rest),
  highlight: (verb, rest) => parseWatchlist(verb, rest),

  // Issue #20 — services shortcuts. Each one rewrites to a {kind: "msg"}
  // command targeting the canonical ServiceNick. Empty body → error (no
  // point sending an empty PRIVMSG to ChanServ et al). Server responses
  // route to the `$server` window via the services-sender allowlist
  // (lib/grappa/irc/identifier.ex + cicchetto/src/lib/servicesSender.ts —
  // kept in lockstep). The compose.ts `msg` arm already short-circuits
  // services targets to `sendPrivmsg` without opening a query window.
  cs: (_verb, rest) => parseServiceShortcut("cs", "ChanServ", rest),
  ns: (_verb, rest) => parseServiceShortcut("ns", "NickServ", rest),
  ms: (_verb, rest) => parseServiceShortcut("ms", "MemoServ", rest),
  os: (_verb, rest) => parseServiceShortcut("os", "OperServ", rest),
  hs: (_verb, rest) => parseServiceShortcut("hs", "HostServ", rest),
  rs: (_verb, rest) => parseServiceShortcut("rs", "RootServ", rest),

  // /quote <raw irc line> — escape hatch. Sends the raw bytes
  // verbatim upstream (CRLF appended by the client). Pure-parser pass-
  // through; compose.ts pushes the line via Phoenix Channel to
  // GrappaChannel.handle_in("raw", ...) → Session.send_raw → Client
  // socket. No validation here; CRLF/NUL injection rejected at the
  // wire boundary.
  quote: (verb, rest) => {
    if (rest === "") return err(verb, "/quote requires a raw IRC line");
    return { kind: "quote", line: rest };
  },

  // /oper <name> <password> — IRC OPER command. Pure parser; the
  // password is captured but NEVER logged or persisted in cic (it
  // travels over WS to the bouncer, which redacts it before any log
  // line by emitting a static log message body — no interpolation).
  // BOTH fields must be single tokens with no embedded whitespace —
  // IRC OPER is a 2-token wire frame, and a multi-word "password"
  // would be silently truncated by the server to its first token
  // (yielding a confusing 464 ERR_PASSWDMISMATCH for the user) AND
  // splice the trailing tokens into positional arg slots upstream.
  // The bouncer-side `Identifier.safe_oper_token?/1` mirrors this
  // check as the wire-boundary guard.
  oper: (verb, rest) => {
    const sp = rest.search(/\s/);
    if (sp === -1) return err(verb, "/oper requires <name> <password>");
    const name = rest.slice(0, sp);
    const password = rest.slice(sp + 1).trim();
    if (name === "" || password === "") return err(verb, "/oper requires <name> <password>");
    if (/\s/.test(password))
      return err(
        verb,
        "/oper password must be a single token (IRC OPER takes one whitespace-delimited password)",
      );
    return { kind: "oper", name, password };
  },
};

function parseServiceShortcut(verb: string, target: string, rest: string): SlashCommand {
  if (rest === "") return err(verb, `/${verb} requires a command to send to ${target}`);
  return { kind: "msg", target, body: rest };
}

// Post-init aliases. Adding to DISPATCH after the literal initializer
// keeps the type narrowed in the original block while still surfacing
// aliases through the same Handler indirection.
//   /q → /query (same handler)
//   /j → /join  (same handler)
// All five service-msg shortcuts (/cs /ns /ms /os /hs /rs) live as
// independent DISPATCH entries below; they rewrite to {kind: "msg"}.
const queryHandler = DISPATCH.query;
if (queryHandler) {
  (DISPATCH as Record<string, Handler>).q = queryHandler;
}
const joinHandler = DISPATCH.join;
if (joinHandler) {
  (DISPATCH as Record<string, Handler>).j = joinHandler;
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
