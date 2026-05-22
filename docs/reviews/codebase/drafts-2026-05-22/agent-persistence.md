# Persistence scope — 17 findings (1 CRIT, 6 HIGH, 7 MED, 3 LOW)

Scope reviewed in full: `lib/grappa/scrollback*`, `lib/grappa/networks*`,
`lib/grappa/accounts*`, `lib/grappa/visitors*`, `lib/grappa/query_windows*`,
`lib/grappa/user_settings*`, `lib/grappa/repo.ex`, `lib/grappa/vault.ex`,
`priv/repo/migrations/*` (spot-coverage), `config/{runtime,dev,test,prod}.exs`,
plus `CLAUDE.md`, `docs/checkpoints/2026-05-22-cp38.md`, and selected tests.

Severity order, then file order.

---

### S1. SQLite `synchronous` PRAGMA is not pinned anywhere
**File:** `config/runtime.exs:31-55`, `config/dev.exs:3-10`, `config/test.exs:3-26`
**Category:** sqlite-pragma / data-integrity boundary
**Severity:** CRITICAL

CLAUDE.md "Explicit SQLite angle" lists `synchronous` as one of the four
canonical WAL pragmas that MUST be configured per-environment.
`config/runtime.exs:31-55` sets `journal_mode: :wal`, `cache_size`,
`temp_store`, `busy_timeout`, but **not `synchronous`**. Same omission in
`config/dev.exs` and `config/test.exs`.

This silently inherits the `exqlite` default of `synchronous: :normal`
(verified in `deps/exqlite/lib/exqlite/pragma.ex:40`). `:normal` is the
RIGHT choice for WAL on a single-disk server (durability against process
crash + acceptable risk of losing the last 0–1 transaction on OS
crash/power loss), but **it is the right choice by accident**. The whole
reason CLAUDE.md calls it out is that an `ecto_sqlite3` major version that
flips its default (e.g. to `:off` to win a benchmark) would silently turn
every prod commit into a fsync-deferred best-effort write — operator-
relevant durability would disappear with no migration, no log line, no
visible diff.

The same risk class applies to `foreign_keys`, which IS verified-on by
default in `deps/exqlite/lib/exqlite/connection.ex:478` but is not pinned
here either; the entire FK-cascade chain (visitor reap → CASCADE through
8 dependent tables; user unbind → cascade-on-empty network drop) depends
on it.

**Fix:** Pin both pragmas explicitly in the Repo config block in all three
config files. Add to runtime.exs / dev.exs / test.exs:

```elixir
config :grappa, Grappa.Repo,
  # ... existing ...
  synchronous: :normal,   # WAL durability — pin to avoid dep-default flips
  foreign_keys: :on       # CASCADE/RESTRICT chain depends on this
```

The pinned values match the current behaviour; this is a no-op at runtime
and a guard against future dep upgrades that flip defaults.

---

### S2. `Scrollback.delete_for_channel/3` does not canonicalise the channel name
**File:** `lib/grappa/scrollback.ex:670-683`
**Category:** charset / divergence-from-write-side
**Severity:** HIGH

`channel_or_dm_where/3` (line 527-559) canonicalises `channel` via
`Identifier.canonical_channel/1` at the read boundary. The write path
(`Message.changeset/2` → `canonicalize_channel/1`) does the same.
`delete_for_channel/3` only `String.downcase/1`s — it does NOT call the
sigil-aware `canonical_channel/1`.

For ASCII channel names today the two functions happen to agree (RFC 2812
folds ASCII via `String.downcase/1`), but the contract documented in
`Message.canonicalize_channel/1`'s comment ("single bypass cannot
corrupt") explicitly says the canonical form is `canonical_channel/1`.
The day someone extends `canonical_channel/1` to do anything beyond
ASCII downcase (Unicode RFC follow-up, leading-`!`-prefix stripping, …),
`delete_for_channel/3` silently deletes the wrong subset.

Worse: `delete_for_channel/3`'s fragment is
`lower(m.channel) == ^lower_channel` so it would correctly find rows
written under EITHER `#Foo` or `#foo` IF any rows had escaped
canonicalisation — but `delete_for_dm/3` (line 619-649) does the same
`String.downcase/1` on `peer`, and the read-side dispatcher
`Identifier.canonical_channel/1` returns `dm_with` UNCHANGED for nick-
shaped targets (per `canonicalize_channel` comment line 254). The two
deletes share the bug shape but were authored independently.

**Fix:** Replace `String.downcase(channel)` with
`Identifier.canonical_channel(channel)` in both `delete_for_channel/3`
and (where channel-shaped) the dispatcher in `ArchiveController`.
Single-source via the canonicalise helper exactly like
`channel_or_dm_where/3` already does.

---

### S3. `list_archive/3` query has no covering index for its `GROUP BY`
**File:** `lib/grappa/scrollback.ex:446-461`
**Category:** index coverage vs hot read pattern
**Severity:** HIGH

`list_archive/3` GROUPs BY `COALESCE(dm_with, channel)` and AGGregates
`max(server_time) + count(id)` filtered on `(subject, network_id)`. The
four current `messages` indexes are:

- `(user_id, network_id, channel, server_time)`
- `(visitor_id, network_id, channel, server_time)`
- `(user_id, network_id, dm_with, server_time)`
- `(visitor_id, network_id, dm_with, server_time)`

The planner can pick ONE of them to drive the `(subject, network_id)`
prefix, but the `GROUP BY COALESCE(dm_with, channel)` cannot be served
incrementally from any single index — the planner must sort the
intermediate result. For a heavy user (say 50k messages on a network),
this is N×log(N) per archive open.

Today the consumer is the cic sidebar archive expand — operator-driven,
infrequent. But there is no comment flagging the cost vs the per-window
fetches that have hand-tuned composites. Future archive-bound features
(infinite scroll, search) WILL hit this.

**Fix:** Either (a) add an index expression on
`(user_id, network_id, COALESCE(dm_with, channel))` and the visitor
mirror — sqlite supports expression indexes via raw `execute/1` (same
pattern `20260504130000_create_query_windows.exs` uses for
`lower(target_nick)`), OR (b) materialise an `archive_targets` table
maintained at write-time and avoid the COALESCE-group entirely. Pick (a)
for the additive low-cost path; document the cost trade in the moduledoc
so future plan authors don't burn a discovery cycle.

---

### S4. `Networks.connect/1`'s `:parked | :failed` guard quietly drops the wider type
**File:** `lib/grappa/networks.ex:389-399`
**Category:** untyped / pattern incomplete vs the closed-set state machine
**Severity:** HIGH

`Credential.connection_states/0` is `[:connected, :parked, :failed]` —
three states. `connect/1` matches `:connected` (idempotent) then
`:parked | :failed` (the transition). There is no explicit fallthrough
for "any other value" — if a fourth state ever lands in the enum (e.g.
`:locked`, foreshadowed in the windowState moduledoc), `connect/1` will
fail with a `FunctionClauseError` from the caller (`NetworksController`,
`Bootstrap`) with no actionable error.

`disconnect/2` and `mark_failed/2` have the same issue (each explicitly
patterns on a subset of the closed set).

This isn't catastrophic — let-it-crash is the right OTP shape for an
invariant violation, and CLAUDE.md says so. But the function's `@spec`
returns `{:ok, Credential.t()}` with no `{:error, _}` arm, which
declares to Dialyzer that the function ALWAYS succeeds. When the
extension to the enum lands, Dialyzer will not flag the now-buggy spec
because the new value is a runtime concern. The contract drifts silently.

Same shape in `mark_failed_by_ids/3` (`:parked` rejects, `:failed`
idempotent, `:connected` transitions, but the spec is `:ok | {:error,
:user_parked}` while the function returns `:ok` only — `:user_parked` is
absorbed inside `mark_failed/2`).

**Fix:** Either (a) tighten the spec to `{:ok, Credential.t()} | no_return`
to declare the crash-on-unknown-state contract explicitly (Dialyzer reads
`no_return`), OR (b) add an explicit fallthrough clause:

```elixir
def connect(%Credential{connection_state: other}),
  do: raise ArgumentError, "unknown connection_state: #{inspect(other)}"
```

mirroring the pattern `Scrollback.subject_where/2` already uses
(line 582-583). Pick (b) for parity with that pattern.

---

### S5. Visitor `touch/1` swallows expired-row update with `:ok` instead of the typed error
**File:** `lib/grappa/visitors.ex:136-169` (specifically `maybe_bump/1`)
**Category:** silent fall-through / leaky abstraction
**Severity:** HIGH

`touch/1` is documented (line 134-136) as `{:ok, Visitor.t()} | {:error,
:not_found | :expired | Ecto.Changeset.t()}`. The flow:

1. nil → `{:error, :not_found}` ✓
2. expires_at nil → identified visitor, `{:ok, visitor}` no-op ✓
3. expires_at past → `{:error, :expired}` ✓
4. expires_at future + maybe_bump skip → `{:ok, visitor}` ✓
5. expires_at future + maybe_bump update → returns `Repo.update/1` result,
   which is `{:ok, _} | {:error, Ecto.Changeset.t()}` ✓

OK so the spec is honored — but `maybe_bump/1` writes through
`Visitor.touch_changeset/2` which has NO validation guard against
backward-clock skew (cf. `Accounts.Session.touch_changeset/2` which DOES
have `B5.4 L-pers-3` time-monotonicity validation, line 110-138).
`Visitor.touch_changeset/2:115-118` is `change(visitor, %{expires_at:
new_expires_at})` — a system-clock step backward + per-IP-cap visitor
flow can silently slide `expires_at` backward by 48h, briefly shrinking
the visitor's TTL window.

This is the inverse of the bug that `Accounts.Session.touch_changeset/2`
fixed in B5.4 L-pers-3. The `Visitor` schema documents the rule for
anon-vs-identified (line 12-16) but not the time-monotonicity rule that
the sibling Accounts module enforces.

**Fix:** Port the `B5.4 L-pers-3` time-monotonicity guard from
`Accounts.Session.touch_changeset/2` into `Visitor.touch_changeset/2`.
The clock-skew failure mode is identical; the guard belongs on every
sliding-TTL bump verb in the codebase, not just the user-session one.

---

### S6. `Visitors.commit_password/2` runs no concurrency control on the password commit
**File:** `lib/grappa/visitors.ex:111-124`
**Category:** race / data integrity
**Severity:** HIGH

`commit_password/2` reads the visitor with `Repo.get/2`, then writes via
`Repo.update/2`. Between read and write, a concurrent operation (Reaper
deleting the row, operator deletion, another +r MODE observer racing
on the same visitor) can:

1. Delete the visitor — `Repo.update/2` then crashes with
   `Ecto.StaleEntryError` (no row matches the WHERE id=$). Caller (in
   `Session.Server`'s effect handler) gets an exception, not the typed
   `{:error, :not_found}` the spec declares (line 112).
2. Race a second `commit_password/2` call (Bahamut's +r MODE can fire
   from two different transitions during NickServ recovery): both
   succeed serially; the second wins. Both reads see
   `password_encrypted: nil`; both writes overwrite with potentially
   different ciphertexts. Last-write-wins is OK here, but the docstring
   doesn't say so.

**Fix:** Either (a) wrap in `Repo.transaction/1` with a `SELECT … FOR
UPDATE` (sqlite doesn't have row-level locking — would degrade to
serialized writes, which is essentially the sqlite single-writer behavior
already) — so the fix is really (b) catch `Ecto.StaleEntryError` (or
move to `Repo.get_by/2` + `case` re-check) and map to `{:error,
:not_found}` so the spec doesn't lie. Same fix shape needed in
`Visitors.update_nick/2` (line 446-457) for the same race class.

---

### S7. `Networks.Credentials.update_last_joined_channels/3` write is unrestricted in size at the changeset
**File:** `lib/grappa/networks/credentials.ex:167-186` & `lib/grappa/networks/credential.ex:140-145`
**Category:** ev-data integrity / write-amplification
**Severity:** HIGH

`@last_joined_max 200` is enforced **in the context module** via
`Enum.take(channels, @last_joined_max)`. The schema field
`last_joined_channels` has no length cap; `Credential.changeset/2`
casts the list verbatim and only validates per-element shape via
`validate_autojoin_channels/2`. So:

1. Any future writer that bypasses
   `Credentials.update_last_joined_channels/3` (a controller, a mix task,
   an operator-side REST surface someday) can write an unbounded list.
2. The cap is split between the schema-truth ("what fits in the column,
   forever") and a single context-function ("how callers should size their
   input"). New writer authors won't know the cap exists; they'll grep
   the schema and find nothing.

Same class as the `messages.body` length: deliberately unbounded at
sqlite. But there the cap discussion is in the schema moduledoc
("adjust at the schema layer if needed"). Here the cap is documented
in the helper function only.

**Fix:** Add a schema-level `validate_length(:last_joined_channels,
max: 200)` to `Credential.changeset/2` so the cap is enforced at every
write door, then keep the `Enum.take/2` in
`update_last_joined_channels/3` as the truncation-on-input convenience.
The two together — cap in changeset, truncate in context helper —
mirror how `messages` enforces per-kind body presence (schema) +
controller-side max-length (context).

---

### S8. `UserSettings.merge_with_defaults/1` re-reads atom keys that production cannot produce
**File:** `lib/grappa/user_settings.ex:480-508`
**Category:** dead code / cargo
**Severity:** MEDIUM

`merge_with_defaults/1` (line 480-494) uses `read_bool/3` / `read_list/3`
helpers that fall back to atom-keyed reads of `stored`:

```elixir
Map.get(stored, key, Map.get(stored, Atom.to_string(key)))
```

The stored value comes from `data[@notification_prefs_key]` — which is
JSON-decoded with string keys (the entire string-key invariant in the
moduledoc, line 36-41). Atom keys cannot occur in `stored` post-DB-
roundtrip. The atom fallback is dead.

Worse: it implies to the next reader that BOTH key shapes are possible
and they need to think about which path produces atoms (in-memory write
that hasn't hit `Repo.insert/2`? Internal `put_notification_prefs/2`
flow before `stringify_prefs/1`?). The cognitive cost of the dead
branch exceeds the LOC savings.

**Fix:** Drop the dual-key reads in `read_bool/3` and `read_list/3`;
read only the string key from `stored`. Add a comment pointing to the
string-key invariant in the moduledoc.

---

### S9. `Accounts.create_session/4` requires `opts` as a keyword list but only consumes `:client_id`
**File:** `lib/grappa/accounts.ex:193-201`
**Category:** untyped / under-specified
**Severity:** MEDIUM

The `@spec` (line 193) declares `opts :: keyword()`. Inside
`do_create_session/2` only `Keyword.get(opts, :client_id)` is read.
Any caller passing other opts has them silently dropped — no warning,
no `Logger.debug`.

This is a CLAUDE.md "atoms or `@type t :: literal | literal` — never
untyped" violation: `keyword()` is `[{atom(), any()}]`, but the API
contract is exactly `[client_id: Grappa.ClientId.t() | nil]`. Saying so
in the spec lets Dialyzer catch a future caller typo (`:cliend_id`)
and lets the next implementer see the contract without grepping
`Keyword.get` calls.

Same shape applies to `Visitors.Login.login/2`'s `opts` arg (line 150)
which accepts `keyword()` but only honors three named keys
(`:login_connect_timeout_ms`, `:login_welcome_timeout_ms`,
`:login_probe_timeout_ms`).

**Fix:** Tighten both specs to the explicit keyword shape:

```elixir
@spec create_session(
        subject(),
        String.t() | nil,
        String.t() | nil,
        [client_id: Grappa.ClientId.t() | nil]
      ) :: ...
```

For `Login.login/2`, type the three timeout keys explicitly.

---

### S10. `Scrollback.fetch/5` and `fetch_after/5` (5-arity) auto-pass `nil` for `own_nick` — incomplete defense-in-depth
**File:** `lib/grappa/scrollback.ex:208-211, 290-292`
**Category:** API surface drift
**Severity:** MEDIUM

The 5-arity wrappers (no `own_nick`) forward to the 6-arity primary
with `nil` for `own_nick`. The 6-arity functions documented the
own-nick narrowing rule (line 220-233): without it, the OR-shape filter
pulls every inbound DM. The 5-arity wrappers exist for "channel-shape
target fetches and tests with synthetic data."

But there is no enforcement that a `nil`-`own_nick` 5-arity caller is
NOT fetching against an own-nick window. A future controller that
forgets to thread `own_nick` and calls the 5-arity will silently
re-introduce the CP14-B3 leak that the 6-arity fix already shipped
once. The 5-arity wrappers are an open footgun for the next code path
that needs `Scrollback.fetch/5`.

**Fix:** Either (a) drop the 5-arity wrappers — make `own_nick` always
required at the call site; controllers thread `nil` explicitly so the
nil-ness is a deliberate decision, OR (b) add a guard that the 5-arity
form raises if `channel` happens to be nick-shaped (which is exactly
the case where own-nick narrowing matters). (a) is less code; CLAUDE.md
"No default arguments via `\\`" extends naturally to "no wrapper
arities that default a load-bearing parameter."

---

### S11. `Networks.transition!/3` bypasses every changeset rule via `Ecto.Changeset.change/2`
**File:** `lib/grappa/networks.ex:521-533`
**Category:** raw-write boundary smell
**Severity:** MEDIUM

`transition!/3` is documented as the "direct-write changeset for
connection-state transitions only." The docstring justifies bypassing
`Credential.changeset/2`: "we already have a row that passed those
rules at bind time." But:

1. The closed-set `Ecto.Enum` cast at the schema field does fire on
   `change/2` writes (Ecto enforces enum casts at dump time), so a
   bogus atom value raises at `Repo.update!/1`. Good.
2. The `connection_state_reason` text field has NO changeset validation
   for CR/LF/NUL (`Identifier.safe_line_token?/1`) — but
   `connection_state_reason` is interpolated into the operator-visible
   error trail and ends up in PubSub payloads on a topic that crosses
   the JSON boundary. A reason string containing `\n` would split log
   lines and confuse a future log-shipping consumer. Reasons today come
   from controlled internal sources (`disconnect/2`'s caller has the
   safe_line_token gate per the comment line 538-542), so this is
   defense-in-depth, not a live bug.
3. The bypass means a future schema validation on Credential (say
   "auth_method MUST be compatible with current connection_state")
   would silently NOT fire here. The bypass is documented; the drift
   is invisible.

**Fix:** Either (a) route through a dedicated narrow changeset on
`Credential` (`Credential.connection_state_changeset/2`) that casts
only the three transition fields + applies safe_line_token to
`:connection_state_reason`, OR (b) leave as is but add the
safe_line_token validation inline. (a) is the consistent shape with
`Accounts.User.admin_changeset/2` (line 92-97).

---

### S12. `QueryWindows.fetch_existing/3`'s "unreachable" path returns an error WITH a fresh changeset that loses the original failure context
**File:** `lib/grappa/query_windows.ex:300-330` (also `UserSettings.fetch_existing/1` line 396-410)
**Category:** error-shape leaky abstraction
**Severity:** MEDIUM

`do_insert/4`'s on_conflict-:nothing path goes to `fetch_existing/3`.
If the row is missing on re-select (a "should not happen" race), the
function returns `{:error, Window.changeset(%Window{}, attrs)}` — a
changeset with NO errors attached. Same shape in
`UserSettings.fetch_existing/1`.

A controller pattern-matching on `{:error, %Ecto.Changeset{} = cs}` will
see no error keys, no validation messages, no hint that the row vanished
post-conflict. cic will render an empty error banner.

The comment correctly notes the path is "effectively unreachable in
production" — but if it ever fires (cascading FK drop mid-upsert, manual
DB intervention), the silent-changeset return is exactly the silent-
swallow boundary the CLAUDE.md `feedback_no_silent_drops_closed` rule
exists to prevent.

**Fix:** Either (a) raise an explicit `RuntimeError "unreachable: row
vanished mid-upsert"` so the operator sees the actual condition, OR
(b) add an explicit error to the returned changeset:

```elixir
{:error,
 attrs
 |> then(&Window.changeset(%Window{}, &1))
 |> Ecto.Changeset.add_error(:base, "row vanished mid-upsert")}
```

Pick (a) — production is supposed to never see it.

---

### S13. `Visitor.touch_changeset/2` is mis-named — used by both touch and `mark_failed`
**File:** `lib/grappa/visitors/visitor.ex:115-118` consumed by `Visitors.mark_failed/2` at `lib/grappa/visitors.ex:318-321`
**Category:** name/contract drift
**Severity:** MEDIUM

`Visitor.touch_changeset/2` is documented (line 109-114) as "slides
`expires_at` forward on user-initiated REST/WS verbs." But
`Visitors.mark_failed/2` (line 318-321) ALSO calls
`Visitor.touch_changeset(now)` to expire the visitor immediately —
sliding `expires_at` BACKWARD by 48h. The schema function's docstring
is wrong about that direction; only `Visitors.maybe_bump/1` enforces
"forward" via `DateTime.diff(target, visitor.expires_at, :second) >=
@touch_cadence_seconds`.

So `mark_failed/2` is the inverse use case AND the very same call shape.
The `touch_changeset/2` name lies to the next reader: a future
defense-in-depth that ports the time-monotonicity guard (S5 above)
would now reject the legitimate `mark_failed/2` write.

**Fix:** Either (a) rename `Visitor.touch_changeset/2` to
`Visitor.set_expires_at_changeset/2` and update both call sites
(`Visitors.maybe_bump/1` + `Visitors.mark_failed/2`) and the docstring
to reflect the actual contract, OR (b) split into two distinct
changesets (`touch_changeset/2` with the future-only constraint;
`set_expired_changeset/1` that explicitly moves to now). Pick (b) so
the type-system tells the difference between the two intents.

---

### S14. `Visitors.delete/1` does the lookup-then-delete two-step that races itself
**File:** `lib/grappa/visitors.ex:333-342` (also `Visitors.purge_if_anon/1` line 473-485)
**Category:** race / silent-swallow
**Severity:** LOW

`Visitors.delete/1` reads, then deletes:

```elixir
case Repo.get(Visitor, visitor_id) do
  nil -> {:error, :not_found}
  visitor ->
    {:ok, _} = Repo.delete(visitor)
    :ok
end
```

A concurrent delete between the `Repo.get` and `Repo.delete` raises
`Ecto.StaleEntryError`, not the typed `{:error, :not_found}`. The
operator-visible behaviour is a crash where the spec promised a graceful
error. Same shape in `purge_if_anon/1`.

This is the same class as `commit_password/2` (S6) but lower severity:
the only callers are the Reaper (single-process serialised sweeps) and
mix-task operator deletes (also serial). Live race is improbable but
possible if an operator runs `bin/grappa delete-visitor` while the
Reaper sweep is concurrent.

**Fix:** Use `Repo.delete_all/2` keyed on id directly:

```elixir
case Repo.delete_all(from(v in Visitor, where: v.id == ^visitor_id)) do
  {0, _} -> {:error, :not_found}
  {1, _} -> :ok
end
```

— atomic, race-free, no `Ecto.StaleEntryError` exposure. For
`purge_if_anon/1` the `where: v.id == ^visitor_id and
is_nil(v.password_encrypted)` shape gives the same behaviour without
the read.

---

### S15. Migration 20260516184555 has a destructive `down` that loses operator data
**File:** `priv/repo/migrations/20260516184555_fix_networks_user_sessions_nullability.exs:54-66`
**Category:** migration drift / rollback safety
**Severity:** LOW

The fix-up `up/0` does `DROP COLUMN` then `ADD COLUMN INTEGER DEFAULT
3`. Any operator value that was set in `max_concurrent_user_sessions`
between the application of `20260516154723_split_network_session_caps`
and this fix-up is **silently reset to 3**. The migration moduledoc
acknowledges this for the prod case ("Production DB has a single
networks row (azzurra, id=1, user_sessions=3) so the DEFAULT does the
right thing") — but anyone running grappa with more than one
networks row (Phase 5+ multi-network operator) will lose customised
caps with no log line.

The rollback (`down/0`) is also destructive: it intentionally restores
the asymmetric `NOT NULL DEFAULT 3` shape (line 60-65). Both legs of
the migration drop the user-set value.

**Fix:** Either (a) skip the migration entirely on databases where the
column is already nullable (idempotent guard via `PRAGMA table_info`
read at runtime), OR (b) add a `DEFAULT 3 IF NULL` clause that
preserves operator values. The current state is OK for vjt's
single-network prod box but flag this for the Phase 5 multi-network
operator audience.

---

### S16. Several `Repo.preload(_, :network)` calls happen after the changeset insert/update fanout, costing an extra round-trip per write
**File:** `lib/grappa/scrollback.ex:117-121`, `lib/grappa/networks/credentials.ex:107`
**Category:** efficiency / write-path overhead
**Severity:** LOW

`Scrollback.persist_event/1` runs `Repo.insert/1` then `Repo.preload(_,
:network)` — every PRIVMSG burns two round-trips. Sqlite WAL plus
single-connection-per-write makes the second round-trip cheap (~0.3ms
on prod scale), but it is a measurable hot path. Same in
`Credentials.update_credential/3` (line 107).

The preload exists because `Scrollback.Wire.message_payload/1` pattern-
matches on the network slug and crashes on unloaded assoc. But the
caller already knows the network — the changeset attrs carry
`network_id`, and the controller/EventRouter has the `%Network{}` struct
in hand for the topic-builder anyway.

**Fix:** Either (a) accept the network struct as a `persist_event/2`
arg and `%Message{m | network: net}` it in directly without the round-
trip, OR (b) document the extra-round-trip cost in the moduledoc so
the next perf-tuning sweep sees it explicitly. (a) is the more
disciplined long-game fix but touches every caller.

---

### S17. `Scrollback.fetch_around/6` returns `[]` if `around_id` is `0` (the only valid sentinel for "no cursor yet")
**File:** `lib/grappa/scrollback.ex:367-401`
**Category:** API rough edge / off-by-one
**Severity:** LOW

The function guard requires `around_id > 0`. The sole consumer is cic's
"open window centered on read-cursor" — cic has the cursor from the
subject envelope and passes it through. If a user has NEVER read the
window (cursor == nil → 0), cic would either skip this fetch entirely
or pass `1` as a sentinel; the function would crash with
`FunctionClauseError` on `around_id == 0`.

Today cic gates the call behind cursor-non-nil. But the function's
contract is one accidental signature change away from a 500. The 5-arity
`fetch_after/5` accepts `after_id: 0` to mean "from the beginning";
`fetch_around` should mirror that convenience.

**Fix:** Relax the guard to `around_id >= 0`. Empty result on
`around_id == 0` (no row with `id <= 0` exists) is the same shape as a
deleted cursor — graceful, not crashing.

---

## Summary

| Severity | Count | Theme |
|----------|-------|-------|
| CRITICAL | 1 | Unpinned SQLite `synchronous` (and `foreign_keys`) pragmas |
| HIGH     | 6 | Canonicalisation / index coverage / closed-set guards / time-monotonicity / race control / cap enforcement |
| MEDIUM   | 7 | Dead code / spec drift / silent-changeset returns / name-vs-contract drift / raw-write bypass / opts-keyword under-spec / 5-arity wrappers as footguns |
| LOW      | 3 | Two-step race in delete / destructive rollback / off-by-one + minor perf |

No CRITICAL data-corruption findings (the kind/dm_with/XOR boundary is
well-defended; the M5 fragility flag pattern is excellent;
`messages.network_id ON DELETE RESTRICT` correctly blocks cascade-on-
empty when scrollback is present; the changeset boundaries enforce per-
kind body + per-kind dm_with rules at every write door). The one CRIT is
defensive: the FK + synchronous pragma defaults are correct but unpinned,
which violates CLAUDE.md's "Explicit SQLite angle" rule and would break
silently on a dep major-version bump.

The HIGH-class findings cluster around two themes:

1. **Closed-set discipline at boundaries** (S2 canonicalise drift, S4
   `connect/1` incomplete pattern, S10 5-arity wrappers): the codebase
   has the rules well-established but a few entry points slipped the
   net.
2. **Read-side optimisation lag** (S3 missing GROUP BY index): the
   per-window indexes are well-tuned for the per-window fetch path but
   `list_archive/3`'s aggregation is unindexed.

The MEDIUM cluster is mostly cleanup / spec tightening — easy fixes
that compound into clearer next-author guidance.
