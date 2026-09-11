import { DEFAULT_CHANTYPES, isChannelName } from "./chantypes";
import {
  DEFAULT_NOTIFICATION_SOUND,
  isNotificationSound,
  NOTIFICATION_SOUNDS,
  type NotificationSound,
  OPT_IN_NOTIFICATION_SOUND,
} from "./notificationSound";

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
// T32 verbs — /quit /disconnect /connect, and #1796's /reconnect:
//
// `/disconnect [network] [reason]` and `/reconnect [network] [reason]` share
// ONE arm (`parseNetworkReason`) — see the comment there for the
// first-token-is-always-the-slug heuristic and why it is not the sigil one.
//
// #1796 — the two BOUNCE verbs are scoped to different things, deliberately:
// `/reconnect` bounces a NETWORK (park then unpark), `/cycle` bounces a
// CHANNEL (part then join). That is irssi's own split — `RECONNECT <tag>` vs
// `CYCLE [<channel>] [<message>]` — and cic, being irssi-shaped, must not
// invert an irssi verb. `/cycle` shares `/part`'s arm (`parseChannelReason`),
// which is what keeps the #1208 sigil rule from having to be remembered twice.
//
// S3.4 — /away verb:
//
// `/away :reason` AND `/away reason text` → set (action: "set",
// reason: "..."). The leading `:` is stripped if present (irssi
// convention). Bare `/away` (no args) → unset (action: "unset"). A
// reason that is empty after the colon-strip (`/away :`) ALSO → unset:
// an empty away reason is the bare-AWAY un-away semantics, not a set.
// reason is always a non-empty plain string on the set arm — callers do
// not need to handle the `:` prefix variant after this parser strips it.
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
// Built-in aliases:
//   - `/q` == `/query` (both produce {kind: "query"})
//   - `/j` == `/join`  (both produce {kind: "join"})
//   - `/watch` == `/notify` (#356: presence; was a keyword alias pre-#356)
//   - `/highlight` == `/hilight` (both keyword-highlight add)
//
// #385 — user-defined aliases: `/alias <name> <expansion>` /
// `/unalias <name>` let users register their own. They are expanded
// (`expandAlias`) BEFORE the DISPATCH lookup, so an expanded alias flows
// through the normal command path. Aliases MAY shadow builtins (#427 — reverses
// #385 decision #3), except the two-verb deny list /alias + /unalias (the
// command-side repair surface). Expansion is bounded at MAX_ALIAS_DEPTH. The
// `%{name => expansion}` map is passed into
// `parseSlash` by compose.ts (from the aliasList store) — this parser stays
// pure. Grammar: `$1..$9` positional (missing → empty), `$N-` the Nth arg and
// everything after it (#1047 — out of range → empty, same silent rule), `$*`
// all args, and implicit verbatim append when the expansion holds no
// placeholder. `$N-` unlocks the "first arg is a target, the rest is free
// text" shape (`alias k kick $1 $2-`) that `$*` (target twice) and `$2`
// (reason truncated to one word) both failed to express.
//   SPACING (#1047 ruling): `$N-` joins the whitespace-COLLAPSED token list —
//   the list `$1..$9` read from — with single spaces, NOT the raw tail `$*`
//   substitutes. So `$1-` and `$*` cover the same args and differ only in
//   spacing normalisation. That is deliberate: `$N-` is the positional form
//   extended, and for N > 1 "where does arg N start in the raw string" has no
//   answer that survives tabs and runs of spaces.
//
// Services shortcuts (issue #20) — `/<x>s <cmd>` rewrites to
// {kind: "msg", target}; a BARE `/<x>s` (issue #290) opens the dedicated
// services console modal via {kind: "service-modal", service}:
//   - `/cs [cmd]` → ChanServ
//   - `/ns [cmd]` → NickServ
//   - `/ms [cmd]` → MemoServ
//   - `/os [cmd]` → OperServ
//   - `/hs [cmd]` → HelpServ
//   - `/rs [cmd]` → RootServ
//
// Power-user verbs:
//   - `/quote <line>` → raw IRC frame (escape hatch)
//   - `/oper <name> <password>` → IRC OPER (password redacted in logs)
//
// #356 — watch-family grammar (classic-IRC, irssi-direct):
//   - presence: `/notify <nick> …` / `/watch <nick> …` add; bare → settings.
//   - keyword:  `/hilight <pattern>` / `/highlight <pattern>` add,
//               `/dehilight <pattern>` remove; bare → settings.
// A bare form of any of them yields {kind: "open-settings"} (the unified
// watch-lists section); compose.ts routes add/del over the existing
// server round-trips and opens the settings drawer for the bare case.
//
// #1958 — `/credits` → {kind: "open-credits"}: the end-titles modal, the
// same UI deep-link shape as the bare watch-family verbs (no network, no
// wire). Shadowable by a user alias.

export type SlashCommand =
  | { kind: "empty" }
  | { kind: "privmsg"; body: string }
  | { kind: "me"; body: string }
  // #431 — /ame + /amsg, the mIRC "say it everywhere" pair. Same body grammar
  // as /me, but the target is NOT the active window: compose.ts fans one copy
  // out per JOINED channel of the current network. The parser stays pure — it
  // knows nothing about which channels exist, the confirm gate above ten of
  // them, or the pacing against the send door.
  | { kind: "ame"; body: string }
  | { kind: "amsg"; body: string }
  | { kind: "join"; channels: string[]; key: string | null }
  | { kind: "part"; channel: string | null; reason: string | null }
  // #1796 — /cycle [<channel>] [<message>]: part then join, and nothing else.
  // irssi's CYCLE, spelled the same way and scoped the same way (a CHANNEL,
  // never a network — the network bounce is `reconnect` below). It carries
  // `part`'s field names because the message IS the PART message and the two
  // verbs share one parser arm; the operator-facing grammar keeps irssi's
  // `[<message>]` spelling.
  | { kind: "cycle"; channel: string | null; reason: string | null }
  | { kind: "topic-show"; channel: string | null }
  | { kind: "topic-set"; channel: string | null; text: string }
  | { kind: "topic-clear"; channel: string | null }
  | { kind: "nick"; nick: string }
  | { kind: "msg"; target: string; body: string }
  // #1225 — /notice <target> <text>. Same grammar as /msg; the target may be a
  // nick OR a channel (`/notice #chan` is legal IRC and is the oper's actual
  // reach). It is NOT a conversation verb: compose.ts sends it through the
  // #640 source-window seam, so the echo lands in the window it was typed in
  // and no query window is opened — which is also why the channel target /msg
  // refuses is harmless here.
  | { kind: "notice"; target: string; body: string }
  // #290 — a BARE services command (`/ns`, `/cs`, `/ms`, …) opens the
  // dedicated services console modal, titled by `service`. compose.ts
  // fires `help` on open so the service help wall lands in the modal, not
  // the server-window flood. A full command WITH args stays `kind:"msg"`
  // (inline execute) — no unsolicited popup for power users.
  | { kind: "service-modal"; service: string }
  | { kind: "query"; target: string | null }
  | { kind: "quit"; reason: string | null }
  | { kind: "disconnect"; network: string | null; reason: string | null }
  | { kind: "connect"; network: string }
  // #1796 — /reconnect [<network>] [<reason>]: park then unpark ONE network,
  // the round trip `/disconnect` + `/connect` used to cost two commands (the
  // second of which made the operator type a slug the client already knows).
  // irssi's RECONNECT is network-scoped, so ours is too; the grammar is
  // `disconnect`'s, verbatim, via the same parser arm.
  | { kind: "reconnect"; network: string | null; reason: string | null }
  | { kind: "away"; action: "set"; reason: string }
  | { kind: "away"; action: "unset" }
  | { kind: "op"; nicks: string[] }
  | { kind: "deop"; nicks: string[] }
  | { kind: "voice"; nicks: string[] }
  | { kind: "devoice"; nicks: string[] }
  | { kind: "kick"; nick: string; reason: string }
  // #386 — /kb <nick> [reason] kickban (irssi/xchat convenience). Pure parser
  // shape: same grammar as /kick. compose.ts expands it into a MODE +b (mask
  // from the server's userhost_cache, `*!*@host` fail-closed) followed by a
  // KICK — two frames, ban first, attempt both (vjt decisions #1/#4).
  | { kind: "kb"; nick: string; reason: string }
  // #557 — /kill <nick> [reason]: first-class operator KILL, same grammar as
  // /kick/kb (first token = nick, remainder = reason). Target is a NICK with
  // NO channel; compose.ts composes `KILL <nick> :<reason>` and adds the
  // trailing colon downstream (never typed by the user — the /quote foot-gun
  // #557 fixes). No client permission-probe: the server's 481 is the feedback.
  | { kind: "kill"; nick: string; reason: string }
  | { kind: "ban"; mask: string }
  | { kind: "unban"; mask: string }
  // #386 /banlist opens the channel list-mode modal. The shape carries the
  // resolved channel — an explicit `/banlist #chan`, or null (= the current
  // window, resolved in compose.ts) — and, since #1251, WHICH type-A list
  // (`b` bans, `e` exempts, `I` invex, `z`/`q` restrict/quiet).
  //
  // #536's `/mode #chan +b` route no longer lands here: whether a bare
  // `+<letter>` is a LIST query or a flag toggle depends on the network's
  // 005, which this pure parser cannot see, so the `mode` arms keep their
  // literal shape and compose.ts (which has the isupport table) intercepts.
  | { kind: "banlist"; channel: string | null; mode: string }
  | { kind: "invite"; nick: string; channel: string | null }
  | { kind: "umode"; modes: string }
  // #229 — no-mode-args umode forms open the umode viewer/editor modal.
  // Bare `/umode` and `/mode <ownnick>` (a non-channel target with no mode
  // args) both emit `umode-view`; compose.ts opens the modal (and, for the
  // `/mode <target>` route, only when the target resolves to the operator's
  // OWN nick — the modal edits your own umodes, not another user's). Any
  // `/umode <modes>` or `/mode <ownnick> <modes>` stays an execute verb.
  | { kind: "umode-view" }
  | { kind: "mode"; target: string; modes: string; params: string[] }
  // #216 — no-mode-args /mode forms open the viewer/editor modal instead
  // of executing. `mode-view` = open the modal for `channel` (explicit
  // `/mode #chan`) or the current channel (`null` from bare `/mode`).
  // `mode-apply-current` = `/mode +s` (a mode string but no channel
  // token) applies to the current channel — compose.ts resolves it. Any
  // form WITH both a channel and modes stays `mode` (execute directly).
  | { kind: "mode-view"; channel: string | null }
  | { kind: "mode-apply-current"; modes: string; params: string[] }
  | { kind: "umode-target-view"; target: string }
  | { kind: "who"; target: string | null }
  | { kind: "names"; target: string | null }
  | { kind: "list"; pattern: string | null }
  | { kind: "links"; pattern: string | null }
  // #581 — /recover [network]: guided "recover my identity" (NickServ). The
  // optional first token is the network slug (bare → the active window's
  // network, resolved in compose.ts). Same optional-arg grammar as /links.
  | { kind: "recover"; network: string | null }
  // #579 — /lusers [<mask> [<server>]] (RFC 2812 §3.4.2). Both optional and
  // POSITIONAL: `server` can never be present without `mask`, which is how the
  // client mirrors the server's `:invalid_line` rejection of that shape — the
  // illegal state is unconstructible here rather than built-then-refused.
  | { kind: "lusers"; mask: string | null; server: string | null }
  | { kind: "info" }
  | { kind: "version" }
  | { kind: "motd"; target: string | null }
  // #992 — /admin [<target>] (RFC 2812 §3.4.4). Fourth member of the
  // server-text family; same optional-single-token grammar as /motd.
  | { kind: "admin"; target: string | null }
  | { kind: "stats"; query: string | null; target: string | null }
  | { kind: "rehash"; opt: string | null }
  | { kind: "whois"; nick: string | null; server: string | null }
  | { kind: "whowas"; nick: string }
  // #356 — keyword highlight list (classic-IRC /hilight + /dehilight,
  // /highlight alias). irssi-direct grammar: `/hilight <pattern>` adds,
  // `/dehilight <pattern>` removes. A BARE form opens settings (see
  // "open-settings" below), so there is no list action any more.
  | { kind: "watchlist"; action: "add" | "del"; pattern: string }
  // #247/#356 — /notify presence watch (server-side per-network list;
  // NOT the keyword highlight list above). irssi-direct: `/notify <nick> …`
  // adds. Removal is via the settings ×; a bare form opens settings.
  | { kind: "notify"; action: "add"; nicks: string[] }
  // #162 — /ignore + /unignore, the server-honoured mask list. irssi-direct:
  // `/ignore <mask>` adds (a bare nick means nick!*@*), `/unignore <mask>`
  // removes, and a BARE `/ignore` lists what is set for this network.
  | { kind: "ignore"; action: "add" | "del"; mask: string }
  // #356/#385 — a BARE verb that opens a settings sub-page instead of
  // printing inline (watch-family → watch lists; bare /alias → aliases).
  // Opening the drawer IS the feedback. `section` widens as sub-pages gain
  // bare-verb deep-links; it must stay assignable to settingsNav's
  // SettingsSubPage.
  | { kind: "open-settings"; section: "watchlists" | "aliases" | "ignores" | "push" }
  // #1480 — `/beep <preset>` selects the in-app notification sound. Carries the
  // NARROWED preset name, so the handler cannot be handed a string the server
  // would 422: `on`/`off` are resolved to their preset here, in the parser,
  // where every other alias-to-value mapping in this file lives.
  | { kind: "beep"; sound: NotificationSound }
  // #1958 — a bare `/credits` opens the end titles: the same modal the
  // settings drawer's last entry opens, one verb deep instead of three taps.
  // It carries nothing — the modal is a module-singleton signal and the verb
  // takes no arguments; trailing text is ignored, the no-arg family's posture.
  | { kind: "open-credits" }
  // #385 — user-defined command aliases. `/alias <name> <expansion>` defines
  // one, `/unalias <name>` removes one. The define carries the parsed name +
  // expansion; compose.ts round-trips them through the aliasList store.
  | { kind: "alias-define"; name: string; expansion: string }
  | { kind: "unalias"; name: string }
  | { kind: "quote"; line: string }
  | { kind: "oper"; name: string; password: string }
  // #591 — /ctcp <target> <VERB> [args]: send an arbitrary CTCP query. The
  // parser carries the raw parts (verb uppercased per convention); compose.ts
  // reuses the /me framing seam to build the single \x01VERB args\x01 frame.
  | { kind: "ctcp"; target: string; verb: string; args: string }
  // #591 — /ping <target>: sugar for CTCP PING. The parser only carries the
  // target; compose.ts stamps the outbound timestamp token and owns the
  // reply-correlation state (RTT synthesized locally in the source window).
  | { kind: "ping"; target: string }
  // #1698 — /np: an ACTION naming the track the tuned radio station is
  // playing. It carries NOTHING, and that is the shape rather than an
  // omission: the track, the station and whether either is currently
  // knowable all live in the `nowPlaying` store, and a parser that stays
  // pure cannot see any of them. compose.ts resolves the state and decides
  // between a wire frame and a local refusal.
  | { kind: "np" }
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

// #557 — shared grammar for the nick-then-optional-reason verbs (/kick, /kb,
// /kill): first whitespace-delimited token is the nick, the trimmed remainder
// is the (optional) reason. `kind` is the discriminated-union literal (as
// `parseNicksVerb` does) so we never re-cast the loose `verb` string back to the
// narrow set; `verb` supplies the error copy so an alias (/kickban) names what
// the user typed. #557 collapsed the three copy-pasted handlers into this one
// (kick/kb predate it — the divergent copy-paste CLAUDE.md forbids).
type NickReasonKind = "kick" | "kb" | "kill";

function parseNickReason(kind: NickReasonKind, verb: string, rest: string): SlashCommand {
  if (rest === "") return err(verb, `/${verb} requires a nick`);
  const sp = rest.search(/\s/);
  const nick = sp === -1 ? rest : rest.slice(0, sp);
  const reason = sp === -1 ? "" : rest.slice(sp + 1).trim();
  return { kind, nick, reason };
}

// #162 — /ignore and /unignore. One token: the mask. `/ignore` alone lists.
// Trailing tokens are ignored, the no-arg family's posture — a second token
// is not a second mask, and irssi's `<levels>` argument is deliberately not
// parsed here (v1 ignores content only; see the server filter).
// #162 — `/ignore <mask>` adds; a BARE `/ignore` opens the ignore-list
// settings sub-page, the same door bare `/hilight` and `/notify` take (the
// list with its per-entry × is right there; Gabriele's ruling, 2026-09-06).
function parseIgnore(_verb: string, rest: string): SlashCommand {
  const [mask] = tokens(rest);
  if (mask === undefined) return { kind: "open-settings", section: "ignores" };
  return { kind: "ignore", action: "add", mask };
}

// #1480 — `/beep`, the shortcut into the notification-sound preference. vjt's
// shape, verbatim (2026-09-11): «/beep nudo ti apre i settinfs», «on è il beep
// che abbiamo ora il default, off è none, e preset è il preset».
//
//   /beep            → the settings sub-page that holds the picker
//   /beep on         → the 440 Hz tone cic shipped before this issue
//   /beep off        → `none`
//   /beep <preset>   → that preset by name
//
// `on` is NOT a synonym for "the default": the default is silence, and `on` is
// what a subject types to opt in. Keeping them separate constants is what
// stops a later change of default from silently redefining `/beep on`.
//
// A generic `/set <key> <value>` was proposed and killed by vjt on his own
// call the same afternoon («/set è un puttanaio lasciamo perdere») — do not
// grow this into one.
function parseBeep(verb: string, rest: string): SlashCommand {
  const [name] = tokens(rest);
  if (name === undefined) return { kind: "open-settings", section: "push" };

  const lowered = name.toLowerCase();
  if (lowered === "on") return { kind: "beep", sound: OPT_IN_NOTIFICATION_SOUND };
  if (lowered === "off") return { kind: "beep", sound: DEFAULT_NOTIFICATION_SOUND };
  if (isNotificationSound(lowered)) return { kind: "beep", sound: lowered };

  // Name the whole set rather than "unknown preset": the operator asked for a
  // sound by name and the answer they need is which names exist.
  return {
    kind: "error",
    verb,
    message: `unknown sound: ${name} — try on, off, or one of: ${NOTIFICATION_SOUNDS.join(", ")}`,
  };
}

function parseUnignore(verb: string, rest: string): SlashCommand {
  const [mask] = tokens(rest);
  if (mask === undefined) return { kind: "error", verb, message: "/unignore requires a mask" };
  return { kind: "ignore", action: "del", mask };
}

// #356 — presence-watch parser, shared by /notify + /watch (alias).
// irssi-direct: `/notify <nick> [<nick> …]` adds each nick; a BARE form
// opens the watch-lists settings section (removal lives there, per-entry ×).
function parseNotify(_verb: string, rest: string): SlashCommand {
  const nicks = tokens(rest);
  if (nicks.length === 0) return { kind: "open-settings", section: "watchlists" };
  return { kind: "notify", action: "add", nicks };
}

// #356 — keyword-highlight add parser, shared by /hilight + /highlight
// (alias). irssi-direct: `/hilight <pattern>` adds the pattern (the whole
// rest is one pattern — highlight patterns may contain spaces). A BARE form
// opens the watch-lists settings section.
function parseHilight(_verb: string, rest: string): SlashCommand {
  const pattern = rest.trim();
  if (pattern === "") return { kind: "open-settings", section: "watchlists" };
  return { kind: "watchlist", action: "add", pattern };
}

// #356 — keyword-highlight remove parser (/dehilight). irssi spelling for
// "stop highlighting <pattern>". A BARE form opens settings (same landing
// as bare /hilight — the list is right there to prune from).
function parseDehilight(_verb: string, rest: string): SlashCommand {
  const pattern = rest.trim();
  if (pattern === "") return { kind: "open-settings", section: "watchlists" };
  return { kind: "watchlist", action: "del", pattern };
}

// #591 — /ctcp <target> <VERB> [args]. First whitespace-delimited token is the
// target, the second is the CTCP verb (uppercased per convention), the trimmed
// remainder is the (optional) args. A missing target OR verb is a usage error.
// The parser stays framing-free: compose.ts builds the \x01VERB args\x01 frame
// via the shared /me send seam (no second CTCP writer).
function parseCtcp(rest: string): SlashCommand {
  const trimmed = rest.trim();
  const sp1 = trimmed.search(/\s/);
  // No target, or a target with no following verb token.
  if (trimmed === "" || sp1 === -1) {
    return err("ctcp", "/ctcp requires a target and a verb");
  }
  const target = trimmed.slice(0, sp1);
  const afterTarget = trimmed.slice(sp1 + 1).trim();
  const sp2 = afterTarget.search(/\s/);
  const verb = (sp2 === -1 ? afterTarget : afterTarget.slice(0, sp2)).toUpperCase();
  const args = sp2 === -1 ? "" : afterTarget.slice(sp2 + 1).trim();
  return { kind: "ctcp", target, verb, args };
}

// #431 — shared grammar for the two fan-out verbs: the trimmed remainder is the
// message, whole. `kind` is the discriminated-union literal (as `parseNicksVerb`
// and `parseNickReason` do) so the loose `verb` string is never re-cast back to
// the narrow set; `verb` supplies the error copy so it names what was typed.
//
// An EMPTY body is refused, where /me tolerates one. The asymmetry is the point:
// /me's empty ACTION is one pointless frame to one window, whereas an empty
// fan-out is one refused frame per joined channel, each burning a send token
// against the #340 bucket on the way to delivering nothing.
type FanOutKind = "ame" | "amsg";

function parseFanOut(kind: FanOutKind, verb: string, rest: string): SlashCommand {
  const body = rest.trim();
  if (body === "") return err(verb, `/${verb} requires a message`);
  return { kind, body };
}

// #591 — /ping <target>. Only the target survives the parser; compose.ts owns
// the timestamp token + reply correlation. Trailing tokens are ignored (a nick
// is a single word), mirroring /whois <server> <nick> <junk>.
function parsePing(rest: string): SlashCommand {
  const [target] = tokens(rest);
  if (target === undefined) return err("ping", "/ping requires a target");
  return { kind: "ping", target };
}

// #1208/#1796 — the `[<channel>] [<reason>]` grammar, shared by /part and its
// round trip /cycle.
//
// #1208 — `/part <reason>` is the common form and it MUST NOT eat its first
// word as a target. Pre-fix the first token was the channel unconditionally, so
// `/part non trovo utili le bestemmie` issued a DELETE against a channel named
// "non" and the operator was told "The request was malformed." about a name
// they never typed.
//
// The sigil resolves the ambiguity, as it does in every other IRC client: a
// first token carrying one of the network's advertised sigils (#1255) is the
// target, anything else is the start of the reason and the target falls back to
// the current window (in the handler).
//
// Deliberately NOT symmetric with `join`: /join auto-prepends `#` to a bare
// name because a JOIN has no second meaning for its first token. /part does,
// and so does /cycle, so the same sugar here is precisely what manufactures the
// phantom channel.
//
// #1796 — ONE function rather than a second copy for /cycle, and that is the
// point: the rule above is a rule about a grammar, not about a verb, and a
// copy is how `/cycle brb` would have grown its own phantom `brb` channel while
// every /part test stayed green.
type ChannelReasonKind = "part" | "cycle";

function parseChannelReason(
  kind: ChannelReasonKind,
  rest: string,
  chantypes: readonly string[],
): SlashCommand {
  if (rest === "") return { kind, channel: null, reason: null };
  const sp = rest.search(/\s/);
  const first = sp === -1 ? rest : rest.slice(0, sp);
  if (!isChannelName(first, chantypes)) return { kind, channel: null, reason: rest };
  if (sp === -1) return { kind, channel: first, reason: null };
  return { kind, channel: first, reason: rest.slice(sp + 1).trim() };
}

// T32/#1796 — the `[<network>] [<reason>]` grammar, shared by /disconnect and
// /reconnect.
//
// The first whitespace-delimited token is ALWAYS the network slug (no state
// lookup, no ambiguity). A bare form returns `network: null` so the handler
// resolves the active window's network. A user who wants a reason without
// naming a network must spell the network out (`/disconnect <activenet> ...`).
// This keeps the parser pure (zero state dependency).
//
// NOT the sigil heuristic above, and the asymmetry is deliberate: a network
// slug wears no sigil, so there is nothing to disambiguate it with. Sharing one
// arm between the two network verbs is what keeps an operator from getting two
// different answers to the same first word.
type NetworkReasonKind = "disconnect" | "reconnect";

function parseNetworkReason(kind: NetworkReasonKind, rest: string): SlashCommand {
  if (rest === "") return { kind, network: null, reason: null };
  const sp = rest.search(/\s/);
  if (sp === -1) return { kind, network: rest, reason: null };
  return { kind, network: rest.slice(0, sp), reason: rest.slice(sp + 1).trim() };
}

// Dispatch table: verb (lowercased) → handler(verb, rest) → SlashCommand.
// Every registered verb must appear here; unknown verbs produce {kind: "error"}.
// #1255 — handlers receive the network's advertised channel sigils as DATA,
// the same shape `aliases` takes: the parser stays pure and testable against
// a network that publishes something other than the RFC class. A handler
// that does not care about sigils simply declares two parameters.
type Handler = (verb: string, rest: string, chantypes: readonly string[]) => SlashCommand;

const DISPATCH: Readonly<Record<string, Handler>> = {
  me: (_verb, rest) => ({ kind: "me", body: rest }),

  // #431 — the fan-out pair. Registered as BUILTINS, which is the whole of what
  // "builtin" buys them under #427: a same-named user alias shadows them like
  // it shadows /join or /quit, because the non-shadowable set is the fixed
  // two-name repair surface (/alias, /unalias) and nothing else. Issue #431's
  // body claims the opposite ("builtins are never shadowed by aliases") — it
  // predates #427, which reversed exactly that. The alias engine (#385) cannot
  // express iteration, so this is not scriptable today; nothing here is
  // pre-built for a future iteration primitive.
  ame: (verb, rest) => parseFanOut("ame", verb, rest),
  amsg: (verb, rest) => parseFanOut("amsg", verb, rest),

  // #591 — CTCP send verbs. /ctcp is the general form; /ping is the RTT sugar.
  ctcp: (_verb, rest) => parseCtcp(rest),
  ping: (_verb, rest) => parsePing(rest),

  // #1698 — /np. Registered here like any other verb rather than special-cased
  // in the composer, which the issue asks for explicitly and which is also the
  // only way it inherits the whole path for free: the `//np` literal escape,
  // #427 alias shadowing, and the dispatch characterization net.
  // Trailing tokens are ignored, the no-arg family's posture (/info, /version):
  // there is nothing a second token could mean, so refusing one would buy the
  // operator a scolding instead of the line they asked for.
  np: (_verb, _rest) => ({ kind: "np" }),

  join: (verb, rest, chantypes) => {
    // UX-4 bucket F: `/join #chan` OR `/join #chan key` (+k channel
    // support). Second positional token is the optional key. Tokens
    // beyond the second are rejected — keys per RFC 2812 are a single
    // word (no embedded spaces).
    //
    // Issue #30/-pre / B (this bundle): bare-name UX — `/j sniffo`
    // and `/join sniffo` auto-prepend `#` so users don't have to type
    // the prefix. A name that already carries one of the sigils THIS
    // network advertises (#1255 — 005 CHANTYPES, the RFC class when the
    // network says nothing) is left untouched.
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
    if (!isChannelName(raw, chantypes) && raw.includes(","))
      return err(
        verb,
        `/${verb}: bare names with commas are ambiguous — spell each channel out (e.g. /${verb} #${raw.split(",").join(",#")})`,
      );
    // #516 — the parser owns the comma semantics: an RFC1459 JOIN target
    // may be a comma-list (`#a,#b`), so return `channels: string[]` rather
    // than lie about a single `channel: string`. The bare-name comma path
    // already errored above; here `target` is sigil-normalised, so splitting
    // on `,` yields one explicitly-prefixed channel per element (`["#a"]`
    // for the single-join case). compose.ts rejoins with `,` for the wire
    // (server splits it per #382) and focuses `channels[0]`.
    const target = isChannelName(raw, chantypes) ? raw : `#${raw}`;
    const channels = target.split(",");
    const key = toks[1] ?? null;
    return { kind: "join", channels, key };
  },

  // The #1208 sigil rule lives on `parseChannelReason` — read it there, not
  // here, and add nothing to this arm that /cycle should not inherit.
  part: (_verb, rest, chantypes) => parseChannelReason("part", rest, chantypes),

  // #1796 — /cycle is /part's round trip, so it is /part's grammar. The
  // handler runs the second leg (the JOIN); the parser knows nothing about it.
  cycle: (_verb, rest, chantypes) => parseChannelReason("cycle", rest, chantypes),

  topic: (_verb, rest, chantypes) => {
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
    // The explicit channel is recognized by the network's advertised sigil
    // set (#1255). The bare `#` escape (a single `#` followed by whitespace)
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
    if (isChannelName(rest, chantypes)) {
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
    // #12 — /msg is for nicks (queries); grappa does not relay a PRIVMSG to a
    // channel addressed by name (even one that accepts external messages).
    // Reject every IRC channel sigil (# & ! +) up front, otherwise compose.ts
    // opens a phantom query window keyed by the channel name whose WS-driven
    // own-send never renders (cic only subscribes to JOINED channel topics).
    // #343 — the refusal STAYS by design, but say so out loud: name the
    // target, explain that /msg addresses nicks, and point at what to type
    // instead (open the channel's window / /join it, then type there). The
    // guard is unconditional — no joined-state check — so the guidance is
    // "open its window", never "/msg after joining".
    if (["#", "&", "!", "+"].includes(target[0] ?? "")) {
      return err(
        verb,
        `/msg is for private messages to a nick, not channels. To message ${target}, open its window (or /join ${target}) and type your message there.`,
      );
    }
    return { kind: "msg", target, body };
  },

  // #1225 — /notice <target> <text>. Deliberately NOT sharing /msg's handler:
  // they differ on the one rule that matters, the channel-target refusal (#12/
  // #343). That refusal exists because a PRIVMSG addressed to a channel by
  // name opens a phantom query window whose own-send never renders; a notice
  // opens no window at all, so the same guard here would refuse the form opers
  // use most. Shared grammar, opposite target policy — one handler with a flag
  // would hide exactly the distinction worth seeing.
  notice: (verb, rest) => {
    const sp = rest.search(/\s/);
    if (rest === "" || sp === -1 || sp === 0) {
      return err(verb, "/notice requires <target> <text>");
    }
    const target = rest.slice(0, sp);
    const body = rest.slice(sp + 1).trim();
    if (body === "") return err(verb, "/notice requires message text after the target");
    return { kind: "notice", target, body };
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

  disconnect: (_verb, rest) => parseNetworkReason("disconnect", rest),

  // #1796 — the round trip of `disconnect` + `connect`, as ONE verb. It takes
  // `disconnect`'s grammar and not `connect`'s: the bare form must work, and
  // the reason must have somewhere to go. `connect` keeps its slug requirement
  // untouched.
  reconnect: (_verb, rest) => parseNetworkReason("reconnect", rest),

  connect: (verb, rest) => {
    const [network] = tokens(rest);
    if (!network) return err(verb, "/connect requires a network slug");
    return { kind: "connect", network };
  },

  away: (_verb, rest) => {
    const reason = rest.startsWith(":") ? rest.slice(1).trim() : rest;
    // Any empty reason → unset. Covers bare `/away` (rest "") AND
    // `/away :` (colon then nothing/whitespace). An empty reason would
    // build `AWAY :` on the wire — the bare-AWAY un-away line (RFC 2812
    // §4.6), which the server rejects as :invalid_line — so emit the
    // honest unset instead of a set with reason "".
    if (reason === "") return { kind: "away", action: "unset" };
    return { kind: "away", action: "set", reason };
  },

  op: (_verb, rest) => parseNicksVerb("op", rest),
  deop: (_verb, rest) => parseNicksVerb("deop", rest),
  voice: (_verb, rest) => parseNicksVerb("voice", rest),
  devoice: (_verb, rest) => parseNicksVerb("devoice", rest),

  kick: (verb, rest) => parseNickReason("kick", verb, rest),

  // #386 — /kb <nick> [reason] kickban. First token is the nick, the rest is
  // the (optional) reason — identical grammar to /kick. The ban-mask build
  // (`*!*@host` fail-closed) + MODE+KICK sequencing live in compose.ts.
  kb: (verb, rest) => parseNickReason("kb", verb, rest),

  // #557 — /kill <nick> [reason] operator KILL. Same nick-then-reason grammar
  // as /kick/kb, but no channel — the target is a NICK. compose.ts composes
  // `KILL <nick> :<reason>` (trailing colon added downstream) and ships it via
  // pushRaw, mirroring /quote. A non-oper gets the server's 481; cic does not
  // client-gate (issue #557 out-of-scope: no /gline, no confirm dialog).
  kill: (verb, rest) => parseNickReason("kill", verb, rest),

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

  // #386/#1251 — `/banlist [#chan] [mode]`. Both args optional, order-free,
  // classified by SHAPE: a single (optionally signed) letter is the mode, a
  // sigil-led token is the channel. The mode test runs FIRST because `+e` is
  // both a signed mode and a `+`-sigil channel name — and a channel literally
  // named `+e` is extinct, while `/banlist +e` is the obvious spelling.
  // Defaults: current window's channel (resolved in compose.ts) and `b`.
  banlist: (_verb, rest) => {
    let channel: string | null = null;
    let mode = "b";

    for (const tok of tokens(rest)) {
      if (/^[+-]?[A-Za-z]$/.test(tok)) mode = tok.replace(/^[+-]/, "");
      else if (/^[#&!+]/.test(tok)) channel = tok;
    }

    return { kind: "banlist", channel, mode };
  },

  invite: (verb, rest) => {
    // Codebase audit type-A9 — destructure + guard so the index access
    // is narrowed by tsc's flow analysis (was `toks[0] as string` after
    // a `toks.length === 0` length-check that doesn't propagate to
    // individual indices under `noUncheckedIndexedAccess`).
    const [nick, channel] = tokens(rest);
    if (!nick) return err(verb, "/invite requires a nick");
    return { kind: "invite", nick, channel: channel ?? null };
  },

  umode: (_verb, rest) => {
    // #229 — bare `/umode` opens the umode viewer/editor modal (mirror of
    // bare `/mode` opening the channel-mode modal). `/umode <modes>` still
    // executes the change directly (mode-args present → apply).
    if (rest === "") return { kind: "umode-view" };
    return { kind: "umode", modes: rest };
  },

  mode: (_verb, rest, chantypes) => {
    // #216 — dispatch by argument shape. The rule (vjt): mode-args
    // present → execute directly (no modal); NO mode-args → open the
    // viewer/editor modal.
    //
    //   /mode                 → mode-view {channel: null}   (current chan)
    //   /mode #chan           → mode-view {channel: "#chan"}
    //   /mode #chan +s [args] → mode (execute — channel + modes)
    //   /mode +s [args]       → mode-apply-current (current chan + modes)
    //
    // A token is a CHANNEL when it carries one of the network's advertised
    // sigils (#1255);
    // a MODE string starts with +/-. Note `+` is BOTH a channel sigil
    // and a mode sign — disambiguate: a lone leading `+`/`-` followed by
    // mode letters (no further sigil) is a mode string, whereas `+chan`
    // is a (rare) channel. We treat a first token matching /^[+-]/ that
    // is NOT a bare `+`/`&`/`!`/`#`-prefixed channel-shaped name as a
    // mode string. In practice mode strings look like `+s`, `-l+k`,
    // `+o-v`; `+`-sigil channels are near-extinct — but a token like
    // `+foo` with no mode-sign letters after a sign is ambiguous. We
    // resolve conservatively: `-`-led is always modes; `+`-led is modes
    // (the common case) — a `+chan` channel must be addressed via the
    // explicit two-token form `/mode +chan +s`.
    const toks = tokens(rest);
    const [first, ...restToks] = toks;

    // Bare /mode → view current channel.
    if (!first) return { kind: "mode-view", channel: null };

    const isModeString = /^[+-]/.test(first);
    // #1255 — advertised sigils, MINUS `+`: the exclusion above is not the
    // RFC class disagreeing with the network, it is `+` being claimed by the
    // mode-sign disambiguation two comments up. A `+`-sigil channel is
    // addressed with the explicit two-token form.
    const isChannel = isChannelName(
      first,
      chantypes.filter((sigil) => sigil !== "+"),
    );

    if (isModeString) {
      // /mode +s [params] → apply to the current channel. #536/#1251: a bare
      // `+b`/`+e` with no mask is a LIST QUERY on a network that advertises
      // that letter as type A — but only compose.ts can tell, so the
      // interception lives there and this arm keeps the literal shape.
      return { kind: "mode-apply-current", modes: first, params: restToks };
    }

    if (isChannel) {
      const [modes, ...params] = restToks;
      // /mode #chan (no modes) → open the modal for that channel.
      if (!modes) return { kind: "mode-view", channel: first };
      // /mode #chan +s [params] → execute directly (or, for a bare list
      // letter with no mask, get intercepted into the list modal by
      // compose.ts — see the mode-string branch above).
      return { kind: "mode", target: first, modes, params };
    }

    // First token is neither a channel sigil nor a mode string — treat it
    // as an explicit target nick. #229: `/mode <nick>` with NO mode args
    // opens the UMODE viewer/editor modal — but only when the target is the
    // operator's OWN nick (the modal edits your own umodes; there is no
    // per-other-user umode viewer). The parser stays pure, so it emits
    // `umode-target-view` carrying the target; compose.ts resolves it
    // against the operator's own nick and errors on a mismatch (mirror of
    // #216's mode-view resolving the current channel). `/mode <nick> <modes>`
    // still executes the user-MODE change directly.
    const [modes, ...params] = restToks;
    if (!modes) return { kind: "umode-target-view", target: first };
    return { kind: "mode", target: first, modes, params };
  },

  // #540 — forward the FULL argument string, not just the first token.
  // bahamut's extended WHO takes flag args (`+s <server>`, `+A <away-msg>`,
  // `+c <chan>`, `+H <maxhits>`); dropping everything after the first token
  // sent `WHO +s` to the wire, and bahamut answered 522 ERR_WHOSYNTAX (the
  // `s` flag's server arg was eaten). cic is a thin pass-through for WHO
  // syntax — the server forwards the args verbatim (line-safety gated).
  // Bare `/who` (empty rest) → null, so compose defaults to the current
  // channel (#122).
  who: (_verb, rest) => {
    const target = rest.trim();
    return { kind: "who", target: target === "" ? null : target };
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

  // #581 — /recover [network]. First token = optional network slug (bare →
  // current window's network, resolved in compose.ts). Same optional-arg shape
  // as /links; trailing tokens are ignored.
  recover: (_verb, rest) => {
    const [network] = tokens(rest);
    return { kind: "recover", network: network ?? null };
  },

  // #579 — /lusers [<mask> [<server>]] (RFC 2812 §3.4.2). Pre-#579 `rest` was
  // dropped, so a user's arguments vanished with no error — the failure mode
  // #374 closed for /motd. #571 already threads both tokens server-side.
  // What the args buy on bahamut (azzurra/bahamut src/s_serv.c, read for
  // #579): `m_lusers` routes via `hunt_server` only when BOTH tokens are
  // present, and the answering server reports ITS OWN local counts — that
  // two-token form is the one with a visible effect. `send_lusers` never
  // match()es the mask, so a mask ALONE is accepted and ignored there (an
  // RFC-honouring ircd is free to filter on it, hence we still send it).
  // Two-optional-token split, same shape as /stats' `query` + `target`.
  // ORDER NOTE: /whois's two-arg form is `<server> <nick>` (server FIRST,
  // RFC 2812 §3.6.2) — LUSERS is the other way round, mask FIRST. Reading the
  // first token as a server would produce the one shape the server rejects as
  // `:invalid_line`; the invariant test pins the order.
  // Tokens past the second are ignored (LUSERS is a 2-slot wire frame).
  lusers: (_verb, rest) => {
    const [mask, server] = tokens(rest);
    return { kind: "lusers", mask: mask ?? null, server: server ?? null };
  },

  // #127 — /info, /version. No-arg server-text queries; the reply renders
  // in a dismissable retro modal (ServerReplyModal).
  info: (_verb, _rest) => ({ kind: "info" }),
  version: (_verb, _rest) => ({ kind: "version" }),
  // #374 — /motd [<target>] (RFC 2812 §3.4.1). Bare = current server's
  // MOTD (target null); /motd <server> routes the query through that server.
  // Pre-#374 the arg was dropped, so the user got the wrong server's MOTD
  // with no error. First token only (mirror of /who); trailing tokens are
  // ignored. /info + /version stay no-arg (same family, separate issue).
  motd: (_verb, rest) => {
    const [target] = tokens(rest);
    return { kind: "motd", target: target ?? null };
  },
  // #992 — /admin [<target>] (RFC 2812 §3.4.4). bahamut's m_admin routes
  // through the same `hunt_server` as m_motd (src/s_serv.c:2683), so the
  // grammar is /motd's: bare = the connected server's A:line, one token =
  // route the query there, trailing tokens ignored (1-slot wire frame).
  admin: (_verb, rest) => {
    const [target] = tokens(rest);
    return { kind: "admin", target: target ?? null };
  },

  // #155 — /stats [query] [server]. Native parser sugar over the raw
  // transport (like the #20 services shortcuts rewrite to {kind:"msg"}):
  // compose builds the raw `STATS [query] [server]` frame and ships it via
  // pushRaw. Both args optional — bare `/stats` sends `STATS`. IRC STATS
  // takes at most a query char + a server target, so any tokens past the
  // second are ignored (2-token wire frame). Pure parser, no side effects.
  stats: (_verb, rest) => {
    const [query, target] = tokens(rest);
    return { kind: "stats", query: query ?? null, target: target ?? null };
  },

  // #155 / #375 — /rehash [option]. Oper-only UPSTREAM — a non-oper gets 481,
  // an oper's config reload runs server-side; cic never client-gates it, same
  // as /oper letting the ircd reject. #375: the OPTION (MOTD / DNS / GC /
  // TKLINE / …) must survive parsing — pre-fix it was dropped, so bahamut ran
  // the default full-config reload instead of the scoped `REHASH <option>`.
  // First-token-only, mirroring /stats + #374's /motd (REHASH takes one
  // option upstream); compose builds the raw `REHASH [option]` frame.
  rehash: (_verb, rest) => {
    const [opt] = tokens(rest);
    return { kind: "rehash", opt: opt ?? null };
  },

  // #122 — bare /whois (and its /w alias) no longer errors here. A null
  // nick signals "use the current context": the compose consumer resolves
  // the active query window's nick (and errors if not in a query window).
  // Mirrors the bare-target tolerance of /who and /names.
  //
  // #198 — two-arg RFC 2812 §3.6.2 form `/whois <server> <nick>`: the FIRST
  // token is the target server the query routes through, the SECOND is the
  // nick. Single-arg `/whois <nick>` keeps server null; bare `/whois` keeps
  // both null. Trailing tokens past the second are ignored (WHOIS is a
  // 2-slot wire frame). Server validation is the wire boundary's job
  // (grappa_channel `validate_args` + `Client.send_whois/3`).
  whois: (_verb, rest) => {
    const [first, second] = tokens(rest);
    // Both tokens present → two-arg form: first=server, second=nick.
    if (first !== undefined && second !== undefined) {
      return { kind: "whois", nick: second, server: first };
    }
    // Zero tokens → bare (both null); one token → single-arg (server null).
    return { kind: "whois", nick: first ?? null, server: null };
  },

  whowas: (verb, rest) => {
    const [nick] = tokens(rest);
    if (!nick) return err(verb, "/whowas requires a nick");
    return { kind: "whowas", nick };
  },

  // #356 — presence watch (classic IRC WATCH/MONITOR = presence).
  // /notify is canonical; /watch is now a presence ALIAS (was a keyword
  // alias pre-#356). Both: irssi-direct add, or bare → open settings.
  ignore: (verb, rest) => parseIgnore(verb, rest),
  unignore: (verb, rest) => parseUnignore(verb, rest),
  notify: (verb, rest) => parseNotify(verb, rest),
  watch: (verb, rest) => parseNotify(verb, rest),

  // #1480 — the notification-sound shortcut. Registered as an ordinary
  // builtin, so it inherits the `//beep` literal escape, #427 alias shadowing
  // and the dispatch characterization net for free.
  beep: (verb, rest) => parseBeep(verb, rest),

  // #356 — keyword highlight. /hilight is canonical (irssi spelling on the
  // host /usr/share/irssi/help/), /dehilight removes, /highlight kept as an
  // alias of /hilight. All: irssi-direct, or bare → open settings.
  hilight: (verb, rest) => parseHilight(verb, rest),
  dehilight: (verb, rest) => parseDehilight(verb, rest),
  highlight: (verb, rest) => parseHilight(verb, rest),

  // #1958 — /credits: the end titles. A UI deep-link like a bare /hilight,
  // resolving no network and putting nothing on the wire. Shadowable by a
  // user alias like every verb but /alias + /unalias (Gabriele's ruling on
  // the issue: nothing argues it must join the deny list).
  credits: (_verb, _rest) => ({ kind: "open-credits" }),

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
  hs: (_verb, rest) => parseServiceShortcut("hs", "HelpServ", rest),
  rs: (_verb, rest) => parseServiceShortcut("rs", "RootServ", rest),

  // #385 — user-defined command aliases. `/alias <name> <expansion>`
  // defines/overwrites, `/unalias <name>` removes; bare `/alias` deep-links
  // into the aliases settings sub-page (mirror of bare /notify). #427 — a
  // define may shadow any builtin EXCEPT /alias + /unalias (the two-verb deny
  // list `isNonShadowableVerb`, NOT the live DISPATCH set). Expansion happens
  // in parseSlash (before DISPATCH lookup).
  alias: (verb, rest) => parseAlias(verb, rest),
  unalias: (verb, rest) => parseUnalias(verb, rest),

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

function parseServiceShortcut(_verb: string, target: string, rest: string): SlashCommand {
  // #290 — a BARE services command opens the dedicated services console
  // modal (titled by `target`); compose.ts fires `help` on open so the
  // service's multi-NOTICE help wall lands confined in the modal instead
  // of flooding the server window. A full command WITH args stays an
  // inline PRIVMSG (kind:"msg") to the service — power users typing e.g.
  // `/ns identify <pass>` get no unsolicited popup, reply shows inline.
  if (rest === "") return { kind: "service-modal", service: target };
  return { kind: "msg", target, body: rest };
}

// #427 — the two verbs a user alias may NOT shadow: /alias and /unalias
// themselves — the command-side repair surface. Everything else (/join, /quit,
// /w, /q, /j, /n, …) is shadowable (ruling vjt 2026-07-26). This is a FIXED
// two-name set on PURPOSE: the old `isBuiltinVerb` gate read the LIVE DISPATCH
// key set, which rejected EVERY builtin — reusing it here would reproduce that
// reject-everything behaviour. Both the define-time gate (`parseAlias`) and the
// expander bail (`expandAlias`) route through this one predicate.
const NON_SHADOWABLE_VERBS: ReadonlySet<string> = new Set(["alias", "unalias"]);

export function isNonShadowableVerb(verb: string): boolean {
  return NON_SHADOWABLE_VERBS.has(verb.toLowerCase());
}

// #385 — `/alias <name> <expansion>` defines/overwrites a user alias; bare
// `/alias` deep-links into the aliases settings sub-page. A single optional
// leading `/` is stripped from BOTH the name and the expansion so
// `/alias w /whois` and `/alias w whois` are equivalent (the spec spells
// expansions slash-less). #427 — a define MAY shadow a builtin; only /alias
// and /unalias are rejected here, at define time, naming them.
function parseAlias(verb: string, rest: string): SlashCommand {
  const trimmed = rest.trim();
  if (trimmed === "") return { kind: "open-settings", section: "aliases" };

  const sp = trimmed.search(/\s/);
  if (sp === -1) return err(verb, "usage: /alias <name> <expansion>");

  const name = trimmed.slice(0, sp).replace(/^\//, "").toLowerCase();
  const expansion = trimmed
    .slice(sp + 1)
    .trim()
    .replace(/^\//, "");
  if (name === "" || expansion === "") return err(verb, "usage: /alias <name> <expansion>");

  if (isNonShadowableVerb(name)) {
    return err(verb, `/${name} can't be aliased — it's needed to manage aliases`);
  }
  return { kind: "alias-define", name, expansion };
}

// #385 — `/unalias <name>` removes a user alias. First token only.
function parseUnalias(verb: string, rest: string): SlashCommand {
  const [raw] = tokens(rest);
  if (!raw) return err(verb, "usage: /unalias <name>");
  return { kind: "unalias", name: raw.replace(/^\//, "").toLowerCase() };
}

// #385 — alias expansion. Iterate `verb`+`rest` through the user's alias map
// until the head verb is non-shadowable (/alias, /unalias — always win, #427)
// or not an alias, bounded at MAX_ALIAS_DEPTH. A same-named alias now shadows
// any OTHER builtin (the alias fires). Returns the final verb+rest for the
// normal DISPATCH path,
// or an {error} naming the chain when a cycle / over-long chain is hit
// (surfaced inline in compose).
export const MAX_ALIAS_DEPTH = 5;

export type AliasExpansion = { verb: string; rest: string } | { error: string };

export function expandAlias(
  verb: string,
  rest: string,
  aliases: Readonly<Record<string, string>>,
): AliasExpansion {
  let curVerb = verb;
  let curRest = rest;
  const chain: string[] = [verb.toLowerCase()];

  for (let depth = 0; ; depth++) {
    const lower = curVerb.toLowerCase();
    // #427 — non-shadowable verb (/alias, /unalias) wins; not an alias →
    // nothing to expand. Either way, done. Any OTHER builtin with a same-named
    // alias falls through and expands (the alias shadows it).
    if (isNonShadowableVerb(lower) || !(lower in aliases)) {
      return { verb: curVerb, rest: curRest };
    }
    if (depth >= MAX_ALIAS_DEPTH) {
      return { error: `alias expansion too deep (chain: ${chain.join(" → ")})` };
    }
    // Tolerate a single leading `/` in the stored expansion — the CLI define
    // path strips it, but a settings-sub-page edit submits raw, so the map
    // may hold `/whois`. The expander is the one choke-point every expansion
    // flows through, so normalise here too.
    const template = (aliases[lower] as string).replace(/^\//, "");
    const expanded = substituteAlias(template, curRest).trim();
    const sp = expanded.search(/\s/);
    curVerb = sp === -1 ? expanded : expanded.slice(0, sp);
    curRest = sp === -1 ? "" : expanded.slice(sp + 1).trim();
    chain.push(curVerb.toLowerCase());
  }
}

const ALIAS_PLACEHOLDER = /\$(\*|[1-9]-?)/;
// Same grammar, global — `.test/2` on a /g regex is stateful (lastIndex), so
// the two uses need distinct objects. Derive rather than repeat the literal:
// #1047 added one character to this pattern, and a second hand-kept copy is
// exactly where that edit gets forgotten.
const ALIAS_PLACEHOLDER_ALL = new RegExp(ALIAS_PLACEHOLDER.source, "g");

// Substitute placeholders in `template` from `rest`. If the template holds
// ANY placeholder, only substitutions happen ($1..$9 → the Nth arg or empty
// string; $N- → the Nth arg and every one after it; $* → all args verbatim).
// If it holds NONE, the rest is appended verbatim (space-separated) — one rule
// serving both `alias w whois` (append) and `alias wii whois $1 $1` (no
// double-append).
function substituteAlias(template: string, rest: string): string {
  if (!ALIAS_PLACEHOLDER.test(template)) {
    return rest === "" ? template : `${template} ${rest}`;
  }
  // Deliberate asymmetry: `$*` substitutes the RAW rest (internal spacing
  // preserved — "all remaining args verbatim"), while `$1..$9` pull from the
  // whitespace-collapsed token list. Don't "fix" one to match the other.
  //
  // #1047 — `$N-` had to pick a side and picks the COLLAPSED one: it joins
  // `args` from N onward with single spaces, so it reads as "the positional
  // form, extended" rather than "a second `$*`". Consequence worth knowing
  // before calling it a bug: `$1-` and `$*` select the SAME arguments and
  // differ only in that `$1-` normalises internal whitespace. Out of range
  // joins nothing → empty string, matching the "missing → empty" rule above.
  const args = tokens(rest);
  return template.replace(ALIAS_PLACEHOLDER_ALL, (_m, g: string) => {
    if (g === "*") return rest;
    const from = Number(g[0]) - 1;
    return g.endsWith("-") ? args.slice(from).join(" ") : (args[from] ?? "");
  });
}

// Post-init aliases. Adding to DISPATCH after the literal initializer
// keeps the type narrowed in the original block while still surfacing
// aliases through the same Handler indirection.
//   /q → /query (same handler)
//   /j → /join  (same handler)
//   /w → /whois (same handler)   — #122
//   /n → /names (same handler)   — #122
// All six service-msg shortcuts (/cs /ns /ms /os /hs /rs) live as
// independent DISPATCH entries below; they rewrite to {kind: "msg"}.
const queryHandler = DISPATCH.query;
if (queryHandler) {
  (DISPATCH as Record<string, Handler>).q = queryHandler;
}
const joinHandler = DISPATCH.join;
if (joinHandler) {
  (DISPATCH as Record<string, Handler>).j = joinHandler;
}
// #122 — /w → /whois, /n → /names. Context-aware defaults (bare → current
// query nick / current channel) live in the compose consumers, not here.
const whoisHandler = DISPATCH.whois;
if (whoisHandler) {
  (DISPATCH as Record<string, Handler>).w = whoisHandler;
}
const namesHandler = DISPATCH.names;
if (namesHandler) {
  (DISPATCH as Record<string, Handler>).n = namesHandler;
}
// #386 — /kickban → /kb (irssi spelling; both produce {kind: "kb"}).
const kbHandler = DISPATCH.kb;
if (kbHandler) {
  (DISPATCH as Record<string, Handler>).kickban = kbHandler;
}

// `aliases` (#385) is the user's `%{name => expansion}` map, passed in by
// compose.ts from the aliasList store. It defaults to `{}` (no aliases → no
// expansion, the correct production behavior when the user has defined none),
// which also keeps the many pure `parseSlash(input)` call sites in tests
// working unchanged.
export function parseSlash(
  input: string,
  aliases: Readonly<Record<string, string>> = {},
  chantypes: readonly string[] = DEFAULT_CHANTYPES,
): SlashCommand {
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

  // #385 — expand user-defined aliases BEFORE the DISPATCH lookup, so an
  // expanded alias flows through the normal command path with no downstream
  // special-casing (spec Placement). #427 — a same-named alias shadows its
  // builtin (except /alias + /unalias, guarded inside expandAlias); a cycle /
  // over-deep chain surfaces as an inline error.
  const expanded = expandAlias(verb, rest, aliases);
  if ("error" in expanded) return err(verb, expanded.error);

  const verbLower = expanded.verb.toLowerCase();
  const handler = DISPATCH[verbLower];
  if (!handler) {
    return err(expanded.verb, `unknown command: /${expanded.verb}`);
  }

  return handler(expanded.verb, expanded.rest, chantypes);
}
