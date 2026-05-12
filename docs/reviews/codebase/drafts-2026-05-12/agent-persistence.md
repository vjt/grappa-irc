# Codebase Review Draft — Persistence + SQLite
**Agent:** persistence/
**Scope:** lib/grappa/{scrollback,accounts,networks,query_windows,user_settings,visitors,repo,vault,encrypted_binary}* + priv/repo/migrations + config/* (sqlite angle)
**Date:** 2026-05-12

## CRITICAL

### S1. `foreign_keys` PRAGMA never enabled — every FK + every CHECK is a no-op in prod

❌ **FALSE FINDING — corrected 2026-05-12 bucket A.** The `ecto_sqlite3` adapter sets `PRAGMA foreign_keys = ON` on every connection-init by default (see `deps/ecto_sqlite3/lib/ecto/adapters/sqlite3.ex:85` + `deps/exqlite/lib/exqlite/pragma.ex:52`). Live-container probe confirmed `Grappa.Repo.query!("PRAGMA foreign_keys").rows == [[1]]` AND that an orphan-FK insert raises `Exqlite.Error "FOREIGN KEY constraint failed"`. The reviewer read "SQLite ships with PRAGMA foreign_keys = OFF" as the runtime default and missed the adapter's connection-init override. See compiled review doc's C2 section for the full correction. The S7 finding below also inherits the false premise — re-validate at bucket B.

### S1 (HISTORICAL — invalidated text retained for audit)

**File:** `config/runtime.exs:22-27` ; `config/dev.exs:3-6` ; `config/config.exs:71-73`
**Category:** SQLite / data integrity
SQLite ships with `PRAGMA foreign_keys = OFF` by default — it must be re-enabled on every connection. Nowhere in the codebase do we set it: prod, dev and the `config/config.exs` defaults all configure `Grappa.Repo` without `foreign_keys: true` (the option `ecto_sqlite3` exposes for connection-init pragmas). Test runs only enable it implicitly via the Sandbox pool's defaults — which is precisely why every `assoc_constraint` works in tests but the comments throughout the codebase describe FK errors as un-pattern-matchable in prod ("ecto_sqlite3 returns the constraint name as `nil`").

The downstream consequences are severe: every `references(..., on_delete: :delete_all|:restrict|:cascade)` in the migrations is dead code at runtime; CASCADE on user/visitor delete (Reaper, `purge_if_anon`, `accounts.user.delete_all`) does NOT cascade to `messages` / `sessions` / `visitor_channels` / `query_windows` / `user_settings`; the `:restrict` guard on `messages.network_id → networks.id` does NOT block the network drop (the elaborate `Networks.Credentials.unbind_credential/2` `Scrollback.has_messages_for_network?` check is the ONLY guard); the XOR CHECK on `messages_subject_xor` and `sessions_subject_xor` and the auth_method/kind enum CHECKs added in `20260504020002` are also gated on `PRAGMA foreign_keys = ON` enabling DEFERRABLE constraint enforcement... but more directly, raw SQL drift of an `auth_method` value would silently flow until the Ecto.Enum cast crashes at load-time.

The migration `20260504020002` even runs `PRAGMA defer_foreign_keys=ON` inside its transaction — proof that someone investigated FK enforcement in detail — yet the connection-level toggle is missing.
**Fix:** Add `foreign_keys: true` to every `Grappa.Repo` config block (`runtime.exs`, `dev.exs`, `config/config.exs`). Verify with `scripts/db.sh` running `PRAGMA foreign_keys;` against `runtime/grappa_dev.db` (expect `1`). Add a runtime smoke test that asserts an FK violation propagates as a `Ecto.ConstraintError` (or whatever the resolved shape ends up being once `foreign_keys=ON`). Then revisit every "ecto_sqlite3 returns FK constraint name as nil — pre-flight check is required" workaround (`Accounts.create_session/4`, `QueryWindows.open/4`, `UserSettings.get_or_init/1`) — those workarounds may still be needed (FK-name mapping in ecto_sqlite3 is genuinely flaky), but the reasoning recorded in those modules is half-true; document the actual post-fix behaviour.

## HIGH

### S2. `busy_timeout` not set in prod — sub-second default invites `database is locked` flakes
**File:** `config/runtime.exs:22-27` ; `config/dev.exs:3-6`
**Category:** SQLite / contention
`config/test.exs` sets `busy_timeout: 30_000` with a long-form comment explaining the WAL+single-writer reality; prod and dev set NEITHER. ecto_sqlite3's default is 2000 ms, and the upstream `exqlite` default is even lower (~50ms historically). With WAL mode + multiple read connections the writer contention window is small but real — and the CP23 S4 retry-tolerated `database is locked` Exqlite contention in two e2e specs (`cp15-b6-kicked` + `m9-cicchetto-part-x-click`, called out in checkpoint) is the visible symptom on CI. Prod's pool_size of 10 amplifies this — every connection queues on the same writer.
**Fix:** Add `busy_timeout: 30_000` (or 5_000 minimum) to the prod + dev Repo config. The test config's 30s value is correct; copy that. Document that the actual contention guarantee under WAL is "writers serialize via the WAL, readers proceed concurrently — busy_timeout governs writer-contention waits."

### S3. `pool_size: 10` for SQLite is misleading at best, harmful at worst
**File:** `config/runtime.exs:24`
**Category:** SQLite / concurrency model
SQLite has a single writer by file definition. With WAL mode, readers proceed in parallel, so a pool >1 helps reads; but a pool of 10 with no connection-level pragma (busy_timeout, foreign_keys, etc.) means 10 concurrent transactions can race for the single writer with the default ~2s wait. The test config (`pool_size: 1`) carries an extensive moduledoc explaining why "the canonical ecto_sqlite3 Sandbox pattern is pool_size: 1." Prod has no equivalent reasoning recorded — it inherits Phoenix's PostgreSQL-shaped default. Couple this with S2 (no busy_timeout) and the cascading-busy class observed on CI is structurally guaranteed under load.
**Fix:** Either (a) drop pool_size to 2-5 and pair with `busy_timeout: 30_000` to keep the contention window bounded, or (b) keep 10 but explicitly document the read-pool reasoning + add the busy_timeout safety net. Either way, the comment block in `config/test.exs` deserves a sibling in `runtime.exs`.

### S4. PubSub broadcast inside `Repo.transaction` (Networks.Credentials.unbind_credential)
**File:** `lib/grappa/networks/credentials.ex:202-228` (and via `lib/grappa/networks.ex:475-477` `broadcast_state_change/4`)
**Category:** Crash boundary / consistency
`unbind_credential/2` runs `Session.stop_session/2` BEFORE the transaction (good comment explaining why), then opens a transaction that does `delete_all(cred_query)` + maybe-delete-network-or-rollback. Inside the transaction the `Scrollback.has_messages_for_network?/1` rolls back with `:scrollback_present`. This is correct.

But adjacent `Networks.connect/1` / `disconnect/2` / `mark_failed/2` flows do `transition!/3` (a `Repo.update!`) followed by `broadcast_state_change/4` — NOT inside an explicit transaction, but the broadcast can proceed even if a downstream caller's transaction wraps the whole thing and rolls back. More acutely, `disconnect/2` does `best_effort_quit` + `Session.stop_session/2` BEFORE the DB write — if the DB update raises (`Repo.update!`), the upstream is QUIT but the credential row stays `:connected`. This is observable as a "ghost connected" state that survives reboot.
**Fix:** (a) Wrap `transition! + broadcast` in a transaction so the broadcast only fires post-commit (or use `Ecto.Multi` + an `after_commit` hook). (b) For `disconnect/2`, do the DB transition FIRST (so a rollback leaves state consistent), then QUIT, then stop_session — accept that `disconnect/2` may QUIT a session that the operator's intent says to disconnect even if the row write later fails; that's still better than a "connected row, dead session" inversion.

### S5. Missing index on `network_credentials.connection_state` for the Bootstrap hot path
**File:** `lib/grappa/networks/credentials.ex:282-292` ; `priv/repo/migrations/20260504120000_add_connection_state_to_network_credentials.exs`
**Category:** SQLite / index coverage
`Credentials.list_credentials_for_all_users/0` (Bootstrap's boot-time enumerator) runs `WHERE connection_state = :connected ORDER BY (inserted_at, user_id, network_id)`. There is NO index on `connection_state`. Today's row count is small enough that a full scan is cheap; under operator-personal scale (100s of bindings + a few `:parked`/`:failed` rows) this stays fine, but the migration that added the column did not add the index. As `:parked`/`:failed` becomes more common (T32 disconnect verb shipped in CP19), the scan grows linearly with archival rows.
**Fix:** Add a partial index `create index(:network_credentials, [:connection_state], where: "connection_state = 'connected'", name: :network_credentials_connected_partial_index)`. Mirrors the partial-index pattern already used in `20260504015357_session_client_id_partial_index.exs`.

### S6. `messages_subject_xor` CHECK constraint isn't enforced if `foreign_keys=OFF`
**File:** `priv/repo/migrations/20260502085339_add_visitor_id_to_messages.exs:50` (and sibling sessions migration)
**Category:** SQLite / data integrity
SQLite enforces CHECK constraints regardless of foreign_keys pragma — actually CHECK enforcement is independent in SQLite, so this paragraph reverses S1's concern. The risk is different: the XOR CHECK relies on table-level CHECK enforcement which IS on by default. The `(user_id IS NULL) <> (visitor_id IS NULL)` predicate is correct. **No bug here**, but pin this in a code comment so future operators don't conflate "FK pragma off" with "CHECK pragma off." (Removing this finding from the report is fine — flagged for Triage.)
**Fix:** No code change. Document in the migration moduledoc that CHECK enforcement is always-on in SQLite, distinct from FK enforcement which requires the pragma.

### S7. `validate_subject_exists/1` TOCTOU ignores the FK fail-safe that doesn't exist (S1 dependency)
**File:** `lib/grappa/accounts.ex:190-211` ; `lib/grappa/query_windows.ex:240-262` ; `lib/grappa/user_settings.ex:184-198`
**Category:** SQLite / data integrity
Three contexts implement an identical "pre-flight `Repo.exists?` because ecto_sqlite3 returns FK constraint name as nil" pattern, all citing S29 H4 as origin. The pattern's stated fallback is "the DB FK violation is the backstop." With S1 unfixed, there is NO backstop — the TOCTOU window between `Repo.exists?` and `Repo.insert` admits a stale FK that lands a row pointing at a deleted user/network/visitor, and the cleanup path (CASCADE on user delete) doesn't run.

After fixing S1, the backstop reappears. Without S1 fixed, this is an acute bug.
**Fix:** Fix S1 first. Then keep the pre-flight checks (they convert `Ecto.ConstraintError` to clean changeset errors, which is a real UX improvement) but rewrite the comments to stop calling them load-bearing; they're convenience.

### S8. `last_joined_channels` JSON write is unbounded — no size cap, no truncation
**File:** `lib/grappa/networks/credential.ex:134-145` ; `lib/grappa/networks/credentials.ex:111-139` ; `priv/repo/migrations/20260510170000_add_last_joined_channels_to_network_credentials.exs`
**Category:** Persistence / hot-path write amplification
`Session.Server` writes `last_joined_channels` on every self-JOIN/PART/KICK as an `{:array, :string}` JSON column. The schema docstring says "typically 5-50 channels" but no cap is enforced. A user joining 1000 channels (botnet, ill-behaved client) writes a 1000-element JSON blob to disk on EVERY join — the entire array is rewritten every time, not just the delta. Combined with the schema's update_at timestamp, this also bumps `network_credentials.updated_at` on every join, which churns the row's index entries.
**Fix:** Cap the persisted list at e.g. 200 entries (oldest dropped) inside the `update_last_joined_channels/3` boundary; or move this column to a separate `network_session_state` table that doesn't carry `updated_at`. Add a doc comment + StreamData property test that bounds the write size.

## MEDIUM

### S9. `Scrollback.fetch/5` `OR` clause may scan two indexes per query post-CP14 B3
**File:** `lib/grappa/scrollback.ex:359-382` ; `priv/repo/migrations/20260508132130_messages_dm_with_subject_composite_indexes.exs`
**Category:** SQLite / index coverage (refinement of CP15 B6)
The migration's @moduledoc explicitly tracks this — composites land on `(user_id, network_id, dm_with, server_time)` and `(visitor_id, network_id, dm_with, server_time)` so SQLite picks the right composite per OR arm. Verify the runtime EXPLAIN QUERY PLAN still matches: an OR across two columns with two indexes uses a two-leg UNION-shape internally (`OR-by-UNION`), and the merging step doesn't always preserve `ORDER BY ... DESC LIMIT n` push-down. If the LIMIT happens AFTER the merge, the effective scan is N-times-larger than the LIMIT. Worth a one-time `EXPLAIN QUERY PLAN` capture in the test suite to lock the shape.
**Fix:** Add a smoke test (mod-tagged `@tag :perf`) that runs `EXPLAIN QUERY PLAN` on a representative `Scrollback.fetch/6` for both channel and DM targets, asserting both arms hit `SEARCH ... USING INDEX`. Catches regressions where a future schema edit drops one of the composites.

### S10. `network_credentials.user_id` + `network_credentials.network_id` indexes are redundant with the composite PK
**File:** `priv/repo/migrations/20260426000002_create_networks.exs:71-72` (re-created in `20260504020002` `recreate_network_credentials_with_check`)
**Category:** SQLite / index coverage
The table has composite PK `(user_id, network_id)` which gives free leftmost-prefix lookup on `user_id`. The standalone `index(:network_credentials, [:user_id])` is redundant. The `index(:network_credentials, [:network_id])` IS needed (right-side of PK). Same write-amplification argument as `20260504020000` (visitor_channels).
**Fix:** New migration `drop_if_exists index(:network_credentials, [:user_id])`. Same payoff/risk profile as L-pers-4. Verify with `EXPLAIN QUERY PLAN SELECT * FROM network_credentials WHERE user_id = ?` — should still hit the composite PK.

### S11. `Visitors.list_active/0` + `list_expired/0` capture `now()` in Elixir, not in SQL
**File:** `lib/grappa/visitors.ex:179-195`
**Category:** Persistence / clock semantics
Both functions read `DateTime.utc_now()` in Elixir, then bind it as a parameter. Under high concurrency the boundary between `list_active`/`list_expired` is non-atomic — a visitor with `expires_at = T` may land in BOTH lists if the Reaper enumerates `list_expired` at `T+ε` while a session checks `list_active` at `T-ε`. The current Reaper is single-process so this race window is hypothetical, but if a future operator adds parallel reaping or runs `mix grappa.reap_visitors` while the Reaper ticks, the duplicate-delete is benign (`get` returns nil, `delete` short-circuits) but a duplicate-spawn from `Bootstrap` running concurrently with reaping would log noisily and hit the FK-orphan path.
**Fix:** Pass an explicit `now` argument (or use SQLite `unixepoch()` in a fragment). The single-source-of-truth pattern matches Backoff's clock-injection. Low priority — current single-process Reaper makes this a future-bug-prevention edit.

### S12. `Repo.update_all` in `revoke_session/1` doesn't validate the subject_xor invariant on UPDATE path
**File:** `lib/grappa/accounts.ex:252-285`
**Category:** Persistence / discipline
Both `revoke_session/1` and `revoke_sessions_for_visitor/1` use `Repo.update_all` to set `revoked_at`. Bypasses the changeset (no `Session.changeset/2`, no `validate_subject_xor`). Today the columns being touched are uncorrelated to the XOR (just a timestamp), so it's safe. But the CLAUDE.md rule "Ecto.Changeset for ALL user input — never `Repo.insert/2` with a raw map you didn't validate" applies to updates too. The pattern survives because no validator looks at `revoked_at`. Worth a comment pinning the rule + the exception.
**Fix:** No code change. Add a code comment at both `update_all` sites: "Bypass-changeset is acceptable here because we touch a single timestamp column with no validation requirements; new column writes MUST go through `Session.changeset/2` to preserve the XOR + monotonicity invariants."

### S13. `messages.kind` enum CHECK + `auth_method` CHECK don't include the `:nick_change|:mode|:topic|:kick|:notice|:action` extension story
**File:** `priv/repo/migrations/20260504020002_check_constraints_caps_auth_method_messages_kind.exs:346`
**Category:** SQLite / migration discipline
The CHECK constraint hard-codes the kind list at the migration date. If a future migration adds a new kind atom to `Message.@kinds`, the schema `Ecto.Enum` validates it but the DB CHECK rejects it — silent drift. The frozen-snapshot pattern is fragile. The migration's own moduledoc warns about `dm_with` drift; the kind list deserves the same treatment.
**Fix:** Add a moduledoc fragility flag mirroring `dm_with`'s ("future-recreate must include..."). Better: write a migration test that asserts `Message.kinds() == ` the literal list parsed out of the latest `kind_enum` CHECK constraint, surfacing drift at test time. (`Grappa.Migrations.CheckConstraintsTest` is mentioned in the schema — verify it exists and covers this.)

### S14. `User.changeset/2` — `validate_length(:name, min: 1, max: 64)` overlaps + drifts from format regex
**File:** `lib/grappa/accounts/user.ex:46,63`
**Category:** Discipline / consistency
The format regex `^[a-zA-Z][a-zA-Z0-9_\-]*$` enforces "starts with letter then alphanumeric/_/-" but says nothing about length; the explicit `validate_length(:name, min: 1, max: 64)` carries the cap. Networks.Network's `validate_slug/2` delegates to `Identifier.valid_network_slug?/1` which encodes both format AND length in one place. The User schema diverged — same format-vs-length split that A18 unified for slugs is unfixed for usernames. Two sources, two truths.
**Fix:** Move the length cap into `Identifier.valid_user_name?/1` (or a fresh predicate) and call it from a single `validate_change`. Same pattern A18 used for slugs.

### S15. `EncryptedBinary` Cloak field name + post-load semantics is a known footgun (load-bearing comments)
**File:** `lib/grappa/networks/credential.ex:113-122` ; `lib/grappa/networks/wire.ex` (full module)
**Category:** Crypto / discipline
The `password_encrypted` field name describes the on-disk shape; after Cloak load it carries plaintext. The schema comment, Wire moduledoc, AND the upstream_password/2 accessor all warn about this — three layers of documentation guarding one field-name lie. Same on `Visitors.Visitor.password_encrypted`. The Wire modules are exemplary, but the underlying naming bug is one operator-typo (`json(conn, credential)` in a fresh controller) from a credential leak.
**Fix:** Rename the schema field to `:password_at_rest` or split into `password_ciphertext` (raw column) + `:password` (post-load decrypted, `redact: true`, virtual-on-load). Touch every callsite. High discipline cost, but removes the cross-module consistency requirement that the current docstrings work hard to maintain.

### S16. `dialyzer` integer typespec drift between schema field + context contract
**File:** `lib/grappa/scrollback.ex:103,207` (`network_id :: integer()`) ; `lib/grappa/scrollback/message.ex:153` (`network_id: integer() | nil`)
**Category:** Discipline / typespec
`Scrollback.persist_event/1` requires `:network_id => integer()`; `fetch/5` requires `network_id` integer; the schema's `t()` declares `network_id: integer() | nil`. A caller passing the schema's field-from-`Repo.get` would type-check fine for `fetch/5` (it's narrower), but the schema-level `nil` allowance is for non-loaded `belongs_to` (`network` assoc loaded but `network_id` unset, which would actually be a contradiction). Cosmetic — not a bug — but the chase between contexts and schemas across a year of edits has produced 3+ different "what's the network_id type" declarations.
**Fix:** Pick one — `pos_integer()` is correct (autoincrement starts at 1, no zero-FK rows possible). Cascade-edit. Same exercise for `user_id :: Ecto.UUID.t()` shape consistency.

### S17. `query_windows` schema uses `:utc_datetime` (second-precision) where `messages` uses `:utc_datetime_usec`
**File:** `lib/grappa/query_windows/window.ex:38-40` ; `priv/repo/migrations/20260504130000_create_query_windows.exs:53,55`
**Category:** SQLite / type consistency
`messages.server_time` is integer epoch-ms (correct for IRC server-time). `query_windows.opened_at` is `:utc_datetime` (second precision) while `messages.inserted_at`, `users.inserted_at`, `accounts.session.last_seen_at` are all `:utc_datetime_usec`. Mixed precision creates the "two clocks" problem at JSON wire emission (some fields ISO-8601 with microseconds, some without). `Wire.render` calls `DateTime.to_iso8601` which handles both — but the cic-side ordering compare across DM-window-opened-at vs message-server-time vs user-created-at could surprise.
**Fix:** Standardise on `:utc_datetime_usec` across all schemas. The migration is `alter table` + a backfill (or just leave existing rows with `.000000Z`).

### S18. `User.password_hash` uses `:string` for an Argon2 hash — works but bypasses Argon2 verifier hardening
**File:** `lib/grappa/accounts/user.ex:40` ; `priv/repo/migrations/20260426000000_create_users.exs:8`
**Category:** Crypto / discipline
The Argon2 hash output is a printable-ASCII string per Argon2 PHC format, so `:string` storage is functionally fine. But the column has no length cap (`:string` in sqlite is `TEXT` unbounded), no format check, and the schema doesn't `redact: true` it. `inspect(%User{})` would print the full Argon2 hash — not a credential leak (it's already a hash) but a leak of the algorithm + salt + cost params. Compare to `Visitors.Visitor.password_encrypted` and `Credential.password_encrypted` which both `redact: true`.
**Fix:** Add `redact: true` to `field :password_hash, :string`. Cheap discipline.

## LOW

### S19. `defp validate_future_expires_at/2` rejects equal-to-now
**File:** `lib/grappa/visitors/visitor.ex:126-131`
**Category:** Discipline
`validate_future_expires_at` accepts only `:gt` — at `:eq` (microsecond-aligned) it rejects with "must be in the future." Practically unreachable, but a tight test loop with mocked clocks hits it. `:gt` was a deliberate choice per the moduledoc ("strictly in the future"); the comment is at the schema level, not the validator. Add it as a function-doc to surface intent at the validator.
**Fix:** Doc-comment only.

### S20. `UserSettings.set_highlight_patterns/2` — `validate_patterns` builds a fake changeset on a generated UUID
**File:** `lib/grappa/user_settings.ex:200-215`
**Category:** Discipline / hack
On validation failure, the function builds an `%Settings{}` changeset with `Ecto.UUID.generate()` as `user_id` purely so the changeset has a valid shape to attach errors to. The result is a changeset that `traverse_errors` would render but is otherwise nonsense. Better: return a typed error tuple `{:error, {:invalid_patterns, [reason]}}` and let the controller render it.
**Fix:** Refactor return shape, document the contract at module level.

### S21. `Visitors.find_or_provision_anon/3` — race window between `Repo.get_by` + `create_anon`
**File:** `lib/grappa/visitors.ex:81-95`
**Category:** SQLite / race
Two callers can race on `(nick, network_slug)` — both `get_by` returns nil, both call `create_anon`, second insert hits the unique index. The error path goes back as `{:error, %Ecto.Changeset{}}` which the AuthController eventually surfaces. Same race-loser pattern as `Networks.find_or_create_network/1` (which handles it explicitly via `insert_or_recover`). Visitors should adopt the same pattern.
**Fix:** Mirror `Networks.find_or_create_network/1`'s race-recovery: on uniqueness violation, retry the `get_by`.

### S22. `dm_peer/4` allows `:notice` in the eligible-kinds list — verify alignment with `@dm_with_eligible_kinds`
**File:** `lib/grappa/scrollback.ex:157-167` ; `lib/grappa/scrollback/message.ex:123`
**Category:** Discipline
`Scrollback.dm_peer/4` accepts `kind in [:privmsg, :action, :notice]` AND `Message.@dm_with_eligible_kinds = [:privmsg, :action, :notice]`. The two lists were synced in CP23 S3 (per the moduledoc) but they're maintained in two files. Drift class — same flavor as Meta `@known_keys` ↔ Logger metadata allowlist (which has a sync test).
**Fix:** Either consolidate into `Message.dm_with_eligible_kinds()` exposed and called from `Scrollback.dm_peer/4` guard, or add a unit test asserting list equality.

### S23. Migration `20260425000000_init.exs` — "edited in place" lesson, but no test guards the lesson
**File:** `priv/repo/migrations/20260425000000_init.exs:28-37`
**Category:** Migration discipline
The init migration self-documents an edit-in-place exception. The CLAUDE.md rule "migrations are additive" depends on operator vigilance; nothing automated catches a future edit-in-place. A cheap CI gate would `git log --diff-filter=M -- priv/repo/migrations/*.exs` and warn on non-newest-file modifications.
**Fix:** Add a CI check (`scripts/check.sh` extension) that flags edits to migration files older than the newest. Skip-able with a commit-message marker for legitimate cases.

### S24. Empty `change/0` migration `20260504013318_tighten_session_client_id_format.exs` returns `:ok`
**File:** `priv/repo/migrations/20260504013318_tighten_session_client_id_format.exs:26`
**Category:** Discipline
`def change, do: :ok` is correct (avoids the `nil` rollback raise per the moduledoc). A no-op migration MIGHT signal "this is just a marker" — fine. But it inflates the migration count without DDL effect; future operators may wonder why it exists. The moduledoc explains it; no fix.
**Fix:** None. Flagged for awareness only.

### S25. `User.put_password_hash/1` only fires on `valid?: true` — silent skip on invalid changesets
**File:** `lib/grappa/accounts/user.ex:71-74`
**Category:** Discipline
The function clauses skip the hash when the changeset is invalid (correct — saves Argon2 CPU on rejected input). But a caller iterating changesets without checking `valid?` would get an `%Ecto.Changeset{}` with `password_hash: nil` on the changes side; if they then `Repo.insert` (which would fail correctly via `validate_required`), the timing oracle Argon2 is supposed to defend against is cleanly avoided. No bug; pin the pattern in a moduledoc note for the next operator who wonders why "the hash doesn't show up."
**Fix:** Doc-comment in `Accounts.create_user/1` describing the deferred-hash semantic.

### S26. `Networks.update_network_caps/2` silently bypasses the auth_method/last_joined/connection_state validation paths
**File:** `lib/grappa/networks.ex:215-219`
**Category:** Discipline
Calls `Network.changeset/2` which only casts `[:slug, :max_concurrent_sessions, :max_per_client]`. Fine for a caps-update verb. But future schema additions to `Network.changeset` (validation of e.g. a max-bandwidth field) might assume every changeset visits all validators — they do, but only for casted fields. Minor.
**Fix:** None — the pattern is correct. Flag for future-author awareness.

### S27. `Visitors.purge_if_anon/1` swallows `Repo.delete` failure with `{:ok, _} = ...`
**File:** `lib/grappa/visitors.ex:285-297`
**Category:** Discipline
The pattern match `{:ok, _} = Repo.delete(visitor)` raises if `Repo.delete` returns an error tuple (e.g. constraint violation). Since the function spec says `:ok`, the raise becomes an FunctionClauseError-shaped crash at the call site. With S1 fixed and FK enforcement on, a delete-with-FK-restrict could fail (though `visitor`'s FKs are all CASCADE). For now correct; document that the assertion is intentional.
**Fix:** Either pattern-match explicitly with a `{:error, _}` arm + log + return `:ok`, or document the assertion.

## Summary

- 1 CRITICAL, 7 HIGH, 10 MEDIUM, 9 LOW

**Top 3 themes (one line each):**
1. **`PRAGMA foreign_keys` is OFF in prod** — every `references(..., on_delete: ...)` and the elaborate "ecto_sqlite3 returns FK constraint name as nil" workarounds across 3 contexts trace to this single missing connection-init pragma (S1, S6, S7).
2. **SQLite contention defaults are unset** — no `busy_timeout` in prod, `pool_size: 10` despite single-writer reality, no documented WAL pragmas; the CP23 S4 "database is locked" e2e flake is structural, not bad luck (S2, S3).
3. **PubSub-broadcast/transaction ordering and `:utc_datetime` precision drift** — broadcast outside transaction (S4), bypass-changeset on update_all (S12), microsecond-vs-second timestamp split between schemas (S17), kind-enum CHECK frozen-snapshot drift (S13).

**SQLite findings broken out:**
- S1 CRITICAL — `PRAGMA foreign_keys` never enabled.
- S2 HIGH — no `busy_timeout` in prod/dev.
- S3 HIGH — `pool_size: 10` undocumented for single-writer reality.
- S5 HIGH — missing partial index on `network_credentials.connection_state`.
- S6 — CHECK enforcement clarification (no fix).
- S9 MEDIUM — verify EXPLAIN QUERY PLAN for the OR-arm DM fetch.
- S10 MEDIUM — redundant `network_credentials(:user_id)` index, write amplification.
- S11 MEDIUM — `now()` captured in Elixir not SQL for visitor list_active/expired.
- S13 MEDIUM — kind-enum CHECK frozen-snapshot drift class.
- S17 MEDIUM — `:utc_datetime` precision split between schemas.
- S23 LOW — no automated guard against migration edit-in-place.
