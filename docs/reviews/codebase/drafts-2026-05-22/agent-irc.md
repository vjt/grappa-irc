# IRC scope — 11 findings (0 CRIT, 1 HIGH, 6 MED, 4 LOW)

Scope: `lib/grappa/irc/{parser,client,message,auth_fsm,identifier}.ex` plus
the matching test files under `test/grappa/irc/`. Read against CLAUDE.md
project rules (charset boundary, no defaults, atoms-or-typed-literals,
no silent-swallow, log honesty, OTP discipline) and CP38 cluster
context.

The boundary is in excellent shape overall — the prior IRC reviews
(2026-05-08 IRC S1-S4, 2026-05-12 irc/S2-S6, cluster #10) have already
landed the defensive guards (CRLF/NUL strip, AuthFSM phase guards, SASL
credential-leak fix, send-helper validation funnels). The findings below
are remaining gaps in correctness, defensive-self-check parity, and
typed-error fidelity.

---

### S1. AuthFSM `:sasl` request collapses both caps when only `labeled-response` is NAK'd
**File:** `lib/grappa/irc/auth_fsm.ex:411-431, 390-391`
**Category:** exhaustiveness
**Severity:** HIGH
When `auth_method: :sasl` and the server advertises both `sasl` and
`labeled-response`, `finalize_cap_ls/2` sends
`CAP REQ :sasl labeled-response` (atomic per IRCv3). If the server NAKs
the combined request (it must ATOMICALLY reject all caps when it can't
serve one), `handle_cap([_, "NAK", _ | _], %{phase: :awaiting_cap_ack})`
unconditionally collapses to `cap_unavailable/1` → `{:stop, :sasl_unavailable}`.
The FSM never retries with `CAP REQ :sasl` alone, even though the
server explicitly advertised SASL support. A `:sasl`-required credential
restart-loops permanently against a server that only happens to
mis-implement `labeled-response`. Bahamut + Solanum variants are known
to behave this way for unfamiliar caps.
**Fix:** On NAK during `:awaiting_cap_ack`, if the prior REQ included
`labeled-response` alongside `sasl`, retry with `CAP REQ :sasl` alone
before declaring `:sasl_unavailable`. Carry the "what we requested"
list on FSM state (today's struct only has `caps_buffer` for LS reply
collection — we don't remember our last REQ blob) so the retry knows
what to drop. Same logic applies to `:auto` (today the bug is silent —
session continues without SASL even when SASL was on offer).

---

### S2. AuthFSM `new/1` does not validate nick/realname/sasl_user **syntax** — only CR/LF/NUL
**File:** `lib/grappa/irc/auth_fsm.ex:158-181`
**Category:** exhaustiveness
**Severity:** MEDIUM
`validate_line_safe/1` only checks `safe_line_token?/1` (rejects
CR/LF/NUL). A nick containing a space, or starting with `-` or a digit,
or longer than 30 chars, passes `new/1` but lands at the upstream as
`NICK foo bar\r\n` (split into two tokens) or as a `432 ERR_ERRONEUSNICKNAME`
returning the `:nick_rejected` stop reason. Today `Networks.Credential`'s
changeset validates nick syntax, but the FSM docstring at lines 119-128
explicitly claims self-defense for Phase 6 listener reuse + bypass-the-
schema REST callers. The defense-in-depth promise is incomplete.
**Fix:** Extend `validate_line_safe/1` (or add a sibling
`validate_identifier_syntax/1`) to delegate to
`Identifier.valid_nick?/1` for `:nick` and `Identifier.safe_line_token?`
+ a no-space check for `:realname`/`:sasl_user`. Return
`{:error, {:invalid_nick, value}}` etc. so callers can distinguish
"unsendable byte" from "RFC-invalid identifier."

---

### S3. `parse_prefix/1` accepts `nick!user!more@host` (multiple `!`s) — `!` is RFC-illegal in `user`
**File:** `lib/grappa/irc/parser.ex:308-328`
**Category:** parser-leniency
**Severity:** MEDIUM
`String.split(rest, "!", parts: 2)` means a prefix like
`"foo!bar!baz@host"` produces `{:nick, "foo", "bar!baz", "host"}` — the
`!` in `user` is preserved verbatim. RFC 2812 §2.3.1 forbids `!` in
the user component; a real upstream wouldn't emit this, but the parser
is the gate against malformed/hostile input. The leniency means
downstream consumers (Scrollback row writes, sender-badge rendering)
see a user field that fails `Identifier.valid_nick?/User-shape` checks
silently — no error path triggers.
**Fix:** Either reject the prefix (return `{:nick, _, nil, _}` and let
the line go through with a degraded prefix), or normalize the user
field via a stricter regex. The "preserve verbatim + let downstream
deal with it" stance is fine as long as downstream consumers actually
check; today none do.

---

### S4. `Identifier.canonical_channel/1` uses Unicode `String.downcase/1`, ignoring IRC casemapping
**File:** `lib/grappa/irc/identifier.ex:98-103`
**Category:** charset-boundary
**Severity:** MEDIUM
RFC 2812 §2.2 defines IRC casemapping as "Scandinavian": `{}|^` are
lowercase equivalents of `[]\~`. The `CASEMAPPING=rfc1459` ISUPPORT
token is still advertised by some networks (older ircds, Bahamut
variants). `String.downcase("#FOO[]")` yields `"#foo[]"` (correct on
ASCII/none) but the same network's `#foo{}` is the SAME channel under
rfc1459 — the bouncer would route them to two different windows,
scrollback row sets, read-cursors, and PubSub topics. The UX-4 bucket
A docstring explicitly states the rule but the implementation only
covers `ascii` casemapping.
**Fix:** Track the active `CASEMAPPING` value from ISUPPORT (numeric
005) on the Session state and route `canonical_channel/2` through an
arity-2 form that takes the casemap. For Phase 1 the simpler answer is
to document explicitly that only `ascii`/`none` networks are supported
and add an ISUPPORT check at registration time that logs a warning if
the server announces `rfc1459`.

---

### S5. `transport_setopts` `:ok = …` assertion can crash on `{:error, :closed}` race
**File:** `lib/grappa/irc/client.ex:734, 749`
**Category:** defensive-rescue / let-it-crash-boundary-alignment
**Severity:** MEDIUM
After a parse-error or successful `run_fsm_step`, the recv-loop calls
`:ok = transport_setopts(state, active: :once)`. The inline comment
(line 744-747) claims this "cannot fail for a transport-level reason
short of the socket already being gone." But `:inet.setopts/2` and
`:ssl.setopts/2` CAN return `{:error, :closed}` / `{:error, :einval}`
when the peer RST has already landed (race against the `:tcp_closed`
info message yet to be delivered). The `:ok = …` MatchError crashes
the Client; the supervisor restarts it. Functionally let-it-crash is
the right answer here, but the comment says "the next info-message
will stop us" — that's only true if the assertion match SUCCEEDS;
when it fails, the MatchError beats the info message. Either the
assertion is honest belt-and-braces (then drop the misleading comment
and accept the crash) or we should handle the error path.
**Fix:** Drop the `:ok = ` and discard via `_ = `; the next `:tcp_closed`
/ `:ssl_closed` will stop the GenServer cleanly. Or update the comment
to "let-it-crash on setopts failure — supervisor restarts." Consistency
with the `_ = transport_send/2` discard pattern just above is also
desirable.

---

### S6. `parse_tag/1` accepts empty tag key `""` silently
**File:** `lib/grappa/irc/parser.ex:193-198`
**Category:** parser-leniency
**Severity:** MEDIUM
`String.split("=foo", "=", parts: 2)` → `["", "foo"]`, producing a
map entry `%{"" => "foo"}` in `tags`. Downstream consumers using
`Message.tag(msg, "")` would retrieve the value; nothing rejects the
empty key. IRCv3 message-tags §3.2 requires `key-name = ( letter /
digit ) *( letter / digit / "-" )` — empty key is malformed. As with
S3, the leniency just shifts the rejection point to consumers that
don't actually check.
**Fix:** Skip empty-key tag entries in `parse_tag/1` (return a sentinel
that `parse_tags/1` filters out), or reject the whole line with a new
`parse_error :: :malformed_tag`. Documenting "empty key tags dropped"
in the moduledoc would also work.

---

### S7. `auth_fsm.ex:289-291` — `{:numeric, 903}` arm has no phase guard
**File:** `lib/grappa/irc/auth_fsm.ex:289-291`
**Category:** exhaustiveness
**Severity:** MEDIUM
The post-`:registered` catch-all at line 262 absorbs 903 in `:registered`,
so the practical impact is small. But the 903 arm at 289 has no phase
pin. A stray 903 in `:awaiting_cap_ls` or `:pre_register` (buggy/hostile
upstream emitting SASL-success without our having SASL-initiated)
would unconditionally collapse phase to `:pre_register`, clear
`caps_buffer`, and emit `CAP END\r\n`. Whatever LS work was in flight
gets discarded; the FSM is now in `:pre_register` with no NICK/USER
retry path. Same issue with 904/905 → `{:sasl_failed, code}` arm at
line 293-295: a stray 904 mid-LS crashes the session even though we
never sent AUTHENTICATE. The 432/433 arm at 316-319 has the same
shape. C1 (line 280) explicitly pinned the AUTHENTICATE arm to phase
`:sasl_pending` — same logic should apply to 903/904/905.
**Fix:** Add `%{phase: :sasl_pending} = state` pin to the 903 arm
(line 289) and the 904/905 arm (line 293); add a corresponding
catch-all just below that absorbs stray SASL-related numerics in
non-SASL phases. The 432/433 arms should pin to `:pre_register`,
`:awaiting_cap_ls`, `:awaiting_cap_ack` (i.e. anything pre-registered).

---

### S8. Inspect-derive on AuthFSM struct redacts `:password` — but Client struct holds the FSM and `inspect/1` cascades
**File:** `lib/grappa/irc/auth_fsm.ex:102-111`, `lib/grappa/irc/client.ex:115-128`
**Category:** untyped / credential-leak surface
**Severity:** LOW
`AuthFSM` defstruct has `@derive {Inspect, except: [:password]}`, good.
But `Client.t()` embeds `fsm: AuthFSM.t()` and has no `@derive Inspect`
of its own — `inspect/1` on a Client struct delegates to the default
formatter which respects the FSM's derive. Verify the cascade actually
holds (it does in BEAM today). Less concerning: there's no `@derive
{Inspect, except: [:fsm]}` on the Client itself, so `:sys.get_state(client)`
shows the FSM struct including `password: "[FILTERED]"` (correct), but
any future refactor that lifts `password` onto `Client.t()` directly
loses the redaction silently.
**Fix:** Add a defense-in-depth `@derive {Inspect, except: [...]}` to
`Client` if any secret-bearing field ever lands there. Today this is
an observation, not a bug — flagged so the next person touching the
struct remembers the invariant.

---

### S9. `Identifier.valid_host?/1`: redundant `s != ""` guard
**File:** `lib/grappa/irc/identifier.ex:126`
**Category:** dead-code
**Severity:** LOW
`@host_regex ~r/^[^\s\x00-\x1f\x7f]+$/` requires at least one char
via `+`, so `Regex.match?` against `""` already returns `false`. The
`s != ""` guard is redundant.
**Fix:** Drop the `s != ""` in `def valid_host?(s) when is_binary(s)
and s != "")`. Minor cleanup.

---

### S10. `Identifier.services_sender?/1`: four redundant channel-sigil clauses
**File:** `lib/grappa/irc/identifier.ex:191-196`
**Category:** dead-code
**Severity:** LOW
`String.downcase("#foo")` is `"#foo"`, which is not in `@services`. The
four `def services_sender?("#" <> _), do: false` (and `&`, `+`, `!`)
clauses short-circuit before the `in @services` check, but they only
duplicate the result the catch-all already produces. The comment
justifies them as "by definition NOT services" — true, but the
allowlist check already enforces that. Keeping them is fine for
readability; removing them is also fine.
**Fix:** Optional. Either drop the four clauses and let the
allowlist arm cover the case, or document explicitly that they exist
only for fast-path / intent-signalling reasons (not correctness).

---

### S11. `Client.send_away/2` accepts empty-string `reason` → emits `AWAY :\r\n`
**File:** `lib/grappa/irc/client.ex:324-328`
**Category:** exhaustiveness
**Severity:** LOW
`safe_line_token?("")` is `true` (no CRLF/NUL), so `send_away(client, "")`
emits `AWAY :\r\n` with an empty trailing parameter. RFC 2812 §4.6
treats absent vs present trailing differently: bare `AWAY` unsets,
`AWAY :text` sets. Behavior of `AWAY :` (empty trailing) is ambiguous
— most servers treat it as set-to-empty-string, some as unset. The
two-function shape (`send_away/2` vs `send_away_unset/1`) was added
specifically to make the distinction explicit at the call site;
allowing `""` re-introduces the ambiguity.
**Fix:** Reject empty `reason` in `send_away/2` with
`{:error, :invalid_line}`, or route empty-string to
`send_away_unset/1`. The first preserves the "two paths, two
behaviors" intent; the second silently does what the caller probably
meant.
