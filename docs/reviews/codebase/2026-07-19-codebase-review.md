# Codebase Review — 2026-07-19 (completed 2026-07-20)

**Base:** `main` @ `0f2fe3c4` (includes the 17-commit #247 `/notify` presence-watch feature).
**Method:** 8 scope agents per `.claude/skills/review` (codebase mode), run sequentially/pairwise over two sessions to respect usage limits. Full per-scope findings below; triage first.
**Previous review:** 2026-07-08 (11 days — within the 12-session/2-week gate).

## Severity summary

| Scope | CRITICAL | HIGH | MEDIUM | LOW | Findings |
|-------|----------|------|--------|-----|----------|
| irc/ | 0 | 0 | 4 | 9 | 13 |
| persistence/ | 0 | 0 | 3 | 9 | 12 |
| lifecycle/ | 0 | 1 | 3 | 7 | 11 |
| web/ | 0 | 0 | 7 | 9 | 16 |
| cicchetto/ | 0 | 1 | 4 | 5 | 10 |
| cross-module | 0 | 0 | 2 | 4 | 6 |
| docker/infra | 0 | 2 | 8 | 14 | 24 |
| cross-surface | 0 | 1 | 6 | 6 | 13 |
| **Total** | **0** | **5** | **37** | **63** | **105** |

Zero CRITICAL across 105 findings: the load-bearing invariants (single parser,
case-folding, server-owned state, Wire discipline, Boundary annotations,
Logger allowlist, migration hygiene) all held under sweep — the cross-module
agent explicitly verified those clean. The findings cluster at **contract
seams** (server↔client drift gates, error-copy mapping, doc-reality
divergence) and in the **freshest code** (#247 carries 1 of 5 HIGHs directly
and a large share of MEDIUMs), which is the review working as designed.

## Triage — must-fix (all HIGH)

| # | Finding | Bucket |
|---|---------|--------|
| H1 | lifecycle S1 — 512/734 presence-error numerics misroute to a ghost query window instead of `$server`; leaks into archive; untested | A notify-hardening |
| H2 | cicchetto S1 — token rotation with unchanged identity never re-joins the user topic; all user events + push verbs dead until reload | B client-lifecycle |
| H3 | cross-surface S6 — `/invite` fire-and-forget paints ✓ on rejected/dropped frames; read-query verbs swallow validation rejects entirely | C no-silent-drops |
| H4 | docker S1 — Dockerfile dep/compile bake 100% shadowed by the `./:/app` bind mount in every deployment shape | D infra |
| H5 | docker S2 — `iex.sh`/`observer.sh` boot a second full application (duplicate IRC sessions, sqlite WAL contention) instead of remsh-attach | D infra |

## Triage — gating MEDIUMs (architecture smell / maintainability / evolution risk)

- **A notify-hardening (#247 follow-up):** lifecycle S2 (ghost-recovery bare `==` nick compare), lifecycle S3 (unguarded `Notify.list/2` Repo read can crash sessions at reconnect pressure — reopens the #336 class), persistence S1 (SubjectReset never drains notify_entries — e2e flake vector), persistence S3 + web S4 + web S5 (zero visitor-subject / WS-snapshot / quiet-re-add test coverage on fresh #247 surfaces), cicchetto S3 (notifyWatch store not identity-scoped — cross-account leak).
- **E fold consistency:** persistence S2 (fold SQL half-migrated — QueryWindows literal unpinned by the drift test), cicchetto S4+S5 / cross-surface S13 (client folds: Unicode `toLowerCase` in `rfc1459Fold`, bare `.toLowerCase()` sites bypassing `nickEquals`, two unpinned client fold impls), irc S4 (**decision needed**: `canonical_channel/1` diverges from rfc1459 channel casemapping — forks `#chan[1]`/`#chan{1}`, merges `#CAFÉ`/`#café`; fix or pin as accepted in DESIGN_NOTES).
- **F wire-contract drift gates:** cross-surface S1 (`String.t()` envelope kinds defeat codegen literal pinning in ~10 Wire modules), cross-surface S2 (codegen drops `optional(...)` — generated types over-claim), cross-surface S7 (largest payloads have no `_Assert_` pins), web S1 (FallbackController spec drifted six tags behind clauses).
- **G boundary robustness:** web S2 (`away` payload crash), web S3 (no `handle_in` catch-all — hostile client crashes channel pid), web S6 (non-atomic admin settings PUT), irc S1–S3 (SASL numeric phase pins, nick/ident single-token gap, privmsg target splice — all pre-existing wire-frame classes).
- **H error-copy mapping:** cross-surface S3/S4/S5 (server error tokens with no cic copy despite server comments promising it).
- **I reuse:** web S7 (subject topic-label derivation copy-pasted across 7 modules — single source needed).
- **J rule decision:** cross-module S2 (runtime `Application.get_env` DI-seam pattern propagating across 3 modules — either migrate to the boot-time `:persistent_term` pattern or amend CLAUDE.md to bless the seam explicitly).
- **D infra:** docker S5 (`mix.sh --env=prod` runs against the dev DB file), docker S6 (Docker hot-deploy swallows per-module reload failures the jail path treats as fatal), docker S10 (deploy scripts do side effects before their worktree/branch guards).

LOW findings (63) are informational — docs drift, dead code, hygiene; sweep opportunistically or batch into the tech-debt issue.

**Dedup notes:** no exact duplicates across agents. Deliberate overlaps kept: fallback-spec drift (web S1) vs missing cic mappings (cross-surface S3) are the two sides of one seam; the fold findings (persistence S2, lifecycle S4, cicchetto S4/S5, cross-surface S13, irc S4) are one theme across four surfaces — bucket E treats them as a single cluster.

## Trajectory

**Recently built:** the themes gallery cluster (#299 et seq.), the #247
`/notify` presence-watch feature (server context + session presence + REST/WS
surface + cic panel/toasts), and a steady stream of cicchetto UX work (the
#345–#363 issue band: mobile ergonomics, scroll behavior, i18n epic,
registration wizard). All of it serves the core mission — the notify feature
is classic bouncer parity, and the UX band is the "UI polish" cluster on the
road to PUBLIC OPEN.

**Health:** invariant discipline is holding (zero CRITICAL, clean cross-module
sweeps). The review's concentration of HIGHs/MEDIUMs in week-old code (#247,
infra drift) says the ship-then-review loop is catching things at the right
cadence, but also that fresh features are landing with test gaps on their new
surfaces (web S4/S5, persistence S3) — worth tightening at authoring time.

**Stalling:** Phase 5 hardening (#88–#101) advances only when an item blocks
something else; Phase 6 listener is untouched (fine — it's post-PUBLIC-OPEN
long-tail). Infra/scripts accumulated the largest single-scope finding count
(24) — the docker scope hadn't had a dedicated review pass before, and it
shows.

**Direction (2–3 sentences):** burn down the five HIGHs plus bucket A
(notify-hardening) as one worktree cluster before the next feature cluster —
most fixes are small and localized. Then resume the P0 cicchetto issues
(#360, #356) which align with the UI-polish roadmap cluster. Run the planned
architecture review separately; buckets E/F/I/J above are its natural inputs.

**Process note:** `docs/checkpoints/` no longer exists (retired with the todo
migration to GitHub issues); the skill doc and `docs/todo.md`'s closing pointer
still reference it — update both. Review stats recorded here in lieu of a
checkpoint update.

---

# Per-scope findings (verbatim agent reports)

---

## irc/ agent findings (2026-07-19 codebase review)

**Severity count: 0 CRITICAL, 0 HIGH, 4 MEDIUM, 9 LOW**

Scope reviewed: `lib/grappa/irc/{parser,message,client,auth_fsm,identifier,identity,ctcp,line_split}.ex`, `lib/grappa/irc.ex`, and all of `test/grappa/irc/`. Cross-checked against CLAUDE.md invariants, the Logger metadata allowlist in `config/config.exs`, and the GH #121 / irc-review entries in `docs/DESIGN_NOTES.md`.

### S1. AuthFSM SASL numerics 903/904/905 have no pre-registration phase pin
**File:** `lib/grappa/irc/auth_fsm.ex:336-342`
**Category:** FSM exhaustiveness / phase-guard consistency
**Severity:** MEDIUM
The S1-S4 (post-registration) and C1 (pre-`:sasl_pending` AUTHENTICATE) reviews pinned every other auth-relevant clause to its legitimate phase, but the three SASL numerics remain phase-free below `:registered`: (a) a stray 904/905 arriving in `:pre_register`/`:awaiting_cap_ls`/`:awaiting_cap_ack` stops the client with `{:sasl_failed, code}` even though no AUTHENTICATE was ever sent — the exact spurious-crash class S3 fixed post-registration, still open pre-registration; (b) a stray/hostile 903 in `:awaiting_cap_ls` or either cap-ack phase emits `CAP END`, resets to `:pre_register`, and silently aborts the SASL chain — under mandatory `auth_method: :sasl` the session then registers **without SASL** instead of stopping `:sasl_unavailable`. The only legitimate phase for all three numerics is `:sasl_pending`.
**Fix:** Pin the 903 and 904/905 clauses on `%__MODULE__{phase: :sasl_pending}`; let strays in other phases fall to the catch-all `{:cont, state, []}` (mirroring the C1 AUTHENTICATE catch-all).

### S2. AuthFSM `new/1` leaves the single-token gap open for `nick` and `ident` that S30 closed for PASS passwords
**File:** `lib/grappa/irc/auth_fsm.ex:188-196`
**Category:** Wire-frame boundary validation (S30 class)
**Severity:** MEDIUM
`validate_line_safe/1` gates `:nick`/`:ident` only with `safe_line_token?/1` (CR/LF/NUL), but both are single wire tokens: a space in `nick` emits `NICK vjt evil` (server registers `vjt`, `state.nick` holds `"vjt evil"`, self-detection via `nick_eq?` silently breaks), and a space in `ident` shifts every USER positional slot (`USER gr p 0 * :real` — garbled registration, no breadcrumb). This is byte-for-byte the S30 failure class ("silently truncates to the first token → restart loop with no breadcrumb") that was fixed for `:server_pass`/`:auto` passwords only. The module's own rationale (irc/S5: self-defending boundary for the Phase-6 listener and future callers that bypass `Networks.Credential`) applies identically here — today only the changeset path saves it.
**Fix:** In `validate_line_safe/1`, gate `:nick` and `:ident` with `Identifier.safe_oper_token?/1` (or the stronger `valid_nick?/1` / `valid_ident?/1`), keeping `:realname` (trailing) and `:sasl_user` (base64-wrapped) on the CR/LF/NUL-only gate.

### S3. `send_privmsg/3` accepts a space-bearing target — middle-param wire splice
**File:** `lib/grappa/irc/client.ex:305-311`
**Category:** Wire-frame boundary validation / consistency
**Severity:** MEDIUM
The target is a middle (non-trailing) wire param, but the guard is only `target != "" and safe_line_token?(target)` — spaces pass. `PRIVMSG #a b :body` shifts the param boundary: the server delivers to `#a` with garbled text or drops the frame, reproducing exactly the silent-no-op class irc/S3 fixed for the empty target. The codebase's own discipline already uses the single-token predicate for every other single-slot field for this exact reason (`send_oper`, `send_who` per #221, the S30 PASS gate).
**Fix:** Gate the target with `Identifier.safe_oper_token?(target)` (non-empty + no whitespace + no CR/LF/NUL) and keep `safe_line_token?/1` for the trailing body.

### S4. `canonical_channel/1` diverges from the ircd's rfc1459 channel casemapping — forks and merges windows
**File:** `lib/grappa/irc/identifier.ex:157-161`
**Category:** Casemapping discipline (GH #121 class, channel side)
**Severity:** MEDIUM
`CASEMAPPING=rfc1459` on bahamut applies to **channel names too**, not just nicks, and it is byte-level ASCII. `canonical_channel/1` instead uses Unicode `String.downcase/1` with no bracket fold. Two concrete divergences: (a) `#chan[1]` and `#chan{1}` are the **same** channel to bahamut but produce two distinct grappa window keys — the silent window-fork CLAUDE.md's channel invariant exists to prevent; (b) Unicode downcase folds non-ASCII (`#CAFÉ` → `#café`) that bahamut does **not** fold — two distinct upstream channels merge into one grappa window key (scrollback, cursors, and PubSub topics interleaved). GH #121 fixed exactly this class for nicks (`canonical_nick/1` is deliberately byte-level ASCII for this reason); the channel fold was never brought in line, and no DESIGN_NOTES entry pins the divergence as accepted.
**Fix:** Apply the same rfc1459 byte-level fold to the channel body after the sigil (ASCII A-Z + `[]\~` → `{}|^`), replacing `String.downcase/1`; audit stored channel keys for a backfill migration (same expression-index/dedup pattern as the #121 migrations). If the team decides ASCII-downcase-only is the accepted posture, record it in DESIGN_NOTES with the fork/merge consequences.

### S5. `@typep verb` is missing `:channel_modes` — closed-set drift
**File:** `lib/grappa/irc/client.ex:788-810` (type), `lib/grappa/irc/client.ex:575` (call)
**Category:** Untyped / weakly-typed (closed-set drift)
**Severity:** LOW
`send_channel_modes/2` calls `reject_invalid_line(:channel_modes)` but `:channel_modes` is absent from the `@typep verb` union that specs `reject_invalid_line/1`. The closed set has silently drifted from the call sites; the next helper added will copy whichever pattern is closer.
**Fix:** Add `:channel_modes` to the `verb` typep.

### S6. `:ok = transport_setopts(...)` re-arms are latent MatchError crashes on a dying socket
**File:** `lib/grappa/irc/client.ex:1368` and `lib/grappa/irc/client.ex:1383`
**Category:** No-silent-swallow / crash-shape at boundary (U-cluster class)
**Severity:** LOW
Both `process_line/2` arms assert `:ok = transport_setopts(state, active: :once)`. `:inet.setopts/2` / `:ssl.setopts/2` return `{:error, :einval}` once the port is gone (e.g. socket closed under the Client, the very scenario the U-cluster test provokes with `:gen_tcp.close/1`), so a line-in-flight race crashes the Client with a wrapped `MatchError` instead of a clean `:tcp_closed`/`:ssl_closed` — the exact crash shape the U-cluster fix removed from `transport_send` because `Session.Server`'s narrow exit-catch list misses it (5s supervisor block per child). The inline comment ("the next info-message will stop us") is wrong for the error-return case: the MatchError raises before any next message.
**Fix:** Pattern-match the setopts result: on `{:error, _}`, `{:stop, :tcp_closed | :ssl_closed, state}` (or fall through and let the pending close message arrive) instead of asserting `:ok`.

### S7. `Message.tag/3` has no production caller
**File:** `lib/grappa/irc/message.ex:155-157`
**Category:** Dead code
**Severity:** LOW
Only `tag/2` is used in `lib/` (`session/numeric_router.ex:521`, `session/server.ex:2441`). The 3-arity default-carrying variant is exercised solely by its own tests.
**Fix:** Delete `tag/3` (and its tests) until a caller exists; `tag/2` + `||`/`case` covers the need.

### S8. Comments describe a "recv-loop nils the socket post-tcp_closed" mechanism that does not exist
**File:** `lib/grappa/irc/client.ex:126`, `lib/grappa/irc/client.ex:955-958`, `lib/grappa/irc/client.ex:1456-1459`
**Category:** Stale/misleading comments
**Severity:** LOW
Three comment sites (the `send_result` type, the `handle_call({:send, ...})` note, and the `transport_send` nil-guard) attribute `socket: nil` to "recv-loop nilled post-tcp_closed", but no code path ever nils the socket after assignment — `{:tcp_closed, _}` / `{:ssl_closed, _}` stop the process immediately. The only real `nil` window is pre-connect / connect-failed-awaiting-giveup; the corresponding test has to fabricate the state via `:sys.replace_state` (`client_test.exs:509`). The fictional mechanism will mislead the next maintainer reasoning about socket lifecycle.
**Fix:** Reword the three comments to name the real windows: pre-`handle_continue` and the 30s connect-failed throttle window.

### S9. Parser moduledoc grammar claims `*14( SPACE middle )` but the 14-param rule is not implemented
**File:** `lib/grappa/irc/parser.ex:15` (grammar), `lib/grappa/irc/parser.ex:350-358` (implementation)
**Category:** IRC parser exhaustiveness / doc-code mismatch
**Severity:** LOW
RFC 2812 caps middle params at 14, with the 15th token becoming the trailing param **even without a `:` prefix**. `parse_params/2` splits unboundedly, so a server sending 15+ middles without a colon (legal per the RFC the moduledoc quotes) parses the colonless trailing into multiple params. Real ircds virtually always send the colon, but the moduledoc asserts a grammar the code doesn't honor — and the Phase-6 listener will parse *client*-originated lines where sloppy colonless trailing is more common.
**Fix:** Either implement the 14-middle cutoff in `parse_params/2` or correct the moduledoc grammar to state the deviation explicitly.

### S10. `services_sender?/1` property test re-implements the allowlist and has already drifted
**File:** `test/grappa/irc/identifier_test.exs:418-434`
**Category:** Test quality (hardcoded re-implementation, CLAUDE.md "use production code in tests")
**Severity:** LOW
The property builds its own `MapSet.new(~w(nickserv chanserv memoserv operserv botserv hostserv helpserv))` — 7 entries — while production `@services` has 8 (`rootserv` added). If StreamData ever generated `"rootserv"` (any case) the property would assert `refute services_sender?` against a true positive and fail. Probability is negligible, but the duplicated list has *already* drifted, which is precisely the failure mode the "never re-implement logic in tests" rule targets; the drift also silently weakens what the property proves.
**Fix:** Derive the test's allowlist from production — expose the list (e.g. `Identifier.services/0` or a `@doc false` accessor) or at minimum assert the named-list test covers the same set the property excludes, so a drift fails loudly.

### S11. No positive-path Client tests for eight send helpers
**File:** `test/grappa/irc/client_test.exs`
**Category:** Test coverage
**Severity:** LOW
`send_part/2`, `send_away/2` (set path), `send_away_unset/1`, `send_whois/3` (both arities, including the #198 two-arg `WHOIS <server> <nick>` ordering), `send_whowas/2`, `send_lusers/1`, `send_info/1`, `send_version/1`, `send_motd/1` have no emission assertions at the Client boundary — only rejection tests exist for `send_part`/`send_away`, and nothing at all for the rest. The wire framing (param order, colon placement) is exactly what these helpers exist to own; a regression (e.g. swapping WHOIS arg order) would pass this suite.
**Fix:** Add one `IRCServer.wait_for_line` framing assertion per helper, mirroring the existing `send_kick`/`send_invite` pattern.

### S12. `resolve_and_ifaddr/1` double-resolves DNS and bypasses the #271 resolver seam
**File:** `lib/grappa/irc/client.ex:1339-1351`
**Category:** Consistency / use-the-infrastructure
**Severity:** LOW
The v6-pool path calls `:inet_res.lookup(host, :in, :aaaa)` directly to probe AAAA existence, then `connect_with_rotation/6` resolves the same name again through the injected `deps.resolver`. Two DNS round-trips per connect, and the pool-path lookup is invisible to the #271 test seam (untestable without a real resolver). `source_bind/2` similarly uses raw `:inet.getaddr/2`.
**Fix:** Thread `deps.resolver` into `resolve_and_ifaddr/1` (and `source_bind/2`) so one resolution feeds both the family decision and the rotation set.

### S13. Default arguments via `\\` in test helpers
**File:** `test/grappa/irc/client_test.exs:30`, `test/grappa/irc/client_test.exs:45`, `test/grappa/irc/client_test.exs:79`
**Category:** Default arguments (CLAUDE.md "No default arguments via `\\`")
**Severity:** LOW
`start_server(handler \\ passthrough_handler())`, `start_client(port, overrides \\ %{})`, and `sasl_handler(numeric \\ "903 ...")` use `\\` defaults. None is a genuine config default; CLAUDE.md's rule carries no test-file exemption and directs removal when touching code that uses them.
**Fix:** Make the parameters explicit at call sites, or split explicit zero-arg wrappers (`start_server()` / `start_server(handler)`) if brevity matters.

---

## persistence/ agent findings (2026-07-19 codebase review)

**Severity summary: 0 CRITICAL, 0 HIGH, 3 MEDIUM, 9 LOW** (12 findings)

SQLite posture checked and clean: WAL + `busy_timeout: 30_000` + `synchronous: :normal` + `foreign_keys: :on` pinned in all three envs (`config/runtime.exs:101-137`, `config/dev.exs:3-11`, `config/test.exs:3-11`); pool-saturation degradation (#336) and pool tuning (#337) are documented/filed; migrations use plain `create`; the notify_entries fold SQL is byte-identical to `Identifier.nick_fold_sql/1` and pinned by the migration drift test. Findings below.

### S1. `Notify.clear_all_for_user/1` is dead code — SubjectReset never drains notify_entries
**File:** `lib/grappa/test_support/subject_reset.ex:162-168` (and `lib/grappa/notify.ex:226-235`)
**Category:** dead code / e2e state leakage
**Severity:** MEDIUM
`Notify.clear_all_for_user/1` was written with a docstring saying "Intended for `Grappa.TestSupport.SubjectReset` only", but `SubjectReset.do_reset/2` calls `ReadCursor.clear_all_for_user`, `QueryWindows.close_all_for_user`, `Push.subscription_clear_all_for_user`, `UserSettings.reset_for_user`, `Uploads.delete_all_for_user` — and never `Notify.clear_all_for_user`. The e2e reset therefore leaves watch-list rows behind: a spec that runs `/notify add` pollutes every subsequent reset baseline, and the leftover list re-arms MONITOR/WATCH on the respawned session (`Session.Server` reads `Grappa.Notify.list/2` at end-of-MOTD), which can flake unrelated specs with presence events/toasts. Zero grep hits for the function anywhere.
**Fix:** Add `:ok = Notify.clear_all_for_user(user.id)` to `SubjectReset.do_reset/2` alongside the sibling drains (or delete the function if the reset gap is deliberately accepted — but then the docstring lies).

### S2. rfc1459 fold SQL half-migrated to the single source — QueryWindows still hand-copies the literal, unpinned by the drift test
**File:** `lib/grappa/query_windows.ex:273`
**Category:** consistency / #121 fold invariant
**Severity:** MEDIUM
Review 2026-07-19 introduced `Identifier.nick_fold_sql/1` as the single source for the conflict-target fold fragment and migrated `Grappa.Notify` (`notify.ex:323`), but `Grappa.QueryWindows` still carries the hand-copied literal `@nick_fold_sql "replace(replace(...lower(target_nick)...)"`. Worse, the drift-pin test (`test/grappa/irc/identifier_test.exs:502-524`) scans only `priv/repo/migrations/*.exs` — the QueryWindows module attribute is the one remaining copy with **no** pin. CLAUDE.md: "Total consistency or nothing. Half-migrated creates two patterns — Claude copies whichever is closer." A future fold change would fail loudly on migrations and Notify but leave QueryWindows' upsert conflict target erroring at runtime ("ON CONFLICT clause does not match any … unique constraint") on the first contended DM-window open.
**Fix:** Replace `query_windows.ex:273` with `@nick_fold_sql Grappa.IRC.Identifier.nick_fold_sql("target_nick")`, and/or extend the drift-pin test's scan to `lib/**` fold literals.

### S3. Notify has zero visitor-subject test coverage
**File:** `test/grappa/notify_test.exs` (whole file), `test/grappa_web/controllers/notify_controller_test.exs`
**Category:** test quality
**Severity:** MEDIUM
Every test in both files uses `{:user, user.id}`. The visitor arm is entirely unexercised: `conflict_target({:visitor, _})` (a distinct `:unsafe_fragment` against the visitor partial unique index — the exact class of thing that breaks silently when the fragment and index drift), `check_subject_exists/2`'s Visitor branch, the `notify_entries_visitor_network_nick_folded_index` itself, and the visitor-reap CASCADE of notify rows. The moduledoc sells subject parity ("Both registered users and visitors may keep watch lists"); the tests don't prove it. If the visitor fragment were wrong, no test would catch it.
**Fix:** Add a visitor fixture and mirror at minimum: idempotent add (exercises the visitor conflict target), fold-collapse, unknown-visitor changeset error, and a CASCADE-on-`Visitors.delete/1` assertion.

### S4. Stale `dm_with` error message and comment exclude `:notice`
**File:** `lib/grappa/scrollback/message.ex:321-342`
**Category:** misleading boundary error
**Severity:** LOW
`@dm_with_eligible_kinds` derives from `@content_kinds` (`[:privmsg, :notice, :action]` — the CP23 extension added `:notice`), but the validator's error message still reads `"may only be set on :privmsg or :action rows"` and the comment at line 322 repeats the pre-CP23 pair. A developer debugging a rejected changeset is told a rule that isn't the rule.
**Fix:** Reword to derive or at least match: `"may only be set on content kinds (#{inspect(@dm_with_eligible_kinds)})"`.

### S5. Unreachable `unique_constraint` mapping in `identity_changeset/2`
**File:** `lib/grappa/networks/credential.ex:484-488`
**Category:** dead code
**Severity:** LOW
The second `unique_constraint(:nick, name: :network_credentials_user_id_network_id_index, message: "credential already exists for this (user, network)")` can never fire from an identity edit — that index is `(user_id, network_id)` and contains no nick column; a nick/ident/realname change cannot violate it. The comment itself trails off admitting it ("n/a — but a future cross-user guard"). If it somehow fired, the message would be attached to `:nick` and be wrong.
**Fix:** Delete the mapping; re-add deliberately if a user-side folded-nick index ever exists.

### S6. UserSettings typed setters are lost-update racy (read-modify-write on the whole JSON blob)
**File:** `lib/grappa/user_settings.ex:210-217, 316-323, 368-380, 441-448, 500-512`
**Category:** transaction granularity
**Severity:** LOW
Every setter does `get_or_init` → `Map.put(settings.data, key, value)` → `Repo.update` with no transaction or optimistic lock. Two concurrent setters for *different* keys (e.g. `put_vhost_selection` from one tab, `put_notification_prefs` from another) interleave read-before-write and the loser silently reverts the winner's key. SQLite's single-writer lock serializes the UPDATEs, not the SELECT-then-UPDATE window. Low frequency (settings writes are rare), but the loss is silent.
**Fix:** Either wrap read-modify-write in `Repo.transaction` (SQLite `BEGIN IMMEDIATE` semantics would serialize) or use a `json_set` fragment update per key.

### S7. Settings schema "Known key registry" missing `active_theme_id`
**File:** `lib/grappa/user_settings/settings.ex:30-40`
**Category:** doc drift (a registry that mandates registration)
**Severity:** LOW
The schema moduledoc's key registry says "Future additions MUST be documented here to avoid collisions" and lists four keys; `"active_theme_id"` (#75, accessor at `user_settings.ex:478-527`) is absent. The parent context's table has it; the collision registry — the one that claims authority — doesn't.
**Fix:** Add the `"active_theme_id"` row to the schema registry table.

### S8. Duplicated comment block in `visitors.ex`
**File:** `lib/grappa/visitors.ex:799-808`
**Category:** dead text / paste error
**Severity:** LOW
The four-line "#211 phase 6 — the #126 disconnect_session/reconnect_session verbs were REMOVED…" comment appears twice back-to-back verbatim (lines 799-803 and 804-808), reading as a botched paste.
**Fix:** Delete one copy.

### S9. ShareTokens consumed-set never evicts — node-lifetime ETS growth
**File:** `lib/grappa/visitors/share_tokens.ex:98-105, 117-121`
**Category:** unbounded growth
**Severity:** LOW
`mark_consumed/1` inserts forever; nothing ever deletes entries even though every token's signature TTL is ≤15 min — an entry is dead weight 15 minutes after insert. The moduledoc discusses the restart-loss window but not the growth axis. At operator-personal scale it's tiny, but it's the only unbounded in-memory set in the persistence-adjacent surface, and the entry already stores `System.monotonic_time` that nothing reads.
**Fix:** Sweep entries older than the token TTL on a lazy cadence (e.g. `:ets.select_delete` on each insert or a periodic tick), or document the acceptance explicitly.

### S10. Visitor CASCADE documentation stale after notify_entries landed
**File:** `lib/grappa/visitors/reaper.ex:16-26`, `lib/grappa/visitors/visitor.ex:39-47`
**Category:** doc drift
**Severity:** LOW
Both moduledocs enumerate the tables the visitor-delete CASCADE wipes ("messages, query_windows, push_subscriptions, user_settings, read_cursors, themes, accounts_sessions" / "network_credentials, messages, accounts_sessions, themes"). `notify_entries` (#247, `ON DELETE CASCADE` on `visitor_id` per migration 20260718140000) is missing from both lists. These enumerations are the operator's mental model of what a reap destroys.
**Fix:** Add `notify_entries` to both lists (or replace the enumeration with a pointer to the FK graph).

### S11. Redundant single-column partial indexes on notify_entries
**File:** `priv/repo/migrations/20260718140000_create_notify_entries.exs:57-58`
**Category:** index coverage / write amplification
**Severity:** LOW
`index(:notify_entries, [:user_id], where: "user_id IS NOT NULL")` and the visitor twin duplicate the leading column of the partial unique expression indexes created just above (`(user_id, network_id, fold(nick)) WHERE user_id IS NOT NULL`), which SQLite can already use for both the `(subject, network)` lookups and the FK-delete check (`user_id = ?` implies the partial predicate). The repo has explicit precedent for dropping exactly this shape (`20260504020000_drop_redundant_visitor_channels_visitor_id_index`). Cost is only write amplification on a 64-row-per-subject table — small, but it contradicts the repo's own established rule.
**Fix:** Drop the two single-column indexes in a follow-up migration (keep `[:network_id]`, which has no covering prefix elsewhere).

### S12. `Notify.add/4` runs per-nick subject/network existence checks — up to 2N redundant SELECTs per batch
**File:** `lib/grappa/notify.ex:142, 360-388`
**Category:** query efficiency
**Severity:** LOW
`build_changeset/3` pipes every changeset through `validate_refs_exist/2`, which issues one `Repo.exists?` for the subject and one for the network — per nick. The subject and network are identical for the whole batch, so a full 64-nick `/notify add` issues up to 128 identical existence SELECTs before the transaction even starts. QueryWindows (single-row verb) established the per-changeset shape; Notify copied it into a batch verb without hoisting.
**Fix:** Check subject + network existence once per `add/4` call, then apply the (already-decided) result to each changeset.

---

## lifecycle/ agent findings (2026-07-19 codebase review)

**Severity counts: 0 CRITICAL, 1 HIGH, 3 MEDIUM, 7 LOW**

(Scope note: `lib/grappa/config.ex` was listed in the scope but does not exist; admission config lives at `lib/grappa/admission/config.ex`, which was reviewed.)

### S1. 512/734 presence-error numerics misroute their raw row to a bogus query window, not `$server`
**File:** `lib/grappa/session/numeric_router.ex:146` (and `lib/grappa/session/event_router.ex:1660-1698`)
**Category:** routing bug / doc-reality divergence (#247)
**Severity:** HIGH
EventRouter's comments and DESIGN_NOTES 2026-07-18 both promise the 734 ERR_MONLISTFULL / 512 ERR_TOOMANYWATCH raw text "stays visible on `$server`" while the typed `presence_error` rides alongside. But neither numeric is in `@active_numerics` nor `@delegated_numerics`, so they fall to `scan_params/2`: 512 (`[own, nick, trailing]`) yields candidate `[nick]` — nick-shaped → `{:query, nick}`; a single-target 734 (`[own, limit, target, trailing]`) likewise routes `{:query, target}` (the numeric `limit` fails `valid_nick?`, the rejected nick passes). The raw error notice is persisted into a ghost query window named after the *watched nick*, which also leaks into Archive via `list_archive`'s `COALESCE(dm_with, channel)` — the exact disease class already fixed twice (#184 STATS letters, UX-4-I connect-storm 004/042). It is reachable in practice: the static 64-row cap rationale ("64 sits under every observed mechanism limit") only covers solanum(100)/bahamut(128); ircds with lower caps exist (e.g. InspIRCd's default MONITOR cap is 30), and `/quote WATCH +…` bypasses the cap entirely. No `numeric_router_test` covers 512/734 routing (grep finds none), so the divergence is untested.
**Fix:** Add 512 and 734 to `@active_numerics` (deny-list → `{:server, nil}`) with a #247 comment, and add the routing test asserting both persist on `$server`. Note 512's deny-listing is unconditional while the typed effect stays WATCH-gated — that matches the "raw text visible, typed effect gated" contract.

### S2. GhostRecovery compares nicks with bare `==` instead of the rfc1459 fold
**File:** `lib/grappa/session/ghost_recovery.ex:109,117`
**Category:** rfc1459 nick-fold invariant (GH #121)
**Severity:** MEDIUM
The `:awaiting_whois` clauses guard `when queried == orig` on the 401/311 `params[1]` echo. The 311 nick comes from the ghost holder's server-side user record and can differ in case (or bracket-fold) from the configured `orig_nick` (`kazam` vs `Kazam`); the clause then misses, the input falls to the no-op catch-all, and the FSM stalls until the 8s `:ghost_timeout` forces `:failed` — recovery that should have resolved in one round-trip is silently degraded. The module already has the folded compare pattern (`nickserv?/1` uses `Identifier.canonical_nick/1`); the accepted #121 gap covers only members-map keys + `state.nick` as identity keys, not compare sites.
**Fix:** Drop the guard and compare in the body: `if Identifier.canonical_nick(queried) == Identifier.canonical_nick(orig)` (fold both sides), mirroring `EventRouter.nick_eq?/2`.

### S3. End-of-MOTD presence arm does an unguarded Repo read inside the session GenServer — a slow/saturated DB now crashes the session at reconnect
**File:** `lib/grappa/session/server.ex:4578` (also `server.ex:3380` — the 421 fallback arm)
**Category:** robustness / inconsistent hardening (#247 vs #336)
**Severity:** MEDIUM
`arm_presence/1` and the `{:presence_command_unknown, :watch}` fallback call `Grappa.Notify.list/2` synchronously in `handle_info`. #336 explicitly hardened the persist path so "a slow DB degrades scrollback durability, it must never disconnect the user" (`log_persist_failure`, `:persist_unavailable`). `Notify.list/2` has no such treatment: a saturated SQLite pool at the exact moment every session reconnects (deploy, upstream netsplit — the moment pool pressure is highest) raises `DBConnection.ConnectionError` inside the 376/422 handler, crashing the session and feeding the Backoff ladder. The read is bounded (≤64 rows) so this is a pressure-window bug, not a steady-state one, but it reintroduces the slow-DB→disconnect class #336 closed.
**Fix:** Wrap the arm-time list read in the same bounded-degrade contract as persist: on DB error, log honestly, skip the arm (leave `presence_armed: false` so a later `/notify` mutation or reconnect retries), never `raise` through the session. Alternatively have `Notify` expose a `{:ok, list} | {:error, :unavailable}` read for this call site.

### S4. `/who` and `/names` accumulators key nick/mask targets with bare `String.downcase` instead of the rfc1459 fold
**File:** `lib/grappa/session/server.ex:1448,1468`; `lib/grappa/session/event_router.ex:1488,3125,3179`
**Category:** rfc1459 nick-fold invariant (nick-keyed cache)
**Severity:** LOW
`who_pending` (and, via `Session.send_who/3`, its 315-drain key) accepts a *nick or mask* target since #221, but the prime/drain key is `String.downcase(target)`. CLAUDE.md: "A new nick lookup, equality, or nick-keyed cache MUST fold via these, never a bare `String.downcase`". Write and read are self-consistent today (both downcase, and `who_fold`'s single-in-flight fallback papers over echo drift), so no observable bug is known — but a bracket-nick `/who Foo[x]` against an ircd that echoes the folded form in 315 (`foo{x}`) would strand the accumulator until the S10 TTL sweep. `whois_pending`/`whowas_pending` already fold correctly via `canonical_nick`, so the module is internally split on the rule.
**Fix:** Key nick-shaped WHO targets through `Identifier.canonical_nick/1` (channels keep `canonical_channel/1`), or document the deliberate exception next to the accepted #121 gaps.

### S5. `:presence_snapshot` handle_call returns a bare map, breaking the `{:ok, _}`/`{:error, _}` getter convention
**File:** `lib/grappa/session/server.ex:1601-1603` (facade compensation at `lib/grappa/session.ex:1145-1148`)
**Category:** inconsistent return typing
**Severity:** LOW
Every other snapshot getter (`:get_isupport`, `:get_umodes`, `{:current_nick}`, `{:list_channels}`…) replies `{:ok, value}`; `:presence_snapshot` replies the raw map, forcing the facade to discriminate with `map when is_map(map) -> {:ok, map}` after the `{:error, _}` catch. Works, but it's the "two patterns, Claude copies whichever is closer" trap CLAUDE.md warns about — the next getter added by pattern-matching this one will silently diverge.
**Fix:** Reply `{:ok, Map.get(state, :presence, %{})}` from the handler and make the facade a plain pass-through.

### S6. Bootstrap reads the visitor set and per-visitor credentials from the DB twice per boot
**File:** `lib/grappa/bootstrap.ex:212,245,632-633`
**Category:** duplicated work / race window
**Severity:** LOW
`run/0` calls `Visitors.list_active()` at line 212, then `validate_credential_servers!/1` calls it *again* (line 632) plus `Credentials.list_visitor_credentials/1` per visitor — and the spawn loop repeats the credentials query per visitor. Beyond the redundant queries, the two reads can diverge: a visitor provisioned between validation and spawn is spawned against a network the server-existence invariant never checked, hitting the opaque `:no_server` → `plan_failed` path the boot-time raise exists to prevent.
**Fix:** Thread the already-fetched `visitors` list (and their credential lists) from `run/0` into `validate_credential_servers!` and reuse the same credential lists in `spawn_visitor/2`.

### S7. Bootstrap `Result` documented as "five counters" but carries six
**File:** `lib/grappa/bootstrap.ex:77,164-188`
**Category:** doc drift
**Severity:** LOW
Moduledoc: "Five counters (U-2 honest-log split …), five operationally-distinct conditions" and the `Result` moduledoc lists five names — the struct has six fields (`subject_row_gone` added later, with its own `classify_outcome` clause and log bucket). A reader auditing counter semantics against the doc will miss the sixth.
**Fix:** Update both moduledoc sections to enumerate `subject_row_gone`.

### S8. EventRouter moduledoc claims the `:reply` effect is unused ("No E1 route emits this effect")
**File:** `lib/grappa/session/event_router.ex:84-88`
**Category:** stale doc
**Severity:** LOW
The "## `:reply` effect (forward-compat in E1)" section states no route emits it, but the CTCP VERSION clause (lines 367-397) has been emitting `{:reply, line}` for a long time, and `Server.apply_effects` has a dedicated arm for it (with the REV-E H11 fire-and-forget hardening).
**Fix:** Rewrite the section to name the CTCP VERSION reply as the live producer.

### S9. `Grappa.Version.current/0` crashes the session on inbound CTCP VERSION if `mix.exs` is unreadable or the regex misses
**File:** `lib/grappa/version.ex:33-38`
**Category:** remote-input crash path
**Severity:** LOW
`File.read!` + `Regex.run |> List.last` — if `mix.exs` is absent at the compile-time-anchored path (a packaging change; the FreeBSD release ships "no Mix, no project source" per `Grappa.Release`'s own moduledoc, and only works today because the jail keeps the source checkout in place) or the `@version` attribute format drifts, `Regex.run` returns `nil` and `List.last(nil)` raises — inside `EventRouter.do_route` for a *remote-controlled* input (any peer's CTCP VERSION), crashing the session. A peer spamming CTCP VERSION would then drive the crash/backoff loop.
**Fix:** Make `current/0` total: return a compile-time-captured fallback (`Mix.Project.config()[:version]` baked as a module attribute) when the live read or parse fails, keeping the live-read as the primary path.

### S10. `handle_info({:EXIT, _, :shutdown|:normal})` catch-all nils out `client` while the Client may still be alive
**File:** `lib/grappa/session/server.ex:2017-2020`
**Category:** state honesty / lost graceful QUIT
**Severity:** LOW
The OTP-convention clause for an external `Process.exit(pid, :shutdown)` sets `%{state | client: nil}` unconditionally, even though on that path the EXIT sender is *not* the Client — the Client is still linked and alive. `terminate/2`'s `:shutdown` clause then sees `client: nil` and skips the graceful `QUIT`, so an externally-shutdown session always drops the socket without a QUIT line (contradicting the "peer sees graceful disconnect" contract that clause exists for). Today's only production sender is test-helper teardown, so impact is cosmetic — but the comment documents a "future linked sibling" case where the same nil-out would drop a live Client reference.
**Fix:** Only clear `client` when the EXIT sender is `state.client` (a separate clause head), letting the catch-all preserve the pid so `terminate/2` can still send the QUIT.

### S11. Presence `add_commands/2` is a pure alias with no distinct behavior
**File:** `lib/grappa/session/presence.ex:84-85`
**Category:** near-dead code
**Severity:** LOW
`add_commands(mechanism, nicks), do: arm_commands(mechanism, nicks)` — a one-line delegation that exists only to give `send_sync_lines/4` a differently-named verb. It adds a second public name for identical output; if arm and add ever need to diverge (e.g. WATCH `+` semantics on re-add), nothing forces the change through this seam, and until then it is an alias maintained for symmetry only.
**Fix:** Either call `arm_commands/2` directly at the sync site with a comment, or keep the alias but mark the intent (`@doc` already implies future divergence — fine to keep if that divergence is genuinely expected; otherwise delete).

---

Triage guidance: S1 is the only ship-blocker candidate (documented `$server` contract vs. actual query-window misroute, in the historically-recognized ghost-window disease class, with zero routing-test coverage for those numerics). S2 and S3 are behavioral degradations in fresh #247/adjacent code. S4–S11 are consistency, doc, and hardening nits.

---

## web/ agent findings (2026-07-19 codebase review)

**Severity counts: 0 CRITICAL / 0 HIGH / 7 MEDIUM / 9 LOW** — scope: entire `lib/grappa_web/` tree + `test/grappa_web/`, with emphasis on the fresh #247 code. The `/notify` nginx allowlist check passes (routes nest under `/networks/`, covered by the shared `infra/snippets/locations-api.conf` alt included by both `:80`/`:443` blocks in `infra/nginx.conf` and `cicchetto/e2e/nginx-test.conf`).

### S1. FallbackController @spec drifted six tags behind its clauses
**File:** `lib/grappa_web/controllers/fallback_controller.ex:38-88`
**Category:** spec drift / documented-lockstep violation
**Severity:** MEDIUM
The moduledoc mandates "add a clause here and update the spec in lockstep," but six implemented clauses are missing from the `@spec call/2` error union: `:body_too_large` (line 123), `:too_many_attempts` (209), `:list_full` (229 — the new #247 tag), `:timeout` (513), `:resolve_failed` (538), and `{:start_failed, term()}` (557). None are covered by `Grappa.Admission.error()` (verified: `capacity_error | Captcha.error()`). Dialyzer can't catch callers passing these tags against the narrowed contract, and the module's own governance rule is broken.
**Fix:** Add the six tags to the spec union. Consider extending the `FallbackControllerTest` clause-matrix canary (which already pins `Admission.capacity_error()`) to walk every clause head vs the spec union so the drift class stays closed.

### S2. `away` handlers crash the channel on non-map `origin_window`; spec types it wrong
**File:** `lib/grappa_web/channels/grappa_channel.ex:398,412,1478-1483,1591-1612`
**Category:** boundary validation / malformed-input crash
**Severity:** MEDIUM
`Map.get(payload, "origin_window")` is passed unvalidated to `dispatch_set_away/4` / `dispatch_unset_away/3`, which only have clauses for `nil` and `is_map/1`. A hostile or buggy client sending `"origin_window": "main"` (string, number, list) raises `FunctionClauseError` and kills the channel pid — while the sibling `visibility` handler explicitly documents "reject a malformed payload loudly rather than crash." Additionally the `away_set_dispatch/4` `@spec` declares `origin_window :: String.t() | nil` but the implementation requires `map() | nil` — the spec is simply wrong (`Grappa.Session.set_explicit_away/4` guards `is_map(origin_window)`).
**Fix:** Normalize at the boundary — `case Map.get(payload, "origin_window") do m when is_map(m) -> m; _ -> nil end` (or reply `invalid_payload`), and correct both dispatch specs to `map() | nil`.

### S3. No `handle_in` catch-all on GrappaChannel — unknown events / wrong-typed payloads crash the channel
**File:** `lib/grappa_web/channels/grappa_channel.ex:339-991`
**Category:** consistency / boundary robustness
**Severity:** MEDIUM
Every `handle_in/3` clause is tightly guarded (`is_integer(network_id)` etc.) and there is no terminal catch-all clause. An unknown event name, or a known event with a wrong-typed field (e.g. `"op"` with a string `network_id`), raises `FunctionClauseError` and crashes the channel process. `AdminChannel` (line 98) carries an explicit catch-all with the rationale "without this clause Phoenix's default `handle_in/3` raises…, crashing the channel pid. Reply `:ok` so a hostile or buggy cic can't take down the admin socket." Same problem, two solutions — CLAUDE.md consistency rule. A hostile client can repeatedly crash its user channel, spamming crash reports in operator logs.
**Fix:** Add a terminal `handle_in(_, _, socket)` clause replying `{:error, %{error: "unknown_event"}}` (or `invalid_payload`), mirroring AdminChannel's documented posture.

### S4. #247 WS snapshot-on-attach pushes have zero channel-test coverage
**File:** `lib/grappa_web/channels/grappa_channel.ex:1183-1213` (tests: `test/grappa_web/channels/grappa_channel_test.exs`)
**Category:** test gap (fresh unreviewed code)
**Severity:** MEDIUM
`push_notify_list/2` and `push_presence_if_live/2` (commit `da657b90`) have no assertions anywhere in `grappa_channel_test.exs` — `grep notify|presence` over the file returns nothing — while every sibling after-join push is pinned (`query_windows_list` line 809+, `umode_changed` 869, `bundle_hash` 899). The described contracts (full-list snapshot; empty presence maps skipped; parked networks skipped; per-network fan-out isolation) are exactly the outcome-shaped behaviors a channel test should pin. The only coverage is the e2e spec, which per DESIGN_NOTES is not executed on this dev host and gates only in CI.
**Fix:** Add user-topic join tests asserting `assert_push("event", %{kind: "notify_list", ...})` and the `presence_snapshot` push (and its absence when the map is empty / session missing), following the `bundle_hash` test pattern.

### S5. "Quiet re-adds" diff in NotifyController.create is untested
**File:** `lib/grappa_web/controllers/notify_controller.ex:76-93` (tests: `test/grappa_web/controllers/notify_controller_test.exs`)
**Category:** test gap
**Severity:** MEDIUM
The `pre_folds` snapshot + `Enum.reject` exists solely so an idempotent re-add does not re-emit `MONITOR +`/`WATCH +` (review nit 2026-07-19, commit `5e916515`). No test asserts it: the controller test "POST duplicate (fold-equal) add is idempotent" checks only the HTTP/DB outcome, and `server_test.exs`'s `notify_changed` test exercises the Session facade directly with a pre-computed diff. If someone simplifies `create/2` to pass `nicks` verbatim, every test stays green while the fixed bug returns.
**Fix:** Controller test with a live fake session (Grappa.IRCServer helper) asserting no second `MONITOR +` on duplicate POST, or at minimum a test seam asserting `notify_changed` receives `[]` for a fold-duplicate batch.

### S6. Admin `PUT /admin/settings` applies updates non-atomically — 422 with partial state persisted
**File:** `lib/grappa_web/controllers/admin/settings_controller.ex:113-118`
**Category:** boundary validation / atomicity
**Severity:** MEDIUM
`apply_updates/1` folds over the `upload` map applying each key immediately (`ServerSettings.put_*`) and halts on the first invalid value. A body like `{"upload": {"active_host": "litterbox", "global_cap_bytes": -1}}` persists `active_host` (map iteration order dependent), then returns 422 `invalid_setting` — and because `fanout_changed/1` never runs, the applied key is also not broadcast to live cic tabs, so the operator sees an error, the DB has half the edit, and connected clients have none of it. Contradicts "Ecto.Changeset for ALL user input" / validate-then-commit.
**Fix:** Two-phase: validate every key first (collect `{key, valid_value}` or the first `{:error, {:invalid_setting, field}}`), then apply all and fan out only on a fully-valid body.

### S7. `subject_label` / topic-segment derivation copy-pasted across seven modules
**File:** `lib/grappa_web/controllers/notify_controller.ex:161-167` (also `archive_controller.ex:210-222`, `channels_controller.ex:272-284`, `read_cursor_controller.ex:183-212`, `test_read_cursor_controller.ex:87-105`, `channels/user_socket.ex:181-185`, `channels/grappa_channel.ex:1576`)
**Category:** reuse / "Implement once, reuse everywhere"
**Severity:** MEDIUM
The load-bearing routing invariant "user → `user.name`, visitor → `"visitor:" <> id`" (must match `UserSocket.connect/3`'s `:user_name` assign or broadcasts silently miss the subject's topic) is re-implemented in at least seven places, each with its own comment saying it mirrors the others. NotifyController just added the newest copy. A future change to the label shape (or a new subject kind) must find every copy or windows silently stop receiving events — the exact drift class CLAUDE.md's rule exists to prevent.
**Fix:** Add `GrappaWeb.Subject.topic_label/1` (or a function on `Grappa.PubSub.Topic`) as the single source; delegate all seven sites.

### S8. `UsersController.create_then_maybe_admin` falsely claims atomicity; failed promotion leaves a half-created user
**File:** `lib/grappa_web/controllers/admin/users_controller.ex:209-225`
**Category:** correctness / misleading comment
**Severity:** LOW
The comment claims "Both run inside the same Repo sandbox / SQLite single-writer window so the operator-visible effect is atomic" — false: these are two independent `Repo` writes with no transaction. If `update_admin_flags/2` errors after `create_user/1` succeeds, the endpoint returns an error while the (non-admin) user row persists — a retry then hits a duplicate-name 422. Practically rare (boolean cast), but the comment codifies a wrong mental model the next author will copy.
**Fix:** Wrap in `Repo.transaction/1` (context-side, e.g. `Accounts.create_user_with_flags/1`) or fix the comment to state the non-atomic reality and the retry consequence.

### S9. Dead conditional in `UsersController.create_attrs/1`
**File:** `lib/grappa_web/controllers/admin/users_controller.ex:234`
**Category:** dead code
**Severity:** LOW
`if extra == [], do: {:error, :bad_request}, else: {:error, :bad_request}` — both branches identical; the `if` is dead.
**Fix:** Replace with a plain `{:error, :bad_request}`.

### S10. NotifyController.clear/remove: live-sync divergence window
**File:** `lib/grappa_web/controllers/notify_controller.ex:117-128`
**Category:** concurrency (DB vs live state)
**Severity:** LOW
`clear/2` snapshots the nick list, wipes the table, then un-arms the snapshot. An add committed between the `Notify.list` read and `Notify.clear` is deleted from the DB but was never in `removed`, so the session keeps it armed (dots keep painting) until reconnect. Symmetrically, `remove/2` sends `MONITOR -` for a nick that was never armed (harmless upstream but asymmetric with `create/2`'s careful diff). Bounded by reconnect re-arm, but it's the same class the create-side diff was added to fix.
**Fix:** Have `Notify.clear/3` return the deleted rows (`Repo.delete_all` → select-then-delete in the transaction) and un-arm that authoritative set; optionally diff `remove/2` against the pre-state like `create/2` does.

### S11. `GET /notify` renders a session `:timeout` as `presence: null` ("no session running")
**File:** `lib/grappa_web/controllers/notify_controller.ex:52-56`
**Category:** DB-vs-live honesty
**Severity:** LOW
`Session.presence_snapshot/2` is specced `{:error, :no_session | :timeout}`; the controller collapses both to `presence: nil`, which the moduledoc defines as "no session is running (parked / failed / backoff)." A live-but-stuck `Session.Server` (mailbox blocked) is presented as not-running — precisely the divergence the CLAUDE.md "live_state: null is the honesty signal" rule wants distinguishable, at least in logs.
**Fix:** Log the `:timeout` discriminator (allowlisted `:reason` key) before collapsing to `nil`, mirroring `Plugs.ResolveNetwork`'s log-but-uniform-wire posture.

### S12. `visitor_error_response` catch-all swallows the actual failure atom unlogged
**File:** `lib/grappa_web/controllers/auth_controller.ex:460-461`
**Category:** silent-swallow at boundary (log honesty)
**Severity:** LOW
`visitor_error_response(_, _, _, _), do: {:error, :internal}` maps any un-enumerated `Login.login/2` error to a bare 500 with no `Logger` line carrying the original reason. FallbackController's own philosophy is that unknown shapes surface loudly; here a new context error atom degrades to an anonymous "internal" with nothing greppable at the controller layer.
**Fix:** `Logger.warning("visitor login: unmapped error", reason: inspect(reason))` in the catch-all before returning `:internal` (or let it raise a FunctionClauseError like FallbackController deliberately does).

### S13. Inconsistent bad-query-param policy: 400 vs silent clamp
**File:** `lib/grappa_web/controllers/admin/session_log_controller.ex:40-47` (also `directory_controller.ex:107-114`)
**Category:** consistency ("same problem, same solution")
**Severity:** LOW
`MessagesController` documents and enforces "a param that is present and unparseable returns 400 — forgiving the typo would mask client bugs," explicitly noting the read-only nature does not relax the bar. `SessionLogController.parse_limit` and `DirectoryController.parse_limit` do the opposite: `?limit=banana` silently falls back to the default, with a comment asserting "a read endpoint shouldn't 400 on a bad query param" — directly contradicting the sibling's documented rule.
**Fix:** Pick one policy (the MessagesController one is the documented rule) and align both controllers, or lift the decision into a shared `GrappaWeb.Validation.parse_limit/3`.

### S14. Stale router comment: `/push/subscriptions` described as user-only
**File:** `lib/grappa_web/router.ex:305-309`
**Category:** doc drift
**Severity:** LOW
The router comment says "User-only (visitors get :forbidden inside the controller per the visitor-gating boundary)" — stale since V3 (2026-05-15) lifted the gate; `PushSubscriptionController` accepts both subjects and documents visitor parity. A future author reading the router will re-add a forbidden gate or mis-triage a bug.
**Fix:** Update the comment to the V3 subject-scoped reality.

### S15. Stale comment: `send_topic returns {:ok, message}` in GrappaChannel
**File:** `lib/grappa_web/channels/grappa_channel.ex:792` (also `resolve_subject` comment at 1570-1574)
**Category:** doc drift
**Severity:** LOW
The `topic_set` comment claims "send_topic returns {:ok, message} on success (persists scrollback row)"; `Grappa.Session.send_topic/4` returns `:ok | {:error, ...}` (persist happens later via the upstream echo → EventRouter — the #22 single-write path), and `topic_set_dispatch` correctly matches `:ok`. The comment describes a retired contract; its `persist_failed` error string compounds the confusion. Similarly the `resolve_subject/1` comment claims the user miss "surfaces as `{:error, :not_found}`" but the function returns bare `:error`.
**Fix:** Correct both comments to the actual return shapes.

### S16. Ops-verb nick lists have no size cap at the WS boundary
**File:** `lib/grappa_web/channels/grappa_channel.ex:443-496,1357-1363`
**Category:** boundary limits
**Severity:** LOW
`op`/`deop`/`voice`/`devoice` accept an unbounded `nicks` list; validation checks each nick's shape but not the count. A hostile client can push thousands of nicks in one frame, fanning out `ceil(N/MODES=)` MODE lines to the upstream — enough to get the session flooded off the network. Free-text fields got `BodyLimit` (HIGH-19) and #247 capped the watch list at 64 for the same "bounded resource at the boundary" reason; the nick-list vector was left open.
**Fix:** Reject lists over a small constant (e.g. 32) in `validate_args([{:nicks, list} | _])` with a distinct tag, mirroring the BodyLimit posture.

---

## cicchetto/ agent findings (2026-07-19 codebase review)

**Severity count: 0 CRITICAL / 1 HIGH / 4 MEDIUM / 5 LOW**

### S1. User-topic channel never re-joins after token rotation with same identity
**File:** `cicchetto/src/lib/userTopic.ts:762-783` (with `cicchetto/src/lib/socket.ts:143-158`)
**Category:** reactivity / lifecycle bug
**Severity:** HIGH
On token rotation (prev ≠ next, both non-null), `socket.ts` deliberately **rebuilds** the Socket instance (`_socket = null; getSocket().connect()`) because the `authToken` subprotocol is captured at construction, and it nulls `_userChannel`. `subscribe.ts` handles this correctly (its `on(token)` arm leaves + clears `joined` so every per-channel topic re-joins on the new socket). But `userTopic.ts`'s effect guards with `if (joined && joinedFor === name) return;` — on a rotation that keeps the same identity (re-login via `/login` without logout, which `auth.login` permits today; the designed Phase-5 refresh / admin re-issue path) the name is unchanged, so the effect early-returns and the user topic is **never joined on the new socket**. Consequences: all `Topic.user/1` events are lost (channels_changed, window_pending/invited, query_windows_list, notify_list/presence, connection_state_changed, bundle_hash…) AND `_userChannel` stays null, so every user-channel push verb (`pushAwaySet/Unset`, all ops verbs, `pushOper`, `pushRaw`, `pushWhois`, `reportVisibility`, `notifyClientClosing`, watchlist verbs) rejects "not connected" until logout or reload. The socket.ts comment ("phoenix.js auto-rejoins on the next connect()") only holds for the *same* Socket instance — rotation discards it.
**Fix:** Mirror subscribe.ts: in `userTopic.ts` add `createEffect(on(token, (t, prev) => { if (prev != null && t !== prev) { joined = false; joinedFor = null; } }))` (or fold the reset into the existing effect using `on(token, ...)` with the prev value) so the join effect re-runs against the rebuilt socket.

### S2. Logout/rotation skips `disconnect()` on a mid-backoff socket → zombie reconnect loop with stale bearer
**File:** `cicchetto/src/lib/socket.ts:137` and `cicchetto/src/lib/socket.ts:153`
**Category:** lifecycle / resource leak
**Severity:** MEDIUM
Both the logout and rotation arms guard the teardown with `if (_socket?.isConnected()) _socket.disconnect()`. If the socket is mid reconnect-backoff (not currently open — e.g. logout while the server is restarting, exactly when users log out), `disconnect()` is skipped but the module reference is nulled anyway. The orphaned Socket's internal `reconnectTimer` stays armed and keeps re-connecting with the **stale ctor-time bearer** forever — unreachable by any code path (both handles nulled), producing endless failed handshakes (and, if the old token is still valid server-side, a ghost session under the dead identity). `Socket.disconnect()` is safe on a non-open socket and cancels the pending timer.
**Fix:** Call `_socket.disconnect()` unconditionally (drop the `isConnected()` guard) in both arms before nulling the reference.

### S3. notifyWatch store is not identity-scoped; `resetNotifyWatch` is dead production code
**File:** `cicchetto/src/lib/notifyWatch.ts:52-58,158-162`
**Category:** cross-identity state leak / pattern violation (#247 fresh code)
**Severity:** MEDIUM
The module comment on `resetNotifyWatch` claims "Identity teardown (logout / account switch) — mirror of the other identity-scoped stores' reset shape", but unlike every sibling store (`windowState.ts`, `members.ts`, `mentions.ts`, `awayStatus.ts`, … all wired through `identityScopedStore`), nothing in production ever calls it — only `notifyWatch.test.ts` does. On logout → login as a different account in the same browser, the previous identity's watch list renders in `WatchedPanel` (network ids are global, so slugs collide across accounts) until the new `notify_list` snapshot lands, and `presenceByNetwork` dots persist indefinitely for any network the new identity lacks a live-session snapshot for. Toast queue also survives the identity switch.
**Fix:** Build the store inside `identityScopedStore((onIdentityChange) => { …; onIdentityChange(resetNotifyWatch); … })` like its siblings (or register `resetNotifyWatch` on an `on(token)` rotation arm).

### S4. `rfc1459Fold` uses Unicode `toLowerCase()` while the server fold is ASCII-byte-level
**File:** `cicchetto/src/lib/notifyWatch.ts:49-50`
**Category:** wire-shape drift (fold mirror)
**Severity:** LOW
`Grappa.IRC.Identifier.canonical_nick/1` folds bytes `A-Z` + `[ ] \ ~` only; JS `String.prototype.toLowerCase()` is Unicode-aware (e.g. `"É"` → `"é"`, `"İ"` → `"i̇"`), so for any non-ASCII nick the cic key diverges from the server presence-map key and the dot silently never lights — the exact failure mode the module comment warns about for bracket nicks. Today the divergence is gated by the server's ASCII-only `@nick_regex` at add time, but CLAUDE.md pins "Never assume ASCII", and upstream-reported nicks are the other key source.
**Fix:** Fold ASCII-only: `nick.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32)).replace(/\[/g,"{")…` so the mirror is byte-for-byte with `fold_nick_byte/1`.

### S5. Nick comparisons via bare `.toLowerCase()` bypass `nickEquals`/`normalizeNick`
**File:** `cicchetto/src/Shell.tsx:486-487`, `cicchetto/src/lib/selection.ts:204-205,222-223,275-276,737-738`, `cicchetto/src/lib/queryWindows.ts:79-81,109-111`, `cicchetto/src/lib/peerAway.ts:34,42`, `cicchetto/src/PeerAwayBanner.tsx:26`, `cicchetto/src/lib/pushTriggers.ts:68`
**Category:** consistency / single-source-of-truth drift
**Severity:** MEDIUM
`nickEquals.ts` pins the contract: "every nick comparison in the cic codebase goes through this helper… single source of truth means no drift class; if a future network needs strict RFC 2812 casemapping we extend this helper and migrate all callsites." These sites re-implement the fold inline (`targetNick.toLowerCase() === lower`, peer-key maps keyed on `peer.toLowerCase()`, push-pref membership on `message.sender.toLowerCase()`). Functionally identical today, but the documented migration path (rfc1459 fold, the same fold #247 just introduced server-side) would silently skip all of them — the exact "half-migrated creates two patterns" failure CLAUDE.md forbids.
**Fix:** Replace each with `normalizeNick(...)` (for map keys) / `nickEquals(...)` (for equality); no behavior change today, one knob tomorrow.

### S6. `apple-touch-icon` points at an SVG — iOS home-screen icon broken
**File:** `cicchetto/index.html:21`
**Category:** PWA shell
**Severity:** MEDIUM
`<link rel="apple-touch-icon" href="/icon.svg" />` — iOS Safari does not support SVG for `apple-touch-icon` (PNG required); the S45 comment on the same lines says this tag is precisely "what iOS scrapes for the home-screen icon", so Add-to-Home-Screen on iOS falls back to a page-screenshot/blank tile. `public/icon-192.png` and `icon-512.png` already exist.
**Fix:** Point the tag at a PNG (`/icon-192.png`, ideally a dedicated 180×180 `apple-touch-icon.png`) and add it to `includeAssets`.

### S7. WatchedPanel row captures `networkId()` non-reactively
**File:** `cicchetto/src/WatchedPanel.tsx:56-58`
**Category:** SolidJS reactivity
**Severity:** LOW
Inside the `<For>` row callback, `const id = networkId();` executes once at row creation (Solid's `mapArray` runs the map fn untracked), so `state()` closes over a stale network id. If the slug→id mapping changes while rows exist (networks refetch after an admin delete/recreate reassigns ids), dots keep querying the dead id ("unknown" forever) until the watch-list array identity changes.
**Fix:** Resolve inside the accessor: `const state = () => { const id = networkId(); return id === undefined ? "unknown" : presenceFor(id, entry.nick); };`

### S8. Presence dots stay stale on parked/failed networks — no clear on `connection_state_changed`
**File:** `cicchetto/src/lib/userTopic.ts:913-940` (arm) / `cicchetto/src/lib/notifyWatch.ts` (store); comment claim at `cicchetto/src/HomePane.tsx:319-322`
**Category:** state staleness (#247 fresh code)
**Severity:** LOW
The `DisconnectedRow` comment claims "dots render ◌ unknown (no live session to report presence)" on parked/failed rows, but nothing clears `presenceByNetwork[id]` when a session parks or fails: the server only pushes `presence_snapshot` for networks *with a live session* (grappa_channel.ex:1195-1205), so after an operator parks a network the last live dots (● online) keep rendering, misleading until a fresh attach with a live session or a reload. The claimed ◌ state only holds for cold loads.
**Fix:** In the `connection_state_changed` arm, when `payload.to` is `"parked"`/`"failed"`, drop `presenceByNetwork[payload.network_id]` (add a `clearPresence(networkId)` verb to notifyWatch.ts).

### S9. Viewport pins `maximum-scale=1, user-scalable=no` — browser zoom disabled app-wide
**File:** `cicchetto/index.html:7`
**Category:** a11y (WCAG 1.4.4)
**Severity:** LOW
Pinch/browser text zoom is disabled globally. The decision is deliberate and documented (iOS-1, `pinchZoom.ts` moduledoc) and partially mitigated by the in-app font-size setting and the hand-rolled media-viewer pinch, but low-vision users cannot magnify general UI (sidebar, modals, admin tabs), and desktop browsers honoring the meta also lose ctrl-+ page zoom. Recorded as a known accessibility cost of the app-like posture, not a regression.
**Fix:** Consider `maximum-scale=5` with the iOS double-tap/pinch suppression handled by `touch-action: manipulation` + the existing element-level `preventDefault` instead of the viewport lock; at minimum note the trade-off where a11y issues are tracked.

### S10. PresenceToasts comment/markup drift: `role="status"` promised, only `aria-live` shipped
**File:** `cicchetto/src/PresenceToasts.tsx:12-21`
**Category:** a11y / comment drift (#247 fresh code)
**Severity:** LOW
The header comment pins `role="status"` (polite) as the design decision, but the container renders only `aria-live="polite"`. `role="status"` additionally implies `aria-atomic="true"` and gives AT a named landmark; as shipped, partial re-renders of a toast row may be announced fragmentarily, and the error-styled `presence_error` toast (which the comment contrasts against interruptive error banners) rides the same polite region with no `role` at all.
**Fix:** Add `role="status"` to the container (matching the comment), or update the comment to the weaker `aria-live` contract deliberately.

---

## cross-module agent findings (2026-07-19 codebase review)

**Severity summary: 0 CRITICAL, 0 HIGH, 2 MEDIUM, 4 LOW**

Sweeps that came back CLEAN (verified, not skipped): `\\` default arguments (zero hits in all of `lib/` — only docstring shell-continuation backslashes); migrations (66 files, monotonic timestamps, no `create_if_not_exists` anywhere — the flagged files only use `drop_if_exists` for idempotent index/table drops, which conforms; two migrations explicitly cite the CLAUDE.md plain-`create` rule); `@spec` coverage on public context facades (the no-spec hits were all multi-clause heads whose first clause carries the spec, plus GenServer/Ecto.Type callbacks); PubSub topic shapes (every `broadcast_event`/`broadcast` call site passes a `Grappa.PubSub.Topic` function result; no hand-built `"grappa:..."` topic strings outside `topic.ex` itself); Boundary annotations (every context + top-level module carries `use Boundary`; cross-context schema refs are declared, documented dirty-xrefs; no direct `Repo.` calls from `lib/grappa_web`); untyped closed sets (no string-compared state values; kinds are atoms internally, strings only at the Wire layer as documented); Logger metadata keys (programmatic diff of every keyword key in every `Logger.*` call in `lib/` against the `config/config.exs` allowlist: zero non-allowlisted keys).

### S1. Bare `rescue _` + `catch _, _` with no logging in Themes image fetcher
**File:** `lib/grappa/themes/image_fetcher/req.ex:82-88`
**Category:** silent-swallow / wide rescue
**Severity:** MEDIUM
`request/2` wraps `Req.get/2` in `rescue _ -> {:error, :fetch_failed}` plus `catch _, _ -> {:error, :fetch_failed}` — the only fully bare exception+exit+throw absorber in the entire `lib/` tree. The comment calls it "belt-and-braces", but unlike the codebase's own precedent (`Grappa.Push.Sender.web_push_send/2`, which narrows the rescue, logs an `error:` breadcrumb, and reraises unrecognized shapes), this one leaves zero trace: a genuine bug class (bad `connect_options/1` output, a Req API change after a dep bump — exactly what bit `web_push_elixir` on the req 0.5.18 bump) collapses indistinguishably into the same `:fetch_failed` the operator sees for an ordinary dead URL. That's the "safety net that silently absorbs the next class of bug" CLAUDE.md names.
**Fix:** Mirror the `Push.Sender` shape: keep the no-raise contract but `Logger.warning("theme image fetch raised", error: inspect(e))` (`:error` is an allowlisted metadata key) inside both clauses before returning `{:error, :fetch_failed}`; or narrow to the exception classes a malformed target can actually raise and let the rest crash.

### S2. Runtime `Application.get_env` DI-seam pattern contradicts the boot-time-only rule and is propagating
**File:** `lib/grappa/push/badge_source.ex:50`, `lib/grappa/window_counts/push_source.ex:58`, `lib/grappa/themes/background_image.ex:85-89`
**Category:** Application env at runtime (CLAUDE.md "boot-time only, runtime banned")
**Severity:** MEDIUM
Three behaviour-injection seams resolve their impl via `Application.get_env/2` at call time: `BadgeSource.impl/0` runs on the push-dispatch path, `PushSource.impl/0` runs inside `Session.Server`'s persist arm (a GenServer callback, per-message), and `BackgroundImage.fetcher/0` inside a context function — all three are in CLAUDE.md's explicitly banned categories, and none of them is in its allowed-exception list (`config/*.exs`, `application.ex start/2`, pre-`ensure_all_started` mix-task helpers). Each moduledoc justifies the read (Boundary-cycle inversion, hot-deploy config window, Mox), and each newer copy cites the previous as precedent — the exact "codebase IS the instruction set" propagation failure. Meanwhile `lib/grappa_web/controllers/push_vapid_controller.ex:33-35` still documents the H16 fix as removing "the lone CLAUDE.md 'boot-time only, runtime banned' violation in the codebase", which is now stale by three sites. Note the codebase already owns the compliant pattern twice: `Grappa.Push.boot/0` and `Grappa.Admission.Config.boot/0` pin env into `:persistent_term` at `application.ex start/2`.
**Fix:** Either (a) resolve the seam impls at boot into `:persistent_term` alongside `Push.boot/0`/`Admission.Config.boot/0` (the hot-deploy nil-window argument applies identically — `:persistent_term` is just as writable via rpc as app env, and `config_change/3` already exists as the rebind hook), or (b) amend CLAUDE.md's rule to bless the DI-seam read explicitly with its constraints (read-only, module-literal value, nil-degrade documented) so the next session doesn't have to re-litigate it — and fix the stale `push_vapid_controller.ex` claim either way.

### S3. Inline interpolation in Logger calls where allowlisted structured keys exist
**File:** `lib/grappa/visitors/login.ex:497`, `lib/grappa/uploads/metadata_strip.ex:259`, `lib/grappa/net/ptr_cache.ex:194`
**Category:** structured logging
**Severity:** LOW
Three log sites interpolate values into the message string that the `config/config.exs` metadata allowlist already has keys for: `login.ex:497` inlines `visitor=#{visitor.id} pid=#{inspect(pid)}` (`:visitor_id` and `:pid` are allowlisted — and the moduledoc rationale for `:visitor_id` is exactly "grep the visitor lifecycle across login", which this line defeats); `metadata_strip.ex:259` inlines `#{reason}` (`:reason` allowlisted) so upload-rejection reasons are not KV-greppable alongside every other `reason:` line; `ptr_cache.ex:194` inlines the address into the message while putting only `reason:` in metadata (no `:address` key exists — sibling of `:remote_ip`).
**Fix:** `Logger.info("login: attached to existing live session", visitor_id: visitor.id, pid: inspect(pid))`; `Logger.warning("metadata strip failed", reason: reason, ...)` (mime either into the message or a new allowlisted key); for ptr_cache, add the address under an allowlisted key or reuse `:remote_ip` if semantics fit.

### S4. `String.to_atom/1` on beam basenames in hot reload
**File:** `lib/grappa/hot_reload.ex:78`
**Category:** atom creation (DoS sweep)
**Severity:** LOW
`reload_from/1` mints atoms from every `*.beam` basename in the given directory. Mitigations are real: `to_existing_atom` is impossible here (freshly-added modules don't exist as atoms yet — that's the point of hot reload), and the input is the release's own ebin dir behind the loopback-gated `/admin/reload`, so no untrusted path reaches it today. But `reload_from/1` is a public function taking an arbitrary `Path.t()` with no guard on what the basenames look like, so a future caller with a less-trusted directory inherits unbounded atom creation silently.
**Fix:** Guard the comprehension with a cheap shape check before atom creation (e.g. basename must start with `"Elixir."` and match the app's module namespace), or document the trusted-input contract in the `@doc` of `reload_from/1` so the constraint is visible at the call boundary.

### S5. Literal `"grappa:*"` topic strings in match positions can drift from `Topic` SoT
**File:** `lib/grappa_web/channels/admin_channel.ex:59`, `lib/grappa_web/channels/admin_channel.ex:85`
**Category:** PubSub topic-shape consistency
**Severity:** LOW
`join/3` matches the literal `"grappa:admin:events"` and `handle_info/2` matches `%Phoenix.Socket.Broadcast{topic: "grappa:session_log"}` while the subscribe on line 65 goes through `Topic.session_log()`. If either `Topic` function ever changes, the subscription follows the function but the pattern match silently stops matching — session-log events stop reaching the admin socket with no compile error (the drift-catch depends entirely on an integration test noticing). Function calls can't appear in match position, but both `Topic.admin_events/0` and `Topic.session_log/0` are pure and callable at compile time. (The `channel "grappa:user:*"` / `"grappa:admin:events"` literals in `user_socket.ex:78-79` are the same class but the wildcard form has no `Topic` counterpart — excluded.)
**Fix:** Pin module attributes at compile time — `@admin_events_topic Grappa.PubSub.Topic.admin_events()` / `@session_log_topic Grappa.PubSub.Topic.session_log()` — and match on the attributes, so a `Topic` change propagates on recompile.

### S6. `rescue _ -> nil` silently omits wire modules from generated TS types
**File:** `lib/mix/tasks/grappa/gen_wire_types.ex:195-196`
**Category:** silent-swallow / wide rescue
**Severity:** LOW
`module_from_path/1` ends in a bare `rescue _ -> nil`. A wire module whose path→module resolution raises for any reason is silently dropped from the generated `wireTypes` output — the codegen exits green while the TS surface is missing a type. Since the generated file is the server↔cic contract, a silent omission surfaces later as a confusing cic-side type error (or nothing at all, if the type isn't referenced yet). Dev-tooling only, hence LOW, but it is a bare swallow at exactly the boundary the no-silent-drops rule targets.
**Fix:** Drop the rescue (let it crash — a mix task raising on a malformed path is the correct loud failure), or if best-effort skipping is intended, `Mix.shell().error("wire codegen: skipping #{path}: #{Exception.message(e)}")` before returning `nil`.

---

## docker/infra agent findings (2026-07-19 codebase review, run 2026-07-20)

**Findings: 24 total — 0 CRITICAL / 2 HIGH / 8 MEDIUM / 14 LOW**

### S1. Dockerfile dep-fetch/compile pipeline is 100% shadowed by the bind mount — pure build waste
**File:** `Dockerfile:49-60`
**Category:** simplification
**Severity:** HIGH
Every consumer of this image mounts the repo over `/app`: dev compose (`compose.yaml:57` `./:/app`), oneshots (same service), and both e2e services (`cicchetto/e2e/compose.yaml:177,341` `../..:/app`). Since `MIX_HOME=/app/.mix`, `HEX_HOME=/app/.hex`, `deps/`, and `_build/` all live under `/app`, the image-baked `mix local.hex`, `COPY mix.exs mix.lock`, `mix deps.get`, `mix deps.compile`, `COPY . .`, and `mix compile` layers are invisible at runtime in **every** deployment shape — which is why `quickstart.sh:87-89` and the e2e seeder (`cicchetto/e2e/compose.yaml:195-197`) both re-run `mix local.hex && mix deps.get` against the mounted tree, and why the healthcheck comment concedes "first-deploy boot can take 2-3 min" recompiling. The bake buys nothing (it can't seed the host tree), yet every cold deploy pays `docker compose build grappa` (`deploy.sh:167`) re-running deps compilation whenever the context changes, and the `COPY . .` layer invalidates on any repo edit. It also makes compose.yaml's "clone-and-go `docker compose up`" claim false — a fresh clone has no hex/deps on the host, and the baked ones are shadowed. Single-stage is still the right call (the CP23 rationale holds); the vestigial bake is not.
**Fix:** Reduce the Dockerfile to base image + `apk add` + `ENV` + `WORKDIR` + `EXPOSE` + `CMD` (a toolchain image). Move `mix local.hex/local.rebar + deps.get` to a documented first-boot step (quickstart already does it; `bin/start.sh` could self-heal the same way the bun/bats scripts do). Image rebuilds become seconds, the image shrinks, and the false clone-and-go implication goes away.

### S2. iex.sh / observer.sh boot a SECOND full application instance instead of attaching to the live node
**File:** `scripts/iex.sh:24`, `scripts/observer.sh:15`
**Category:** correctness / duplication
**Severity:** HIGH
`iex -S mix` (and `iex -S mix run -e ':observer_cli.start()'`) starts a whole new `Grappa.Application` inside the running container: Bootstrap reads the dev DB credentials and spawns a duplicate `Session.Server` + IRC connection per binding (nick collisions upstream), and the second node writes the same sqlite file the live node owns (the exact WAL "Database busy" contention class OPERATIONS logs as a known flake). `observer.sh` is doubly broken: it routes through `in_container` = `docker compose exec -T` (`_lib.sh:185`), so the observer_cli TUI has no TTY — and even with one it would introspect the freshly-booted node, not the live one, defeating its documented purpose ("see every supervised process" of the running system). The `iex.sh:7-9` comment claiming "`bin/grappa remote` is gone along with `mix release`" is stale — `bin/grappa remote-shell` exists (T-2, `iex --remsh grappa@grappa` with `RELEASE_COOKIE`) and is exactly the correct attach path.
**Fix:** Make both scripts thin wrappers over the remsh path (`docker compose exec grappa iex --sname "dbg-$$" --cookie "$RELEASE_COOKIE" --remsh grappa@grappa`, observer via `:observer_cli.start/0` on the remote node with a TTY-full exec) — or delete them and point docs at `bin/grappa remote-shell`. Delete the stale comment.

### S3. Env-var registry contract broken: POOL_SIZE / PORT / LOG_LEVEL silently ignored on Docker; EXTRA_CHECK_ORIGINS missing from .env.example
**File:** `compose.yaml:60-101`, `.env.example:86-106`
**Category:** config drift
**Severity:** MEDIUM
`config/runtime.exs:7-15` mandates: every `System.get_env` read must appear in compose.yaml's `environment:` block AND in `.env.example`. Both directions are violated: (a) `POOL_SIZE`, `PORT`, `LOG_LEVEL` are read by runtime.exs and documented as operator knobs in `.env.example:86-106`, but compose.yaml never propagates them — an operator setting `LOG_LEVEL=debug` or `POOL_SIZE=20` in `.env` gets a silent no-op (the "no silent drops" class). `PORT` is doubly misleading since the publish mapping hardcodes container port `:4000`. (b) `EXTRA_CHECK_ORIGINS` is propagated by compose.yaml:72 and read by runtime.exs:38 but absent from `.env.example` (only the override example mentions it).
**Fix:** Add `POOL_SIZE`, `PORT`, `LOG_LEVEL` to compose.yaml's environment block (or delete them from `.env.example` and hard-doc the defaults); add an `EXTRA_CHECK_ORIGINS` entry to `.env.example`. For `PORT`, either wire the publish as `...:${PORT:-4000}` or remove the knob.

### S4. .env.example documents PHX_HOST as optional-with-default; runtime.exs hard-raises without it
**File:** `.env.example:110-112`
**Category:** config drift
**Severity:** MEDIUM
The entry sits in the "Optional in prod (sensible defaults applied)" section and says "Defaults to grappa.bad.ass" — but `runtime.exs:205-211` raises at boot when PHX_HOST is missing in prod (the fallback was deliberately removed). An operator trimming "optional" entries gets a boot crash the template says can't happen. Related inconsistency: `.env.example:37` says generate SECRET_SIGNING_SALT with `phx.gen.secret 32` while `runtime.exs:187` and `quickstart.sh:105` say 64. The personal hostname `grappa.bad.ass` as the committed example value also contradicts the "nothing depends on a particular LAN/hostname" posture.
**Fix:** Move PHX_HOST to the required-for-prod block, replace the default text with "REQUIRED in prod — boot raises without it", use a neutral example hostname, and align the salt-generation snippet on 64.

### S5. DATABASE_PATH is derived from the HOST's MIX_ENV — `scripts/mix.sh --env=prod` runs prod config against the dev DB file
**File:** `compose.yaml:62`, `scripts/mix.sh:41`
**Category:** correctness
**Severity:** MEDIUM
`DATABASE_PATH: /app/runtime/grappa_${MIX_ENV:-dev}.db` is interpolated by compose from the host shell / `.env` at container-create time. `mix.sh --env=prod` (a documented usage, `mix.sh:7`) only overrides MIX_ENV *inside* the process via `env MIX_ENV=prod mix ...` — the oneshot (or exec'd live container) still carries `DATABASE_PATH=.../grappa_dev.db` whenever the host-level MIX_ENV is dev/unset. runtime.exs's prod branch then happily migrates/reads the dev DB believing it's prod. The same mismatch exists in reverse.
**Fix:** Derive the DB path from MIX_ENV *inside* the container (bin/start.sh: `: "${DATABASE_PATH:=/app/runtime/grappa_${MIX_ENV}.db}"` and drop the compose interpolation), or have `mix.sh --env=` also inject a matching `-e DATABASE_PATH=`.

### S6. Docker deploy.sh hot path swallows per-module reload failures the jail path treats as deploy failure
**File:** `scripts/deploy.sh:150-154`
**Category:** consistency / silent-swallow
**Severity:** MEDIUM
`infra/freebsd/deploy.sh:272-286` parses the `/admin/reload` response and fails the deploy on a non-empty `"failed"` list (`:old_code_in_use`, `:not_purged` — both live-reproduced), because HTTP 200 is explicitly "NOT success". The Docker twin just POSTs and prints "✓ hot-deploy complete" unconditionally — a reload that failed for half the modules is declared a success, leaving the dev/e2e stack silently on stale code. This is the exact no-silent-swallow boundary class CLAUDE.md names, already solved once in the sibling script. There is also no post-reload healthcheck (the jail does one).
**Fix:** Port the jail's `case "${response}" in *'"failed":[]'*)` check (and the short healthcheck loop) into scripts/deploy.sh's hot branch — or better, hoist one shared reload-verify helper both substrates call.

### S7. deploy.sh oneshots bypass compose.oneshot.yaml — either the collision guard is load-bearing (deploy.sh is buggy) or it's dead weight
**File:** `scripts/deploy.sh:114-116,190,203`, `compose.oneshot.yaml:1-32`
**Category:** simplification / consistency
**Severity:** MEDIUM
`_lib.sh:in_oneshot` exists precisely so ephemeral runs layer `compose.oneshot.yaml` (whose header claims that without it, oneshots "inherit `container_name: grappa` … both collide with the long-running copy"). Yet deploy.sh issues three raw `docker compose run --rm --no-deps grappa …` calls (preflight, deps.get, ecto.migrate) with no oneshot layer — while the live container is up. Two of these run in the *auto* path on every deploy. Either the oneshot override's rationale is real and deploy.sh has a latent name/port collision, or (more likely, since these deploys demonstrably work) Compose v2 `run` never applies `container_name`/`ports`/healthcheck/restart, and compose.oneshot.yaml is mostly a file-sized no-op whose comment misdocuments Docker behavior. Both states are worse than one code path.
**Fix:** Establish the truth once, then converge: route deploy.sh's oneshots through `in_oneshot`, or delete `compose.oneshot.yaml` (and the `-f` layering in `_lib.sh`) with a comment recording why `compose run` needs no override.

### S8. db.sh re-implements the MIX_ENV probe that _lib.sh declares "single source of truth", with a silent dev fallback
**File:** `scripts/db.sh:16`
**Category:** duplication
**Severity:** MEDIUM
`_lib.sh:172-174` defines `detect_mix_env()` explicitly "so the two callers can't drift" — but db.sh hand-rolls `in_container printenv MIX_ENV 2>/dev/null || echo dev` instead of calling it. Beyond the drift the helper was built to prevent, the behavior differs: with the container down, `mix.sh:36` prints an honest "defaulting MIX_ENV=dev" warning while db.sh silently opens the dev DB — on a prod-profile box an operator inspecting "the" DB gets the wrong file with no signal (the exact honest-fast-path rule in CLAUDE.md).
**Fix:** `env="$(detect_mix_env)"; [ -z "$env" ] && { warn; env=dev; }` — reuse the helper and mirror mix.sh's stderr notice.

### S9. grappa.env.example still ships the RETIRED GRAPPA_OUTBOUND_V6_POOL — populated with the real prod v6 inventory
**File:** `infra/freebsd/grappa.env.example:52-56`
**Category:** config drift / hygiene
**Severity:** MEDIUM
#228 removed `GRAPPA_OUTBOUND_V6_POOL` entirely — `.env.example:98-102`, CLAUDE.md, and OPERATIONS all state "the env var is GONE, the pool is DB-driven". The jail env template still documents it as live *and* fills it with six concrete `2a03:4000:2:33c::…` addresses — the actual production vhost inventory committed into a public template (plus `PHX_HOST=grappa.bad.ass` as another personal default). A new jail operator copying the template sets a dead knob and inherits someone else's address list.
**Fix:** Delete the block (optionally leave a one-line pointer to the admin Vhosts tab, mirroring `.env.example`), and neutralize PHX_HOST to `grappa.example.org`.

### S10. Deploy scripts do side effects before their worktree/branch guards can fire — half-done deploys from a worktree
**File:** `scripts/deploy-cic.sh:37-52`, `scripts/deploy.sh:144-151`
**Category:** worktree invariants
**Severity:** MEDIUM
`deploy-cic.sh` has no branch guard at all (deploy.sh refuses non-main; cic deploys ship whatever the main checkout's branch holds), and no worktree guard: invoked from a worktree it rebuilds `runtime/cicchetto-dist` (the bundle nginx serves is **swapped on disk**) and only then dies inside `in_container`'s worktree check at the broadcast POST — dist deployed, no refresh banner, non-zero exit. deploy.sh from a worktree similarly performs the `git pull` in REPO_ROOT, then the hot path dies at the same guard before the reload — tree updated, BEAM stale.
**Fix:** Both scripts: assert `[ "$SRC_ROOT" = "$REPO_ROOT" ]` (and for deploy-cic, the same branch check deploy.sh has) as the FIRST step, before any pull/build.

### S11. .dockerignore misses priv/plts, cicchetto/dist, vendor/
**File:** `.dockerignore`
**Category:** build context
**Severity:** LOW
The dialyzer PLT cache (`priv/plts`, ~9 MB currently, grows with deps), local-preview `cicchetto/dist` (~7 MB), and `vendor/bats-core` (~0.5 MB) are all tarred into the Elixir image build context and baked by `COPY . .` — never used at runtime (see S1). Small today, but PLTs and dist are exactly the artifact classes that balloon quietly.
**Fix:** Add `priv/plts/`, `cicchetto/dist/`, `vendor/` (moot if S1 removes `COPY . .`, in which case prune .dockerignore down instead).

### S12. `export` of bash arrays in _lib.sh is a no-op
**File:** `scripts/_lib.sh:39,46,63`
**Category:** dead code
**Severity:** LOW
`export COMPOSE_ARGS` and (implicitly via `declare -ag`) exported arrays don't cross process boundaries in bash — arrays are never inherited by child processes. Every child script re-sources `_lib.sh`, so nothing breaks, but the exports imply an inheritance mechanism that doesn't exist and will mislead the next refactor. (`SRC_ROOT`/`REPO_ROOT` scalar exports are fine.)
**Fix:** Drop `export COMPOSE_ARGS`; keep the arrays plain globals.

### S13. Healthcheck defined twice with drifting values (Dockerfile vs compose)
**File:** `Dockerfile:64-65`, `compose.yaml:102-111`
**Category:** simplification / duplication
**Severity:** LOW
The Dockerfile bakes `HEALTHCHECK … retries=3`; compose.yaml redefines the same probe with `retries: 5` and always wins for every consumer (dev, prod profile; e2e defines its own too). The Dockerfile copy is dead configuration that will drift further.
**Fix:** Delete the Dockerfile `HEALTHCHECK` and keep compose as the single definition (or vice versa — one owner).

### S14. `./runtime:/app/runtime` mount is a redundant subpath of `./:/app`
**File:** `compose.yaml:58-59`
**Category:** simplification
**Severity:** LOW
The whole repo is already bind-mounted at `/app`; mounting `./runtime` again at `/app/runtime` maps the identical host directory to the identical container path. It documents intent but adds a second mount entry Docker must maintain and readers must reason about.
**Fix:** Delete the second mount; keep the "per-env state lives in runtime/" note as a comment on the `./:/app` line.

### S15. nginx listens IPv4-only, forcing the documented localhost/::1 healthcheck workaround
**File:** `infra/nginx.conf:48`, `compose.yaml:176-179`
**Category:** simplification
**Severity:** LOW
The compose healthcheck carries a paragraph explaining that alpine resolves `localhost` → `::1` first while nginx.conf only declares `listen 80` — so the probe must say `127.0.0.1`. Declaring `listen [::]:80;` alongside removes the failure mode entirely and the explanatory comment with it (and makes the container behave under any future IPv6-preferring client).
**Fix:** Add `listen [::]:80;` next to `listen 80 default_server;` and shrink the healthcheck comment.

### S16. e2e compose passes build args the Dockerfile never declares
**File:** `cicchetto/e2e/compose.yaml:166-170,304-308`
**Category:** dead config
**Severity:** LOW
Both `grappa-e2e-seeder` and `grappa-test` pass `args: CONTAINER_UID/CONTAINER_GID` to the root-context build, but the Dockerfile contains no `ARG` — BuildKit warns "unconsumed build arguments" and the args do nothing, implying the image is UID-parameterized when the UID drop actually happens via the runtime `user:` directive.
**Fix:** Delete the `args:` blocks from both services.

### S17. bun.sh UID default diverges from the compose default when CONTAINER_UID is unset
**File:** `scripts/bun.sh:53-54`, `compose.yaml:138`
**Category:** consistency
**Severity:** LOW
bun.sh defaults to `$(id -u)` while compose's `cicchetto-build` defaults to literal `1000`. On a host with UID ≠ 1000 and no `CONTAINER_UID` in `.env`/env (e2e exports it on Linux; the dev prod-profile path does not), the shared `runtime/bun-cache` gets written by two different owners — the exact intermittent-EACCES class bun.sh's own comment claims this wiring prevents.
**Fix:** Align the defaults: have `_lib.sh` export `CONTAINER_UID/GID` (the `e2e_export_uid` logic, un-gated from e2e) so compose and raw `docker run` always agree, or make bun.sh default to `1000` to match compose.

### S18. deploy.sh header describes a preflight implementation that no longer exists
**File:** `scripts/deploy.sh:2-31`
**Category:** doc drift
**Severity:** LOW
The header says the preflight "has to be in this script: diff `HEAD@{1}..HEAD` for the unsafe markers", enumerates the marker classes inline, and attributes hot reload to `Phoenix.CodeReloader` — but the implementation delegates classification to `Grappa.Deploy.Preflight` over `prev_sha..HEAD`, and OPERATIONS states module reload is `Grappa.HotReload`, "NOT Phoenix.CodeReloader". The stale prose is exactly what a future session will copy (the CP28 regression class the file itself cites).
**Fix:** Rewrite the header to match: "classification lives in `lib/grappa/deploy/preflight.ex`; this script is a thin invoker dispatching on exit code 0/3".

### S19. testnet.sh: hardcoded container name in `probe`, broken empty-arg `logs`
**File:** `scripts/testnet.sh:126,117`
**Category:** consistency
**Severity:** LOW
`probe` runs `docker exec grappa-e2e-nginx` — the literal-container-name brittleness the H27 review fixed elsewhere (`deploy-cic.sh:48-51` documents why bare `docker exec <name>` was banned). `logs` with no service passes an empty string to `docker compose logs -f ""`, which errors instead of defaulting to all services.
**Fix:** `probe` → `docker compose exec nginx-test …` (after `cd "$E2E_DIR"`); `logs` → `docker compose logs -f ${1:+"$1"}`.

### S20. jail_install_nginx.sh hardcodes the probe IP and REPO_ROOT
**File:** `infra/freebsd/jail_install_nginx.sh:11,53`
**Category:** consistency
**Severity:** LOW
`REPO_ROOT="/home/grappa/grappa"` is hard-pinned (sibling `deploy.sh:35` makes it env-overridable, and deploy-m42.sh exposes `JAIL_REPO` — an override there silently doesn't reach this script, breaking `refresh_nginx` for any non-default layout), and the final probe curls the literal `10.66.6.7` — a host-specific jail IP in a committed script.
**Fix:** `REPO_ROOT="${REPO_ROOT:-/home/grappa/grappa}"`; the probe can't use `127.0.0.1` (the server binds the jail IP), so derive the IP from the nginx config or make it `PROBE_URL="${PROBE_URL:-…}"`.

### S21. register-dns.sh defaults to personal infrastructure
**File:** `scripts/register-dns.sh:38-39`
**Category:** hygiene
**Severity:** LOW
The script's header claims "nothing is hardcoded to a particular IP/hostname", and DESIGN_NOTES records it was "depersonalized (env vars now required, no defaults)" — yet `TECHNITIUM_BASE_URL` and `DNS_NS` default to `ns1.bad.ass`, and `TECHNITIUM_ENV_FILE` to `/srv/dns/.env`. The defaults contradict both the claim and the recorded decision.
**Fix:** Make `TECHNITIUM_BASE_URL` and `DNS_NS` required (`:?` expansion) like the GRAPPA_* triple, or move personal values to the operator's shell profile.

### S22. `--profile prod` names a stack that is documented as "NOT this project's production"
**File:** `compose.yaml:136,157`
**Category:** simplification
**Severity:** LOW
Since prod moved to the m42 jail, OPERATIONS opens with a whole paragraph disclaiming that the Docker "prod" profile is the dev/e2e/self-hoster full stack, and CLAUDE.md repeats it. Every future session pays the disambiguation tax, and the misnomer invites exactly the "deploy to prod" confusion the docs keep fencing off.
**Fix:** Rename the profile (`full` / `stack`), update the call sites (`deploy.sh`, `deploy-cic.sh`, `_lib.sh` comment, docs) — or explicitly record in compose.yaml why the rename is not worth the churn.

### S23. RELEASE_COOKIE exposed on the BEAM command line
**File:** `bin/start.sh:59`
**Category:** security
**Severity:** LOW
`-setcookie ${RELEASE_COOKIE}` inside `ELIXIR_ERL_OPTIONS` puts the cookie in beam.smp's argv — visible via `docker top`/host `ps` to any host user, a wider surface than the documented "anyone with docker exec can printenv" threat model (container processes' cmdlines are host-readable without docker privileges).
**Fix:** Write the cookie to `$HOME/.erlang.cookie` (mode 0400) in start.sh and drop `-setcookie` from the argv, keeping only `-sname grappa`.

### S24. credo.sh usage example references a branch that doesn't exist
**File:** `scripts/credo.sh:8`
**Category:** doc drift
**Severity:** LOW
`scripts/credo.sh diff master` — the repo's default branch is `main`; the example command fails verbatim.
**Fix:** s/master/main/.

Non-findings worth recording: the named-volume→bind-mount posture is coherent and consistently reasoned across compose.yaml, the e2e compose, and bun.sh (the UID-drop trap is documented at every site); the nginx :80/:443 duplication was already solved by the `infra/snippets/locations-api.conf` hoist (one source, three include sites); the hot/cold preflight no longer uses shell regexes at all — classification (including long-lived GenServer/defstruct detection via the tokenizer against `lib/grappa/hot_reload/long_lived_modules.ex`) lives in `lib/grappa/deploy/preflight.ex`, with correct 0/3/abort exit-code dispatch in both substrate scripts; CSP restate-'self' discipline in `infra/snippets/security-headers.conf` is internally consistent.

---

## cross-surface agent findings (2026-07-19 codebase review, run 2026-07-20)

**Severity summary: 0 CRITICAL / 1 HIGH / 6 MEDIUM / 6 LOW (13 findings)**

### S1. Envelope `kind`/`state` typed `String.t()` in ~10 Wire modules defeats codegen literal pinning
**File:** `lib/grappa/notify/wire.ex:34`, `lib/grappa/query_windows/wire.ex:35`, `lib/grappa/read_cursor/wire.ex:48`, `lib/grappa/window_counts/wire.ex:28`, `lib/grappa/scrollback/wire.ex:49,187,220`, `lib/grappa/server_settings/wire.ex:81`, `lib/grappa/cic/wire.ex:44`, `lib/grappa/networks/wire.ex:221`, `lib/grappa/session_log/wire.ex` (event), `lib/grappa/session/wire.ex:354-397` (`state: String.t()` on joined/window_pending/window_invited/join_failed/kicked); client side `cicchetto/src/lib/api.ts:630-714,924-1181`
**Category:** Wire-shape drift / unification opportunity
**Severity:** MEDIUM
The repo's own S14/S15 convention (Scrollback `kind`, ServerSettings `active_host`, WindowCounts `severity`) is: keep the closed atom in the typespec so `mix grappa.gen_wire_types` emits a **literal** TS union the cic side asserts against. But the envelope discriminators of these modules are typed `kind: String.t()` (and Session.Wire's window-state payloads type `state: String.t()`), so the generated types carry `kind: string` / `state: string` and no `WireXEvent` union is auto-emitted. cic restates every literal by hand (`"query_windows_list"`, `"notify_list"`, `"read_cursor_set"`, `"window_counts"`, `"bundle_hash"`, `"server_settings_changed"`, `"archive_changed"`, `"archive_purged"`, `"connection_state_changed"`, `state: "pending" | "invited" | ...`) with zero compile-time gate — a server-side rename of any of these strings ships silently past codegen, `wireTypesAssert.ts`, and tsc, and every event of that kind is then dropped at the cic narrower with only a console.warn.
**Fix:** Change the typespecs to literal atoms (`kind: :notify_list`, `state: :pending`, etc.) and pass the atom through (Jason stringifies) — the exact S14 precedent — then regenerate and pin cic's hand-rolled unions to the generated literals via `_Assert_*` entries.

### S2. Codegen silently drops `optional(...)` map keys — generated type over-claims `version` as required
**File:** `lib/mix/tasks/grappa/gen_wire_types.ex:376-383` (`strip_atom_keyed_field` matches `map_field_exact` and `map_field_assoc` identically); `lib/grappa/cic/wire.ex:43-47` (`optional(:version) => String.t()`); generated `cicchetto/src/lib/wireTypes.ts:384-388` (`version: string;` — required)
**Category:** Wire-shape drift (codegen)
**Severity:** MEDIUM
The server deliberately **omits** the `version` key when the bundle advertises no semver, but the generated `CicWireBundleHashPayload` declares it required `string`. Any cic code trusting `wireTypes.ts` for this shape is type-lied to; today only the hand narrower (`userTopic.ts:599-605`, which normalises absent → null) saves it, and cic's own union (`api.ts:1114` `version: string | null`) diverges from both the server typespec (`String.t()`, optional) and the generated type (`string`, required) — three shapes for one field. Same latent bug awaits any future `optional(...)` field in a Wire typespec (`Notify.Wire`/`QueryWindows.Wire` use `required(...)` today, but nothing stops an optional key landing).
**Fix:** In `strip_atom_keyed_field/1` distinguish `:map_field_assoc` and emit `key?: T` in `do_render/1`'s map clause; regenerate and align `api.ts`'s `bundle_hash` arm.

### S3. FallbackController wire tokens with no cic mapping — raw `"<status> <code>"` reaches operator-visible alerts
**File:** `lib/grappa_web/controllers/fallback_controller.ex:513-518` (`session_timeout`), `:568-572` (`invalid_message`), `:638-642` (`already_attached`), `:218-222` (`theme_cap_reached`); client `cicchetto/src/lib/friendlyApiError.ts:33-62` (`KnownApiErrorCode` lacks all four)
**Category:** Error-shape inconsistency
**Severity:** MEDIUM
`session_timeout` (504, reachable from **every** REST IRC-verb path since REV-J M14 — `POST /messages`, join, part), `invalid_message` (422 from read-cursor set), `already_attached` (409 from the HomePane visitor connect flow, which routes errors straight into `friendlyApiError` at `HomePane.tsx:159-168`), and `theme_cap_reached` (429, whose FallbackController comment explicitly promises "cic can render a cap-specific hint") all fall through `isKnownCode` to the raw `err.message` (`"504 session_timeout"`). The server-side comments assert cic copy exists; it doesn't.
**Fix:** Add the four tokens to `KnownApiErrorCode` + switch arms (+ vitest matrix rows) with the copy each FallbackController comment already specifies.

### S4. Upload error tokens and their actionable payload fields are ignored by the upload error surface
**File:** `lib/grappa_web/controllers/fallback_controller.ex:123-176` (`body_too_large`+`limit`, `file_too_large`+`max_bytes`, `insufficient_storage`, `unsupported_media_type`, `metadata_strip_failed`); client `cicchetto/src/lib/uploadOrchestrator.ts:236-263`
**Category:** Error-shape inconsistency / REST contract divergence
**Severity:** MEDIUM
The server threads `max_bytes` "so cic can render the actionable threshold" and maps 507 to "the same admin-action affordance as network_busy (talk to your admin)". cic's `friendlyErrorMessage` branches only on the numeric status: every 4xx becomes "Upload rejected (NNN) — try a different file" (wrong advice for `metadata_strip_failed`, where a different file of the same kind fails identically) and 507 becomes "Upload service unavailable (507). Retry?" — retry advice for a disk-at-capacity condition that retrying cannot fix. `max_bytes`/`limit` are never read (client pre-check uses server-settings caps, but the litterbox/proxy paths and cap drift mid-session still surface the server 413).
**Fix:** Parse the JSON body's `error` token in the `http` arm of `friendlyErrorMessage` and branch per token (`insufficient_storage` → admin-affordance copy, `file_too_large` → render `max_bytes`, `metadata_strip_failed` → "couldn't strip metadata" copy).

### S5. `friendlyChannelError` misses tokens the awaited WS verbs actually return
**File:** `lib/grappa_web/channels/grappa_channel.ex:1000-1021` (`save_failed`, `not_found` from watchlist), `:1471` (`persist_failed` from topic_set), `:371` (`invalid_payload`), `:905-907` (`open_failed`); client `cicchetto/src/lib/friendlyChannelError.ts:28-53`
**Category:** Error-shape inconsistency
**Severity:** MEDIUM
`pushWatchlistAdd`/`Del` are awaited in `compose.ts:887-896` and their rejections route through `friendlyError` → `friendlyChannelError`; the server replies `not_found` ( `/watch del <missing pattern>` — an ordinary user action) and `save_failed`, neither of which is in `KnownChannelErrorCode`, so the operator sees the raw `"channel push error: not_found"`. (`not_found` is mapped in friendlyApiError but the channel-side map is a separate union.) `persist_failed`/`invalid_payload`/`open_failed` are currently reachable only from fire-and-forget or non-awaited sites, but the module's own contract ("add a token: add it to the union") is out of sync with the server's emit set.
**Fix:** Add `not_found` + `save_failed` arms (at minimum) to `KnownChannelErrorCode` with watchlist-appropriate copy; document or map the remaining three.

### S6. Fire-and-forget WS pushes swallow server rejections — `/invite` paints ok on a dropped frame
**File:** `cicchetto/src/lib/socket.ts:527-530` (`pushChannelInvite`), `:612-674` (`pushWhois`/`pushWhowas`/`pushWho`/`pushLusers`/`pushInfo`/`pushVersion`/`pushMotd`/`pushNames`), `:559-562` (`pushChannelTopicSet`, dead helper); server `lib/grappa_web/channels/grappa_channel.ex:554-565` (invite replies `{:error, %{error: ...}}` via `dispatch_subject_verb/3`); client `cicchetto/src/lib/compose.ts:638-639` (`pushChannelInvite(...)` then `result = { ok: true }`)
**Category:** No-silent-drops / REST-vs-Channel contract divergence
**Severity:** HIGH
#154(1) promoted the state-changing channel verbs to awaited Promises precisely because "compose.ts painted a green ✓ on a dropped state-changing frame" — but `/invite`, a write verb whose server handler replies `invalid_channel`/`invalid_nick`/`no_session`/`upstream_unavailable`, was left fire-and-forget: compose returns `{ok: true}` unconditionally, so a rejected or WS-down invite silently reports success. The read-query verbs share the swallow with a worse UX twist: a server-side validation reject (e.g. `/whois <malformed>` → `invalid_nick`) means **no bundle ever arrives** and no numeric lands on `$server` (the reject happens before the upstream write), so the operator gets literally nothing. (`banlist` is deliberately exempt because its errors surface via numerics — that rationale does not hold for these.) `pushChannelTopicSet` is an unused helper that would swallow `persist_failed` if ever wired.
**Fix:** Route `invite` through `pushUserChannelVerb` and await it in compose (mirror of kick/ban); give the query verbs the same Promise shape (their server handlers already reply); delete or promote `pushChannelTopicSet`.

### S7. Hand-rolled Session payload mirrors (WhoisBundle, WhowasBundle, LusersBundle, NamesReply, WhoReply, presence arms) have codegen counterparts but no `_Assert_` pins
**File:** `cicchetto/src/lib/wireTypesAssert.ts:124-142` (pin list); `cicchetto/src/lib/api.ts:775-905,1166-1181` (mirrors); generated `cicchetto/src/lib/wireTypes.ts:648-893`
**Category:** Wire-shape drift (drift-gate gap)
**Severity:** MEDIUM
The assert file's stated rule is "per-arm PAYLOADS that have a flat counterpart are pinned below", but the largest payloads on the boundary — `WhoisBundle` (27 fields, `SessionWireWhoisBundlePayload`), `WhowasBundle`, `LusersBundle`, `NamesReply`/`WhoReply` envelopes, and the #247 `presence_changed`/`presence_error`/`presence_snapshot` arms — have exact generated counterparts and **no** assert. A server field add/rename in `whois_bundle_payload` (which has grown twice already: P-0a, #221) regenerates `wireTypes.ts` cleanly and leaves `api.ts` + the 30-line hand narrower in `userTopic.ts` silently stale; the narrower would then drop every whois bundle at runtime with only console noise.
**Fix:** Add `Assert<Equal<...>>` entries pinning each hand mirror to `Omit<SessionWireXPayload, "kind">` (or restructure the mirrors to derive from the generated types).

### S8. `invite_ack` carries no server timestamp — cic interleaves client wallclock against `server_time`
**File:** `lib/grappa/session/wire.ex:523-528` (payload: network/channel/peer only); client `cicchetto/src/lib/inviteAck.ts:33-42` (`at` = client epoch ms, sorted against server `server_time` in ScrollbackPane's `rows()` memo)
**Category:** Timestamp consistency / state-mirror discipline
**Severity:** LOW
Every other ephemeral Session event that needs ordering carries a server-stamped time (`presence_changed.ts`, `channel_created.created_at`). `invite_ack` doesn't, so cic fabricates the wallclock used to merge the row into the `$server` timeline alongside server-stamped messages — a skewed client clock reorders the ack against neighbouring server rows, and the timestamp shown is client-originated data in a server-truth timeline.
**Fix:** Add `at: DateTime.to_iso8601(...)` (or epoch ms to match `server_time`'s unit) to `invite_ack/3` and use it as the interleave key; keep the client counter only as tiebreaker.

### S9. cic `WindowState` includes `"parked"` that no wire event or snapshot can ever deliver
**File:** `cicchetto/src/lib/windowState.ts:31` (union includes `"parked"`, no setter writes it); server `lib/grappa/session/server.ex:1705-1707` (`get_window_state` returns `:not_tracked` for `:parked` — "cic doesn't yet render :parked"), `lib/grappa/session/wire.ex` (no `window_parked` kind); consumers `cicchetto/src/ComposeBox.tsx:77`, `Sidebar.tsx:82,166`
**Category:** Dead branch / event-name divergence
**Severity:** LOW
The server's `window_states` map holds `:parked`, but neither the event surface nor the cold-subscribe snapshot ever emits it, and no cic setter writes it — so the `"parked"` member of `windowStateByChannel`'s union and the `"parked"` entries in `NOT_JOINED_STATES` are unreachable via this store (parked grey is actually derived from `connection_state`, a different source). The half-mirrored state invites a future consumer to trust a branch that can't fire.
**Fix:** Either emit a `window_parked` event/snapshot arm (completing the mirror per "cic just mirrors"), or drop `"parked"` from the cic union and the state-set literals with a comment pointing at the `connection_state` derivation.

### S10. Contract-doc drift at the wire-boundary sources
**File:** `lib/grappa/session/wire.ex:195-199` (presence_snapshot typedoc: "pushed at channel after-join" — actually pushed at **user-topic** after-join, `grappa_channel.ex:1200-1213`); `lib/grappa/read_cursor/wire.ex:21-22,45-46` (points cic mirror at "`narrowReadCursorSet` in `userTopic.ts`" — actual consumer is `narrowChannelEvent` in `wireNarrow.ts:409` + `subscribe.ts:406`); `lib/grappa_web/channels/grappa_channel.ex:138` (documents `query_windows_list` as `%{network_id => [%Window{}]}` raw structs — actual wire is `QueryWindows.Wire` rendered entries); `cicchetto/src/lib/inviteAck.ts:6-8` (says invite_ack arrives "on the channel's per-channel topic" — P-0f moved it to user-topic)
**Category:** Wire-shape drift (documentation at the contract source)
**Severity:** LOW
These moduledocs/typedocs are the declared single source of truth for their shapes; each currently misdirects the next editor to the wrong topic, wrong consumer file, or a struct shape that would crash the fastlane if actually emitted.
**Fix:** Correct the four comments (one-line edits each).

### S11. Network-level topic tier is dead: joinable, documented, never broadcast, never joined
**File:** `lib/grappa_web/channels/grappa_channel.ex:54-57,324-328` (accepts `{:network, _, _}` joins, moduledoc: "the network-level topic carries connection-state events only"); no server broadcaster targets `Topic.network(...)` (grep over `lib/` = zero hits — connection-state events ride `Topic.user`); client `cicchetto/src/lib/socket.ts:233-236` ("joinNetwork ... has no cicchetto consumer yet")
**Category:** Event-name divergence (dead surface)
**Severity:** LOW
The moduledoc promises events on a tier that has no producer and no consumer. A future contributor reading the channel doc would reasonably broadcast a network-scoped event there and have it silently reach nobody.
**Fix:** Either reject network-topic joins until a producer exists, or fix the moduledoc to state the tier is reserved/unused (matching the cic-side comment).

### S12. Notify REST index diverges from the WS snapshot shape and has zero consumers
**File:** `lib/grappa_web/controllers/notify_controller.ex:45-59` (`{entries: [...], presence: map | null}` flat per-network); WS door `lib/grappa/notify/wire.ex:34` + `lib/grappa/session/wire.ex:201-205` (`notify_list` grouped `%{network_id => [entry]}` + separate `presence_snapshot` event); client `cicchetto/src/lib/api.ts:2391-2428` (only POST/DELETE — no GET client, removed as dead in review R4)
**Category:** REST-vs-Channel contract divergence
**Severity:** LOW
The same domain entity (the watch list + presence map) is serialized differently on the two doors: REST nests `presence` inline (with `null` as the no-session honesty signal), WS splits it into two events and groups entries by network id. The R4 review decision keeps the GET "for API completeness", so this is deliberate — but the endpoint is untested-by-consumer and its shape can drift freely (nothing on the cic side would notice). Worth an explicit annotation or convergence on the Wire envelope if the endpoint is to stay.
**Fix:** Have `index` reuse `Wire.notify_list_payload`-adjacent shapes (grouped or at least the same entry envelope + a documented `presence` key), or mark the endpoint's divergence + no-consumer status in the controller moduledoc.

### S13. Two client-side nick-fold implementations, neither pinned against the server fold
**File:** `cicchetto/src/lib/notifyWatch.ts:49-50` (`rfc1459Fold` — full rfc1459 mirror of `Grappa.IRC.Identifier.canonical_nick/1`); `cicchetto/src/lib/nickEquals.ts` (ascii-downcase-only, used by members/DM routing/own-nick checks); server `Grappa.IRC.Identifier.canonical_nick/1`
**Category:** Duplicated logic / unification opportunity
**Severity:** LOW
CLAUDE.md documents the `nickEquals` ascii tradeoff as a known gap, and `notifyWatch.ts` documents `rfc1459Fold` as a wire-key mirror, so this is a deliberate split — but the client now carries **two** fold rules for one identity invariant, and nothing (test or assert) pins `rfc1459Fold`'s character table to the server's `canonical_nick/1` (`[ ] \ ~` → `{ } | ^`). A server-side fold change (e.g. a future CASEMAPPING accommodation) would silently desync presence-dot lookups only.
**Fix:** Unify on one exported fold helper (`rfc1459Fold`) with `nickEquals` layered on it (or documented as intentionally weaker at ONE site), and add a fixture test enumerating the fold table shared with a server-side doctest (same drift-pin pattern the migrations got via `nick_fold_sql/1`).
