# Codebase Review — 2026-04-26 (post-Phase-2 close, pre-2i)

**Trigger:** CLAUDE.md gate enforced every 12 sessions or 2 weeks. S15
was last codebase review (2026-04-25); S28 trips threshold. This is the
post-Phase-2 trip — 19 commits / +5491 / -501 since S20 (`phase2-auth`
branch). Review runs BEFORE sub-task 2i (Channel `connect/3` token
verify) so the auth surface is reviewed at its current widest point
(REST + Channel authz wired, UserSocket flip pending).

**Worktree:** `/home/vjt/code/IRC/grappa-phase2` @ `phase2-auth`
(19 commits ahead of unpushed local main).

**Scope:** 5 parallel agents — irc/, persistence/, lifecycle/, web/,
cross-module + infra. Each read every file in scope plus CLAUDE.md +
CP07 (S21–S28) + DESIGN_NOTES + todo (Phase 5+ deferred items
explicitly excluded from findings).

---

## Severity counts (post-deduplication)

| Tier | Count | Notes |
|---|---|---|
| **CRITICAL** | 2 | CRLF injection + scrollback cascade |
| **HIGH** | 12 | mostly schema/contract gaps, latent footguns |
| **MEDIUM** | 19 | type-spec accuracy, drift telegraphs, hygiene |
| **LOW** | 18 | naming, docs, micro-perf, log-spam |
| **TOTAL** | **51** | from 66 raw findings (15 dedup) |

Per-scope raw → dedup contribution:

| Scope | Raw | After dedup |
|---|---|---|
| irc/ | 11 | 9 (S2 grouped with S1; S9 grouped with crossmodule/L6) |
| persistence/ | 17 | 14 (S4 grouped with lifecycle/S2; S16 folded into S3; S18 withdrawn) |
| lifecycle/ | 13 | 10 (S2 + S8 grouped, S16 folded) |
| web/ | 7 | 7 |
| cross-module + infra | 17 | 11 (S1 distinct from S4 PK cast — different angle; S2 grouped with irc/S5; M2 grouped with irc/S7; L6 grouped with irc/S9; M5 grouped with web/L2) |

---

## CRITICAL

### C1. CRLF injection — REST-exploitable by any authenticated user
**Files:** `lib/grappa/irc/client.ex:181-182, 186, 190` + controllers
`lib/grappa_web/controllers/messages_controller.ex:87-92`,
`lib/grappa_web/controllers/channels_controller.ex:31-41, 51-60`
**Category:** security / wire-shape boundary

`Client.send_privmsg/3` builds the IRC line by `"PRIVMSG #{target}
:#{body}\r\n"`. Neither argument is sanitized for `\r` / `\n`.
Same shape on `send_join/2` and `send_part/2`. Body flows in unmodified
from `POST /networks/:slug/channels/:channel/messages`; `target`
is the URL `:channel_id`; the channel name on JOIN/PART comes from
controller params. An authenticated user can submit
`body = "hi\r\nQUIT :pwn\r\n"` (or `channel = "#x\r\nJOIN #other"`)
and the bouncer fires arbitrary IRC commands on its upstream socket
as the credential's identity. No exploit kit needed — `curl` reaches
it. The `Grappa.IRC.Identifier` module exists for exactly this
single-source job but isn't consulted on either path.

CLAUDE.md "IRC is bytes; the web is UTF-8 — convert at the boundary"
implies the boundary must also reject in-band control framing.

**Fix:** Reject `\r` / `\n` inside `Client.send_privmsg/3`,
`send_join/2`, `send_part/2`, `send_quit/2`, `send_pong/2` (lowest
single-source choke point). A `defguardp safe_token(s) when
is_binary(s) and :binary.match(s, ["\r", "\n"]) == :nomatch` does it
once. Return `{:error, :invalid_line}` and propagate through Session
so the controller renders 400. Add `Identifier.valid_channel?/1`
guard at the controller for the channel-name path
(belt-and-braces — `Client` doesn't trust upstream callers either).

### C2. Scrollback cascade nuked on last-user unbind
**File:** `priv/repo/migrations/20260426000003_messages_per_user_iso.exs:33`
**Category:** schema correctness / cascade semantics

The `init.exs` design comment (lines 22-26) establishes the
invariant **"Scrollback is operator-archival — when a network is
removed... its historical messages stay so the operator can re-add
the network or audit history."** The Phase 2 migration silently
inverts that: `add :network_id, references(:networks, on_delete:
:delete_all)` plus `Networks.unbind_credential/2` cascade-on-empty
(deletes the parent network when last credential is removed) means
`mix grappa.unbind_network` for the LAST user wipes every historical
scrollback row for that network. No undo. CP07/S25 design notes do
not flag the inversion. Same risk on `users` cascade — a future
`mix grappa.delete_user` (Phase 5 housekeeping) would wipe per-user
scrollback (probably intentional for users; almost certainly not
for networks).

CLAUDE.md "Total consistency or nothing" — the comment says one
thing and the schema does the opposite.

**Fix:** Change `messages.network_id` FK to `on_delete: :restrict`
(or `:nilify_all` if Phase 6 listener tolerates orphan rows). Update
`init.exs:22` comment if the invariant is being intentionally
reversed (DESIGN_NOTES entry required) — but the safer move is to
honor the original archival posture by tightening the FK.

---

## HIGH

### H1. Credential `realname` and `password` interpolated into wire without control-char validation
**File:** `lib/grappa/irc/client.ex:300, 323-324, 462` +
`lib/grappa/networks/credential.ex:113`
**Category:** security / claude-md "validate at the boundary"

Handshake builders interpolate credential fields verbatim:
`"PASS #{pw}\r\n"`, `"NICK #{state.nick}\r\n"`,
`"USER #{state.nick} 0 * :#{state.realname}\r\n"`,
`"PRIVMSG NickServ :IDENTIFY #{pw}\r\n"`. The Credential changeset
only validates `:nick` against `@nick_format`; `realname` and
plaintext `password` accept anything. A `realname` of
`"Marcello\r\nOPER root rootpw"` would inject. Operator-only writers
today (mix tasks → lower threat) but Phase 5+ exposes credential
editing over REST and the gap becomes remotely exploitable.

**Fix:** Add `Identifier.valid_realname?/1` (and arguably
`valid_password?/1` — same rule) to the single-source `Identifier`
module. `Credential.changeset/2` calls it via `validate_change/3`.
C1's CRLF guard inside `Client.send_*` is still required as defense
in depth.

### H2. `Credential.changeset/2` casts the composite primary key on update
**Files:** `lib/grappa/networks/credential.ex:98-110`,
`lib/grappa/networks.ex:201-208`
**Category:** API hygiene / future-REST footgun

`update_credential/3` loads the credential then pipes through
`Credential.changeset/2`, which `cast/3`s `:user_id` AND
`:network_id`. A caller supplying `attrs = %{user_id: other_uuid}`
silently rebinds the credential to a different user — composite PK
mutated in place. Mix tasks today construct attrs from CLI flags
only (safe), but Phase 2 plan reserves a REST credentials surface
where the changeset becomes the public boundary contract.

**Fix:** Split into `create_changeset/2` (PK-cast) vs
`update_changeset/2` (mutable fields only). Standard Ecto idiom,
removes the footgun before REST lands. Same fix retired from
`bind_credential/3` would also enforce the asymmetry at the type
level.

### H3. `Credential` schema lacks `unique_constraint([:user_id, :network_id])` — re-bind raises instead of `{:error, changeset}`
**File:** `lib/grappa/networks/credential.ex:97-116`
**Category:** error-shape divergence + boundary contract

`network_credentials` PK is `(user_id, network_id)`, but
`Credential.changeset/2` defines no `unique_constraint`. On
duplicate-bind, Ecto raises `Ecto.ConstraintError` because there's
no matching constraint declaration. The `bind_network` mix task's
`halt_changeset/2` can't catch it; operator sees a stack trace
instead of `"already bound"`. The mix task moduledoc explicitly
promises "rebinding an existing `(user, network)` credential reports
a changeset error."

**Fix:** Add
`unique_constraint([:user_id, :network_id], name: :network_credentials_pkey)`
to `Credential.changeset/2`, then translate in
`Networks.bind_credential/3` symmetric to `add_server/2`'s
`host_port_collision?/1` → `{:error, :already_exists}` mapping.

### H4. `Accounts.create_session/3` bypasses the changeset pattern
**Files:** `lib/grappa/accounts.ex:147-156`,
`lib/grappa/accounts/session.ex` (no `changeset/2` exists)
**Category:** Ecto rules / changeset discipline

CLAUDE.md "Ecto.Changeset for ALL user input. Never `Repo.insert/2`
with a raw map you didn't validate." `create_session/3` calls
`Ecto.Changeset.change/2` (no validation cast) and inserts. No
`assoc_constraint(:user)` — a stale `user_id` (user deleted between
authentication and session creation) raises raw `Ecto.ConstraintError`
instead of the `{:error, changeset}` the @spec promises. No
`validate_required([:user_id, :created_at, :last_seen_at])` to catch
a future caller that forgets a field. Session is the only schema in
the project without a `changeset/2` (User, Credential, Network,
Server, Message all have one).

**Fix:** Add `Session.changeset/2` with required-field validation +
`assoc_constraint(:user)`. `create_session/3` builds through it
like every other context function in this codebase.

### H5. `unbind_credential/2` does not stop the running `Session.Server`
**File:** `lib/grappa/networks.ex:232`
**Category:** OTP lifecycle / leaky abstraction

The transaction deletes the credential row and (when last binding)
cascade-deletes network + servers, but the running
`Grappa.Session.Server` registered under `{:session, user_id,
network_id}` survives. Cached `state.network_id` now points at a
deleted FK — next outbound `:send_privmsg` violates the messages →
networks FK and crashes the GenServer. `:transient` restart calls
`Networks.get_credential!/2` which raises `Ecto.NoResultsError`;
supervisor eventually gives up. Net effect: noisy crash loop, a
window where the operator-believed-revoked binding is still able to
send PRIVMSGs upstream, and the IRC.Client process is leaked until
the link signal arrives. Same gap exists for any future
`Accounts.delete_user/1` (FK is `:delete_all` on `users`).

**Fix:** Before deleting the credential row, look up via
`Grappa.Session.whereis/2` and `DynamicSupervisor.terminate_child/2`
(add a `Grappa.Session.stop_session/2` wrapper). Terminate BEFORE
the transaction commits so a concurrent `bind_credential/3` racing
the unbind doesn't see half-torn state.

### H6. `Bootstrap.spawn_one/2` mis-classifies `{:already_started, pid}` as `failed`
**File:** `lib/grappa/bootstrap.ex:176-192`
**Category:** Bootstrap counter semantic

The `with` chain matches on `{:ok, _}` only;
`Session.start_session/2`'s success-equivalent `{:error,
{:already_started, pid}}` falls into `else` and increments `failed`.
Bootstrap is `:transient` so a crash-and-restart re-walks the full
TOML and counters every existing session as "failed" — burying real
failures and triggering operator action for sessions running fine.

**Fix:** Add `{:error, {:already_started, _}}` clause to `else`
that logs at `:debug` and counts as `started` (or third bucket if
distinguishing first-boot vs. idempotent re-run is wanted). Counter
semantic is doc-load-bearing per the moduledoc.

### H7. `validate_length(:password, max: 256)` counts graphemes, not bytes
**File:** `lib/grappa/accounts/user.ex:65`
**Category:** charset boundary / validation correctness

`validate_length/3` defaults to `count: :graphemes`. 256 emoji
graphemes ≈ 1024 bytes — past Argon2's practical input ceiling.
Conversely, 8 multi-byte graphemes = 32 bytes passes the min check
but is entropy-poor. CLAUDE.md "Use `String.length/1` only when you
mean graphemes; use `byte_size/1` for IRC framing limits." Password
storage is byte-shaped, not grapheme-shaped — Argon2 hashes bytes.

**Fix:** Add `count: :bytes` to `validate_length(:password, ...)`,
`validate_length(:name, ...)`, and same on `Credential.nick`,
`Network.slug`, `Server.host` (IRC nicks + DNS hostnames are
byte-counted). The `:graphemes` default is the wrong choice
everywhere in this codebase.

### H8. `belongs_to :network, Network` lacks explicit `type:` at three sites
**Files:** `lib/grappa/scrollback/message.ex:131`,
`lib/grappa/networks/credential.ex:61`,
`lib/grappa/networks/server.ex:34`
**Category:** type safety / schema discipline

Default for `belongs_to` is `:integer`, which today matches
Network's autoincrement PK. But the asymmetry is striking:
`belongs_to :user, User, type: :binary_id` is consistently spelled
out at every site. The Network PK type is implicit at the call
site, requiring the reader to chase to the schema (and through any
future PK migration).

**Fix:** Add `type: :id` (or `:integer`) explicitly to all three
sites. Symmetry with `type: :binary_id`. Cheap; protects against a
future "let's slug-PK the network" refactor that wouldn't crash
compile but would silently corrupt FKs.

### H9. `password_encrypted` field name actively misleads — Cloak `:load` decrypts to plaintext
**Files:** `lib/grappa/networks/credential.ex:49`,
`lib/grappa/encrypted_binary.ex`, `lib/grappa/session/server.ex:262`
**Category:** type safety / Cloak discipline

`@type t` declares `password_encrypted: binary() | nil`. After
`Repo.one!`, Cloak's `:load` callback decrypts AES-GCM ciphertext
into the plaintext UTF-8 password — IN-MEMORY value is `String.t() |
nil`. `Session.Server.client_opts/4` passes
`credential.password_encrypted` directly as the `:password` opt to
IRC.Client expecting a String. A future contributor reading
`credential.password_encrypted` will reasonably assume they need to
decrypt before use; actual contract is "decrypted on load,
encrypted on dump." S28 `redact: true` fix addressed log leakage but
the misnaming remains a footgun.

**Fix:** (a) Rename schema field to `password` (drop `_encrypted`
since the in-memory value isn't encrypted); rename migration column
to `password_ciphertext` for the at-rest layer if you want to make
it explicit at DDL level. OR (b) keep the column name but document
the type-shapeshift prominently in the moduledoc and tighten
`@type t` to `String.t() | nil` (the load-shape is canonical
caller-facing). Current `binary() | nil` obscures that callers
pattern-match on a String.

### H10. `auth_method: :auto` default + validators rejecting `:auto`-without-password = silent restart loop
**Files:** `lib/grappa/networks/credential.ex` (default `:auto`,
validators) + `lib/grappa/irc/client.ex:218-224, 244, 472-474`
**Category:** state machine invariant / default footgun

`Credential.auth_method` defaults to `:auto`. Both the changeset
validator AND `IRC.Client.validate_password_present/1` require
non-empty password for any method except `:none`. Operator runs
`mix grappa.bind_network --auth auto` without `--password` →
Credential changeset rejects → operator must explicitly choose
`--auth none` OR supply password. But if a future code path or test
accidentally builds a credential with `auth_method: :auto, password:
nil` (the schema default), it will pass the schema enum check but
the bitstring builder `<<0, sasl_user, 0, sasl_user, 0, password>>`
crashes with `ArgumentError` if password is nil. Dialyzer can't
prove the cross-callback invariant.

**Fix:** Two parts. (a) Drop `default: :auto` from the
`Credential.auth_method` field — force operator to choose explicitly,
match the changeset validator's strictness. OR flip the default to
`:none` so the no-password path matches the no-auth contract. (b) In
`IRC.Client`, add explicit guard `defp sasl_plain_payload(%{password:
pw} = state) when is_binary(pw)` so the impossible nil case fails
loudly with a `FunctionClauseError` naming the contract instead of
`:badarg` from the bitstring builder.

### H11. Wire-shape divergence: `MeJSON.show` vs `AuthJSON.login` — no central User wire shape
**Files:** `lib/grappa_web/controllers/me_json.ex:13-16`,
`lib/grappa_web/controllers/auth_json.ex:13-17`
**Category:** wire-shape divergence

Two separate JSON renderers each hand-roll the user payload:
- `MeJSON.show` → `%{id, name, inserted_at}`
- `AuthJSON.login` → `%{id, name}`

No `Grappa.Accounts.Wire` (or similar) module owns "the user on
the wire" — symmetric to `Grappa.Scrollback.Wire` for messages.
Documented intent ("login is credential-exchange not profile
lookup") is fine as a surface choice but the two emitters drift
independently. When a third user-emitting surface lands (operator
listing, session listing showing `user.name`), the third path will
copy whichever is closer rather than read the spec. This is the
exact shape `Scrollback.Wire` exists to prevent.

**Fix:** Add `Grappa.Accounts.Wire` (or `User.to_json/1` on the
schema) with `to_json/1` returning the canonical map, plus a slim
`to_minimal/1` for the login-style 2-key form. Both renderers
delegate.

### H12. `Logger.warning("bootstrap: " <> Config.format_error(err) ...)` — inline interpolation violates structured-KV memory rule
**File:** `lib/grappa/bootstrap.ex:103, 109, 116, 123`
**Category:** logger metadata abuse

Per `~/.claude/projects/-srv-grappa/memory/project_logging_format.md`
and the CP07 logging-format invariant: structured metadata via
keyword-args, not message interpolation. Four `log_load_failure/2`
clauses concatenate the formatted error into the message string
instead of riding a metadata key. The Phase 5 JSON-formatter swap
(memory's stated end state) loses this key in the message blob.

**Fix:** Pass the formatted error as a metadata key
(`error: Config.format_error(err)`); keep static prefix
`"bootstrap config load failed — running web-only"` as the message;
extend `config/config.exs` allowlist with the new key.

---

## MEDIUM

### M1. `caps_buffer` LS-continuation clause has no phase guard (CP07 claim mismatch)
**File:** `lib/grappa/irc/client.ex:393-395`
**Category:** logic-bug / DoS surface (theoretical)

CP07 S27 claims "I4 `handle_cap` LS/ACK/NAK guarded by phase so
CAP NEW post-registration cannot re-enter SASL chain". ACK/NAK
clauses (lines 409, 418) DO have `%{phase: :awaiting_cap_ack} =
state` guards. The `[_, "LS", chunk]` clause (line 397) reaches
phase-guarded `finalize_cap_ls/2`. **But the `[_, "LS", "*",
chunk]` continuation clause has no phase guard at all** — appends
to `caps_buffer` unconditionally. A buggy/malicious upstream
sending repeated `:server CAP nick LS * :junk` post-registration
grows the in-process buffer without bound until a finalizing
non-`:awaiting_cap_ls` arrival clears it via the catch-all.

**Fix:** Add `%{phase: :awaiting_cap_ls} = state` guard to the
`[_, "LS", "*", chunk]` clause symmetric with ACK/NAK, plus
explicit phase guard on `[_, "LS", chunk]` rather than relying on
downstream to silently drop.

### M2. `MessagesController.create/2` re-preloads an already-preloaded `:network`
**File:** `lib/grappa_web/controllers/messages_controller.ex:95`
**Category:** leaky abstraction / Boundary-dep justification

`Session.send_privmsg/4` returns the message with `:network`
already preloaded — `Server.persist_and_broadcast/4` does
`Repo.preload(message, :network)` explicitly so `Wire.message_event/1`
can build the broadcast. Controller then issues a SECOND
`Repo.preload`. This is the **only** `Repo.*` call in the entire
web layer — the sole reason `Grappa.Repo` appears in `GrappaWeb`'s
Boundary deps. Removing it removes a dep-edge: web layer stops
reaching across the contracts boundary into Repo.

**Fix:** Drop the `Repo.preload`: `|> render(:show, message:
message)`. Drop `Grappa.Repo` from `GrappaWeb`'s Boundary deps.
Document on `Session.send_privmsg/4` `@spec`/moduledoc that the
returned `Message` has `:network` preloaded.

### M3. Three nick-validation regexes drift (`User.@name_format`, `Credential.@nick_format`, `Identifier.@nick_regex`)
**Files:** `lib/grappa/accounts/user.ex:46`,
`lib/grappa/networks/credential.ex:86`,
`lib/grappa/irc/identifier.ex:26`
**Category:** identifier validation inconsistency

- `User.@name_format` → `^[a-zA-Z][a-zA-Z0-9_-]*$` (Grappa user — tight)
- `Credential.@nick_format` → `^[a-zA-Z\[\]\\\`_^{|}][...]*$` (excludes leading `-`)
- `Identifier.@nick_regex` → `^[A-Za-z\[\]\\\`_^{|}\-][\w\[\]\\\`_^{|}\-]{0,30}$` (allows leading `-`)

Identifier permits leading dash (RFC 2812 violation — dash is tail-only
per §2.3.1); Credential excludes it. A nick passing the upstream
parser would be rejected by the Credential changeset, or vice versa.
Phase 2 plan A decided "Phase 2 nick syntax: same as Identifier"
but the implementations diverge.

**Fix:** Drop `\-` from `Identifier.@nick_regex` first-char set.
Pull the corrected regex into `Identifier` as the single source
(already exported). `Credential.changeset/2` calls
`validate_change(:nick, fn _, n -> if Identifier.valid_nick?(n),
do: [], else: [{:nick, "invalid IRC nick"}] end)` — same pattern
`Scrollback.Message` already uses for `:channel` and `:sender`.

### M4. `Topic.parse/1` accepts identifiers containing arbitrary characters
**File:** `lib/grappa/pubsub/topic.ex:71-87`
**Category:** topic-shape laxity

`parse/1` only checks for non-empty segments. A subscribe-time
topic `grappa:user:foo bar/network:azzurra/channel:#chan` would
parse, authz against `socket.assigns.user_name` (which the
producer side constrains via `User.@name_format`). The build
helpers (`user/1`, `network/2`, `channel/3`) only check non-empty.
A bug or attacker-supplied broadcast on `Phoenix.PubSub` directly
with a malformed topic could reach a subscribed client.

**Fix:** Tighten the BUILD-side guards to call `Identifier.valid_*?`
predicates and `Accounts.valid_user_name?/1`. parse/1 stays
permissive (accept-then-authz). Reject malformed builds at the
producer.

### M5. `Authn` plug + `FallbackController` error wire bodies use 3 different string casings
**Files:** `lib/grappa_web/plugs/authn.ex:61`,
`lib/grappa_web/controllers/fallback_controller.ex:23,28,33,46`
**Category:** wire-shape inconsistency

Wire body `error` values: `"unauthorized"`, `"invalid_credentials"`
(snake), `"not found"` (space), `"no session"` (space), `"bad
request"` (space). Five tags, three styles. Snake is the right call
(matches `AuthJSON` body keys + Cloak ciphers tag style). Clients
will pattern-match on the string. Plus: `Authn.unauthorized/1`
hand-rolls `send_resp(401, ~s({"error":"unauthorized"}))` — literal
bypassing the encoder, asymmetric with every other JSON error
going through `Phoenix.Controller.json/2` via `FallbackController`.

**Fix:** Settle on snake_case for every error string:
`"not_found"`, `"no_session"`, `"bad_request"`,
`"invalid_credentials"`, `"unauthorized"`. Funnel `Authn.unauthorized/1`
through `FallbackController.call(conn, {:error, :unauthorized})` so
the 401 body shape lives in one module.

### M6. `auth_fixtures.ex` `\\` defaults — six call sites
**File:** `test/support/auth_fixtures.ex:29,48,76,101,119`
**Category:** CLAUDE.md "no defaults via `\\`" violation

Five fixture functions take `attrs \\ []` / `attrs \\ %{}`.
Test-only — but per the rule, "When touching existing code that
uses defaults, REMOVE them." Phase 2 added `network_with_server/1`
+ `credential_fixture/3` (both with `\\` defaults) — fresh code
introducing the pattern.

**Fix:** Convert each to require the keyword/map explicitly. Tests
already pass attrs at every call site that needs them — defaulted
calls become `user_fixture([])`. (`message_event_assertions.ex:39`
+ `irc_server.ex:60`'s `timeout \\ 1_000` are debatable as config
defaults but lower stakes.)

### M7. `compose.yaml` env block omits `GRAPPA_ENCRYPTION_KEY` — dev/.env asymmetry
**File:** `compose.yaml:43-47`
**Category:** env coverage gap

`compose.yaml` (dev) sets `MIX_ENV=dev`, `GRAPPA_CONFIG`,
`DATABASE_PATH`, `ELIXIR_ERL_OPTIONS` — no `GRAPPA_ENCRYPTION_KEY`.
`config/dev.exs:21-26` hardcodes a base64 key. Works today, but
`.env.example:27` documents `GRAPPA_ENCRYPTION_KEY=` and the
`compose.prod.yaml` correctly does not pass it. A new operator who
copies `.env.example` will populate `GRAPPA_ENCRYPTION_KEY` and
reasonably expect dev to honor it.

**Fix:** Either honor the env var in dev (move dev's Cloak config
to `runtime.exs` for `:dev` too with the hardcoded value as
fallback) OR add a comment in `compose.yaml` near the env block:
"dev Cloak key is hardcoded in config/dev.exs;
GRAPPA_ENCRYPTION_KEY is prod-only."

### M8. `IRCServer.feed/2` silently swallows feeds before client connects
**File:** `test/support/irc_server.ex:118`
**Category:** test-correctness / silent-failure

`handle_cast({:feed, _}, %{sock: nil} = state), do: {:noreply,
state}`. A test that races and feeds before TCP accept lands
silently no-ops; the test then asserts on the consequent reply and
times out with no clue. This is the test-flake class CP07 lists as
outstanding (`grappa_channel_test.exs:76`).

**Fix:** Either raise loudly or buffer pending feeds and flush on
`{:accepted, sock}`. (b) is more useful for tests that
legitimately race.

### M9. `Networks.update_credential/3` `@spec` omits the raise path
**File:** `lib/grappa/networks.ex:201-203`
**Category:** Type safety / signature accuracy

Spec is `{:ok, Credential.t()} | {:error, Ecto.Changeset.t()}`,
but the impl calls `get_credential!/2` first which raises
`Ecto.NoResultsError` for unknown `(user, network)`. Per CLAUDE.md
"State the contract: signature + failure mode in one sentence" —
the signature lies about a real failure mode.

**Fix:** Either rename to `update_credential!/3` (idiomatic Elixir
`!` suffix) or split into a non-raising load-and-update.

### M10. `Grappa.Accounts.Session` lacks `@derive {Inspect, except: [:id]}` — bearer token leak
**File:** `lib/grappa/accounts/session.ex:51`
**Category:** security / credential redaction

Session's `:id` IS the bearer token (Decision A). No call site
today does `Logger.error(..., reason: inspect(session))` — only
explicit `session_id: id` — but the moduledoc invites callers to
pattern-match on the struct (boundary export). Symmetric with the
2f I3 fix on `Grappa.IRC.Client` (`@derive {Inspect, except:
[:password]}`) and the 2g I1 fix on `Credential.password_encrypted`
(`redact: true`). The credential pattern was just hardened on
review; this is the matching hole.

**Fix:** `@derive {Inspect, except: [:id]}` on
`Grappa.Accounts.Session` schema.

### M11. Bootstrap per-session start is sequential and synchronous
**File:** `lib/grappa/bootstrap.ex:131-142`
**Category:** OTP / boot performance (distinct from Phase 5
`{:continue, _}` deferred item)

`Enum.reduce(pairs, ..., &spawn_one/2)` runs `Session.start_session/2`
synchronously per pair. `start_session/2` blocks on
`DynamicSupervisor.start_child/2` which runs `Session.Server.init/1`
which spawn-links `Grappa.IRC.Client` (synchronous TCP/TLS connect
inside its own `init/1`). 10 networks × 5s connect timeout = 50s
of serialized boot before the supervision tree settles. Distinct
from the deferred Phase 5 item — even after that fix, the
Bootstrap-level serialization remains.

**Fix:** Wrap each `spawn_one` in `Task.Supervisor.async_nolink/3`
+ `Task.yield_many/2`. Or accept the serial behavior and document
WHY (single-writer sqlite under Argon2-load was test infra
reasoning; doesn't apply at boot). Add a comment either way.

### M12. `Application.put_env(:grappa, :start_bootstrap, false)` duplicated 6× across mix tasks
**Files:** `lib/mix/tasks/grappa/{create_user,bind_network,unbind_network,add_server,remove_server,update_network_credential}.ex`
**Category:** runtime config mutation duplication / DRY violation

CLAUDE.md "No `Application.put_env/2` outside `config/`" — this is
the documented escape hatch (mirrors `Application.get_env(:grappa,
:start_bootstrap, true)` in `application.ex`), but it's duplicated
six times and will be the seventh edit-site for every future mix
task. The `Mix.Tasks.Grappa.OptionParsing` shared module already
exists for `parse_server / parse_auth / parse_autojoin`.

**Fix:** Extract `Mix.Tasks.Grappa.OptionParsing.start_minimal/0`
(or rename module to `Mix.Tasks.Grappa.Common`) that does the
two-line sequence with a load-bearing comment. Six call sites
collapse to one.

### M13. `Bootstrap.spawn_all/2` skipped/failed bucket boundary conflates two config-drift modes
**File:** `lib/grappa/bootstrap.ex:130-142`
**Category:** counter semantic — operator-action coupling

If a network found in DB but credential is missing,
`Session.Server.init/1` raises `Ecto.NoResultsError` →
`start_session/2` returns `{:error, _}` → counts as `failed`. Per
moduledoc this is "transient infra" bucket, but operationally MORE
like `skipped` (config drift, not infra). The 3-bucket model is
right; the wiring conflates two distinct config-drift modes (no DB
user → skipped, no DB credential → failed).

**Fix:** Either pattern-match `Ecto.NoResultsError` inside
`spawn_one`'s `else` and route to a fourth bucket, OR document why
"missing credential" lives in `failed` (it does need operator
action via a different mix task — defensible). Pick one.

### M14. `Bootstrap.log_load_failure/2` four-clause function with near-identical bodies
**File:** `lib/grappa/bootstrap.ex:102-127`
**Category:** code shape / consistency

Four function clauses, each constructs the same string and logs at
warning-or-error with subtly different metadata. Could be one
function with a single body. Note: `Grappa.Config` is sub-task 2j
deletion target — this code may go away entirely.

**Fix:** Collapse to one clause (or accept the deletion in 2j).

### M15. `Grappa.Networks.add_server/2` and `bind_credential/3` `@spec` claim `attrs :: map()` but accept keyword
**Files:** `lib/grappa/networks.ex:110, 181`
**Category:** Type safety / @spec accuracy

Both call `Map.new(attrs)` to coerce — accept `keyword() | map()`
— but spec types only `map()`. Latent risk: future REST
controller piping `conn.params` (already a map) through some
keyword intermediate.

**Fix:** Either widen the spec to `map() | keyword()` or drop
`Map.new/1` and require map-only input (validated by guard). Pick
the stricter shape.

### M16. `Wire.t.network` typed as `String.t()` but `Network.t.slug` is `String.t() | nil`
**Files:** `lib/grappa/scrollback/wire.ex:39`,
`lib/grappa/networks/network.ex:23`
**Category:** type safety

`Wire.t` declares `network: String.t()`. `Network.t.slug` is
`String.t() | nil`. `validate_required([:slug])` enforces non-nil
at insert; the `| nil` is only true for `%Network{}` zero-state,
which never reaches Wire — but the type system permits it.

**Fix:** Tighten `Network.t.slug` to `String.t()` (zero-state is
irrelevant — callers never inspect a fresh struct field-by-field).

### M17. `Message.t` declares `kind: kind() | nil` even though changeset requires it; ad-hoc nil discipline across fields
**File:** `lib/grappa/scrollback/message.ex:122`
**Category:** type safety / consistency

Some `null: false` + `validate_required` fields carry `| nil` in
`@type t`; others don't. CP07 S25 S6 already tightened
`Wire.t.kind` for the same reason. Pick one rule.

**Fix:** Adopt: every field that is `null: false` in DB +
`validate_required` in changeset is non-nil in `t()`. The
zero-state is irrelevant.

### M18. `MeJSON.show/1` `@spec` claims `DateTime.t()` but Jason serializes to ISO8601 string
**File:** `lib/grappa_web/controllers/me_json.ex:13`
**Category:** `@spec` lies about wire shape

Spec describes the in-process pre-Jason map, not the contract the
client sees. Compare `Scrollback.Wire.t/0` which types
`server_time: integer()` matching actual JSON output.

**Fix:** Type the spec as `String.t()` and `to_iso8601/1`
explicitly in the function body (single source for the format).

### M19. `Networks.add_server/2`'s `attrs |> Map.new() |> Map.put(:network_id, ...)` allows hostile string-keyed shadow
**File:** `lib/grappa/networks.ex:113`
**Category:** Ecto rules / hostile-input hygiene

Defensive nit, not an exploit (callers today are operator mix
tasks). The same shape on `bind_credential/3` and
`update_credential/3` passes attrs through without normalization.

**Fix:** Helper `to_atom_keyed_map(attrs)` with allowlist
(mirroring `Scrollback.Meta.normalize_key/1`'s discipline). Or
stop accepting string-keyed input at the context layer and force
callers to convert at the controller boundary.

---

## LOW

### L1. `Identifier` nick regex permits `-` as first char (RFC 2812 violation)
**File:** `lib/grappa/irc/identifier.ex:26`
First-char class includes `\-`. RFC 2812 §2.3.1 allows dash only
in tail. Fix folded into M3.

### L2. No `Identifier.valid_realname?/1` predicate
**File:** `lib/grappa/irc/identifier.ex` (missing)
Per H1, realname needs a "no `\r` / `\n` / `\x00`" rule. Fix
folded into H1.

### L3. `IRC.Client.parse_/1` named with trailing underscore
**File:** `lib/grappa/irc/client.ex:476-480`
Trailing-underscore name is a tell of an early-draft "TODO:
rename" that landed. Function parses a cap-list blob.
**Fix:** Rename to `parse_caps/1`. Replace `List.first/1` with
`hd/1` and tighten `@spec` to `[String.t()]`.

### L4. `wait_for_line/3` default arg `\\ 1_000` violates CLAUDE.md
**File:** `test/support/irc_server.ex:60`
The 2f review fix-up explicitly killed `Process.sleep(20)` from
tests but left this default in place. Fix folded into M6.

### L5. `parse_prefix` returns empty-string instead of nil for trailing `@` / `!`
**File:** `lib/grappa/irc/parser.ex:208-210, 213-215`
`"nick!user@"` lands as `{:nick, "nick", "user", ""}`. Cosmetic —
`Message.sender_nick/1` only inspects nick — but inconsistent
with the missing-via-omission case which uses `nil`.
**Fix:** `empty_to_nil/1` helper applied to user and host.

### L6. `Scrollback.persist_privmsg/5` single-purpose helper — Phase 5 will need siblings
**File:** `lib/grappa/scrollback.ex:88-99`
Defer to Phase 5 design pass.

### L7. `init.exs` "edited in place" comment is now stale
**File:** `priv/repo/migrations/20260425000000_init.exs:28-37`
Comment was correct when written but is now stale: there ARE
migrations after `init` (2a, 2b, 2c, 2d, 2e). Future maintainer
will misread as "okay to keep editing init.exs in place."
**Fix:** Tighten comment to past-tense.

### L8. `messages` table has no `inserted_at` index
**File:** `priv/repo/migrations/20260426000003_messages_per_user_iso.exs:36`
Phase 5 eviction-by-age will want it. Defer.

### L9. `Session.Server.client_opts/4` returns untyped `map()`
**File:** `lib/grappa/session/server.ex:250`
**Fix:** Have `Grappa.IRC.Client` export `@type opts/0`; reference
it here. Dialyzer gains the constraint.

### L10. `Grappa.Vault` moduledoc doesn't document dev/test fallback file paths
**File:** `lib/grappa/vault.ex:12-19`
Reader investigating "how do I rotate the dev key" has to grep
config files. Add `config/dev.exs:21-26` + `config/test.exs:34-39`
file paths to the bullet.

### L11. `Grappa.Accounts.User.t()` `password: String.t() | nil` leaks virtual field into public type
**File:** `lib/grappa/accounts/user.ex:33`
Virtual `:password` is input-only (cleared after changeset cast).
Always `nil` after `Repo.get`, but type signals otherwise.
**Fix:** Drop `:password` from public `@type t`.

### L12. `endpoint.ex` moduledoc is stale post-2c
**File:** `lib/grappa_web/endpoint.ex:12-16`
Says "no auth flow today" — wrong post-2c. `Plug.Session` still
loaded but no caller uses `get_session/2` anywhere.
**Fix:** Drop `Plug.Session` + `@session_options` (less surface,
no salt-rotation pressure). Update moduledoc to bearer-token shape.

### L13. `AuthController.login/2` accepts empty-string `name`/`password`, routes to 401
**File:** `lib/grappa_web/controllers/auth_controller.ex:36-37`
Functionally indistinguishable from wrong-creds (good for oracle),
but a UI bug omitting a field gets 401 not 400.
**Fix:** Tighten guard: `name != "" and password != ""` →
`{:error, :bad_request}`.

### L14. `AuthController.logout/2` doesn't distinguish user-initiated from operator/housekeeping revoke
**File:** `lib/grappa_web/controllers/auth_controller.ex:61-64`
Right now revoke has one caller; conflation is harmless until a
second lands.
**Fix:** Add `:initiator` opt to `revoke_session/2` (`:user |
:admin | :housekeeping`) and log as metadata. Add to allowlist.

### L15. `MessagesController.preload_networks/2` — plural verb for single-network op
**File:** `lib/grappa_web/controllers/messages_controller.ex:101-105`
**Fix:** Rename to `attach_network/2`.

### L16. `AuthJSON.login/1` `@spec` widens to `map()`
**File:** `lib/grappa_web/controllers/auth_json.ex:14`
**Fix:** Tighten to `%{token: String.t(), user: %{id: Ecto.UUID.t(),
name: String.t()}}`. Mirror in `MeJSON.show/1`.

### L17. `GrappaChannel` + `UserSocket` moduledocs duplicate the "2i is next" note
**Files:** `lib/grappa_web/channels/grappa_channel.ex:29-32`,
`lib/grappa_web/channels/user_socket.ex:14-19`
Single-source the explanation in `UserSocket`; have
`GrappaChannel` reference it.

### L18. `IRC.Client` `:caps_buffer` accumulates with `++` (left-append O(n²))
**File:** `lib/grappa/irc/client.ex:394, 398`
Three or four CAP LS continuation lines is fine; future-proofing
favors prepend + reverse. Defer or comment.

### L19. TLS `verify_none` warning fires once per Client init — log spam under reconnect storm
**File:** `lib/grappa/irc/client.ex:228`
Phase 5 hardens to CA chain. Until then,
`:persistent_term`-gated "log once per (host, port)" guard.

### L20. `compose.oneshot.yaml` `restart: "no"` quoted but unexplained
**File:** `compose.oneshot.yaml:33`
Without quotes YAML 1.1 parses `no` as boolean false.
**Fix:** Add comment.

### L21. `scripts/deploy.sh` migration retry 30s vs healthcheck 60s — asymmetric, no comment
**File:** `scripts/deploy.sh:55-65, 70-77`
Either equalize or comment.

### L22. `scripts/check.sh` enumerates gates that mix.exs already owns — drift surface
**File:** `mix.exs:135`, `scripts/check.sh:11-19`
**Fix:** Drop the per-gate enumeration in `check.sh`; point at
`mix.exs:117`.

### L23. `Accounts.create_session/3` three positional args (`user_id, ip, user_agent`) — both `String.t() | nil`
**File:** `lib/grappa/accounts.ex:142-156`
Typo at call site swaps two strings without compiler help.
**Fix:** Take a map / keyword: `create_session(user_id, %{ip: ip,
user_agent: ua})`.

### L24. `Bootstrap` boundary deps lists `Grappa.Config` — telegraph for 2j drift
**File:** `lib/grappa/bootstrap.ex:60-62`
Track the dep removal in 2j checklist. No code change.

### L25. `Vault` boundary `deps: []` but is runtime-coupled to EncryptedBinary callers
**File:** `lib/grappa/vault.ex:34`
Add a comment explaining the runtime coupling and the
supervision-tree-ordering constraint.

### L26. `Scrollback.Meta` `cast/1` has no per-key value-type validation
**File:** `lib/grappa/scrollback/meta.ex:85-89, 93-94`
Today Phase 1 only writes `meta = %{}` so dormant. Phase 5
presence-event producers will exercise the type-loose path.

---

## Trajectory

### What did we build in S21–S28?

Phase 2 auth landed end-to-end across 8 sessions (19 commits / +5491
/ -501). Sub-tasks 2a-pre (Cloak Vault + EncryptedBinary), 2a
(Accounts + User), 2b (Accounts.Session bearer-token model + Authn
plug), 2c (login/logout/me + `:authn` pipeline + AuthFixtures), 2d
(Networks + Network + Server + Credential + 5 mix tasks), 2e
(messages per-user-iso wipe-and-rebuild + Wire user_id removal), 2h
(PubSub.Topic reshape + GrappaChannel.authorize/2 wired to
Topic.user_of), 2f (IRC.Client per-auth_method handshake state
machine — :auto + :sasl + :server_pass + :nickserv_identify + :none
branches with CAP ACK gate + multi-line LS continuation + NICK
rejection + SASL failure stop reasons), 2g (Session.Server DB-driven
init — `start_session(user_id, network_id)` + Credential row drives
nick/realname/sasl_user/password/auth_method/autojoin). Code-review
discipline held: every sub-task except 2a-pre got a follow-up
fix-commit. Test count went from 124 (S20 baseline) to 340 across
6 properties. ci.check fully green throughout.

### Does this serve the core mission?

**Yes — directly.** Phase 2 was always the gating step between
walking-skeleton (one hardcoded user, TOML-driven everything) and
multi-user production: bearer auth → REST gating → DB-backed
credentials → upstream SASL/PASS/NickServ across the four real-ircd
shapes. Without it, the always-on-IRC-bouncer + REST surface mission
is single-tenant only. The `auto` auth_method default was the right
call — it covers SASL-modern AND PASS-handoff-Bahamut shapes in one
default, validated against the actual Bahamut C source
(s_user.c:1273-1278) instead of guessing. The IRCv3 listener (Phase
6) becomes a mechanical query translation now that the per-user
scrollback partition exists.

The `cicchetto` PWA is still un-started, but that's strategic
sequencing not drift — auth surface had to land before the browser
client could be more than a Phase 1 demo.

### What's stalling?

- **No code on `cicchetto` yet.** The PWA framework decision
  (Svelte vs SolidJS vs lit-html) is in Medium tier of todo since
  Phase 0. Decision required before Phase 3 starts.
- **TLS `verify: :verify_none` posture.** Phase 1 expedient still
  in place; documented. Will land in Phase 5 hardening pass.
- **NickServ NOTICE reply parsing.** Per Phase 2 plan, Phase 5
  adds the correlation machinery for REGISTER proxy + GHOST/RECOVER.
  Still on the deferred list.
- **Phase 6 IRCv3 listener** — no tracking issue / spec doc
  collection yet (todo Medium).

### Observation items due for evaluation?

- **`grappa_channel_test.exs:76` flake.** Listed in todo High.
  Hit ~1-in-5 under `mix ci.check` parallelism. CP07/S22 noted "may
  resolve naturally during 2h or 2i refactors." 2h landed without
  resolving; 2i is next. Re-evaluate after 2i.
- **Sqlite "Database busy" intermittent flake.** Hit once during
  S19 ci.check; Low/Observation tier. Hit during S28 again per the
  compact summary (re-ran, deterministic 0 failures). The pattern
  is: `async: true` Repo writes + the live Pi container also
  writing to `runtime/grappa_dev.db`. Worth a separate test DB
  path — or at least a Phase 5 hardening item.

### Risk check

- **C1 (CRLF injection) is exploitable today** by any
  authenticated user via the REST surface. Severity is real, not
  theoretical. Should be the FIRST action after this review (one
  guardp + propagate through Session — small surface, big payoff).
- **C2 (scrollback cascade) is operator-action data loss.** The
  invariant comment in `init.exs` and the actual FK behavior
  contradict each other; one of them needs to win, deliberately.
- **H10 (auth_method `:auto` default + no password = silent restart
  loop).** Latent footgun — operator who omits `--password` on
  `bind_network` today gets the changeset error (good), but if
  attrs ever flow from REST without the schema-level enforcement,
  this becomes a remote DoS surface.
- **H4 (Accounts.Session no changeset).** Currently the only
  schema in the project without one. The `assoc_constraint(:user)`
  gap means a stale user_id surfaces as raw exception not
  `{:error, changeset}` — the @spec lies.
- **H5 (unbind_credential leaks Session)** — small operator-window
  but real: there's a window where the operator-believed-revoked
  binding can still send PRIVMSGs upstream as the credential's
  identity. Not exploitable from outside (operator-initiated), but
  the cleanup discipline is missing.

### Recommendation

**Before 2i: fix C1 + C2 + H10 + H4 + H5 in a single
phase2-followup commit cluster on the worktree.** All five are bugs
introduced or unfixed during the Phase 2 push; none require
architectural rework. C1 is a 5-line guardp + 3 callsites. C2 is a
one-word migration change (`:delete_all` → `:restrict`). H10 is a
default value flip + one Dialyzer-aiding guard. H4 is one new
function (`Session.changeset/2`) + one rewrite. H5 is one new
function (`Session.stop_session/2`) + one wrapping in
`unbind_credential/2`. Combined budget: half a session, with TDD.
Defer the M-tier wire-shape consolidation (M3/M5/H11), the
Boundary/dep cleanup (M2), and the `Application.put_env`
consolidation (M12) to a dedicated cleanup commit cluster after 2i
or as part of 2j (which is already a big-delete pass — natural
home for cross-cutting hygiene).

After the cluster: 2i (Channel `connect/3` token verify), then 2j
(Bootstrap → DB + grappa.toml deletion + README rewrite), then 2k
(live deploy + smoke against real Azzurra + Libera + DESIGN_NOTES
Phase 2 close pass + CP07 → CP08 rotation).

The trajectory is healthy. Phase 2 was the largest single phase to
date in commits AND in scope; landing it in 8 sessions with code
review discipline at every sub-task is the right shape. The
findings above are the natural follow-up of a fast push, not
indicators that the push moved too fast — they're the kind of
issues that surface only when you put the surface area together
end-to-end and look at it.
