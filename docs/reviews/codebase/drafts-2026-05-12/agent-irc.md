# Codebase Review Draft — IRC Subsystem
**Agent:** irc/
**Scope:** lib/grappa/irc.ex + lib/grappa/irc/** + test/support IRC helpers
**Date:** 2026-05-12

## CRITICAL

### S1. Stray `AUTHENTICATE +` leaks SASL credentials in pre-registration phases
**File:** `lib/grappa/irc/auth_fsm.ex:232-234`
**Category:** credential-leak / phase-guard exhaustiveness
The `step/2` clause for `%Message{command: :authenticate, params: ["+"]}` is matched UNCONDITIONALLY for any `phase` other than `:registered` (the `:registered` catch-all at line 227 absorbs only the post-handshake case). The CP S1-S4 review comment at lines 209-227 explicitly enumerated this exact threat ("Stray AUTHENTICATE + from a buggy/malicious upstream would elicit a verbatim SASL credential reply (S2) — credential leak under verify_none") but the fix only covers the post-`:registered` arm.

Concretely: a hostile/buggy server (or, under Phase 1 `verify: :verify_none`, a network-position MitM) can send `:any AUTHENTICATE +` while the FSM is in `:pre_register`, `:awaiting_cap_ls`, or `:awaiting_cap_ack` — even before SASL has been negotiated — and the FSM will reply `AUTHENTICATE <base64(\0sasl_user\0sasl_user\0password)>` with the operator's credentials. The defense the comment claims to provide is incomplete.

**Fix:** Guard the AUTHENTICATE clause on `phase: :sasl_pending` (the only legitimate phase to receive the `+` prompt per IRCv3 SASL spec). Move it to:

```elixir
def step(%__MODULE__{phase: :sasl_pending} = state, %Message{command: :authenticate, params: ["+"]}) do
  {:cont, state, ["AUTHENTICATE #{sasl_plain_payload(state)}\r\n"]}
end
```

Add a regression test covering each non-`:sasl_pending` phase against a stray `AUTHENTICATE +`.

## HIGH

### S2. `send_join`/`send_part` accept malformed channel names (no `valid_channel?` check)
**File:** `lib/grappa/irc/client.ex:179-191`
**Category:** validation asymmetry / hardening
`send_join/2` and `send_part/2` validate only `safe_line_token?(channel)` (CR/LF/NUL stripping) — they do NOT call `Identifier.valid_channel?/1`. Every other channel-targeted send helper (`send_topic`, `send_kick`, `send_invite`, `send_banlist`, `send_who`, `send_names`, `send_topic_clear`) properly validates the channel. The asymmetry means a `/join foo` (no `#` prefix) from cic dispatches `JOIN foo\r\n` to the upstream, which then either silently ignores or replies 403 ERR_NOSUCHCHANNEL — and the bouncer's pending-window state machine has already created a `:pending` channel state for `"foo"` that will never resolve. Same problem for `send_part`.

Per CLAUDE.md "Total consistency or nothing. Half-typed is worse than untyped" — the asymmetric validation pattern will be the seed for future "copy whichever is closer" drift.

**Fix:** Add `Identifier.valid_channel?(channel)` to both `send_join/2` and `send_part/2`. Update docstring to mention "rejects malformed channel name".

### S3. `send_privmsg` does not validate `target` shape (nick or channel)
**File:** `lib/grappa/irc/client.ex:168-175`
**Category:** validation asymmetry / outbound contract
`send_privmsg(client, target, body)` checks only `safe_line_token?` on both args. A PRIVMSG target legally is either a channel or a nick — but right now any string with no CR/LF/NUL is forwarded. A user-emitted slash command typo (`/msg foo bar` where `foo` is nothing) sends `PRIVMSG foo :bar\r\n` upstream. Worse, an empty `target` would emit malformed `PRIVMSG  :bar\r\n` (the trailing colon makes "" the middle-param target, which the upstream rejects).

**Fix:** Reject when `target == ""` and require `Identifier.valid_nick?(target) or Identifier.valid_channel?(target)`. Same shape applies to NOTICE if/when added.

### S4. SASL PLAIN payload may contain NUL bytes from password and break framing
**File:** `lib/grappa/irc/auth_fsm.ex:435-437`
**Category:** SASL framing / credential validation
`sasl_plain_payload/1` builds `<<0, u::binary, 0, u::binary, 0, pw::binary>>` then base64-encodes. SASL PLAIN (RFC 4616) explicitly forbids NUL inside any of the three fields — with NUL the Base64 still encodes cleanly but the server's SASL decoder splits on the wrong boundary, which can either leak the password as the "authzid" field OR (depending on the decoder) cause an opaque 904 with no diagnostic. Since `Networks.Credential.validate_safe_line_token/2` only rejects CR/LF/NUL on `:password` at validation time on the WRITE path, this is hardened by chance — but the AuthFSM module is documented as reusable for Phase 6 and assumes Networks.Credential discipline that future callers may not respect. There's no defensive guard at the SASL framing boundary.

**Fix:** Add an `is_binary` + `not String.contains?(pw, <<0>>)` precondition in `sasl_plain_payload/1`; on violation, return `{:error, :nul_in_sasl_credential}` from `step/2` and stop with `{:sasl_failed, :nul_in_credential}` (or analogous structured reason). The validation cost is one O(n) scan per registration — irrelevant.

### S5. AuthFSM trusts un-validated `nick` / `realname` / `password` for line construction
**File:** `lib/grappa/irc/auth_fsm.ex:166-198, 416-419`
**Category:** boundary trust / future-proofing
`maybe_send_pass`, `send_nick_and_user`, and `maybe_nickserv_identify` interpolate `state.nick`, `state.realname`, `state.password` directly into iodata frames with no `safe_line_token?` check. Today's `Networks.Credential.validate_safe_line_token/2` saves us — but the AuthFSM moduledoc explicitly advertises the module as reusable ("The Phase 6 IRCv3 listener facade reuses the SHAPE … a peer module will live alongside under the same shape template") and `AuthFSM.new/1` only validates `:password` presence, not byte safety. A Phase 6 caller wiring credentials from a different write path (or a test/REPL fixture) can smuggle CR/LF into `realname` and inject an arbitrary command.

**Fix:** In `new/1`, run `Identifier.safe_line_token?/1` against `nick`, `realname`, `sasl_user`, `password` (when present). Return `{:error, {:unsafe_field, :realname}}` etc. on rejection. This makes the AuthFSM self-defending and decouples it from the Networks.Credential schema.

### S6. `Logger.metadata(opts.logger_metadata)` accepts arbitrary keys without allowlist enforcement
**File:** `lib/grappa/irc/client.ex:473`
**Category:** logger metadata hygiene / silent log loss
`Logger.metadata/1` is called with `opts.logger_metadata` whose keys are not validated against the `config :logger, :console, metadata: [...]` allowlist in `config/config.exs`. The Erlang Logger silently drops non-allowlisted keys at format time — which is exactly the failure mode the project memory `project_logging_format` warns about ("extend `config/config.exs` allowlist before using new keys"). A future caller passing `logger_metadata: [foo: "bar"]` will see no error AND no `foo=bar` in the output.

**Fix:** Document the allowlist contract in the `Client.opts` typespec / moduledoc; consider a compile-time / start-time assertion that `opts.logger_metadata`'s keys are a subset of the configured allowlist (read via `Application.get_env(:logger, :console)`). At minimum add a Credo macro check or a one-line `Enum.each` check at `init/1`.

## MEDIUM

### S7. `Boundary` `exports` omits `Parser` despite Phase 6 reuse contract
**File:** `lib/grappa/irc.ex:20`
**Category:** boundary contract / discoverability
Boundary annotation: `exports: [AuthFSM, Client, Identifier, Message]`. The moduledoc and `Parser` itself describe the parser as the "Single source of truth" reused by both `IRC.Client` (upstream reads) AND `Grappa.IRCv3.Listener` (Phase 6 downstream). If the listener facade lives inside the IRC boundary this is fine; if it lives in a sibling boundary (`Grappa.IRCv3`), Boundary will reject the `Parser` import and the design intent breaks.

**Fix:** Add `Parser` to `exports` now (free) so the contract is explicit and Phase 6 work doesn't get blocked on an unrelated boundary edit. Or document explicitly in the moduledoc that the Phase 6 listener will live inside the IRC boundary.

### S8. `process_line` forwards `{:irc, msg}` to `dispatch_to` BEFORE FSM stop is decided
**File:** `lib/grappa/irc/client.ex:589-619`
**Category:** event ordering / supervision race
`process_line/2` does `send(state.dispatch_to, {:irc, msg})` then `run_fsm_step/2`. If the FSM returns `{:stop, reason, ...}`, the Session has already received the message in its mailbox before the link kill arrives. Today this is benign — but for `:authenticate` and SASL-numeric messages, the Session's catch-all swallows them (per the comment). For `{:nick_rejected, _, _}` the Session may have a numeric_router handler that emits a partial scrollback row before the link kill terminates it. Net: scrollback rows can persist for a session that's about to be murdered.

**Fix:** Either dispatch AFTER `run_fsm_step` succeeds (and skip the send on `:stop`), or document the ordering contract explicitly in the moduledoc — Session.Server callers MUST be tolerant of a final pre-crash message landing in the mailbox.

### S9. `parse_prefix` order-dependence: nick containing `.` parses correctly only because `!` clause runs first
**File:** `lib/grappa/irc/parser.ex:308-328`
**Category:** parser exhaustiveness / brittle precedence
The `cond` chain is precedence-sensitive: `String.contains?(raw, "!")` first, THEN `"@"`, THEN `"."`. A prefix like `irc.example.com!user@host` (host with `.` containing a `!` from a malicious peer) classifies as `{:nick, "irc.example.com", "user", "host"}` — wrongly typed as a nick when the leading token is clearly a hostname. Also: `nick.with.dots@host` (no `!`) hits the `"@"` clause as `{:nick, "nick.with.dots", nil, "host"}` — accidentally correct, but only because `"@"` is checked before `"."`.

This works for the conventional shapes but the precedence is undocumented and a future refactor that reorders clauses breaks subtle invariants.

**Fix:** Document precedence rationale inline at the `cond` (ordering matters: `!` → `@` → `.`). Add a parser test pinning the bare-`.`-in-nick case (`nick.with.dots@host`) so future refactors can't reorder silently.

### S10. `take_prefix` / `take_tags` rely on `String.split(_, " ", parts: 2)` — leading-space handling differs from RFC trim spec
**File:** `lib/grappa/irc/parser.ex:178-185, 299-306`
**Category:** parser tolerance / edge cases
`take_tags("@" <> rest)` splits on first ` ` then `String.trim_leading(after_tags)`. RFC 2812 says ONE space separates components — the parser is liberal in accepting multiple spaces, which is fine. But: a tag blob like `@key=val\twith\ttab CMD` (where `\t` is a literal tab) won't be split at the tab; the tab becomes part of the tags blob and corrupts `parse_tags`. RFC 2812 strictly says "SPACE = %x20" so tabs aren't valid separators — but real IRCds occasionally emit them.

**Fix:** Either document strict-SPACE-only behavior in the parser moduledoc OR switch separators to `~r/[ \t]+/` matching the IRCv3 message-tags spec. Add a test case for tabs in the params boundary.

### S11. `latin1_to_utf8` fallback's `_` arm is documented dead but not asserted
**File:** `lib/grappa/irc/parser.ex:392-397`
**Category:** dialyzer-vs-runtime / dead code documentation
The comment notes the catch-all `_` arm is "dead at runtime; it pins the return type to `binary()` for the typechecker." If it ever fires it returns the un-decoded bytes which will then hit `String.trim_leading` (bytewise OK) and feed into `parse_line`, propagating raw latin1 bytes into the domain in violation of the "downstream sees UTF-8 only" invariant.

**Fix:** Either crash loud (`raise`) on the impossible arm so a future Erlang version change in `:unicode.characters_to_binary/3` semantics surfaces immediately, or keep the silent fallback but ADD a `Logger.error` so an operator can grep "irc latin1 fallback failed" to detect the impossible-but-not-anymore case.

### S12. `IRC.Message.sender_nick/1` returns `@anonymous_sender` for `{:nick, nil, _, _}` but the `_` may also include an empty-string nick-equivalent
**File:** `lib/grappa/irc/message.ex:134`
**Category:** input-shape exhaustiveness
The clause normalizes `{:nick, nil, _, _}` to `"*"` (the parser's `nilify/1` ensures empty becomes nil). But there's no clause for `{:nick, "", _, _}` — it would fall into `{:nick, nick, _, _}` and return `""`, violating the `@spec :: String.t()` (nominally non-empty) contract. The parser's `nilify/1` should make this unreachable in production paths, but a synthetic test fixture, REPL call, or Phase 6 listener with a different parser could pass `{:nick, "", _, _}`.

**Fix:** Add a defensive clause `def sender_nick({:nick, "", _, _}), do: @anonymous_sender` BEFORE the catch-all `def sender_nick({:nick, nick, _, _}), do: nick`, with an inline comment matching the parser-side `nilify/1` rationale. Or strengthen `@spec` to `String.t() | nil` and audit downstream consumers.

### S13. `IRC.Client` `init/1` Logger.warning for TLS posture fires per session, not per network — log noise + audit dilution
**File:** `lib/grappa/irc/client.ex:480-482`
**Category:** observability shape / log signal-to-noise
Every Session.Server start (cold deploy, hot reconnect, restart-loop on bad credentials) emits `phase 1 TLS posture: verify_none — no certificate chain validation. Phase 5 hardens this.` In a production deployment with N TLS networks reconnecting on cold deploy, the operator log fills with N copies of the same message — burying real warnings. The original CP10 finding S24 already pushed this to "move to Bootstrap" which would emit ONCE per startup.

**Fix:** Move TLS warning emission to `Grappa.Bootstrap.run/0` (one summary line per cold start: "TLS posture: verify_none on 3 networks: azzurra, libera, oftc"); keep the per-session `init/1` clean.

### S14. `IRC.Client.send_invite/3` arg order vs RFC arg order is doc-only — code review trap
**File:** `lib/grappa/irc/client.ex:312-320`
**Category:** API ergonomics / footgun
The function is `send_invite(client, channel, nick)` (Grappa convention: target context first), but the wire is `INVITE <nick> <channel>` (RFC order). Docstring documents the discrepancy correctly, but the helper's arg order is opposite to `send_kick(client, channel, nick, reason)` where the wire AND function args agree. The asymmetry between `send_invite` (channel first in API, nick first on wire) and `send_kick` (channel first in both) is a future copy-paste bug source.

**Fix:** Either rename to `send_invite(client, nick, channel)` (matching the wire) and update callers in Session.Server, OR add a static-string test that asserts the produced bytes (`assert produces "INVITE bob #foo\r\n"` from `send_invite(c, "#foo", "bob")`) so the arg-vs-wire mapping is pinned.

### S15. `take_tags` does not enforce the IRCv3 4096-byte tag-blob limit
**File:** `lib/grappa/irc/parser.ex:178-198`
**Category:** parser DoS surface
IRCv3 message-tags §2.3 caps the tag blob at 4096 bytes (excluding the leading `@` and trailing space). The parser accepts arbitrary length, so a hostile upstream can send `@x=<2MB-of-data> PRIVMSG #x :hi` and the parser dutifully builds a 2MB-keyed map. With `:packet, :line` the OS framing already caps line size at the ALC default (no explicit `:line_length` set in `do_connect`), so this is bounded by `:gen_tcp`'s default — but the default is large (typically 64KB) and tag-blob alone can fill it.

**Fix:** Either set `packet: :line, line_delimiter: ?\n, packet_size: 4096` (strict IRC line cap) on `do_connect`, OR truncate/reject tag blobs >4096 bytes in `take_tags/1` with a parser error.

## LOW

### S16. `parse_command_and_params` empty-line handling collapses through `parse_line` but error type isn't explicit
**File:** `lib/grappa/irc/parser.ex:341-348`
**Category:** error-type taxonomy
`parse_command_and_params("")` returns `{:error, :no_command}`. But the only way the empty case is reachable is when prefix-only / tags-only lines reach `parse_command_and_params` with empty rest. The `:no_command` atom is good — but the `parse_error` typespec union is only `:empty | :no_command` and there's no doctest pinning the distinction. An operator grepping for `irc parse failed reason=:no_command` won't easily understand it from the type alone.

**Fix:** Add a moduledoc table mapping each `parse_error` atom to "what shape produced this" with a one-liner.

### S17. `IRCServer` test helper accept budget is hardcoded 30s — no escape valve for stress tests
**File:** `test/support/irc_server.ex:137`
**Category:** test maintainability
The 30s `gen_tcp.accept` timeout is documented but hardcoded. A future stress test (e.g. spinning 50 sessions through 50 IRCServers) where setup is intentionally slow will hit this ceiling and fail with `{:error, :timeout}` from accept — diagnosing this requires reading the comment.

**Fix:** Accept timeout via `start_link` opt with default 30s, e.g. `start_link(handler, initial_state, accept_timeout_ms \\ 30_000)`. Note CLAUDE.md "No default arguments via `\\`" — alternative is a 4-arity overload. Either way, parameterize.

### S18. `IRCServer.handle_info({:tcp, sock, line}, ...)` does not handle `:tcp_error`
**File:** `test/support/irc_server.ex:198-216`
**Category:** test helper exhaustiveness
The test fake handles `:tcp` and `:tcp_closed` but not `:tcp_error` (e.g. peer RST under load). On `:tcp_error` the message lands in the catch-all (which doesn't exist — there's no catch-all `handle_info`!). Erlang treats unmatched `handle_info` as a raised `FunctionClauseError`, which crashes the server mid-test with an unhelpful trace.

**Fix:** Add `def handle_info({:tcp_error, _, _}, state), do: {:noreply, state}` (or drain waiters with `{:error, :tcp_error}` mirroring the `:tcp_closed` arm) AND a catch-all `def handle_info(_, state), do: {:noreply, state}` for forward compatibility.

### S19. `Client.handle_call({:send, line}, ...)` uses pattern-match assertion `:ok = transport_send`, no error reporting
**File:** `lib/grappa/irc/client.ex:535-538`
**Category:** error semantics / observability
`:ok = transport_send(state, ensure_crlf(line))` raises `MatchError` on `{:error, _}` from `:gen_tcp.send`. The Client GenServer crashes, the linked Session crashes, the Supervisor restarts both. That's correct OTP — but the operator log just shows `MatchError` with no context about which verb was being sent. `transport_send` errors include `:closed`, `:einval`, etc. — distinguishable, useful debugging signal.

**Fix:** `case transport_send(...) do :ok -> {:reply, :ok, state}; {:error, reason} -> {:stop, {:transport_send_failed, reason}, {:error, reason}, state} end` so the supervisor sees a structured reason and the operator log line is greppable.

### S20. `AuthFSM.parse_cap_list/1` over-allocates on every CAP arrival
**File:** `lib/grappa/irc/auth_fsm.ex:451-456`
**Category:** allocation efficiency / minor
`String.split(blob, " ", trim: true) |> Enum.map(...) |> Enum.reject(&is_nil/1)` does three passes over the cap list. The `is_nil` reject is documented as defensive (List.first never returns nil for trim:true output), so it's a guaranteed no-op pass. Cost is negligible (CAP lists are tiny) but the redundant pass is documented as "defensive belt-and-braces" — at minimum drop the `Enum.reject` and replace with a `Enum.map` that's correct-by-construction (split on `=` returns at least one element by `String.split` contract; first is always a string).

**Fix:** Either drop the reject (correct-by-construction), or replace with `Enum.map(&hd(String.split(&1, "=", parts: 2)))` — same semantics, no nil-shape branch.

### S21. `IRC.Client` `process_line` parse failure swallows the error without surfacing to dispatch_to
**File:** `lib/grappa/irc/client.ex:600-604`
**Category:** observability / dispatch contract
On `{:error, reason}` from `Parser.parse`, the Client emits a `Logger.warning` and re-arms `active: :once`. The Session.Server never knows the parse failed — and a parse failure on a critical line (e.g. malformed 001) means the Session sits in `:pending` forever waiting for an event it'll never get. Today the only documented `parse_error` values are `:empty | :no_command`, both benign, so this is theoretical. But the contract gap is: if the parser ever expands its error taxonomy (e.g. `:tag_blob_too_big` per S15), a real failure could silently strand a session.

**Fix:** Forward parse errors to dispatch_to as `{:irc_parse_error, reason, raw_line}` so Session.Server can decide — at minimum log with full session metadata, possibly increment a telemetry counter.

### S22. No parser test pinning the `params >14` truncation behavior (RFC 2812 §2.3 grammar limit)
**File:** `test/grappa/irc/parser_test.exs`, missing
**Category:** test coverage gap
RFC 2812 §2.3 grammar caps middle params at 14 (`*14( SPACE middle ) [ SPACE ":" trailing ]`). The parser does NOT enforce this — it splits unboundedly. Real-world IRCds either truncate or reject overlong param lists. This is fine for liberal-input parsing, but there's no documented test pinning either "we accept >14 middle params" or "we cap at 14" as the intended behavior.

**Fix:** Add a test asserting the current behavior (accept arbitrary count) so a future "RFC-strict" change doesn't accidentally break consumer assumptions.

### S23. `IRC.Client.send_kick/4` reason is unconditional — IRC allows reason-less KICK
**File:** `lib/grappa/irc/client.ex:295-302`
**Category:** API completeness / minor
`KICK <channel> <nick>` (no reason) is legal RFC 2812 §3.2.8. The current arity-4 helper requires a reason; a reason-less kick is impossible. The default-arg ban (CLAUDE.md) precludes `send_kick(c, ch, n, reason \\ "")`; the right shape is two arities or a `send_kick_no_reason/3`. Today the operator is forced to pass `""` which sends `KICK #foo bob :\r\n` — the empty trailing colon is technically RFC-valid but some ircds normalize the kick reason to "" (with displayed `<nick> kicked by <kicker> ()`).

**Fix:** Either decide "always require reason" and document, or add `send_kick/3` arity that omits the trailing colon entirely.

### S24. `IRC.AuthFSM.maybe_send_pass` PASS line interpolates raw password without doc-locking the upstream invariant
**File:** `lib/grappa/irc/auth_fsm.ex:166-171`
**Category:** documentation gap / invariant locking
The `"PASS #{pw}\r\n"` interpolation is correct iff `pw` is `safe_line_token?` true. The Networks.Credential validator enforces this on the write path, but the AuthFSM has no inline reference to that contract. Future readers grepping for "where do we trust password byte safety" find no answer.

**Fix:** One-line comment: `# Caller invariant: pw is safe_line_token? (enforced by Networks.Credential.validate_safe_line_token/2 on the write path).` — and ideally lift to the moduledoc as a "Caller contracts" section.

### S25. `IRC.Message.tag/2` and `tag/3` accept only binary keys but moduledoc never documents this
**File:** `lib/grappa/irc/message.ex:148-157`
**Category:** spec hygiene
The `is_binary(key)` guard rejects atom keys. A future caller writing `Message.tag(msg, :time)` will hit `FunctionClauseError` rather than getting a useful error. Docstring doesn't document the binary-only contract.

**Fix:** Mention "key is binary (the IRCv3 wire-format string)" in the docstring; consider raising `ArgumentError` with a helpful message when the guard fails (still an exception, but more diagnostic).

## Summary
- 1 CRITICAL, 5 HIGH, 9 MEDIUM, 10 LOW (25 total)
- Top 3 themes:
  1. **Auth FSM phase guards are incomplete** — the `:registered` post-handshake guard exists but pre-handshake phases leak SASL credentials on stray AUTHENTICATE (S1, S5).
  2. **Outbound-helper validation is asymmetric** — `send_join`/`send_part`/`send_privmsg` skip identifier validation that every other helper enforces (S2, S3); the AuthFSM trusts upstream-validated credentials without self-defense (S4, S5, S24).
  3. **Library-extraction posture is half-baked** — modules are documented as Phase-6 / hex-extract reusable but rely on Networks.Credential / Logger config externally (S5, S6, S7, S15, S24); module contracts need to be self-contained before split is possible.
