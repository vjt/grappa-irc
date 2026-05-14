# Codebase Review Draft — IRC Subsystem (B5, no-silent-drops cluster)
**Agent:** irc/
**Scope:** `lib/grappa/irc/**` (parser, client, auth_fsm, message, identifier) + `lib/grappa/session/numeric_router.ex` + `lib/grappa/session/event_router.ex` + tests
**Date:** 2026-05-14

## Summary

| Severity | Count |
|----------|-------|
| CRIT     | 1     |
| HIGH     | 5     |
| MED      | 8     |
| LOW      | 6     |
| NIT      | 3     |
| **Total**| 23    |

Top themes:

1. **The B1 catch-all is too greedy.** It fixes silent drops but persists EVERY unhandled inbound verb to `$server` body — including `AUTHENTICATE` payloads, raw `ERROR` lines, and post-registration `PASS` echoes. This is the inverse failure mode of B1's original problem: instead of dropping silently, the new code persists sensitive bytes to scrollback. (B5-CRIT-1, B5-HIGH-1, B5-HIGH-2)
2. **Latent silent-drop traps in NumericRouter.** The `@delegated_numerics` MapSet lists 321/322/323 (LIST) and 364/365 (LINKS) as "delegated" with NO matching `EventRouter` clause — operator-issued `/list` would hit `:delegated → []` → silent drop. The TODO is in-source but the trap is real: the NEXT polish cluster that wires cic `/list` will hit it. (B5-HIGH-3)
3. **Routing-decision narrowing depends on parser invariants that are not pinned.** `NumericRouter.scan_params` skips `params[0]` (own-nick echo) and the last element on the assumption every numeric carries ≥ 3 params; numerics with shorter param shapes silently route to `$server` instead of the correct window — same disease class as the cluster's reason-for-existing. (B5-HIGH-4, B5-MED-1)
4. **Recursive-pattern-match rule violations** in EventRouter's `param_derived_route` and `route_non_channel_notice_non_chanserv`: `cond` chains masquerading as collect-or-bail traversal. (B5-MED-3, B5-NIT-1)
5. **Parser tolerance edge cases still uncovered** (per S10/S15/S22 from prior review): tab-as-tag-separator, 4096-byte tag-blob limit, >14 middle params. None landed; flagged again because Phase 6 listener facade extraction makes them library-API contracts. (B5-MED-5, B5-LOW-3)

---

## CRIT

### B5-CRIT-1. EventRouter B1 catch-all persists `AUTHENTICATE` payloads to `$server` scrollback — credential leak path
**File:** `lib/grappa/session/event_router.ex:1500-1533`
**Description:** The B1 fallthrough commit (0b96ba9) lists `AUTHENTICATE` explicitly in its rationale comment ("KILL, WALLOPS, GLOBOPS, ERROR, CHGHOST, AUTHENTICATE, vendor verbs all silently dropped"). Today the FSM's `:registered` catch-all at `auth_fsm.ex:262` absorbs post-registration `AUTHENTICATE` from the FSM's perspective — but `Client.process_line` dispatches the `{:irc, msg}` to `Session.Server` BEFORE the FSM step (`client.ex:663`), and Session.Server forwards every parsed line through `EventRouter.route/2`. With B1's new catch-all, an `AUTHENTICATE <base64-payload>` line — whether server-initiated re-auth (some IRCv3 implementations support mid-session SASL refresh), an upstream echo, or a malicious crafted line — now gets persisted to the `$server` window with `body = <base64-payload>` and `meta.raw.params = [<base64-payload>]`.

For a SASL PLAIN payload, the base64 decodes to `\0sasl_user\0sasl_user\0password`. Once that lands in sqlite the password sits in scrollback indefinitely (no scrub path), and is re-emitted on every `Scrollback.fetch` call to cic — including the visitor surface where unrelated sessions may render the `$server` window.

The same applies to `PASS` (a server echoing PASS would not happen in normal IRC, but a hostile peer or operator-confused config could).

**Recommended fix:** Add an explicit deny-list at the head of the catch-all clause for verbs that MUST NOT persist their payload — `AUTHENTICATE`, `PASS`, and (defensively) `OPER`. Either:

```elixir
@no_persist_verbs MapSet.new([:authenticate, :pass, :oper])

def route(%Message{command: command} = _, state) when command in @no_persist_verbs,
  do: {:cont, state, []}
```

…before the catch-all, OR refactor the catch-all to scrub `body` + `params` for these verbs (not preferred — drop is cleaner). Add a regression test: `route(authenticate_message, state)` produces zero `:persist` effects.

---

## HIGH

### B5-HIGH-1. EventRouter B1 catch-all has no per-verb opt-out; `ERROR` lines persist verbatim, polluting `$server` with ircd-format text
**File:** `lib/grappa/session/event_router.ex:1500-1533`
**Description:** The B1 catch-all unconditionally persists `:notice` rows for every unhandled verb. `ERROR :Closing Link: ... [Connection timed out]` from upstream now lands a `:notice` row on `$server` with `body = "Closing Link: ... [Connection timed out]"` and `meta.raw.verb = "ERROR"`. That's a server-side localized string in `body` — violating `feedback_no_localized_strings_server_side`. cic has no per-verb arm yet (the comment explicitly says "grow per-verb pretty-render arms incrementally"); until then, every unhandled verb's English template flows verbatim into the UI.

This isn't a silent drop, but it is the inverse: noisy persistence of verbatim ircd text the server is supposed to be neutral about. The two cases this catch-all was designed for (rendering a [Join] CTA for inbound INVITE etc.) are typed effects with bespoke wire shapes elsewhere; this generic shape only hides the typing debt.

**Recommended fix:** Stage the catch-all behind a `Logger.warning("unhandled inbound verb", verb: ...)` + a telemetry counter, and persist on `$server` ONLY for verbs in an explicit allowlist (e.g. `[:wallops, :kill, :error]`). Vendor `{:unknown, _}` verbs and undeclared atoms get logged + counted but NOT persisted, so cic doesn't accumulate untyped junk. Each future per-verb arm earns its way into the allowlist with a typed-effect commit, NOT by inheriting the generic catch-all shape.

### B5-HIGH-2. EventRouter catch-all takes `body = List.last(params) || ""` — empty body persists as `body = ""`, but `Scrollback.Message.changeset` may reject zero-length text on `:notice` kind
**File:** `lib/grappa/session/event_router.ex:1521`
**Description:** `body = List.last(params) || ""` produces `""` when `params == []` (e.g. a bare `WALLOPS` with no arg). The downstream changeset path (`build_persist` → Server's `apply_effects`) eventually calls `Scrollback.Message.changeset` which `validate_required(:body)` for `:notice` kind. An empty string passes `validate_required` (it's non-nil) but typically fails the implicit length-positivity contract callers expect. Worse: the row PERSISTS with `body = ""`, then cic renders an empty notice card with the verb badge floating over no text — visible noise + no signal.

**Recommended fix:** When `List.last(params)` is nil OR empty, persist with body = `nil` (changeset accepts nil for `:notice`-with-meta) and drive cic rendering off `meta.raw` only. OR: short-circuit the catch-all entirely when params are empty AND the verb has no semantic content (a bare `WALLOPS` with no message IS a parse error from upstream, not a row worth persisting).

### B5-HIGH-3. NumericRouter delegates 321/322/323 (LIST) + 364/365 (LINKS) to EventRouter — but EventRouter has no clauses for them; they hit the new B1 catch-all and persist the localized trailing param
**File:** `lib/grappa/session/numeric_router.ex:146-166`, `lib/grappa/session/event_router.ex:1498-1533`
**Description:** `@delegated_numerics` lists 321, 322, 323, 364, 365 with TODO comments saying the EventRouter handler is "owned by dedicated handlers" but NONE exist. The previous review's lint pass (in-source TODO at line 146) caught the gap and explicitly warned "When a future polish cluster wires the cic /list UI, it MUST land EventRouter clauses for 321/322/323 in the SAME commit -- otherwise the numeric flow goes :delegated -> EventRouter -> [] effects -> SILENT DROP."

But B1 changed the floor: with the catch-all in place, the flow is now `:delegated → EventRouter no-numeric-clause → catch-all (line 1498)` which short-circuits to `{:cont, state, []}` for ALL `{:numeric, _}` (correct — Server's numeric handler owns persistence). So the `:delegated` decision in NumericRouter SKIPS Server's persist path (`server.ex:1545` per the comment) AND finds no EventRouter clause AND falls through the EventRouter numeric short-circuit at line 1498. **Net: still a silent drop.**

The first time a user hits `/list` upstream, every 322 RPL_LIST line gets parsed, FSM-absorbed, EventRouter-no-op'd, NumericRouter-marked-delegated, and Server-skip'd. No row, no log, no telemetry.

**Recommended fix:** Either (a) remove 321/322/323/364/365 from `@delegated_numerics` so the NumericRouter param-scan + Server $server persist applies (good interim — operator at least sees the lines on `$server`), OR (b) land EventRouter clauses for these numerics in this cluster, NOT a future one. Option (a) is the smaller diff and matches the principle "no silent drops"; option (b) is the right shape long-term. The review brief specifically called out push-notifications/image-upload/voice-support trajectory — `/list` is in the polish bucket; the trap will fire then.

### B5-HIGH-4. NumericRouter `scan_params` skips trailing element unconditionally — numerics with `[own_nick, single_param]` shape route to `$server` instead of the param target
**File:** `lib/grappa/session/numeric_router.ex:373-381`
**Description:** `candidate_params([_, _])` returns `[]` — any numeric with exactly 2 params yields no scan candidates. But the assumption "params[0] is own-nick echo, last is human-readable trailing" doesn't hold for short-shape numerics. Examples:

- `:server 421 own_nick UNKNOWN_CMD` — only 2 params after own_nick. Today this is in `@active_numerics` (correctly $server) so OK.
- `:server 401 own_nick target` — ERR_NOSUCHNICK with no trailing string in some legacy ircds. `[own_nick, target]` → `candidate_params` returns `[]` → `scan_params` returns `{:server, nil}`. Should route to query window for `target` to surface "no such nick" inline.
- Any numeric where the upstream omits the trailing param (RFC 2812 says trailing is optional after middle params).

The current rule is "skip the last element because it's human text" — but for 2-param numerics the LAST is the only routable token. The `Enum.drop(rest, -1)` at line 380 unconditionally trims; for 2-param shape it trims away the only candidate.

**Recommended fix:** Drop the trailing only when params count ≥ 3 (i.e. there IS something after own_nick to be routable AND something else for trailing). For 2-param shape, scan `params[1]` as the candidate. Add tests pinning the 401-shape route.

### B5-HIGH-5. `IRC.Client.process_line` dispatch-before-FSM ordering: `Session.Server` receives stop-bound messages
**File:** `lib/grappa/irc/client.ex:655-685`
**Description:** Carried over from prior review S8 (MED then; HIGH now given the cluster's silent-drops focus). `process_line` does `send(state.dispatch_to, {:irc, msg})` (line 663) BEFORE `run_fsm_step/2` runs (line 664). When the FSM returns `{:stop, {:sasl_failed, 904}, ...}`, Session.Server's mailbox already contains the 904 message. Session.Server's catch-all `handle_info` swallows it — but EventRouter's new B1 catch-all (B5-CRIT-1) will now persist a `$server` row for this 904 BEFORE the supervisor link kill arrives.

In practice: a SASL-failed session leaves a stray `{:numeric, 904}` row on `$server` post-restart. Worse for `{:nick_rejected, 432, _}` — the 432 numeric carries the rejected nick name; B1's catch-all persists it as `body = "Nickname is currently in use"` (server-localized string in scrollback, B5-HIGH-1 again).

**Recommended fix:** Dispatch AFTER the FSM step succeeds — flip lines 663-664 to dispatch only when `run_fsm_step` returns `{:cont, _, _}`. For `:stop` cases, skip the send. Document the ordering contract in the moduledoc. (Alternative: filter the `:notice`-on-`$server`-from-numeric-catch-all in EventRouter when it would land for an FSM-owned numeric — but that's defensive on the wrong side; the dispatch ordering is the root cause.)

---

## MED

### B5-MED-1. NumericRouter `param_derived_route` is a `cond` chain that should be a recursive pattern match
**File:** `lib/grappa/session/numeric_router.ex:336-348`
**Description:** Per CLAUDE.md "Recursive pattern match over `Enum.reduce_while/3` for collect-or-bail traversal" — and equivalently "over `cond` chains for closed-set classification." `param_derived_route` is exactly classification:

```elixir
defp param_derived_route(code, msg, state) do
  cond do
    MapSet.member?(@delegated_numerics, code) -> :delegated
    MapSet.member?(@active_numerics, code) -> {:server, nil}
    true -> scan_params(msg.params, state)
  end
end
```

Three pattern-match clauses with guards on the code value would be clearer + Dialyzer-checkable + extensible. Same pattern in `route_non_channel_notice_non_chanserv` (line 1599-1618).

**Recommended fix:** Convert to clause-per-class:
```elixir
defp param_derived_route(code, _, _) when is_map_key(@delegated_numerics, code), do: :delegated
defp param_derived_route(code, _, _) when is_map_key(@active_numerics, code), do: {:server, nil}
defp param_derived_route(_, msg, state), do: scan_params(msg.params, state)
```
(Or use module attributes that are lists, with `code in @list` guards.)

### B5-MED-2. `IRC.Client.send_*` validation drift: `send_quit`, `send_topic`, `send_away` skip `valid_nick?`/`valid_channel?` semantic check
**File:** `lib/grappa/irc/client.ex:260-290, 234-242`
**Description:** Per the previous review's Top Theme #2 ("Outbound-helper validation is asymmetric"), the codebase committed to add `valid_channel?`/`valid_nick?` to every send_* helper. The migration is incomplete:

- `send_quit/2`: only `safe_line_token?(reason)` — fine, reason is free text.
- `send_topic/3`: `safe_line_token?` + `valid_channel?` ✓
- `send_away/2`: only `safe_line_token?(reason)` — fine, reason is free text.
- `send_pong/2`: only `safe_line_token?(token) and token != ""` — fine, token is server-supplied.

Actually on re-read, the asymmetric-validation rule has been satisfied for the 4 helpers covered by the prior S2/S3 findings. The migration looks complete. **DOWNGRADE this finding to a NON-finding** — leaving the entry to document the audit happened.

(No fix needed; flagging as a non-finding so the next reviewer doesn't re-discover.)

### B5-MED-3. `EventRouter.ctcp_verb/1` accepts malformed CTCP framing without rejecting
**File:** `lib/grappa/session/event_router.ex:1644-1651`
**Description:** `ctcp_verb(<<0x01, rest::binary>>)` splits on space-or-`\x01` and takes the first token. For `<<0x01>>` (lone CTCP open with no body), `:binary.split` returns `[""]` → matches `["" | _]` → returns `nil` (good). For `<<0x01, "VERSION">>` (no closing `\x01`), returns `"VERSION"` — and the CTCP-aware route arm at line 207 matches on `binary_part(body, 0, 1) == <<0x01>>` (only checks open framing). So an unclosed CTCP body extracts the verb correctly... but the response `NOTICE sender :\x01VERSION grappa #{version}\x01` is well-formed, and the persisted notice strips CTCP framing for readability. Net: works.

The risk: a hostile peer sends `\x01VERSION\x01\nPRIVMSG ...` — but `Parser.strip_unsafe_bytes` already strips embedded LF, so the smuggling vector is closed at the parser. No fix needed; flagging as a robustness audit data point.

### B5-MED-4. `Parser.parse_prefix` empty-prefix edge case `{:nick, nil, nil, nil}` produces ambiguous downstream sender
**File:** `lib/grappa/irc/parser.ex:308-328`
**Description:** A line like `: PING foo` (bare `:` then space then command) produces `prefix = {:nick, nil, nil, nil}` per `nilify/1`. The `Message.sender_nick` clause at line 134 collapses this to `"*"` (good — handled). But the prefix tuple shape STILL carries `:nick` not `:server` — any code that pattern-matches on `{:nick, _, _, _}` to gate "user-originated" treatment will incorrectly include this case. Today the only such consumer is `EventRouter.route/2`'s JOIN clause's userhost_cache populator (line 274-281) which gates on `is_binary(user) and is_binary(host)` — safe. But future consumers must be aware.

**Recommended fix:** Either (a) parser-level: when ALL three nilify clauses produce nil, return `prefix = nil` instead of `{:nick, nil, nil, nil}` — the type contract becomes stronger. OR (b) document the invariant prominently in `parser.ex`'s moduledoc with a "downstream pattern-match warning" subsection.

### B5-MED-5. Parser tolerance not pinned: tab-as-separator, large tag-blob, >14 middle params
**File:** `lib/grappa/irc/parser.ex:178-198`, `test/grappa/irc/parser_test.exs`
**Description:** Carried over from prior review S10/S15/S22. None landed. With Phase 6 listener facade extraction (and the in-progress hex-lib split per `project_extract_irc_libs` memory), these become library-API contracts. A consumer of the future `grappa_irc_parser` hex package will pattern-match against the documented behavior — if a tab silently parses into the tags blob (S10 in prior), the consumer's tag-keyed lookup misses; if a 4MB tag blob is accepted (S15), the consumer's memory budget breaks.

**Recommended fix:** Land the three tests now (pin "we accept tabs as part of tags blob", "we accept arbitrary tag blob length", "we accept arbitrary middle param count") OR make the parser strict and pin the rejection. Either way, the contract should be testable and documented BEFORE the hex extraction happens.

### B5-MED-6. EventRouter has 1480-byte single-arg `params` regex matching twice — line 1473 chanserv regex compiled per session-route call
**File:** `lib/grappa/session/event_router.ex:1473-1474, 1620-1630`
**Description:** `@chanserv_bracket_regex` and `@services_sender_regex` are module attributes (compile-time constants — good). But `chanserv_bracket_match` runs `Regex.run` for EVERY non-channel NOTICE, and the prior `route_non_channel_notice_non_chanserv` ALSO runs `Regex.match?(@services_sender_regex, sender)` + `String.contains?(sender, ".")`. For a NickServ NOTICE storm during a /msg flood, this is N regex evaluations per inbound line. `String.downcase` + `String.ends_with?(sender, "serv")` would be ~10x cheaper for the services check.

**Recommended fix:** Replace `@services_sender_regex` with `String.ends_with?(String.downcase(sender), "serv")`. Keep the chanserv-bracket regex (anchored, complex enough to need regex). Add a benchmark to `bench/` for the NOTICE-storm path so future regressions are caught.

### B5-MED-7. `Logger.metadata(opts.logger_metadata)` allowlist still not asserted at boot
**File:** `lib/grappa/irc/client.ex:539`
**Description:** Carried over from prior review S6. The fix landed for the typespec (`session_metadata` typedef at lines 75-88) — Dialyzer now flags drift. But there's no runtime assertion that the `Logger` config's `metadata` allowlist is a superset of `session_metadata`'s keys. A future caller adds `:visitor_id` to `session_metadata`, forgets to add it to `config/config.exs`, Dialyzer is happy, runtime silently drops the field. Same disease class as the cluster's reason for existing.

**Recommended fix:** At `init/1` (or boot-time), assert `Application.get_env(:logger, :console)[:metadata]` ⊇ `[:user, :network]` (and any future addition). Crash on mismatch — drift surfaces immediately.

### B5-MED-8. `IRC.AuthFSM.parse_cap_list` allocates a 3-pass list for what should be a 2-pass `Enum.map`
**File:** `lib/grappa/irc/auth_fsm.ex:526-532`
**Description:** Carried over from prior review S20 (LOW). Promoted because the comment at line 519-525 documents the `Enum.reject(&is_nil/1)` as defensive — but `String.split(_, "=", parts: 2)` returning `[]` is impossible (the result has at least one element for any input including ""). The reject pass is a guaranteed no-op. CLAUDE.md "Lightweight over heavyweight. If the mechanism is heavier than the problem, the mechanism IS the problem."

**Recommended fix:**
```elixir
defp parse_cap_list(blob) do
  for cap <- String.split(blob, " ", trim: true),
      do: hd(String.split(cap, "=", parts: 2))
end
```
One pass over the input. Drop the `is_nil` reject entirely.

---

## LOW

### B5-LOW-1. `IRC.Client.handle_info(msg, _)` catch-all uses `inspect/1` on un-validated `msg` — risk of large mailbox dump
**File:** `lib/grappa/irc/client.ex:595-598`
**Description:** A stray mailbox message of arbitrary shape (`{:DOWN, ref, ...}` from a misrouted monitor, `{:EXIT, _, _}` from a linked process, etc.) lands here and gets `inspect`'d into the log. For a stray `{:tcp, sock, megabyte_blob}` that somehow bypassed framing (impossible under packet:line, but hypothetical), the inspect call materializes the whole binary into the log string.

**Recommended fix:** `inspect(msg, limit: 100, printable_limit: 1024)` to bound the log line.

### B5-LOW-2. `IRC.Parser.unescape` non-UTF8 fallback returns input unchanged, hiding malformed-tag-value upstream
**File:** `lib/grappa/irc/parser.ex:270-274`
**Description:** Documented design choice (return malformed unchanged rather than raise). But a tag value that's invalid UTF-8 then propagates into the `tags` map and onward into the `meta` JSON column on Scrollback rows. `Jason.encode` will then crash on the JSON serialization step — moving the error from "loud at parse time" to "loud at PubSub fastlane time" (where the failure mode is the same shape as CP15 B6: PubSub broadcast crash kills fanout).

**Recommended fix:** When `String.valid?(value)` is false, return `nil` (and downstream `Message.tag/2` returns nil + caller defaults to "tag absent"). The malformed bytes never reach Jason. OR: tag the failure structurally — `{:invalid_utf8, raw_bytes}` — and let consumers reject explicitly.

### B5-LOW-3. Parser test missing: a server-prefix line that LOOKS like a nick (no `.`)
**File:** `test/grappa/irc/parser_test.exs:112-162`
**Description:** Prefix tests cover `nick!user@host`, `nick@host`, `nick-only-no-dot`, and `host-with-dot → :server`. Missing: `:irc` (single-token, no `!`/`@`/`.`) → today this classifies as `{:nick, "irc", nil, nil}` per the cond fall-through at line 326. A server like `irc` (yes, some legacy ircds run on bare hostnames in lab setups) would be misclassified as a nick. Edge case, but not pinned.

**Recommended fix:** Add a test asserting current behavior, plus a moduledoc note that server-prefix detection requires a `.` (so a legacy bare-hostname server is mis-classified as a nick — accept the limitation explicitly).

### B5-LOW-4. `IRC.Identifier.valid_nick?` regex allows uppercase first-char + RFC special chars; not pinned for the ban-mask derivation use case
**File:** `lib/grappa/irc/identifier.ex:32`
**Description:** Regex `^[A-Za-z\[\]\\`_^{|}][\w\[\]\\`_^{|}\-]{0,29}$`. Per RFC 2812 §2.3.1 the special chars `[]\\`_^{|}` are valid — fine. But the cluster's S5 ban-mask derivation (referenced in `EventRouter` line 149) takes a nick + builds `*!*@host` masks. If the nick contains a `\` (legal!), the bash-quoting in any future shell-out would break — flag for the trajectory's image-upload bucket where user-originated nicks may flow into shell commands.

**Recommended fix:** Document at the call site (when ban-mask shells out, if it ever does) that nicks can contain `\`. No code change today.

### B5-LOW-5. `EventRouter.command_to_verb_string` returns uppercased atom for `{:unknown, _}` already-uppercased — wasted upcase pass
**File:** `lib/grappa/session/event_router.ex:1535-1538`
**Description:** Parser normalizes `{:unknown, "UPPERCASED"}` at line 174 (`:error -> {:unknown, upper}`). `command_to_verb_string({:unknown, verb})` returns `verb` unchanged — but `command_to_verb_string` for atoms calls `String.upcase` on `Atom.to_string(atom)` — atom names are lowercase, this is a per-call upcase pass for every single line. Non-issue at line rates IRC sees today, flagged for the trajectory's voice-support bucket where call rates may climb.

**Recommended fix:** A precomputed `@command_strings` map: `%{privmsg: "PRIVMSG", notice: "NOTICE", ...}` matching the parser's `@known_commands` shape. One Map.fetch instead of Atom.to_string + String.upcase.

### B5-LOW-6. `IRC.Client` `init/1` warning about TLS posture still per-session, not per-network
**File:** `lib/grappa/irc/client.ex:546-548`
**Description:** Carried over from prior review S13. `if opts.tls do Logger.warning(...)` fires every session start. Comment at line 541-545 says "Phase 5 hardening will move this to Bootstrap" — but the comment has been there for 2+ months and 100+ sessions per cold deploy still emit the same line. The audit-dilution effect is real now that the no-silent-drops cluster is paying close attention to log signal.

**Recommended fix:** Move to `Grappa.Bootstrap.run/0` as a single summary line ("TLS posture verify_none on N networks: X, Y, Z"). Five-line refactor.

---

## NIT

### B5-NIT-1. `EventRouter.route_non_channel_notice_non_chanserv` is a `cond` chain — same recursive-pattern violation as B5-MED-1
**File:** `lib/grappa/session/event_router.ex:1599-1618`
**Description:** Three branches: services-suffix, dotted-host, valid-nick, fallthrough. Pattern-match clauses on `sender` would be cleaner, but `Regex.match?` doesn't compose into a guard — so this case is borderline-justified. Flag for awareness.

### B5-NIT-2. `IRC.Client` `transport_send`/`transport_setopts` use `%{transport: ...}` map pattern instead of `%__MODULE__{}` struct pattern
**File:** `lib/grappa/irc/client.ex:703-713`
**Description:** Match permits any map with `:transport`/`:socket` keys, not just the Client struct. Today only Client calls these; no risk. Tightening to `%__MODULE__{transport: :tcp, socket: sock}` makes the contract explicit. Style only.

### B5-NIT-3. `IRC.Parser` moduledoc lists `@known_commands` count as "~24" but the actual count is 24 exactly
**File:** `lib/grappa/irc/parser.ex:60`
**Description:** The fudge prefix "~" implies the count drifts. The map has exactly 24 entries; the doc should either say "24" or `length(@known_commands)` if doc-tests can compute it. Style.

---

## Trajectory risks

The cluster's stated trajectory (push notifications → image upload → voice → mobile UI polish → public open) intersects the IRC subsystem in three load-bearing ways:

1. **Push notifications** require typed `peer_away`-style wire events for "user mentioned you while you were away." The B5-CRIT-1/HIGH-1 catch-all shape is the WRONG starting point — it persists untyped junk that cic must filter out before deciding "is this a notification-worthy event?" Each per-verb pretty-render arm cic adds becomes coupled to the catch-all's shape. Land the typed-allowlist refactor (B5-HIGH-1's recommended fix) BEFORE the push-notification work starts; otherwise the notification logic gets the same disease.

2. **Image upload** flows user-originated URL strings through `:privmsg` body. The parser's CTCP framing preservation (`\x01ACTION ...\x01`) means `\x01`-bearing image alt-text round-trips into scrollback. The parser is correct; downstream (cic linkify per B4) must skip `\x01` framing. No IRC-layer fix needed — flag for the cicchetto reviewer that the body bytes from Server may contain CTCP delimiters.

3. **Voice support** (likely IRCv3 `chathistory` or a custom verb) needs the parser's tag-handling to be airtight. B5-MED-5 (tab-separator, tag-blob limit, middle-param-count) becomes load-bearing if voice metadata rides in IRCv3 message-tags. Land the parser pinning + tag-blob-limit work BEFORE voice — the ergonomic shape of "what does our parser accept" must be settled before a third party (the voice vendor or the operator's recording infrastructure) starts depending on it.

4. **Public open** means strangers can hit the visitor surface. Visitor sessions go through the same `Session.Server` + `EventRouter` paths as authenticated users. The B5-CRIT-1 leak (AUTHENTICATE payload persisted to `$server`) is benign for an authenticated single-tenant operator but catastrophic for a multi-visitor public surface — visitor A's session crashing on a stray AUTHENTICATE leaves visitor A's hashed credential bytes in a DB that visitor B might pull (depending on $server isolation). Audit visitor-vs-user `$server` isolation BEFORE public open; the IRC layer is fine but the cross-session blast radius matters.

5. **Phase 6 IRCv3 listener facade** reuses `Parser`, `AuthFSM`, `Identifier`, `Message`. Five files in `lib/grappa/irc/`. The Boundary `exports` (per prior review S7) still excludes `Parser`. With the imminent hex extraction (`project_extract_irc_libs`), the parser becomes a public API contract. B5-LOW-3 (server-prefix-without-dot) and B5-MED-5 (tag tolerance) are the two cliff-edges where the API contract is undefined — pin them before extraction or live with versioned breaking changes later.
