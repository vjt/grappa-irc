# Codebase Review Draft — Persistence + SQLite (B5)

**Agent:** persistence/
**Scope:** lib/grappa/{repo,vault,encrypted_binary,scrollback,scrollback/*,networks,networks/*,accounts,accounts/*,query_windows,query_windows/*,user_settings,user_settings/*,read_cursor,read_cursor/*,visitors,visitors/visitor}.ex + priv/repo/migrations/*.exs + tests
**Date:** 2026-05-14
**Cluster:** no-silent-drops (B5 codebase review)
**Reviewer note:** built on top of drafts-2026-05-12/agent-persistence.md. Findings re-verified against present code; closed items are NOT repeated. New issues numbered N1+. CP29 read-cursor surface examined for the first time.

## Summary

| Sev    | Count | Notes |
|--------|-------|-------|
| CRIT   |   0   | (S1 from prior review was disproved — adapter sets PRAGMA foreign_keys=ON by default) |
| HIGH   |   4   | N1 cursor PubSub-rooting bug (visitor topic invalid), N2 ReadCursor.set/4 message_belongs? performance, N3 last_read_message_id index inverted, N4 list_archive missing index |
| MED    |   8   | wire-shape integer keys, IP storage class drift, channel string drift, JSON shape forks (visitor topic), kind enum CHECK frozen drift (still applies), query_windows :utc_datetime second-precision split (carry-over), default value silent paths in Settings, Cursor partial-NULL FK semantics |
| LOW    |   6   | doc gap on `last_read_message_id` SET NULL recovery, settings `validate_patterns` synthetic UUID changeset (carry-over S20), unused id-only index on query_windows, ReadCursor lacks delete-on-channel-close, missing reaper for orphan cursors, `effective_*` accessor pair |
| NIT    |   3   | docstring typos, alias usage, comment freshness |

**Top 3 themes:**
1. **CP29 ReadCursor surface introduces a topic-rooting bug** for visitor cursors (N1) — the controller invents a `"visitor:<uuid>"` user_name to satisfy the user-rooted topic shape; cic does not subscribe to that topic, so the cross-device fan-out promised by the moduledoc never delivers for visitors and the broadcast just goes to nobody. Either drop the visitor broadcast (it's documented as no-op, but the controller still does the work) or design a visitor-rooted topic.
2. **Index coverage for the new cursor + the existing archive view is incomplete.** `read_cursors(:last_read_message_id)` carries an index that's never used by any query in the module (N3); meanwhile `list_archive/3`'s `GROUP BY COALESCE(dm_with, channel)` will full-scan the per-(subject, network) shard in the absence of a covering index (N4) — fine at today's row counts, structurally sized to bite when push notifications start enumerating archive rows.
3. **Per-context wire shape is mostly disciplined, but `QueryWindows.windows_map` keys on the integer `network_id`** (M1) — every other typed wire event uses `network_slug` (Scrollback.Wire.to_json, Networks.Wire.connection_state_changed_event, ReadCursor.bulk_for_subject). The integer is only meaningful inside the server; cic re-keys after every payload. Carry-over candidate.

---

## HIGH

### N1. ReadCursor visitor cross-device broadcast routes to a topic no one subscribes to
**File(s):** `lib/grappa_web/controllers/read_cursor_controller.ex:81-88` ; `lib/grappa/read_cursor.ex:175-208`
**Description:** `ReadCursorController.maybe_broadcast/4`'s visitor arm calls `ReadCursor.broadcast_set("visitor:" <> visitor.id, network_slug, channel, ...)` — the `"visitor:<uuid>"` is a synthetic user_name that gets baked into a `Topic.channel/3` string of shape `grappa:user:visitor:abc-uuid/network:slug/channel:#chan`. The controller comment says "Single-device visitors won't hear an echo from themselves; the broadcast is a no-op subscriber-side." That's not a no-op — it's a promise that is silently violated. Two failure modes:

1. **Wasted broadcast work** — Phoenix.PubSub fan-out runs through every node + the topic registry on every set. For a visitor doing scroll-settle on every blur (potentially every few seconds during normal browsing), this is non-trivial waste over a session lifetime.
2. **Cross-device sync silently broken for the future visitor multi-tab case.** The moduledoc on `ReadCursor.broadcast_set/4` (lines 193-196) explicitly notes "visitor sessions are single-device by construction" — but the controller still emits the broadcast. The "single-device" assumption is also load-bearing on a UX promise that no design doc records; if a future visitor opens a second tab, the cursor will silently desync because the user-rooted topic shape doesn't admit visitor subscribers in the first place.

The bug class is "two surfaces (controller comment vs moduledoc vs runtime behavior) describing three different things." Per CLAUDE.md "no silent drops" — this IS a silent drop of an event the controller spent CPU emitting.

**Recommended fix:** Either (a) drop the visitor branch from `maybe_broadcast/4` entirely and document loudly in `ReadCursor.broadcast_set/4`'s moduledoc that visitor cursors don't broadcast, OR (b) introduce a visitor-rooted topic shape (`grappa:visitor:<uuid>/network:slug/channel:chan`) that `UserSocket` actually joins for visitor sessions. (a) is the right call for now — the current `"visitor:<uuid>"` cargo-cult name suggests confusion about whose principal owns the topic.

### N2. `ReadCursor.set/4` does a full message-belongs-to-subject existence check on EVERY settle event
**File(s):** `lib/grappa/read_cursor.ex:140-145, 240-246`
**Description:** Every cic settle event (focus-leave, browser-blur, future scroll-settle) hits `POST /networks/:net/channels/:chan/read-cursor` → `ReadCursor.set/4` → `message_belongs?/4` (a `Repo.exists?` against `messages` filtered on subject + network_id + channel + id), then a second query for the cursor get + insert/update. That's three round-trips per settle event in the steady-state path. The settle event is a "happens often, work is cheap" pattern but the validation is sized for an attacker-controlled boundary — every legit cic emits messages it just received, so the message_belongs? check almost always succeeds. The check IS load-bearing (it prevents a cursor pointing at a message owned by a different subject — a per-subject iso boundary defense), but the cost is paid on EVERY settle, including the 99.9% legit case.

Compounded by the fact that the cursor row ALSO carries `assoc_constraint(:last_read_message)` in the Cursor changeset, which would surface the FK violation as a clean changeset error if the message_id is bogus. The pre-flight check duplicates that defense at the cost of an extra `Repo.exists?`.

**Recommended fix:** Drop `message_belongs?/4` and rely on the FK assoc_constraint at insert time + a dedicated subject-scoping check (a single composite query). Or cache the recently-validated message_id per (subject, network, channel) for a few seconds — settle events tend to cluster (blur+blur+blur in a tab-switching pattern) and the same message_id is set repeatedly. Or just accept the cost and add a telemetry counter so the per-settle budget is visible. Lowest-risk fix: collapse `message_belongs?` + `do_set` into a single `INSERT ... SELECT ... WHERE EXISTS` on conflict-update — one round trip, defense intact.

### N3. `read_cursors(:last_read_message_id)` index is unused and bloats writes
**File(s):** `priv/repo/migrations/20260513133825_create_read_cursors.exs:89` ; `lib/grappa/read_cursor.ex` (no consumer)
**Description:** The migration creates `create index(:read_cursors, [:last_read_message_id])`. No query in `Grappa.ReadCursor` filters or joins on `last_read_message_id`. `bulk_for_subject/1` projects it; `get/3` returns it; `set/4` writes it. The only pattern that would benefit is "find every cursor pointing at message X" — and the only consumer of THAT shape is the `ON DELETE SET NULL` cascade when a message is deleted. SQLite's FK enforcement uses its own internal lookup, NOT the user index, when servicing a CASCADE/SET NULL trigger (CASCADE may be slow without an index but the cost lands on `messages` deletion, which is rare-to-never in this codebase — visitor reaping CASCADEs the whole subject chain via `messages.visitor_id` instead).

The downside is real: every `set/4` insert/update writes one extra index entry; the unique partial indexes already cover (user_id, network_id, channel) and (visitor_id, network_id, channel), and the network_id index adds a third write path. So this is the FOURTH index touched per write.

**Recommended fix:** Drop the index in a follow-up migration. Add a comment in the schema confirming the FK relies on the SET NULL cascade only (never user-queried). If push notifications later need "find cursors pointing at a deleted message," add a partial covering index then.

### N4. `Scrollback.list_archive/3` GROUP BY runs a full per-subject network shard scan with no covering index
**File(s):** `lib/grappa/scrollback.ex:445-461` ; `priv/repo/migrations/*` (none cover it)
**Description:** `list_archive/3` does:

```elixir
Message
|> subject_where(subject)        # m.user_id = ? OR m.visitor_id = ?
|> where([m], m.network_id == ^network_id)
|> group_by([m], fragment("COALESCE(?, ?)", m.dm_with, m.channel))
|> select(...)
|> Repo.all()
```

The composite indexes available are `(user_id, network_id, channel, server_time)` and `(user_id, network_id, dm_with, server_time)`. The GROUP BY is on `COALESCE(dm_with, channel)` — a derived expression. SQLite cannot use either index for the grouping; it has to materialize every row in the per-(subject, network) shard, evaluate the expression per row, then aggregate. For a long-running operator with months of scrollback, this is a full subject-shard scan on every cic sidebar render that touches the archive endpoint. The `aggregate(... select: max(server_time), count(:id))` adds a second pass.

Today's volumes hide it. Push notifications + Phase 6 CHATHISTORY listener will both need archive-style enumeration as steady-state hot paths. The index pattern that fixes it is a *generated column* + index on `COALESCE(dm_with, channel)` — sqlite supports `GENERATED ALWAYS AS (...) STORED` columns since 3.31; the `(user_id, network_id, target, server_time DESC)` composite would let the planner stream the GROUP BY directly.

**Recommended fix:** Today: add a `@tag :perf` test that runs `EXPLAIN QUERY PLAN` on `list_archive/3` so a regression is loud. Phase 5 (push notifications): introduce a generated `target TEXT GENERATED ALWAYS AS (COALESCE(dm_with, channel)) STORED` column on `messages` + composite index `(user_id, network_id, target, server_time DESC)` + `(visitor_id, network_id, target, server_time DESC)`. Migration is additive (new column + indexes); the schema field is a virtual `target` with the same COALESCE so cic-side wire shape doesn't change.

---

## MEDIUM

### M1. `QueryWindows.windows_map` keys on integer `network_id` not slug — wire-shape inconsistency
**File(s):** `lib/grappa/query_windows/wire.ex:20, 22-26, 57-60`
**Description:** Every other typed wire event in the codebase uses `network_slug` (string) on the wire — `Scrollback.Wire.to_json` (`network: slug`), `Networks.Wire.connection_state_changed_event` (`network_slug:`), `ReadCursor.bulk_for_subject` (envelope keyed by `n.slug`). `QueryWindows.windows_list_payload` is the outlier: `windows: %{integer() => [...]}` keyed by raw FK integer, AND each entry's `network_id` field is also integer. cic has to cross-reference against its `networkBySlug` map to convert. Two costs: (a) cic-side complexity (every consumer re-keys); (b) the integer FK leaks an internal identifier the rest of the wire surface explicitly hides.

**Recommended fix:** Re-key `windows_map` by `network_slug` (string), drop the integer `network_id` from `windows_entry`. Migration is wire-breaking — coordinate with a cic deploy. Adds ~1 join in `list_for_user/1` (already preloads via the Window association) but eliminates a class of cic-side mapping bugs.

### M2. `Visitors.Visitor.ip` and `Accounts.Session.ip` are `:string` — accept anything, no validation
**File(s):** `lib/grappa/visitors/visitor.ex:51, 78` ; `lib/grappa/accounts/session.ex:66, 70`
**Description:** Both schemas store IP as a free-text `:string`. No format validation in the changeset — a caller can persist `"hello"` as an IP and the row goes in. Today the only writers are `Plugs.Authn` + `mix grappa.create_user` + `Visitors.create_anon` (which all pass real `:inet.ip_address/0` strings via `to_string/1`), but the discipline floor is below CLAUDE.md "Ecto.Changeset for ALL user input." If/when `count_active_for_ip/1` (per-IP cap) becomes a security boundary in the no-silent-drops cluster, the inconsistent representation between callsites is a foot-gun (e.g. one caller passes "127.0.0.1" while another passes "::ffff:127.0.0.1" → the cap counts them as different).

**Recommended fix:** Add `validate_change(:ip, &validate_inet/2)` to both `Visitor.create_changeset/1` and `Session.changeset/2`. The validator should normalize via `:inet.parse_address/1` + `:inet.ntoa/1` to canonicalize IPv4-mapped-IPv6 → IPv4. Reject malformed inputs as `{:error, changeset}` rather than silent persistence. Add a test that `127.0.0.1` and `::ffff:127.0.0.1` resolve to the same canonical form.

### M3. `Scrollback.fetch/6` channel-string drift between callers — no IRC-channel normalization layer
**File(s):** `lib/grappa/scrollback.ex:242-256` ; `lib/grappa/read_cursor.ex:100-106`
**Description:** Channel comparison everywhere is byte-equal (`m.channel == ^channel`). IRC channels are case-insensitive in RFC 2812 §2.2 but the columns store case-preserved input. Today, the per-(subject, network, channel) cursor for `#Foo` and `#foo` would create TWO distinct cursor rows because the partial unique index uses raw `channel` (no `lower()`). `Scrollback.fetch/6` likewise treats them as separate.

`QueryWindows` correctly uses `lower()` in its unique index. `read_cursors`, `messages`, and the in-process scrollback queries do NOT. A user joining `#Foo` then disconnecting + reconnecting where the upstream returns the canonical `#foo` would see two scrollback streams + two cursors.

**Recommended fix:** Decision needed: either (a) canonicalize channel names at the persistence boundary (downcase before insert/update everywhere), OR (b) add `lower()`-using indexes to messages + read_cursors. (a) is cheaper but loses round-trip fidelity for display; (b) preserves display + fixes correctness. Document the rule in CLAUDE.md once chosen. At minimum: add a regression test that asserts `#Foo` and `#foo` resolve to the same scrollback stream.

### M4. `read_cursors.last_read_message_id` ON DELETE SET NULL but nullable + required at changeset = mismatch
**File(s):** `priv/repo/migrations/20260513133825_create_read_cursors.exs:71` ; `lib/grappa/read_cursor/cursor.ex:79`
**Description:** Migration declares the column nullable (`NULL` + `ON DELETE SET NULL`) — intentional, per moduledoc, so message deletion doesn't blow away the cursor row. But `Cursor.changeset/2` has `validate_required([:network_id, :channel, :last_read_message_id])`. After a SET NULL cascade fires, the row exists with `last_read_message_id = nil`. The next `Repo.update` of that row via the changeset (e.g. when the operator scrolls + settles in the same channel) would crash with a `validate_required` error on a field that the migration explicitly admits as null.

This isn't reachable today (messages are never deleted in production paths), but the inconsistency is a latent bug class — the moment Phase 5 adds a "delete this network's scrollback" operator path, every cursor for that network has its `last_read_message_id` set null + becomes update-broken until the operator overwrites with a fresh id.

**Recommended fix:** Drop `:last_read_message_id` from `validate_required` and add `validate_required([:last_read_message_id])` only in the INSERT path (e.g. via a separate `insert_changeset/2`). Or use `validate_change/3` so the rule fires only when the field is being explicitly set. Add a regression test: insert a cursor, NULL out `last_read_message_id` via raw SQL, then call `set/4` again — should succeed in re-establishing the cursor.

### M5. `read_cursors` partial unique indexes don't cover the case where both subject FKs are NULL
**File(s):** `priv/repo/migrations/20260513133825_create_read_cursors.exs:78-86`
**Description:** The two partial unique indexes are `WHERE user_id IS NOT NULL` and `WHERE visitor_id IS NOT NULL`. Combined with the CHECK `(user_id IS NULL) <> (visitor_id IS NULL)` (XOR), exactly one branch is always true, so the indexes are sufficient. Subtle correctness — the design requires the CHECK to be enforced; if the CHECK were ever dropped or the WHERE clause edited, a both-NULL row would be invisible to both partial indexes and every `(network_id, channel)` would admit unbounded duplicates. Defense-in-depth would be a third partial index `WHERE user_id IS NULL AND visitor_id IS NULL` to fail loudly, but it would never fire in practice.

**Recommended fix:** Comment in the migration tying the two indexes' correctness to the CHECK constraint explicitly. Add a `Grappa.Migrations.ReadCursorsTest` (mirrors `CheckConstraintsTest`) that asserts: (1) CHECK constraint name + clause, (2) both partial-index WHERE clauses, (3) attempted both-NULL insert raises. Pin the invariant chain at test time.

### M6. `last_joined_channels` cap (`@last_joined_max = 200`) takes from HEAD not TAIL — wrong semantics
**File(s):** `lib/grappa/networks/credentials.ex:132, 137`
**Description:** Quote: `capped = Enum.take(channels, @last_joined_max)`. `Enum.take/2` with a positive count takes from the HEAD of the list. The doc says "Tail (oldest by sort key in the snapshot Session.Server passes in) is dropped on overflow." If the snapshot is sorted oldest-first, `Enum.take(channels, 200)` keeps the OLDEST 200 and drops the NEWEST — exactly inverted from intent. If the snapshot is sorted newest-first, the doc's "oldest dropped" claim is fine but the comment in the schema (`field :last_joined_channels, {:array, :string}, default: []`) doesn't pin the sort order. Either way, the cap depends on a caller-side sort convention that isn't documented.

**Recommended fix:** Pin the sort order in `Session.Server`'s caller comment (or in `update_last_joined_channels/3`'s docstring) AND verify with a unit test. If the intent is "drop oldest," and the snapshot is in JOIN order (oldest first), the cap should be `Enum.take(channels, -@last_joined_max)`. If newest-first, the current code is correct but should be documented as such.

### M7. `UserSettings.Settings` schema uses `:utc_datetime` — second precision; whole rest of codebase uses `:utc_datetime_usec`
**File(s):** `lib/grappa/user_settings/settings.ex:80` ; `lib/grappa/query_windows/window.ex:40`
**Description:** Carry-over from drafts-2026-05-12 S17. Still unfixed. `query_windows.opened_at` is `:utc_datetime`; `user_settings.inserted_at/updated_at` is `:utc_datetime`. Everything else (users, sessions, messages, networks, read_cursors) is `:utc_datetime_usec`. Mixed precision creates the "two clocks" problem at JSON wire emission and at `DateTime.compare/2` calls (subsecond comparisons against second-precision values always tie at microsecond=0). Currently no test exercises this comparison cross-schema, so the bug is latent.

**Recommended fix:** Standardize on `:utc_datetime_usec` everywhere. Migration is `alter table` (sqlite stores TEXT either way; no row rewrite needed). Existing data trims to `.000000Z` on read — harmless.

### M8. `messages.kind` CHECK constraint is a frozen snapshot — schema/DB drift class
**File(s):** `priv/repo/migrations/20260504020002_check_constraints_caps_auth_method_messages_kind.exs:346` ; `lib/grappa/scrollback/message.ex:89-100`
**Description:** Carry-over from drafts-2026-05-12 S13. Still applies. `Message.@kinds` is the schema's source of truth (10 atoms today). The `kind_enum` CHECK in the `recreate_messages_with_check/0` migration hard-codes the same 10 values. Adding an 11th kind (e.g. `:invite_ack` or `:peer_away` per the CP30 numeric-delegation cluster) requires editing BOTH the schema and a NEW recreate migration that copies the kind_enum CHECK forward. The drift would surface as "Ecto.Enum casts the new atom fine but DB rejects the row at insert with a CHECK violation that doesn't carry the constraint name through ecto_sqlite3."

`Grappa.Migrations.CheckConstraintsTest` exists and tests the auth_method enum (verified via grep). Add a sibling that asserts `Message.kinds()` is `==` the literal list parsed out of the latest `kind_enum` CHECK.

**Recommended fix:** Extend `Grappa.Migrations.CheckConstraintsTest` (or sibling) to assert kind-enum drift at test time. Document in `Message.@kinds`'s comment that adding a kind requires both a schema edit and a recreate-messages migration; pin the file path of the latest recreate.

---

## LOW

### L1. `read_cursors` schema doc claims "ON DELETE SET NULL recoverable to 'everything before earliest extant row read'" — recovery code does not exist
**File(s):** `priv/repo/migrations/20260513133825_create_read_cursors.exs:31-36`
**Description:** The migration's moduledoc promises a recovery semantic for the SET NULL case ("recoverable to 'everything before earliest extant row read' rather than losing the entire window's read state"). Neither `Grappa.ReadCursor` nor any consumer implements this — a row with `last_read_message_id = nil` is a pure ambiguity at the cic side (the bulk_for_subject envelope omits it on the wire because the integer projection assumes non-null). Doc-vs-code drift; either build the recovery path (Phase 6) or pull the promise out of the migration moduledoc.
**Recommended fix:** Trim the moduledoc to "ON DELETE SET NULL is for FK integrity; nullable rows are treated by all callers as 'no cursor'." Defer the smarter recovery semantic to a future cluster.

### L2. `UserSettings.validate_patterns` builds a synthetic-UUID changeset (carry-over S20)
**File(s):** `lib/grappa/user_settings.ex:200-215`
**Description:** Same as drafts-2026-05-12 S20. Still unfixed. The function constructs a `%Settings{user_id: Ecto.UUID.generate(), data: %{}}` purely so it can attach an error. Cleaner: return `{:error, {:invalid_patterns, [reason]}}` from `set_highlight_patterns/2` and let the controller render. `FallbackController` already handles arbitrary error tuples.
**Recommended fix:** Same as S20 — refactor return shape; let the controller render via FallbackController.

### L3. `query_windows.id` autoincrement is unused — composite PK candidate
**File(s):** `lib/grappa/query_windows/window.ex:33-41` ; `priv/repo/migrations/20260504130000_create_query_windows.exs`
**Description:** `query_windows` has a surrogate `id` PK + a unique index on `(user_id, network_id, lower(target_nick))`. The `id` is never referenced by FK from any other table, never appears in the wire shape (which uses `(network_id, target_nick)`), and the only ordering is `[asc: w.opened_at, asc: w.id]` (id as tiebreaker). Composite PK on `(user_id, network_id, lower(target_nick))` would save a column + an index. Same shape as `network_credentials` (which uses composite PK).
**Recommended fix:** Cosmetic. Defer unless a future schema rework touches this table.

### L4. No reaper for orphan cursors (visitor delete + ON DELETE CASCADE handles it; user delete same; network delete same — but what about channel "leave forever"?)
**File(s):** `lib/grappa/read_cursor.ex` (no delete API)
**Description:** When a user PARTs a channel and never rejoins, the cursor stays. Bound by the channel-name string, not by any join state. Across years of operator use, dead cursor rows accumulate (every channel ever visited). Not a bug — the row is tiny — but the bulk_for_subject envelope grows unboundedly. Phase 6 listener facade will deliver MARKREAD lines for every dead cursor on connect.
**Recommended fix:** Add an explicit `Grappa.ReadCursor.delete/3` (subject, network_id, channel) verb + REST hookup at `DELETE /networks/:net/channels/:chan/read-cursor`. cic invokes on user-initiated channel close (`/close`). No background reaper — explicit operator action only. Defer until cic actually has a "close DM forever" verb.

### L5. `Visitors.find_or_provision_anon/3` race vs unique index (carry-over S21)
**File(s):** `lib/grappa/visitors.ex:81-95`
**Description:** Same race window as drafts-2026-05-12 S21. The contention is rare (anon login burst) but the changeset return shape on the loser is `{:error, %Ecto.Changeset{}}` with a uniqueness violation — the `AuthController` surfaces it but doesn't retry. `Networks.find_or_create_network/1` shows the canonical retry pattern (lookup_or_insert → insert_or_recover → recover_race).
**Recommended fix:** Same — mirror the Networks retry pattern. Trivial.

### L6. `Networks.Credential` has paired `effective_realname/1` + `effective_sasl_user/1` — single helper would suffice
**File(s):** `lib/grappa/networks/credential.ex:319-329`
**Description:** Two near-identical functions encoding "field || nick" fallback. Could be `effective_field(cred, :realname)` + `effective_field(cred, :sasl_user)` from one private helper. Pure cleanup; no behavior change.
**Recommended fix:** None — leave as-is unless touching this file for unrelated reasons. Pattern is clear at callsite.

---

## NIT

### NIT1. `Scrollback.Wire.to_json/1` typespec declares `kind: Message.kind()` (atom) but Jason serializes atoms to strings on the wire — typespec is "in-memory shape," not "wire shape"
**File(s):** `lib/grappa/scrollback/wire.ex:43, 47`
**Description:** Cosmetic. The wire shape is the post-Jason-encode JSON, where `kind` is a string. The typespec `Message.kind()` (atom) is the in-memory shape Elixir sees. Compare to `Scrollback.Wire.archive_wire_entry` (`kind: String.t()`) which correctly uses string. Document the convention or align.
**Recommended fix:** Comment in the typespec explaining that atoms stringify on encode; the Elixir caller observes atoms, the JSON consumer observes strings. Or split into `wire_t()` (post-Jason) vs `t()` (in-memory) shapes.

### NIT2. `ReadCursor` moduledoc says "Phase 6 IRCv3 facade exposes the same cursor as `+draft/read-marker` MARKREAD lines on the listener side" — `+draft/read-marker` is the IRCv3 cap, MARKREAD is the verb
**File(s):** `lib/grappa/read_cursor.ex:18-20`
**Description:** Pedantic but the moduledoc conflates the cap name with the verb name. Phase 6 implementer will catch it; flag for future-author awareness.
**Recommended fix:** Trim or be precise. Defer.

### NIT3. `network_credentials.connection_state_changed_at` defaults via the changeset (`put_default_connection_state_changed_at/1`) instead of at the migration layer
**File(s):** `lib/grappa/networks/credential.ex:212-220`
**Description:** Comment explains "sqlite ADD COLUMN forbids CURRENT_TIMESTAMP defaults" — fair. But the schema-layer fallback creates a footgun: any future bypass of the changeset (e.g. a `Repo.insert(struct, on_conflict:)` from a mix task) lands a NULL into the column. Mitigated by `connection_state_changed_at` being typed `DateTime.t() | nil` so callers don't crash on read, but a NULL there is invisible to operators looking at "when did this state last change." Not a bug today.
**Recommended fix:** Add a CHECK constraint `connection_state_changed_at IS NOT NULL` in a future recreate migration to make the invariant DB-enforced.

---

## Trajectory risks (B5 — what'll bite the next clusters)

### Push notifications (next cluster after no-silent-drops)
1. **`Scrollback.list_archive/3` shard scan** (N4) — push deciding "is this DM unread + worth notifying" needs efficient enumeration of recent activity per subject. Today's full-scan is OK; with notifications running on every channel message it becomes a hot path.
2. **`ReadCursor.set/4` settle-event chatter** (N2) — push-counter computation `count(messages.id WHERE id > cursor.last_read_message_id)` runs per (subject, network, channel) per push render. Compounded by frequent settle-event cursor moves, the read amplification climbs fast. Pre-aggregate unread counts in the cursor row (`last_read_message_id` + `unread_count` pair, atomic update via `Ecto.Multi`) to amortize.
3. **Visitor cursor broadcast bug** (N1) — push notifications for visitor sessions are explicitly out of scope (visitors are single-tab by design), but the bug-class is "controller does work no subscriber receives." Same shape will reappear if push subscribes per-visitor.

### Image upload (post-push)
1. **`messages.body` is `:string` (TEXT)** — fine for inline image URLs, but the wire-shape contract (`Scrollback.Wire.to_json/1`) doesn't carry an `attachments` field. Adding image attachments as a sibling table (with `message_id` FK) requires the cascade-on-message-delete chain to extend to a new dependent — the messages-recreate migration pattern (M5 fragility flag in `add_dm_with_to_messages`) would need yet another column-list update.
2. **Cloak vault for PII**: image upload typically involves operator-storage (catbox.moe per memory `project_image_upload`). No on-disk image blob lives in the DB — but if attachment metadata (uploader IP, original filename) lands on a row, those fields need a Cloak field if they're sensitive.

### Voice (post-image)
1. **Schema additions to `messages` for voice-call metadata** (call_id, duration, peer) hit the messages-recreate fragility class for the third time (after `dm_with` + `(future kind extensions)`).

### Mobile UI polish + PUBLIC OPEN
1. **`max_visitors_per_ip` cap** + IP storage class drift (M2) — public-facing means hostile traffic; per-IP cap accuracy matters. Validate IP at the boundary BEFORE going public.
2. **Sobelow / mix_audit gates on Cloak** — ensure key rotation path is documented before public open. Today the prod key comes from `GRAPPA_ENCRYPTION_KEY`; rotating it requires re-encrypting every `password_encrypted` column. No tooling for that exists yet.
3. **No-silent-drops invariant** (this cluster's theme): N1 (visitor cursor broadcast routes to nobody) is the ONLY new silent-drop-shaped bug found in the persistence layer. Worth fixing this cluster.

---

## Closed/Confirmed-Fixed (from drafts-2026-05-12)

- **S1 (foreign_keys PRAGMA)** — disproved 2026-05-12 (adapter sets it by default). No action.
- **S2, S3 (busy_timeout, pool_size docs)** — landed in CP24 cluster. `busy_timeout: 30_000` present in `runtime.exs:42` + `dev.exs:7`; documented at length.
- **S5 (network_credentials.connection_state partial index)** — landed in `20260512083037`. Confirmed.
- **S8 (last_joined_channels cap)** — landed (`@last_joined_max = 200`) but with the inversion bug per M6 above.
- **S6 (CHECK enforcement clarification)** — no fix needed.
- **Other carry-overs (S9 query plan smoke, S10 redundant index, S11 SQL-vs-Elixir now, S13 kind enum drift, S14-19, S22-27)** — Not re-investigated this round; status assumed unchanged unless flagged above as M7/M8.
