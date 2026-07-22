# Architecture Review — 2026-07-20

**Base:** `main` @ `0f2fe3c4` (+ local docs commit `be536856`).
**Method:** 6 concern agents per `.claude/skills/review` (architecture mode): abstraction boundaries, responsibility & cohesion, duplication, dependency architecture, type-system leverage, extension & maintainability. Each read across the entire codebase (server + cicchetto) following its concern; extension agent measured touch-counts from real git history rather than estimating. Runs throttled across usage-limit windows; one agent resumed mid-run after a limit cut with its progress intact.
**Companion:** line-level codebase review 2026-07-19 (`docs/reviews/codebase/2026-07-19-codebase-review.md`, issue #364, PR #365) — its buckets E/F/I/J fed these agents as verification input.

## Severity summary

| Concern | CRITICAL | HIGH | MEDIUM | LOW | Findings |
|---------|----------|------|--------|-----|----------|
| Abstraction boundaries | 0 | 4 | 5 | 3 | 12 |
| Responsibility & cohesion | 0 | 3 | 7 | 1 | 11 |
| Duplication | 0 | 4 | 4 | 2 | 10 |
| Dependency architecture | 0 | 1 | 4 | 2 | 7 |
| Type-system leverage | 0 | 4 | 4 | 3 | 11 |
| Extension & maintainability | 0 | 3 | 5 | 1 | 9 |
| **Total** | **0** | **19** | **29** | **12** | **60** |

## Cross-concern synthesis — eight root themes

The six agents converged independently on the same structural roots. Findings
below are grouped by theme (concern-prefixed: B=boundaries, C=cohesion,
D=duplication, P=dependency, T=types, X=extension).

**1. Wire-codegen half-adoption — the single largest cluster (B2, B3, B4, T1,
T2, T3, T4, T11, D4, D5, X6).** The `gen_wire_types` pipeline is sound and
CI-gated, but stalled mid-migration: ~8-10 Wire modules still type `kind:
String.t()` (defeating union emission), the generated unions exist but nothing
imports them, `api.ts` hand-maintains ~90 mirror types with opt-in asserts,
runtime narrowers (~1,400 lines) are invisible to the codegen, the AdminWire
surface (10 modules) escapes the glob by filename, and scrollback `meta` — the
richest payload — crosses as `Record<string, unknown>`. One coordinated
finish-the-migration cluster closes all of it.

**2. `Networks → Session` wrong-direction edge (P1 HIGH, P2, B6 HIGH).** The
data layer sits above the process runtime; every cycle workaround in the
codebase (2 runtime-env DI seams, 7 injected closures, 3+ dirty_xrefs) routes
through this one edge. Fix: SpawnOrchestrator owns session stop; Operator owns
admin DB+live combining. The seams then become static deps and the CLAUDE.md
runtime-env rule needs no carve-outs.

**3. Subject-label codec unowned (B1 HIGH, C10, D3 HIGH).** The
`user.name` / `"visitor:" <> id` topic segment is restated at ~9-10 sites plus
one inverse parser, threaded through context APIs as bare strings. Silent
dead-drop on drift. Fix: `Grappa.Subject.label/1` + `from_label/1` (or on
`PubSub.Topic`), all sites migrated in one commit.

**4. Client fold triplication, mirrors unpinned (D1 HIGH, D2, D8, T6 HIGH,
B11).** Three nick-fold policies client-side (bare toLowerCase, rfc1459Fold,
sigil-gated) vs one server-side; the parity fixture is green while the ports
disagree on bracket nicks; five comment-lockstep mirrors have no pin mechanism
despite two existing in-repo (codegen, truth-table fixture). Fix: one client
fold + fold-vector fixture; pin or generate the other mirrors.

**5. Hub-file re-accretion (C1 HIGH, C3 HIGH, C7 HIGH, C2, C8, C9, X3 HIGH,
X5).** `Session.Server` is a god GenServer again (4,699 lines, 60-key state);
the Broadcaster/Persistor extraction deferred since 2026-04-27 is now
measurably drifting between inbound/outbound persist paths (live correctness
channel); cic `compose.ts` regrew the god-dispatcher shape removed from
networks.ts in April; `server_test.exs` pins state shape with ~98
`:sys.get_state` calls that will tax every extraction. Fix order: Persistor
extraction first (drift), then DirectoryRefresh, then commandDispatch.ts.

**6. Error-token space ungated (B7, D6 HIGH).** No server-side enumeration of
wire error tokens; atom→token bending hidden in clause bodies; two separate
client unions; ~17 emitted tokens unmapped. Fix: token enumeration module fed
through codegen so `assertNever` fails tsc on server additions.

**7. Visitor schema stranded (B5, P4).** 9-12 `dirty_xrefs:
[Grappa.Visitors.Visitor]` — the graph saying the identity schema is in the
wrong boundary. Fix: split visitor identity from orchestration.

**8. Docs-as-authority drifting (P7, X2 HIGH, X1 HIGH, X9).** CLAUDE.md's
supervision tree is ~8 children stale; the window-states enum is quoted
staleley in 2 of 3 locations; the nginx-allowlist instruction predates the
snippet hoist; the env-var registry contract is broken 4+ ways with no gate.
Fix: correct now, then "reference don't quote" + drift-pin tests (the repo's
own established idiom).

## Suggested sequencing

1. **Wire codegen finish** (theme 1) — mechanical, highest drift-class payoff,
   no behavior change. Includes atom-kind sweep + admin_wire glob + narrower
   generation/table.
2. **Subject-label codec** (theme 3) — small, closes a recurring review
   finding.
3. **Client fold consolidation + fixture pins** (theme 4) — fixes live
   bracket-nick divergence; pairs with codebase-review bucket E.
4. **Doc corrections + drift pins** (theme 8) — cheap, stops authority rot;
   env-var registry pin is the highest-value single test.
5. **Persistor/Broadcaster extraction** (theme 5, C3) — the one hub split with
   a live correctness-drift channel; gate `server_test.exs` state access
   through helpers first (X3).
6. **Networks→Session edge** (theme 2) — medium effort, retires two rule
   carve-outs and most closures.
7. **Error-token enumeration** (theme 6), **Visitor schema move** (theme 7),
   remaining hub splits — opportunistic.

Zero CRITICAL: nothing blocks correctness today. The 19 HIGHs are all
maintenance-burden and drift-risk debts, and they cluster tightly — roughly
seven coordinated clusters retire all of them.

---

# Per-concern findings (verbatim agent reports)

---

## Architecture review 2026-07-20 — Abstraction boundaries agent

Severity count: **0 CRITICAL / 4 HIGH / 5 MEDIUM / 3 LOW** (12 findings)

---

### A1. Subject→topic-label encoding has no owner
**Concern:** Abstraction boundaries
**Scope:** `lib/grappa/pubsub/topic.ex`, `lib/grappa/networks.ex:869-870`, `lib/grappa/notify.ex` (`add/4`, `remove/4`, `clear/3` all take a `subject_label` string param), `lib/grappa/window_counts/push_source.ex` (`ctx.subject_label`), `lib/grappa/session.ex` (`start_opts.subject_label`), `lib/grappa/visitors/session_plan.ex:123`, `lib/grappa_web/controllers/notify_controller.ex:159-166`, `lib/grappa_web/controllers/read_cursor_controller.ex:183-185`, `lib/grappa_web/controllers/channels_controller.ex:281`, `lib/grappa_web/controllers/archive_controller.ex:219`, `lib/grappa_web/channels/user_socket.ex:255`, `lib/grappa_web/channels/grappa_channel.ex:1576`
**Severity:** HIGH
**Problem:** The user-rooted PubSub topic segment is `user.name` for users and `"visitor:" <> visitor.id` for visitors, but `Grappa.PubSub.Topic` accepts only a pre-encoded string, so the encoding rule is re-implemented at ~10 production sites: two private `subject_label` helpers in controllers, `subject_label_of/1` in Networks, inline `"visitor:" <> id` concatenations in four more web modules, and every context that broadcasts on a user topic threads `subject_label` through its public API as a bare string parameter (`Notify.add(subject, network_id, nicks, subject_label)`). Worse, `GrappaChannel.resolve_subject/1` string-parses the label *back* into a subject tuple — the label is simultaneously a display key, an identity carrier, and a wire format, owned by nobody. Root cause: the topic is keyed on the user *name* (a DB attribute) while context-layer subjects are bare-id tuples, so no lower layer can compute the label without a lookup.
**Impact:** Any change to the label shape (e.g., allowing user renames, adding a third subject kind) is an N-site shotgun edit; a single site drifting silently partitions PubSub fan-out (subscriber and broadcaster compute different topics — the exact failure class the `#Chan`/`#chan` canonicalisation bug already exhibited for channels). Context APIs are polluted with a web-routing concern.
**Recommendation:** One owner: either (a) add `Topic.user_segment(subject_ref)` / make `Topic.user/1` accept a typed `{:user, name} | {:visitor, id}` label tuple, with a single `GrappaWeb.Subject.label/1` (rich-struct side) and one context-side resolver, or (b) re-key topics on subject UUID (eliminates the name lookup entirely; `join/3` authz compares ids). Delete every inline `"visitor:" <>` concat and both controller-local helpers; contexts should take a label produced by the one function, or better, stop taking labels at all (see A9).

### A2. Wire `kind:` discriminators half-migrated to literal atoms — codegen union emission silently defeated
**Concern:** Abstraction boundaries
**Scope:** `lib/grappa/scrollback/wire.ex:49,187,221`, `lib/grappa/notify/wire.ex:34`, `lib/grappa/query_windows/wire.ex:35`, `lib/grappa/window_counts/wire.ex:28`, `lib/grappa/server_settings/wire.ex:82`, `lib/grappa/read_cursor/wire.ex:49`, `lib/grappa/session_log/wire.ex:34`, `lib/grappa/networks/wire.ex:222`, `lib/grappa/networks.ex:639` vs. `lib/grappa/session/wire.ex` (fully atom-literal), `lib/grappa/admin_events/wire.ex` (fully atom-literal); consumer machinery in `lib/mix/tasks/grappa/gen_wire_types.ex:577-588`
**Severity:** HIGH
**Problem:** `mix grappa.gen_wire_types` emits TS discriminated unions only when the `:kind` field is a literal atom (`extract_literal_kind/1` matches `{:atom, _, literal}`). `Session.Wire` and `AdminEvents.Wire` were migrated to atom-literal kinds (the S14 pattern documented in `scrollback/wire.ex:86-98`), but at least 9 payload types across 8 modules still declare `kind: String.t()` — including, ironically, three in the same Scrollback.Wire whose doc explains why `String.t()` widening "erased the closed set from codegen." This is exactly the CLAUDE.md "half-migrated creates two patterns" failure: a new wire module has a coin-flip precedent to copy.
**Impact:** For every String.t()-kind payload, cicchetto cannot get a generated discriminated union, which is a direct cause of A3's hand-rolled `WireUserEvent`/`WireChannelEvent` unions and the ~45-arm hand-written runtime narrower in `userTopic.ts:271-757`. Each new event kind means hand-edits on both sides with no compiler bridge.
**Recommendation:** Finish the migration in one pass: every `kind:` in every `*/wire.ex` (and the stray `connection_state_changed_event` typedef living in `networks.ex` rather than `Networks.Wire`) becomes a literal atom; let Jason stringify at the boundary. Then extend gen_wire_types to emit per-topic event unions the narrowers can be checked against, and add a Credo/test gate rejecting `kind: String.t()` in wire modules.

### A3. Generated wireTypes barely reach the client's edge — api.ts maintains ~15 hand-rolled mirror types
**Concern:** Abstraction boundaries
**Scope:** `cicchetto/src/lib/wireTypes.ts` (1016 lines, generated), `cicchetto/src/lib/api.ts` (2968 lines, ~95 hand-written types), `cicchetto/src/lib/wireTypesAssert.ts`, `cicchetto/src/lib/channelTopic.ts`, `cicchetto/src/lib/memberTypes.ts`, `cicchetto/src/lib/queryWindows.ts:33-35`
**Severity:** MEDIUM
**Problem:** Only 18 files import from `wireTypes.ts`, mostly assert/narrow machinery and the themes/session-log verticals; just 2 components touch it. Everything else consumes hand-rolled mirrors in `api.ts` (13 shape pairs: `ScrollbackMessage`/`ScrollbackWireT` at api.ts:592/wireTypes.ts:526, `HomeNetworkRow`, `CredentialJson`, `NotifyEntry`, `WhoUser`, etc.) plus mirrors in `channelTopic.ts` and `memberTypes.ts`, each pinned to its generated twin via compile-time `Equal<>` asserts in `wireTypesAssert.ts`. On top of that, the naming convention changes mid-pipe for *some* shapes only: `queryWindows.ts` renames `network_id → networkId` at the store boundary while `ScrollbackMessage` keeps snake_case all the way into components.
**Impact:** The codegen investment yields a parallel type system plus a third bridging file rather than a single source of truth: adding one wire field = edit wire.ex → regen → edit the api.ts mirror → possibly the assert. Drift is *caught* (compile error), not *prevented*, and the mixed snake/camel store shapes mean readers can't predict a field name without checking which side of the rename a shape sits on.
**Recommendation:** Make generated types the canonical import: re-export them from api.ts under the friendly aliases (`export type ScrollbackMessage = ScrollbackWireT`) and delete the mirrors + asserts where the shape is a pure mirror, keeping hand-written types only for genuinely cic-enriched unions. Pick one casing rule for stores (either rename at every narrow step or never) and migrate all instances per the "total consistency" rule.

### A4. Scrollback `meta` contract is documentation-only and evaporates at the wire
**Concern:** Abstraction boundaries
**Scope:** `lib/grappa/scrollback/meta.ex` (per-kind shapes live in the moduledoc; `t()` is an open map), `cicchetto/src/lib/wireTypes.ts:26` (`ScrollbackMetaT = Record<string, unknown>`), `cicchetto/src/lib/wireNarrow.ts:104-116`, `cicchetto/src/ScrollbackPane.tsx:386-387,613-614,660,668-669,700,716-717`, `cicchetto/src/lib/members.ts:70-90`
**Severity:** HIGH
**Problem:** Server-side, `Meta` is a carefully engineered custom Ecto.Type with a closed key allowlist and documented per-kind shapes (`:kick → %{target: ...}`, `:mode → %{modes:, args:}`, `:notice → %{numeric:, severity:}` …) — but the *type* is an open map, so codegen collapses it to `Record<string, unknown>` and the narrower checks only "is an object." Every client consumer then re-derives the per-kind contract with ad-hoc `typeof` probes: six sites in `ScrollbackPane.tsx` (`typeof msg.meta.new_nick === "string" ? … : "?"`, `msg.meta as RawEvent`, …) plus `members.ts` reading `meta.modes`/`meta.args` to drive mode application. The richest structured payload in the system crosses the boundary untyped.
**Impact:** The kind↔meta pairing is enforced nowhere the client can see: a server rename of a meta key compiles clean on both sides and renders `"?"` at runtime. New meta fields ship with zero type pressure to consume them correctly; the `as RawEvent` cast is exactly the "narrower is a lie" pattern `wireNarrow.ts` was built to kill.
**Recommendation:** Model meta per-kind in the type system: a `Message.kind`-discriminated union of meta shapes in a Wire typespec (the allowlist in `Meta` already enumerates the closed set — derive from it), so codegen emits per-kind meta types and the message narrower can pair kind with meta. Client `typeof` probes then collapse into the narrow step.

### A5. `Visitors.Visitor` placement forces a dirty-xref epidemic — 12 boundaries opt out of checking
**Concern:** Abstraction boundaries
**Scope:** `dirty_xrefs: [Grappa.Visitors.Visitor]` in `lib/grappa/{accounts,channel_directory,notify,networks,push,subject,read_cursor,scrollback,query_windows,user_settings,themes,vhosts}.ex`
**Severity:** MEDIUM
**Problem:** The subject model is a `user | visitor` XOR, and every subject-scoped schema needs a `belongs_to :visitor` — but the `Visitor` schema lives inside `Grappa.Visitors`, a high-level orchestration context that deps `Networks` (which deps `Session`…), so a real dep edge from any storage context would close a cycle. The escape hatch, applied 12 times, is `dirty_xrefs` — the boundary exists on paper but is unchecked for precisely the most-referenced schema in the system. Contrast `Accounts.User`: `Accounts` is a low-level leaf, so the symmetric `belongs_to :user` needs no exemption anywhere.
**Impact:** Every new subject-scoped context ships another copy-pasted dirty_xref + rationale comment (the pattern is now the path of least resistance — Notify, the newest context, dutifully copied it). Boundary can no longer tell a legitimate struct ref from a smuggled `Grappa.Visitors.*` function call in those 12 modules; the asymmetry between the two halves of the subject union is structural noise in every boundary declaration.
**Recommendation:** Split identity from orchestration: move the `Visitor` schema (and the identity-only reads) into a leaf boundary — either into `Grappa.Subject`'s neighborhood or a `Grappa.Identity`-style context mirroring Accounts' position — leaving `Grappa.Visitors` as the lifecycle/login orchestrator that deps it. 12 dirty_xrefs collapse to zero, and Visitor gains the same checked status User has.

### A6. The `Networks → Session` dependency direction breeds a constellation of one-off inversion mechanisms
**Concern:** Abstraction boundaries
**Scope:** `lib/grappa/session.ex` (`start_opts` — 7 optional injected closures: `visitor_committer`, `visitor_password_rotator`, `visitor_nick_persister`, `credential_failer`, `credential_committer`, `last_joined_persister`, `refresh_plan`), `lib/grappa/session/server.ex:309` (`refresh_plan_check :: (-> {:ok, map()} | ...)` — untyped plan), `lib/grappa/push/badge_source.ex`, `lib/grappa/window_counts/push_source.ex` (runtime `Application.get_env` behaviour seams), `lib/grappa/spawn_orchestrator.ex`, `lib/grappa/networks.ex` (deps `Session`)
**Severity:** HIGH
**Problem:** Because `Networks` (and transitively `ReadCursor`, `Visitors`, `BadgeCount`) sits *above* `Session`, every time the session process needs a verb or a read from that upper layer a new bespoke inversion is minted. Three distinct mechanism families now coexist: (1) seven optional callback closures threaded through `start_opts` (one of which returns a bare `map()` where `start_opts` belongs — the plan type is lost at its own seam); (2) two behaviour-plus-runtime-`Application.get_env` seams (`BadgeSource`, `PushSource`) that each carry a documented carve-out from the project's own "runtime env banned" rule plus a hot-deploy-window nil path; (3) a top-level glue boundary (`SpawnOrchestrator`) for the admission dance. Each is individually well-reasoned and superbly documented — but the *third* new session-needs-upstream-data feature will mint mechanism number three-plus-one, because none of them generalizes.
**Impact:** The cost curve is linear in features: #267 alone added a whole behaviour module, a config key, a ctx map (which re-duplicates `subject_label`, see A1), and a hot-reload degradation mode — to deliver one push. Testing requires config overrides instead of ordinary Mox on a dep. The untyped `refresh_plan` closure means plan-shape drift between `SessionPlan.resolve/1` and `Server.init/1` is invisible to Dialyzer.
**Recommendation:** Attack the root edge rather than adding seams: the things `Networks` needs from `Session` (`stop_session`, `current_nick`, `whereis`) are a small session-*control* surface. Extract it (registry lookup + GenServer calls) into a leaf boundary below both, so `Networks` no longer deps the full `Session` — then `Session → ReadCursor`/`BadgeCount` become ordinary checked deps and both runtime-config seams and most injected closures can be retired. At minimum: type the closures (`refresh_plan_check :: (-> {:ok, Session.start_opts()} | ...)`), and declare a rule for which mechanism new inversions must use.

### A7. Error contract is a hand-maintained atom dictionary with no producer-side types — and it has already drifted
**Concern:** Abstraction boundaries
**Scope:** `lib/grappa_web/controllers/fallback_controller.ex` (spec at lines 38-88 vs clauses: `:body_too_large`, `:too_many_attempts`, `:list_full`, `:timeout`, `:resolve_failed`, `{:start_failed, _}` all have clauses but are absent from the spec union), `lib/grappa_web/channels/grappa_channel.ex` (inline `%{error: "save_failed"}`, `"open_failed"`, `"user_not_found"` reply envelopes), `lib/grappa/admission.ex` (the only context exporting an `error()` type)
**Severity:** MEDIUM
**Problem:** Structurally, each context mints bare error atoms with no exported `@type error`, so FallbackController's 45-atom spec union is transcribed by hand and has measurably drifted (≥6 clauses missing from it). The moduledoc's own invariant — "the wire string is the snake_case stringification of the atom, falls out automatically" — is no longer true either (`:no_session→"not_found"`, `:timeout→"session_timeout"`, `:ip_cap_exceeded→"too_many_sessions"`, `:resolve_failed→"session_plan_resolve_failed"`, `:captcha_provider_unavailable→"service_degraded"`): the atom→token mapping is now a second hand-maintained table hidden inside clause bodies. Meanwhile the WS surface has a *parallel* error vocabulary: GrappaChannel arms hand-build `%{error: "..."}` replies per verb with tokens that exist nowhere server-side but in string literals, and none of the tokens (REST or WS) participate in wire codegen — cic string-matches them blind.
**Impact:** A new context error atom reaching FallbackController without a clause is a 500 (by design), but the spec no longer tells anyone which atoms are handled; Dialyzer's value on this module is spent. Client copy branches on tokens that can be renamed server-side with zero compile pressure on either side. Two envelope registries (REST + WS) will keep diverging.
**Recommendation:** (1) Every error-producing context exports `@type error`, and FallbackController's spec becomes a composition of those types (Admission already models this). (2) Lift the atom→(status, token) mapping into a declarative list so a single test asserts spec/clauses/tokens agree — and feed the token set into gen_wire_types so cic gets a literal union of error strings. (3) Give the channel a small shared error-reply helper drawing from the same registry instead of per-arm inline maps.

### A8. UserSettings exposes storage-shaped get/set — watchlist domain verbs live in the web layer
**Concern:** Abstraction boundaries
**Scope:** `lib/grappa/user_settings.ex` (`get_highlight_patterns/1`, `set_highlight_patterns/2` — whole-list read/write only), `lib/grappa_web/channels/grappa_channel.ex:996-1022` (`watchlist_add/3`, `watchlist_del/3`)
**Severity:** LOW
**Problem:** The context offers only whole-list get/set, so the channel implements the domain verbs itself: read list → dedupe/membership check → write list, including the `:not_found` business rule. That's read-modify-write logic (racy across two concurrent sockets for the same subject) living in a transport handler, and any second door (REST, future listener) must re-implement it.
**Impact:** Contexts-thick/controllers-thin violated; the idempotent-add and not-found semantics are encoded once per door instead of once per domain.
**Recommendation:** `UserSettings.add_highlight_pattern/2` and `remove_highlight_pattern/2` (atomic within the context), channel arms shrink to dispatch + reply mapping.

### A9. Domain-event broadcast responsibility split between contexts and web layer, inconsistently
**Concern:** Abstraction boundaries
**Scope:** context-owned broadcasts: `lib/grappa/notify.ex`, `lib/grappa/query_windows.ex`, `lib/grappa/networks.ex` (`broadcast_state_change`); web-owned broadcasts of the same pattern: `lib/grappa_web/controllers/read_cursor_controller.ex:189-206`, `lib/grappa_web/controllers/channels_controller.ex:265-281` (`archive_changed`), `lib/grappa_web/controllers/archive_controller.ex:194-219` (`archive_purged`), `lib/grappa_web/channels/grappa_channel.ex:930-947` (`archive_changed` again, on close_query_window)
**Severity:** MEDIUM
**Problem:** The same pattern — mutate subject-scoped state, then push a typed event on the subject's user topic — has two owners depending on which module got there first. When the context owns it, callers must thread `subject_label` (A1); when the web layer owns it, each entry point re-implements the subject-label + topic + payload assembly, and multi-door verbs duplicate it: `archive_changed` is emitted from *two different web modules* because "close a query window" and "PART a channel" both change archive shape but no context owns the archive-changed event. The "one feature, one code path, every door" rule breaks precisely at the broadcast step.
**Impact:** A future door (Phase 6 IRCv3 listener, a mix task, an admin action) that mutates the same state will silently not broadcast unless someone remembers the controller-side copy. Drift between the two `archive_changed` emitters is already only convention-deep.
**Recommendation:** Broadcast-with-the-mutation as the single rule: the context verb that commits the change emits the event (QueryWindows/Notify model), with label resolution centralized per A1 so contexts don't need a string parameter to do it. Controller-side broadcasts move into the context verbs they trail.

### A10. `Grappa.Subject.from_assigns/1` — a core context encodes web-plug knowledge, duplicating `GrappaWeb.Subject.to_session/1`
**Concern:** Abstraction boundaries
**Scope:** `lib/grappa/subject.ex:87-90`, `lib/grappa_web/subject.ex:30-32`
**Severity:** LOW
**Problem:** The non-web `Grappa.Subject` boundary contains a function that pattern-matches `%{current_subject: {:user, %User{}}}` — i.e., it knows the assign key set by `GrappaWeb.Plugs.Authn` and the web-layer rich-tuple shape, and it duplicates the exact conversion `GrappaWeb.Subject.to_session/1` already owns. The rich→bare conversion now has two owners on opposite sides of the web boundary.
**Impact:** Direction-of-knowledge inversion (domain → transport); if the assign shape or key changes, one of the twins silently returns `nil` (this one's fallback arm) while the other raises — divergent failure modes for the same drift.
**Recommendation:** Delete `from_assigns/1` from the core context; callers go through `GrappaWeb.Subject.to_session(conn.assigns.current_subject)` (or move a `from_assigns` helper into `GrappaWeb.Subject`, next to the knowledge it uses).

### A11. Client re-implements IRC interpretation: a MODE-string parser and three coexisting case-fold policies
**Concern:** Abstraction boundaries
**Scope:** `cicchetto/src/lib/modeApply.ts:20-77` (full MODE parser, hard-coded `(ohv)@%+` table, "mirrors `Grappa.Session.EventRouter.apply_mode_string/4`"), `cicchetto/src/lib/nickEquals.ts` (plain `.toLowerCase()`), `cicchetto/src/lib/notifyWatch.ts:49-50` (`rfc1459Fold`), `cicchetto/src/lib/channelKey.ts:39-47` (sigil-gated fold); bypasses: `cicchetto/src/lib/selection.ts:204-205,222-223,275-276,737-738`, `cicchetto/src/lib/queryWindows.ts:79-81,109-111`, `cicchetto/src/lib/compose.ts:1054,1061`, `cicchetto/src/Shell.tsx:486-487`, `cicchetto/src/PeerAwayBanner.tsx:26`
**Severity:** MEDIUM
**Problem:** Two erosions of the "one IRC parser, on the server" / "every nick compare routes through the canonical fold" invariants. (1) The server already parses MODE in `EventRouter.apply_mode_string/4`, yet ships the *raw* mode string + args in the event, so the client maintains a second MODE parser with a hard-coded PREFIX table (ISUPPORT-negotiated prefixes deliberately ignored) to update its members store — a parallel state machine the invariant forbids in spirit, kept aligned only by a "mirrors" comment. (2) Nick/channel folding exists in three client policies (plain lowercase in `nickEquals`, true rfc1459 in `notifyWatch`, sigil-gated in `channelKey`) while `nickEquals`' own header claims all comparisons route through it — and grep shows ~10 non-test sites doing inline `.toLowerCase()` comparisons instead. Server-side #121 made rfc1459 the single fold; the client's dominant helper still folds ASCII-only, so `nick[a]` vs `nick{a}` compares differently on the two sides of the wire.
**Impact:** A network advertising non-`(ohv)` prefixes renders wrong member sigils with no server-side fix possible; the fold divergence silently forks DM/query-window identity client-side for `[]\~` nicks — the exact identity-forking class #121 closed on the server.
**Recommendation:** (1) Have the server broadcast the *result* of mode application (typed member-delta event: nick, added/removed modes) — it already computes it — and delete `modeApply.ts`'s parser (keep sigil display only). (2) Collapse client folding to one exported fold implementing rfc1459 (the `notifyWatch` one), make `nickEquals` delegate to it, and sweep the inline `.toLowerCase()` comparison sites per "total consistency or nothing."

### A12. Session facade's public specs name internal, non-exported types; `Server` exported "for tests only"
**Concern:** Abstraction boundaries
**Scope:** `lib/grappa/session.ex:843-846,861-864` (`get_topic`/`get_channel_modes` return `Grappa.Session.EventRouter.topic_entry()` / `channel_mode_entry()`; `EventRouter` is not in `exports: [Backoff, Server, Wire]`), `lib/grappa/session.ex:47-50` (Server export rationale), `lib/grappa/session/server.ex:309` (`refresh_plan_check` returns `{:ok, map()}`)
**Severity:** LOW
**Problem:** The facade's public contract is typed against internals of a 3,286-line private router module, so callers (GrappaChannel, Wire) structurally depend on EventRouter's cache-entry shapes even though Boundary shows no edge (type refs aren't call-gated). Meanwhile `Server` — the 4,699-line GenServer — sits in the export list for a test convenience, advertising the whole internal surface as fair game; and one injected closure type erases `start_opts` to `map()`.
**Impact:** EventRouter refactors ripple into the public API unannounced; the Server export invites future callers to bypass the facade (today only comments reference it, but the door is open).
**Recommendation:** Re-home `topic_entry`/`channel_mode_entry` as `Grappa.Session` (or `Session.Wire`) public types that EventRouter implements; drop `Server` from exports and give the test its seam via a `@doc false` facade function; type `refresh_plan_check` against `start_opts()`.

---

**Verified clean (one line each):**
- `Grappa.PubSub.broadcast_event/2` enforces the no-struct-payload wire invariant at the boundary with a guard + telemetry on failed fan-out — the CP15 crash class is structurally closed.
- Web layer contains zero direct `Repo` calls; JSON views (`me_json.ex` et al.) delegate rendering to context-owned Wire modules.
- `Grappa.LiveIntrospection` returns a typed `SessionEntry` struct with honest per-field degradation (`introspection_degraded`), never computed-from-DB fakes.
- Boundary is a real compiler gate (`compilers: [:boundary]`, `check in/out`, warnings-as-errors first in `ci.check`) — dirty_xrefs aside (A5), declared edges are enforced.
- `Grappa.SpawnOrchestrator` is a well-judged shared-verb boundary with a typed `spawn_outcome`; the documented refusal to absorb `Visitors.Login` is sound domain-boundary reasoning.
- `Scrollback` is a model context: single wire-shape contract across doors, single-sourced sigil classifier (`target_kind/1`), shared read/write predicate (`channel_or_dm_where/3`), typed closed error set.
- Client `windowState` store mirrors server transitions only — the one pre-CP17 optimistic path was removed; no component originates join/fail/kick state.
- WS payloads are runtime-narrowed per kind (`wireNarrow.ts`/`userTopic.ts`) before dispatch — no blind casts at the socket edge (except `meta`, covered in A4).

---

## Architecture review 2026-07-20 — Responsibility & cohesion agent

**Severity count: 0 CRITICAL / 3 HIGH / 7 MEDIUM / 1 LOW**

Context for the caller: this codebase has a documented history of deliberate god-module splits (DESIGN_NOTES 2026-04-27: A2 Networks, A3 IRC.Client→AuthFSM, A4 cic networks.ts, E1 Server→EventRouter). The findings below are about what has re-accreted since, and about splits that were explicitly deferred and never landed.

---

### A1. `Session.Server` is a god GenServer again — 4,699 lines, 60-key state, ~15 distinguishable jobs
**Concern:** Responsibility & cohesion
**Scope:** `lib/grappa/session/server.ex`
**Severity:** HIGH
**Problem:** Despite eleven extracted collaborators (`AwayState`, `EventRouter`, `NumericRouter`, `WindowState`, `ISupport`, `Presence`, `GhostRecovery`, `ModeChunker`, `NSInterceptor`, `PartCleanup`, `Wire` — all small and clean), the orchestrator itself holds: session lifecycle + backoff + terminal-failure classification (`sasl_terminal?` sniffs upstream error text), ~45 outbound-verb `handle_call` clauses, the away state machine driver, ghost-recovery driver, NickServ secret capture / `SET PASSWD` commit, the whole channel-directory LIST refresh feature (call handler + 3 info handlers + 8 helpers), /notify presence arming and sync, push dispatch, mentions-bundle aggregation, a 40-clause / ~720-line effect interpreter, plus label/whois/who/names pending-map TTL sweeping. The state type declaration alone runs 265 lines with 60 keys. The GenServer also reaches directly into eight-plus contexts (`Scrollback`, `ChannelDirectory`, `Mentions`, `UserSettings`, `WindowCounts`, `SessionLog`, `Push.Triggers`, `Log`), making it the coupling hub of the whole server.
**Impact:** Every feature touching a live session lands here — the file grows ~monotonically (Phase-1 moduledoc still describes a "walking skeleton"). Any regression risks the hot IRC connection; reviewers cannot hold the module; the 60-key state means most handlers see 55 keys they must not touch. HOT-deploy constraints on the struct shape (noted in comments) make later restructuring progressively more expensive.
**Recommendation:** Don't split the process — split the module. Three mechanical, process-preserving extractions, in value order: (1) **DirectoryRefresh** — the LIST feature is fully self-contained (`refresh_directory` call, 3 timers/infos, `handle_directory_numeric/3` + 7 helpers, one state key); (2) **Broadcaster/Projector** for `apply_effects/2` (see A3); (3) **Outbound verb table** for the ~30 fire-and-forget `handle_call` clauses that are pure `Client.send_X` + label bookkeeping (see A6). After that, declare a freeze: new session features start life as a collaborator module, not new Server clauses.

---

### A2. `EventRouter` — pure, but five concerns share one 3,286-line module
**Concern:** Responsibility & cohesion
**Scope:** `lib/grappa/session/event_router.ex`
**Severity:** MEDIUM
**Problem:** The pure `route/2 → effects` contract is excellent, but inside one module live: (a) per-command routing clauses (~70 `do_route` heads), (b) members-map algebra (`walk_modes`, `rename_member_everywhere`, mode-prefix toggling — ~300 lines of pure data-structure math), (c) persist-attrs construction (`build_persist`, `put_sender_prefix`), (d) upstream-text heuristics (ChanServ bracket regex classification, WHOIS "is connecting from" regex parsing at lines 3052/3086, services-notice routing), (e) channel-param canonicalisation. These are different abstraction levels: protocol routing vs. roster algebra vs. free-text scraping.
**Impact:** The module grows with every new numeric/verb (it has roughly doubled since the E1 extraction); the members-map math is only testable through routing tests; the text heuristics — the most fragile, most churn-prone code — hide among mechanical clauses.
**Recommendation:** Keep the router as the single dispatch surface, but extract the roster algebra into a `Session.Members` pure module (it operates on one state key and has zero routing knowledge) and the ChanServ/WHOIS text heuristics into a classifier module (the `AuthFSM` "pure classifier" template DESIGN_NOTES already names). Cheap, high-testability wins; don't split the `do_route` clauses themselves.

---

### A3. Persist+broadcast logic duplicated between inbound and outbound paths — the A20 extraction deferred since 2026-04-27 and now measurably drifting
**Concern:** Responsibility & cohesion
**Scope:** `lib/grappa/session/server.ex` (`apply_effects` `:persist` clause ~line 3813; `persist_and_send_fragments` ~line 2624)
**Severity:** HIGH
**Problem:** DESIGN_NOTES 2026-04-27 records the `Grappa.Session.Broadcaster` extraction as "open as a Phase 5 consolidation candidate." It never landed, and the two sites have since diverged: the inbound `:persist` clause does persist → PubSub broadcast → `maybe_dispatch_push` → `WindowCounts.PushSource.push` (#267, "fires for EVERY kind"); the outbound fragment loop does persist → broadcast → `Client.send_privmsg` with **no** WindowCounts push. Both hand-build `Scrollback` attrs maps inline (the outbound one mirrors `EventRouter.put_sender_prefix` "for the inbound side" by its own comment).
**Impact:** Exactly the drift the deferral risked: a new post-persist obligation (like #267's window-counts push) gets added to one path and silently skipped on the other; whether the skip is intentional is undocumented and unreviewable. Each future obligation (read-state settle, telemetry, mentions) doubles the divergence surface.
**Recommendation:** Land the deferred extraction: one `Session.Persistor`/`Broadcaster` module owning attrs-shape + persist + broadcast + post-persist hooks, with an options flag for the outbound-specific differences (returns the `Message.t()`, sends the wire line, skips self-push). This is the single highest-leverage split in the file because it removes a live correctness-drift channel, not just lines.

---

### A4. 005 ISUPPORT and LIST numeric parsing scattered into Server, bypassing the modules built for it
**Concern:** Responsibility & cohesion
**Scope:** `lib/grappa/session/server.ex` (`extract_modes_isupport`/`parse_modes_token` ~4417, `extract_linelen_isupport` ~4438, `parse_list_entry`/`parse_user_count` ~4211), vs `lib/grappa/session/isupport.ex`, `lib/grappa/session/event_router.ex`, `lib/grappa/session/numeric_router.ex`
**Severity:** MEDIUM
**Problem:** `Grappa.Session.ISupport` (327 lines) exists as the 005-token parser (CHANMODES/PREFIX), yet `MODES=` and `LINELEN=` token scanning lives as private Server helpers — 005 parsing has two homes. Likewise 321/322/323 RPL_LIST param parsing sits in the GenServer while `NumericRouter`+`EventRouter` exist precisely to keep numeric interpretation out of Server.
**Impact:** The next 005 token (and there will be one — three landed already: MODES, LINELEN, CHANMODES/PREFIX) has two candidate homes; whichever the author greps first wins, and per CLAUDE.md's own warning, "Claude copies whichever is closer." Protocol edge cases in Server escape the parser-focused test suites.
**Recommendation:** Move `MODES=`/`LINELEN=` scanning into `ISupport` (it already returns a struct; add the two fields or a companion `scan/2`), and move `parse_list_entry`/`parse_user_count` into the directory extraction of A1 (or EventRouter as `{:directory_row, …}` effects). Mechanical, low-risk.

---

### A5. `archive_changed` signalling has no owning context — four independent re-implementations
**Concern:** Responsibility & cohesion
**Scope:** `lib/grappa/session/server.ex` (`broadcast_archive_changed`), `lib/grappa_web/channels/grappa_channel.ex` (~937, inlined in `close_query_window`), `lib/grappa_web/controllers/channels_controller.ex` (private `broadcast_archive_changed/2`), `lib/grappa_web/controllers/archive_controller.ex`
**Severity:** MEDIUM
**Problem:** The domain event "the archive set changed" is broadcast from four sites — one in the session GenServer, one inlined in a channel handler (with its own network-slug lookup and defensive nil-branch), two as per-controller private helpers explicitly commented as "mirror of" each other. The event's payload comes from `Scrollback.Wire`, but no context owns the *decision* to emit it. This is the "one feature, one code path, every door" rule violated at the broadcast layer: `QueryWindows.close/4` broadcasts its own `query_windows_list` but the archive side-effect is bolted on at one door only.
**Impact:** Any new door that archives scrollback (a future REST query-window close, an admin purge, Phase 6 listener PART) will silently miss the broadcast — the class of bug the divergent `join_failed` comment at server.ex:3635 already documents having to reason about case-by-case.
**Recommendation:** Give the emission a single home — either `Scrollback` (it owns the archive projection) exposing `broadcast_archive_changed(subject_label, slug)` called by all four sites, or fold it into the operations that make windows archive-eligible (`QueryWindows.close`, channel delete, kick/part effects). Delete the two controller mirrors and the channel inline.

---

### A6. The outbound verb pipeline is 5 layers of mechanical repetition — ~10 file touches per new IRC verb
**Concern:** Responsibility & cohesion
**Scope:** `cicchetto/src/lib/slashCommands.ts` → `compose.ts` → `socket.ts` → `lib/grappa_web/channels/grappa_channel.ex` → `lib/grappa/session.ex` (1,392 lines, ~60 delegating functions) → `lib/grappa/session/server.ex` → `lib/grappa/irc/client.ex` (~35 `send_X` one-line formatters)
**Severity:** MEDIUM
**Problem:** A simple fire-and-forget verb (`/lusers`, `/motd`, `/who`, `/names`, …) exists as: a parse arm, a compose dispatch arm, a `pushX` wrapper, a `handle_in` clause, a facade function with full moduledoc, a `handle_call` clause, and a `Client.send_X` formatter — seven near-identical stanzas whose only degrees of freedom are the verb name, arg validation spec, and wire template. The middle three Elixir layers (facade → GenServer clause → Client helper) are pure plumbing for most verbs.
**Impact:** Shotgun surgery on every addition (the codebase adds verbs constantly — 8 landed in CP22/CP24 alone); reviewers see 300-line diffs that contain ~20 lines of substance; the repetition invites copy-drift in validation (the last review's S-findings on guard-vs-body nick folding at three sites are exactly this).
**Recommendation:** Honest cost/benefit: a full data-driven verb table would fight the genuinely bespoke verbs (privmsg, join, away) and isn't worth it. But the *simple-verb subset* (~20 verbs: single upstream line, optional label, no state change) could collapse to one table consumed by a generic `handle_call({:verb, name, args})` + one `Client.send_verb/3` — cutting three layers to one for the common case while bespoke verbs keep dedicated clauses. If that's judged too invasive, the fallback recommendation is: stop treating the seven-stanza pattern as mandatory for read-only verbs and at minimum collapse the `Client.send_X` formatters into a verb→template map.

---

### A7. cic `compose.ts` is a mis-named god-dispatcher — "compose state" module owns the 49-arm command executor
**Concern:** Responsibility & cohesion
**Scope:** `cicchetto/src/lib/compose.ts` (1,108 lines), vs `slashCommands.ts` (parse only)
**Severity:** HIGH
**Problem:** The module's own header says it owns draft/history/tab-complete per channel — ~200 lines of that exist. The other ~900 lines are `submit()`'s 49-case switch executing every slash command: opening query windows, mutating selection, opening five different modals, awaiting WS topic joins, closing windows, quitting all networks, calling 20+ `socket.ts` push functions and REST helpers. It imports ~40 modules — the widest fan-out in `src/lib`. This is precisely the shape the A4/D3 split removed from `networks.ts` in April, regrown under a different name.
**Impact:** Every new slash command edits the compose-state module; command-execution logic (cross-network safety in `/query`, subscribe-before-send in `/msg`, services routing) is only reachable through compose tests (`compose.test.ts` is already 2,003 lines); the name actively misleads — someone looking for "where does /ban execute" will not open `compose.ts` first.
**Recommendation:** Extract the switch into `lib/commandDispatch.ts` (`executeCommand(cmd: ParsedSlash, ctx) → Result`), leaving compose.ts with drafts/history/tab-complete and a one-line call. The parser already produces a typed command union, so the seam is clean; tests split along the same line. This is the highest-value client-side split available.

---

### A8. cic `api.ts` is a 2,968-line grab-bag hub: HTTP client + hand-written wire unions + domain helpers, alongside a *generated* wire-types module
**Concern:** Responsibility & cohesion
**Scope:** `cicchetto/src/lib/api.ts`, vs `src/lib/wireTypes.ts` (generated by `mix grappa.gen_wire_types`), `wireNarrow.ts`
**Severity:** MEDIUM
**Problem:** One module holds: REST fetch functions (~76), the hand-maintained `WireChannelEvent`/`WireUserEvent`/`WireAdminEvent` discriminated unions (~800 lines of types with embedded design commentary), domain identity helpers (`displayNick`, `ownNickForNetwork`, `visitorAnchorNick`, `tagNetwork`), error classes, and the admin API client. Meanwhile the repo already has a generated single-source-of-truth for wire shapes (`wireTypes.ts`, "Source: lib/grappa/**/wire.ex") that api.ts only partially consumes — the big event unions remain hand-written and can drift from the server Wire modules the generator reads.
**Impact:** Nearly every module imports api.ts (maximum blast radius for merge conflicts and accidental cycles — the compose/userTopic import lists show it); two competing homes for wire truth undermine the point of the generator; domain helpers stranded in an "api" module get re-found by grep luck.
**Recommendation:** Three moves, no behavior change: (1) event unions → `wireEvents.ts` (or extend the generator to emit them — it already knows the Wire modules); (2) identity/nick helpers → `networks.ts`/an `identity.ts` store module; (3) admin client + admin types → `adminApi.ts`. Leave REST plumbing and error classes as the residual api.ts.

---

### A9. `ScrollbackPane.tsx` — 2,779-line component mixing pure formatting with a 15-effect scroll/read-marker state machine
**Concern:** Responsibility & cohesion
**Scope:** `cicchetto/src/ScrollbackPane.tsx` (test file: 3,691 lines)
**Severity:** MEDIUM
**Problem:** The component contains ~600 lines of pure, stateless formatting (`renderBody`, `renderRawEvent`, CTCP-action stripping, userhost suffixes, date labels, member-tier sorting) interleaved with the row-model memo, a scroll-position state machine (~15 `createEffect`s, underfill-rescue and gate-lock geometry policies), read-marker freeze/activation policy, auto-focus-on-join policy, and context-menu state. Component-local scroll state is legitimate per the architecture (server owns domain state), but the pure formatting layer and the geometry policy functions have no reason to live inside the component closure.
**Impact:** The 3.7k-line test file must mount the whole component to exercise a body formatter; effects reading a dozen signals each are the classic breeding ground for the reactivity collisions Shell.tsx's BUGHUNT-3 comment documents; the file is the largest non-test unit in the client.
**Recommendation:** Extract the stateless renderers into `lib/messageRender.tsx` and the geometry predicates (`shouldRescueUnderfillLoadOlder`, `shouldLockScrollGate` — already exported for tests, i.e. already half-escaped) into `lib/scrollGeometry.ts`. Leave the effect machine in place — untangling live scroll effects is high-risk/low-reward. "Stop adding to it" applies: new render kinds go in the lib module.

---

### A10. Subject-label ↔ subject-tuple mapping has no single web-layer owner
**Concern:** Responsibility & cohesion
**Scope:** `lib/grappa_web/channels/grappa_channel.ex` (`resolve_subject/1`, 17 call sites), `lib/grappa_web/channels/user_socket.ex`, `lib/grappa_web/controllers/{notify,archive,channels,read_cursor}_controller.ex`, `lib/grappa_web/controllers/admin/vhosts_controller.ex`
**Severity:** MEDIUM
**Problem:** The `"visitor:" <> id` label convention (assigned by `UserSocket`, consumed by `Topic.user/1`) is parsed/rendered by locally-defined helpers in at least six web modules — `GrappaChannel.resolve_subject/1`, per-controller `subject_label` builders, `UserSocket.id_for_user_name`. `Grappa.Subject` exists as a domain module but does not own the label codec. The 2026-07-19 review flagged the same spread (its S-finding lists 7 files); it has not been consolidated.
**Impact:** A change to the label scheme (e.g. a third subject kind — the codebase already generalized user→subject once) is an N-site edit with silent-miss failure mode: a missed site routes broadcasts to a topic nobody joins. Duplicated parsing also invites the guard-vs-fold inconsistencies previous reviews keep re-finding.
**Recommendation:** Add `Grappa.Subject.to_label/1` + `from_label/1` (or put it on `PubSub.Topic`, which already owns the topic grammar) and route all six modules through it. Small, closes a known recurring finding.

---

### A11. cic `socket.ts` — connection lifecycle and the 30-function verb-push RPC surface share one module
**Concern:** Responsibility & cohesion
**Scope:** `cicchetto/src/lib/socket.ts` (766 lines)
**Severity:** LOW
**Problem:** Socket construction/reconnect/offline-halt logic (the subtle, stateful part) cohabits with ~30 mechanical `pushX` wrappers (the flat, ever-growing part). Two audiences, one file.
**Impact:** Minor — churn on verb additions dirties the file containing reconnect logic; review noise.
**Recommendation:** When A6's verb-table work happens client-side, move the `pushX` family to `lib/wsVerbs.ts` importing the channel handle. Not worth doing on its own.

---

**Verified clean (one line each):**
- `lib/grappa/application.ex` — exemplary: every child ordered with a load-bearing why-comment, boot-time config boundary respected.
- `lib/grappa/session/numeric_router.ex` — pure, single-purpose routing classifier with an explicit purity contract.
- Session collaborator modules (`away_state`, `window_state`, `isupport`, `presence`, `ghost_recovery`, `mode_chunker`, `ns_interceptor`, `part_cleanup`) — all small (100–330 lines), each one job.
- Contexts `Scrollback`, `Visitors`, `Networks`/`Credentials`, `Operator` (deliberate cross-context orchestrator, documented), `QueryWindows` — cohesive public surfaces owning their own broadcasts.
- Per-context `*.Wire` modules incl. the large `AdminEvents.Wire` — single-purpose constructor catalogs; the wire-conversion invariant is uniformly honored.
- `lib/grappa/irc/` (`parser`, `auth_fsm`, `identifier`, `line_split`, `ctcp`) — the parser stays the single framing authority; `IRC.Client` is a focused transport GenServer post-A3.
- `GrappaWeb.FallbackController` (59 clauses) — big but exactly its one job.
- cic `Shell.tsx` — UI-only state, domain state correctly consumed from `lib/*` stores; `windowState.ts`, `selection.ts`, `networks.ts` (post-A4 split), `subscribe.ts`, `userTopic.ts` — focused stores/dispatchers with `assertNever`-closed unions; cic originates no window state, honoring the server-owned-state invariant.

---

## Architecture review 2026-07-20 — Duplication agent

**Severity count: 0 CRITICAL, 4 HIGH (A1, A3, A4, A6), 4 MEDIUM (A2, A5, A7, A8), 2 LOW (A9, A10).**

---

### A1. Client-side nick case-folding: three concurrent policies, self-contradicting SSOT claims
**Concern:** Duplication
**Scope:** `cicchetto/src/lib/nickEquals.ts`, `cicchetto/src/lib/notifyWatch.ts` (`rfc1459Fold`), bare `.toLowerCase()` nick-compare sites in `cicchetto/src/lib/queryWindows.ts` (79-111), `cicchetto/src/lib/selection.ts` (204-738, 5 sites), `cicchetto/src/lib/peerAway.ts` (34, 42), `cicchetto/src/PeerAwayBanner.tsx:26`, `cicchetto/src/Shell.tsx:486-487`, `cicchetto/src/lib/pushTriggers.ts:68`; server counterpart `lib/grappa/irc/identifier.ex` (`canonical_nick/1`)
**Severity:** HIGH
**Problem:** The client has THREE nick-fold policies at once: (1) `nickEquals.ts` `normalizeNick` = bare ASCII `.toLowerCase()`, whose header comment declares itself the single source and *argues against* the rfc1459 fold; (2) `notifyWatch.ts` `rfc1459Fold` = the correct server-matching fold (`[ ] \ ~` → `{ } | ^`), added for #247 presence keys; (3) ~12 bare `.toLowerCase()` comparison sites (query-window dedupe, selection restore, peer-away keys, DM push whitelist) that bypass both helpers. The server side, after GH #121, has exactly one fold (`canonical_nick/1` + `nick_fold/1` + `nick_fold_sql/1`, pinned byte-identical by `test/grappa/irc/identifier_test.exs:487`) — the client never got the equivalent consolidation, and `nickEquals.ts`'s rationale ("subscribe.ts already uses toLowerCase… going stricter would create a two-policy split") is now inverted: the two-policy split it warned about *exists*, created by `rfc1459Fold`.
**Impact:** For bracket nicks (`Foo[x]` vs `foo{x}` — same identity on bahamut, and the server dedupes query windows under the rfc1459 fold index), the client forks windows, misses selection-restore matches, and misses DM-whitelist matches while the server-side twin of the same logic matches. Every new nick comparison copies whichever of the three policies is nearest. Directly violates the CLAUDE.md #121 invariant's client mirror intent.
**Recommendation:** One fold module client-side: move `rfc1459Fold` to `nickEquals.ts` (or a `casemap.ts`), make `normalizeNick`/`nickEquals` delegate to it, migrate every bare `.toLowerCase()` nick-compare site (total migration per "Total consistency or nothing" — no exclusion list), rewrite the now-false rationale comment. Pin client fold to server fold with a shared fold-vector JSON fixture consumed by both vitest and ExUnit — the repo already established this exact mechanism for `shouldNotify` (`shouldNotifyTruthTable.json`).

### A2. Push-trigger parity fixture doesn't cover the branch where the ports actually diverge
**Concern:** Duplication
**Scope:** `cicchetto/src/lib/pushTriggers.ts`, `lib/grappa/push/triggers.ex`, `cicchetto/src/lib/shouldNotifyTruthTable.json`, `test/grappa/push/should_notify_parity_test.exs`
**Severity:** MEDIUM
**Problem:** The `shouldNotify` mirror is the repo's flagship pinned-copy: one shared truth table, two test suites. But the server folds the DM sender via `Identifier.canonical_nick` (rfc1459; whitelist canonicalized by `UserSettings.normalize_list`) while the client uses bare `sender.toLowerCase()` — and the truth table contains only plain-ASCII nicks (`alice`, `bob`), so the parity harness is green while the ports demonstrably disagree on `Foo[x]`. The pinning mechanism exists but its coverage stops exactly where the copies drift.
**Impact:** Desktop title-badge increments (client port) and OS pushes (server port) disagree for bracket-nick DM whitelists — the precise "badge and push never disagree" guarantee the fixture was built to hold. Worse, the green parity suite creates false confidence that the mirror is drift-proof.
**Recommendation:** Fix the client fold via A1, then add bracket-nick rows (`sender: "Foo[x]"`, whitelist `"foo{x}"`) to the truth table so the fixture would have caught this and will catch the next fold divergence. Rule of thumb worth encoding in the fixture's header: every place the Elixir port calls a canonicalizer, the table needs a row that fails under the naive fold.

### A3. `subject_label` derivation restated at ~9 sites with no owner
**Concern:** Duplication
**Scope:** `lib/grappa_web/controllers/read_cursor_controller.ex:184-185`, `lib/grappa_web/controllers/notify_controller.ex:162-166`, `lib/grappa/networks.ex:868-870` (`subject_label_of/1`), `lib/grappa_web/controllers/archive_controller.ex:219`, `lib/grappa_web/controllers/channels_controller.ex:281`, `lib/grappa_web/channels/user_socket.ex:185,255`, `lib/grappa/visitors.ex:544`, `lib/grappa/visitors/session_plan.ex:123`, `lib/grappa_web/controllers/test_read_cursor_controller.ex:99`; inverse parse in `lib/grappa_web/channels/grappa_channel.ex:1576` (`resolve_subject/1`)
**Severity:** HIGH
**Problem:** The subject→topic-root mapping (`{:user, u} → u.name`; `{:visitor, v} → "visitor:" <> v.id`) is the load-bearing key for the entire user-rooted PubSub topic scheme, WSPresence, and window-counts push — yet it exists only as scattered private helpers and inline concatenations, each carrying a comment saying "same shape UserSocket assigns" (comment-lockstep, no code sharing). The inverse (`"visitor:" <> id` → subject) is separately restated in `GrappaChannel.resolve_subject/1`. CLAUDE.md names `Grappa.PubSub.Topic` as the topic SSOT, but the label half of every topic is derived nine times outside it. Two sites even take different inputs for the same rule (`Credential` in networks.ex vs subject tuple in the controllers), guaranteeing the next caller writes a tenth copy.
**Impact:** A change to the label scheme (e.g. a third subject kind, or namespacing user names) requires a 10-site synchronized edit; missing one silently mis-routes broadcasts to a topic nobody subscribes — the failure mode is a quiet dead-drop, not a crash. Also blocks the Phase-6 listener, which will need the same derivation an eleventh time.
**Recommendation:** Add `Grappa.Subject.label/1` (and `Grappa.Subject.from_label/1` absorbing `resolve_subject/1`) — or put both on `Grappa.PubSub.Topic` since the label exists solely as a topic segment — and migrate all sites in one commit. The pattern-match pair is ~6 lines; the finding is ownership, not size.

### A4. Two parallel client type systems: codegen'd unions emitted but unused, hand unions unpinned at the membership level
**Concern:** Duplication
**Scope:** `cicchetto/src/lib/wireTypes.ts` (generated: `WireSessionEvent`, `AdminEventsWireEvent`, all `SessionWire*Payload` types), `cicchetto/src/lib/api.ts` (hand-rolled `WireUserEvent` ~line 924, `WireChannelEvent` ~line 630, `WireAdminEvent` ~line 1209), `cicchetto/src/lib/wireTypesAssert.ts`, `cicchetto/src/lib/wireNarrow.ts`, `cicchetto/src/lib/userTopic.ts`, `lib/mix/tasks/grappa/gen_wire_types.ex`
**Severity:** HIGH
**Problem:** The codegen pipeline (`mix grappa.gen_wire_types` + `--check` drift gate in `scripts/check.sh` + `wireTypesAssert.ts` structural asserts) is real and good — but it stalled half-adopted. The generated file emits complete discriminated unions (`WireSessionEvent`, 31 arms; `AdminEventsWireEvent`, 26 arms) that **no module imports**; the working unions are still the hand transcriptions in `api.ts`, and only ~15 of ~90 `api.ts` types are pinned by asserts. Union *membership* is pinned nowhere: a new server event kind lands in the codegen output automatically, but nothing — no assert, no tsc error — forces `WireUserEvent`/`WireChannelEvent` to grow an arm; the runtime narrowers then drop the unknown kind. On top of that, the same event payloads (`joined`, `kicked`, `members_seeded`, `isupport_changed`) are dual-declared in BOTH hand unions (api.ts's own comments call this "dual-declared"), so several wire shapes exist in three places in the client alone. CLAUDE.md: "Half-migrated creates two patterns — Claude copies whichever is closer."
**Impact:** New server events silently no-op client-side until someone hand-extends two unions plus a narrower; every wire change is a 3-file client edit where the codegen was built to make it zero; the unused generated unions actively mislead readers about what's authoritative.
**Recommendation:** Finish the migration: make `api.ts` payload types re-exports/aliases of the codegen types (deleting the pinned hand-rolls the asserts currently guard), and reduce `WireUserEvent`/`WireChannelEvent` to topic-membership compositions over codegen payloads (`SessionWireJoinedPayload | …`). Then add ONE membership assert: every `SessionWireWireEventKind` is claimed by at least one topic union (a `Record<SessionWireWireEventKind, "user" | "channel" | "both">` table fails tsc when the server adds a kind — same trick as `MESSAGE_KIND_PRESENCE` in wireNarrow.ts, already proven in-repo).

### A5. REST/admin wire shapes escape codegen by filename convention
**Concern:** Duplication
**Scope:** `lib/grappa/live_introspection/admin_wire.ex`, `lib/grappa_web/controllers/*_json.ex` (networks_json, channels_json, me_json, auth_json, messages_json, members_json, archive_json, user_settings_json), ~40 hand-rolled unpinned types in `cicchetto/src/lib/api.ts` (`AdminSession`, `AdminNetwork`, `AdminCredential`, `AdminVisitor`, `AdminVhost*`, `MeResponse`, `LoginResponse`, …)
**Severity:** MEDIUM
**Problem:** `gen_wire_types` globs `lib/grappa/**/wire.ex` only. `admin_wire.ex` — a full Wire module in everything but filename — and the `grappa_web` `*_json.ex` view layer are invisible to it, so the entire admin REST surface plus the auth/me envelopes are hand-transcribed in `api.ts` with zero pin (no assert, no codegen, no fixture). The result is a boundary rule enforced by file NAME rather than by role: two modules doing the same job (wire-shape ownership), one inside the drift gate, one outside.
**Impact:** Exactly the drift class the 2026-07-08 S3 review found for the flat mirrors ("~90% of the wire was an unguarded parallel transcription") persists for the admin/auth half of the wire. Admin surfaces change often (five admin-event kinds added since #266/#296-era) and each change silently drifts `api.ts`.
**Recommendation:** Either rename/move `admin_wire.ex` into the glob (and give the `*_json.ex` envelopes context-owned `Wire` typespecs the views delegate to — the moduledoc pattern already exists), or widen the codegen source rule from "files named wire.ex" to "modules carrying a marker attribute". Then extend `wireTypesAssert.ts` (or delete the hand-rolls per A4) for the newly covered types.

### A6. Error-token space: strings scattered server-side, two hand unions client-side, shared tokens split across them, no drift gate
**Concern:** Duplication
**Scope:** `lib/grappa_web/controllers/fallback_controller.ex` (~45 inline `json(%{error: "…"})` tokens), `lib/grappa_web/channels/grappa_channel.ex` (channel-push `error:` tokens), `cicchetto/src/lib/friendlyApiError.ts` (28-token union), `cicchetto/src/lib/friendlyChannelError.ts` (11-token union)
**Severity:** HIGH
**Problem:** Three structural layers of duplication. (1) Server-side there is no enumeration of the wire-token space — the FallbackController `@spec` lists atoms but several clauses emit a *different* string than the atom (`:no_session → "not_found"`, `:ip_cap_exceeded → "too_many_sessions"`, `:timeout → "session_timeout"`, `{:metadata_strip,_} → "metadata_strip_failed"`), so even the spec isn't the token space. (2) Client-side the space is hand-maintained twice, and the same Identifier-boundary rejections surface through both transports but are mapped in only one union: `invalid_line` and `body_too_large` are REST tokens (FallbackController) *and* channel tokens, mapped only in `friendlyChannelError` — the REST occurrence falls through to raw `err.message`. (3) Unlike the entity wire (codegen + `--check` gate), NOTHING fails when the server adds/renames a token: ~17 currently-emitted REST tokens (`insufficient_storage`, `unsupported_media_type`, `metadata_strip_failed`, `theme_cap_reached`, `forbidden_vhost`, `network_unconfigured`, `session_timeout`, `already_exists`, `last_admin`, `share_token_*`, …) have no `friendlyApiError` arm, and no test can tell "deliberately unmapped" from "forgotten".
**Impact:** Users see raw snake_case wire tokens for a growing share of the error surface; a server token rename degrades UX silently (documented as the exact `captcha_provider_unavailable` dead-arm incident, which this structure will reproduce); every new error is a 3-site hand edit.
**Recommendation:** Introduce a server-side token enumeration — a module with `@type api_error_token :: :not_found | …` (values = wire strings, one place where atom→string bending happens) that FallbackController clauses reference — and emit it through `gen_wire_types` so `KnownApiErrorCode`/`KnownChannelErrorCode` become generated literal unions; the existing `assertNever` switches then FAIL tsc on any server-side addition, closing the loop the entity wire already has. Merge the copy for transport-shared tokens (`invalid_line`, `body_too_large`) into one map consulted by both friendly modules.

### A7. Deploy dispatcher twins: hot-reload verification implemented in one, skipped in the other
**Concern:** Duplication
**Scope:** `scripts/deploy.sh` (Docker/dev), `infra/freebsd/deploy.sh` (prod jail)
**Severity:** MEDIUM
**Problem:** The hot/cold *classification* is properly shared (`Grappa.Deploy.Preflight` — both scripts are thin invokers; good). But the surrounding orchestration is copy-paste-with-tweaks, and the copies have drifted: the jail twin validates the reload response (`*'"failed":[]'*` — because "HTTP 200 is NOT success", per its own live-repro comment), runs a post-reload healthcheck loop, and maintains a completed-deploy marker with an honest nothing-to-do gate; the Docker twin's hot path is `curl -fsS -X POST …/admin/reload` then unconditional `✓ hot-deploy complete` — the exact silent-stale-code failure mode (`:old_code_in_use` inside a 200) the jail script documents from the 2026-06-10 incident. Also the mode-parse/preflight-rc `case` block is duplicated verbatim.
**Impact:** Dev-only blast radius (nothing production runs through `scripts/deploy.sh`), but a dev hot-deploy that silently keeps old modules loaded produces "the fix doesn't work" ghost-debugging sessions; and each future deploy-flow hardening must be remembered twice (the marker/nothing-to-do logic already wasn't).
**Recommendation:** Fix at the boundary the way the repo prefers: make `POST /admin/reload` return non-200 when `failed` is non-empty (both callers then get verification for free, plus any future caller — matches "No silent-swallow at boundaries"), keeping the response body for detail. If in-band reporting must stay, hoist the response check + healthcheck loop into a shared `scripts/_lib.sh` helper both dispatchers source.

### A8. Comment-lockstep client/server mirrors with no pinning mechanism
**Concern:** Duplication
**Scope:** `cicchetto/src/lib/servicesSender.ts` ↔ `Identifier.@services`; `cicchetto/src/lib/mentionMatch.ts` ↔ `lib/grappa/mentions.ex` (`mentioned?/3`); `cicchetto/src/lib/loginIdentifier.ts` (`NICK_FIRST`/`NICK_REST`) ↔ `Identifier.@nick_regex`; `cicchetto/src/lib/channelKey.ts` (`canonicalChannel`) ↔ `Identifier.canonical_channel/1`; `cicchetto/src/lib/memberSigil.ts` ↔ `Identifier.@member_prefix_precedence`
**Severity:** MEDIUM
**Problem:** Five cross-boundary mirrors whose only synchronization is a comment ("explicit add here AND on the server in lockstep", "MUST land in both ports together", "byte-identical in spirit"). The restatement itself is inherent — the client can't call Elixir — but the repo has already built two pinning mechanisms (type codegen; shared truth-table fixture) and none of these five uses either. At least one pair has a real semantic gap today: `Mentions.mentioned?` compiles with `[:caseless, :unicode]` (Unicode-aware `\b`) while `mentionsUser` uses `new RegExp(..., "i")` without the `u` flag — word-boundary behavior differs for non-ASCII nicks/patterns, so the "badge and push never disagree" claim in mentions.ex's moduledoc is not actually held by anything.
**Impact:** Each mirror drifts on the branch nobody re-reads the twin for; the services list in particular is a data constant that could be mechanically shared, and its divergence misroutes `/msg nickserv` responses (query window vs `$server`).
**Recommendation:** Per mirror, pick the cheapest existing mechanism: the services list and sigil precedence are constants — emit them through `gen_wire_types` (they're closed sets, exactly what the codegen models); the mention matcher and nick sanitizer are predicates — give each a shared JSON vector fixture consumed by vitest + ExUnit (the `shouldNotifyTruthTable.json` pattern), with Unicode and bracket-char rows. `canonicalChannel` can ride a fold-vector fixture shared with A1's.

### A9. Membership-sigil precedence restated three times inside cicchetto
**Concern:** Duplication
**Scope:** `cicchetto/src/lib/memberSigil.ts` (canonical), `cicchetto/src/lib/nickColor.ts:73-84` (`senderPrefix`, inline `@`/`%`/`+` if-chain), `cicchetto/src/lib/members.ts:139-144` (`tierRank`, inline if-chain)
**Severity:** LOW
**Problem:** The `@ > % > +` precedence table is encoded as three independent if-chains in the same codebase; two of them carry "mirrors memberSigil" comments instead of deriving from it. A fourth statement lives server-side (`Identifier.@member_prefix_precedence`, covered by A8).
**Impact:** Adding a prefix (e.g. `~` owner / `&` admin on other ircds — plausible for Phase 6) requires three synchronized edits; missing one produces inconsistent sort vs glyph vs scrollback prefix.
**Recommendation:** Export one ordered constant `SIGIL_PRECEDENCE = ["@", "%", "+"] as const` from `memberSigil.ts`; derive `memberSigil` (find + pad), `senderPrefix` (find + empty), and `tierRank` (indexOf) from it.

### A10. Session in-memory channel/target keys fold via bare `String.downcase` instead of the canonical helper
**Concern:** Duplication
**Scope:** `lib/grappa/session/server.ex` (1448, 1468, 1649, 1660, 3550, 4007, 4074), `lib/grappa/session/event_router.ex` (1488, 1578, 2092, 3125, 3179, 3207)
**Severity:** LOW
**Problem:** `Identifier.canonical_channel/1` is the declared single source for channel-key folding, yet ~13 accumulator/correlation-key sites (`who_pending`, `names_pending`, `in_flight_joins`, autojoin keys) fold with bare `String.downcase/1`. Each prime/drain pair is internally consistent, so no live bug — but it's a third fold spelling for new code to copy, and for WHO/NAMES the `target` can be a *nick*, where channel-downcase is the wrong policy family entirely (a bracket-nick `/who` prime/drain still pairs up, but only by accident of both sides using the same wrong fold).
**Impact:** Pure pattern-propagation debt: the next channel-keyed map in Session code will copy `String.downcase` (they all did), and the nick-target case quietly diverges from the #121 fold if a drain path ever normalizes differently.
**Recommendation:** Mechanical sweep to `Identifier.canonical_channel/1` (or, for the WHO/NAMES nick-or-channel targets, a small `Identifier.canonical_target/1` that dispatches sigil→channel-fold, else→nick-fold), so the Session layer has zero bare-downcase key sites.

---

**Verified clean (one line each):**
- **Wire-type codegen mechanism** — `gen_wire_types` + `--check` gate in `scripts/check.sh` + `wireTypesAssert.ts` equality asserts is a sound, working drift gate for everything it covers (gaps are A4/A5, not the mechanism).
- **PubSub topic strings** — server single-sourced in `Grappa.PubSub.Topic`; client builds topics in only two `socket.ts` sites, both through `canonicalChannel`.
- **nginx REST allowlist** — location blocks hoisted into `infra/snippets/locations-api.conf`, included by prod `:80`/`:443` AND the e2e `nginx-test.conf` (the CLAUDE.md "list it in both files" text is stale — the code is better than the doc).
- **Watch-list cap 64** — `Grappa.Notify.max_entries/0` server-only; the client never restates it and renders the `list_full` token instead.
- **Message kinds / connection-state enums** — codegen'd, assert-pinned, and tsc-enforced complete in `wireNarrow.ts`'s `MESSAGE_KIND_PRESENCE`.
- **Server broadcast payloads** — Session broadcasts route uniformly through `Session.Wire`/`Scrollback.Wire` (spot-checked ~30 `server.ex` sites); no inline payload maps found.
- **Deploy preflight classification** — single Elixir module (`Grappa.Deploy.Preflight`) drives both substrates; only the shell orchestration around it drifted (A7).
- **`nick_fold` SQL string** — `nick_fold_sql/1` SSOT with a byte-identity pin test against migrations and the fragment (the 2026-07-19 review's three hand-copied sites are fixed).
- **Push-trigger predicate pinning** — the shared truth-table fixture + dual-suite parity test is the right mechanism (coverage hole is A2).

---

## Architecture review 2026-07-20 — Dependency architecture agent

**Severity count: 0 CRITICAL, 1 HIGH, 4 MEDIUM, 2 LOW**

---

### A1. `Networks → Session` is the wrong-direction edge feeding every cycle in the codebase
**Concern:** Dependency architecture
**Scope:** `lib/grappa/networks.ex` (Boundary deps: `Grappa.Session`, `Grappa.LiveIntrospection`), `lib/grappa/networks/credentials.ex` (`Session.stop_session/2,3` at lines 712, 753), `lib/grappa/networks/credentials/admin_wire.ex` (`LiveIntrospection.SessionEntry`), `lib/grappa/session.ex`, `lib/grappa/live_introspection.ex`, `lib/grappa/notify.ex`, `lib/grappa/scrollback.ex`, `lib/grappa/channel_directory.ex`
**Severity:** HIGH
**Problem:** `Grappa.Networks` — the data context for networks/credentials — statically depends on `Grappa.Session` (calls `stop_session` from credential lifecycle verbs `disconnect`/`mark_failed`/`delete_network`) and on `Grappa.LiveIntrospection` (which itself deps Session) for admin DB+live projection assembly. This puts the entire data layer *above* the process runtime. Every context that needs network data (`ReadCursor`, `Visitors`, `Themes`, `Push.BadgeCount`, `Notify`) transitively lands on `Session`, so `Session` and `Push` cannot statically depend on any of them. Every cycle workaround I traced routes through this one edge: the `WindowCounts.PushSource` runtime seam (`Session → ReadCursor → Networks → Session`), the `Push.BadgeSource` runtime seam (`Push → BadgeCount → Networks → Session → Push`), `Notify`'s `dirty_xrefs: [Networks.Network]` (`Session → Notify → Networks → LiveIntrospection → Session`), `Scrollback`'s and `ChannelDirectory`'s `Networks.Network` dirty_xrefs. Session.Server's 13-dep fan-out to persistence contexts is the *correct* direction (orchestrator → contexts); the pathology is that Session sits simultaneously below Networks (spawned/stopped by it, fed a `SessionPlan`) and above the per-message pipeline — an hourglass with Networks pinching the middle.
**Impact:** Every new feature that touches both a session event and network-keyed data is forced into a runtime seam, a dirty_xref, or message-passing — three of these workarounds already exist and each carries its own hot-deploy degradation window and lost Boundary checking. The workaround count grows monotonically with features.
**Recommendation:** Two mechanical extractions dissolve nearly all of it: (1) move session lifecycle control (`stop_session` on credential state transitions) into `Grappa.SpawnOrchestrator` — it is already the documented admission→spawn boundary module and already deps `Session`; make it own the full lifecycle (spawn *and* stop), with `Networks` emitting state transitions and `SpawnOrchestrator`/callers reacting. (2) Move the admin DB+live combining out of `Networks.Credentials.AdminWire` up into `Grappa.Operator` (which already deps Networks, LiveIntrospection, Session) — the CLAUDE.md "combine both sources" invariant says the *listing* must combine them, not that Networks must do the combining. After both, `Networks` drops its `Session` and `LiveIntrospection` deps, and A2's seams become plain static deps.

### A2. Runtime `Application.get_env` DI seams are symptom-fixes for A1, and their implementations live in namespace-lying homes
**Concern:** Dependency architecture
**Scope:** `lib/grappa/push/badge_source.ex`, `lib/grappa/window_counts/push_source.ex`, `lib/grappa/window_counts/pusher.ex`, `lib/grappa/push/badge_count.ex`, `config/config.exs`
**Severity:** MEDIUM
**Problem:** Both seams guard *genuine* cycles today (verified against the Boundary graph: `Push → BadgeCount → Networks → Session → Push` and `Session → ReadCursor → Networks → Session`), so they are locally correct — but both cycles exist only because of the A1 edge, making the seams permanent scaffolding around a fixable inversion. Two structural costs: (1) they are self-documented exceptions to the codebase's own "`Application.{put,get}_env`: boot-time only, runtime banned" rule, each with a hot-deploy `nil`-degradation window (badge silently omitted; window_counts push silently skipped); (2) the implementations are top-level Boundary modules nested inside *another* boundary's directory namespace — `Grappa.WindowCounts.Pusher` (deps ReadCursor) sits in `lib/grappa/window_counts/` beside the seam it implements, and `Grappa.Push.BadgeCount` (deps Networks) sits in `lib/grappa/push/` — so the module path asserts ownership the boundary graph contradicts. A reader (or a pattern-copying session) will treat them as context internals.
**Impact:** Third and fourth instances of this pattern are cheaper to add than to question — `BadgeSource`'s moduledoc is already cited as precedent by two other files. Each instance loses compile-time dep checking, adds a silent-degradation mode, and further normalizes runtime env reads.
**Recommendation:** Treat these as temporary and tie their removal to A1: once `Networks` drops Session, replace both seams with static deps (`Push → BadgeCount`, `Session → WindowCounts.Pusher`) and delete the config keys. Until then, relocate `Pusher`/`BadgeCount` out of the parent boundary's directory (or at minimum rename to make the separate-boundary status loud), and add a "delete when Networks→Session is gone" marker to both moduledocs.

### A3. `Themes.BackgroundImage`'s fetcher seam is a false "cycle inversion" — pattern misuse spreading by imitation
**Concern:** Dependency architecture
**Scope:** `lib/grappa/themes/background_image.ex` (fetcher/0, line 85-89), `lib/grappa/themes/image_fetcher.ex`, `config/config.exs:163`, `config/test.exs:121`
**Severity:** MEDIUM
**Problem:** The seam's comment says it "mirrors `Grappa.Push.BadgeSource.impl/0`" — but there is no cycle here. `Grappa.Themes.ImageFetcher.Req` lives *inside the same Themes boundary* as its caller; the runtime `Application.get_env` read exists solely for Mox test injection plus hot-deploy grace. The cycle-inversion pattern (which has a legitimate structural excuse) has been copied into a place where the only motive is a test seam — exactly the "copies whichever pattern is closer" drift CLAUDE.md warns about, and a second unflagged exception to the runtime-get_env ban.
**Impact:** Blurs the (already fragile) rule that runtime env reads are reserved for genuine Boundary-cycle inversions. Future intra-boundary test seams will cite this file, and the ban erodes into "get_env wherever mocking is convenient."
**Recommendation:** Within-boundary test injection doesn't need runtime config: pass the fetcher module as an explicit parameter from the caller (Themes context function), or use `Application.compile_env` (it stores an atom; the mock module needn't exist at compile time). At minimum, rewrite the comment to state the real justification (test seam, not cycle inversion) so the two pattern populations stay distinguishable.

### A4. `Visitors.Visitor` dirty_xref proliferation — identity schema stranded in the wrong layer
**Concern:** Dependency architecture
**Scope:** `dirty_xrefs: [Grappa.Visitors.Visitor]` in `lib/grappa/scrollback.ex`, `lib/grappa/read_cursor.ex`, `lib/grappa/networks.ex`, `lib/grappa/notify.ex`, `lib/grappa/query_windows.ex`, `lib/grappa/push.ex`, `lib/grappa/subject.ex`, `lib/grappa/themes.ex`; plus `Grappa.Accounts`' commented Visitor xref
**Severity:** MEDIUM
**Problem:** The `Visitors` context sits near the top of the graph (deps Session, SpawnOrchestrator, Networks, Themes, Admission…) because it owns visitor *orchestration* (login, session planning, reaping). But its `Visitor` schema is FK-referenced (`belongs_to :visitor`) from eight-plus boundaries at the *bottom* of the graph, each escaping via a dirty_xref that Boundary explicitly doesn't check. Compare `Accounts.User`: same role (the other half of the `Subject` polymorphism), but everyone takes a real, checked `Grappa.Accounts` dep. `Grappa.Subject` itself is asymmetric — real dep on Accounts, dirty_xref on Visitor. The one-off dirty_xref was a reasonable tradeoff; nine of them for the same schema is the graph saying the schema is in the wrong boundary.
**Impact:** All struct/changeset access to `Visitor` from below is boundary-unchecked — a rename or field change silently escapes the architecture tests across nine call-site populations. Every new subject-keyed table (the codebase adds them steadily) inherits the escape hatch by copy.
**Recommendation:** Split visitor *identity* (the schema, its changeset, canonical types) from visitor *orchestration*. Move the `Visitor` schema into a low-layer identity boundary — inside `Grappa.Subject` (which already models the user|visitor polymorphism) or a sibling of `Accounts` — and let `Grappa.Visitors` keep login/spawn/reaper logic with a real dep on it. The nine dirty_xrefs collapse into checked deps.

### A5. cicchetto: `windowState ↔ selection` module cycle between the two authoritative sidebar stores
**Concern:** Dependency architecture
**Scope:** `cicchetto/src/lib/windowState.ts:4` (`import { selectedChannel } from "./selection"`), `cicchetto/src/lib/selection.ts:27` (`import { windowIsPresent } from "./windowState"`)
**Severity:** MEDIUM
**Problem:** The only import cycle in the ~150-module `lib/` graph (verified by full-graph tsort; graph is otherwise a DAG), and it sits between the two stores CLAUDE.md names as the authoritative sidebar projection (`windowStateByChannel`) and the focused-pane selection. It works today because both bindings are accessors invoked after module init, but any future top-level evaluation of the other module's binding (a `createMemo` at module scope reading `selectedChannel`, say) hits ESM TDZ — and both files are high-churn (selection.ts was itself "lifted out of the networks.ts god-module per A4", windowState.ts mirrors new server states).
**Impact:** Initialization-order fragility that surfaces as a runtime `ReferenceError` only in whichever bundle chunk-ordering triggers it; the cycle also invites more edges between the pair (a cycle normalizes itself).
**Recommendation:** Break it by extracting the shared primitive to a leaf module: either `selectedChannel` (the raw signal) into a `selectionState.ts` both import, or `windowIsPresent` down beside `windowKinds.ts`/`channelKey.ts` (the existing leaf tier both already use). One-file move; then add the pair to whatever lint gate exists (`import/no-cycle` or an e2e-adjacent check) so the DAG stays a DAG.

### A6. cicchetto: two `lib → component` inversions
**Concern:** Dependency architecture
**Scope:** `cicchetto/src/lib/keepKeyboard.ts:47` (`import { isDiagEnabled } from "../DiagFloat"`), `cicchetto/src/lib/mentionsWindow.ts:2` (`import type { MentionsBundle } from "../MentionsWindow"`)
**Severity:** LOW
**Problem:** The documented client direction is components → `lib/*` stores → api/socket. Two files invert it: `keepKeyboard.ts` (store layer) takes a *value* import of the diag-enabled predicate from the `DiagFloat.tsx` component, and `mentionsWindow.ts` (the store for the mentions window) imports its own bundle *type* from the component that renders it. The type-only one is benign at runtime but puts the data contract in the view layer.
**Impact:** The diag flag can't be used from any other lib module without deepening the inversion; component refactors (renaming/splitting DiagFloat or MentionsWindow) now break the store layer. These are the seed instances the next session will copy.
**Recommendation:** Move `isDiagEnabled` into `lib/diagLog.ts` (its natural home — DiagFloat already imports from there) and `MentionsBundle` into `lib/mentionsWindow.ts` or `lib/wireTypes.ts`, flipping both imports to the sanctioned direction.

### A7. CLAUDE.md supervision-tree diagram has drifted ~8 children behind `application.ex`
**Concern:** Dependency architecture
**Scope:** `CLAUDE.md` (Architecture section tree), `lib/grappa/application.ex`
**Severity:** LOW
**Problem:** The documented tree shows 11 children; the real tree has ~19 — `AdminEvents`, `SessionLog`, `Visitors.ShareTokens`, `RateLimit.DailyQuota`, `RateLimit.FailureWindow`, `Net.PtrCache`, `Task.Supervisor (Grappa.TaskSupervisor)`, `Uploads.Reaper`, and `Accounts.Reaper` are all absent, several of them ordering-sensitive ETS/telemetry singletons whose position the in-file comments call load-bearing. I verified every per-child ordering claim in `application.ex` holds in the actual child list (Vault→Repo→PubSub→Registry→ETS singletons→telemetry sinks→TaskSupervisor→SessionSupervisor→Endpoint→reapers→Bootstrap-last) — the *code* is coherent; the *authority document* is stale.
**Impact:** CLAUDE.md declares itself the override-everything authority ("if existing code contradicts them, the code is wrong"). A stale authoritative tree invites exactly the wrong correction — a future session could read the doc, conclude the extra children are undocumented drift, and "fix" ordering that is in fact deliberate.
**Recommendation:** Regenerate the CLAUDE.md tree from the current `application.ex` (docs-only commit), and consider trimming the doc to the ordering *invariants* (the tier structure) rather than the full child list, so it stops rotting child-by-child.

---

**Verified clean (one line each):**
- No context→web inversion: every `GrappaWeb` reference under `lib/grappa/` is doc-comment-only, except `application.ex`'s legitimate Endpoint child.
- Supervision ordering: all why-comments in `application.ex` are consistent with the actual child sequence; no child violates its stated rationale.
- Runtime `Application.get_env` is otherwise confined to the designated boot boundaries (`application.ex`, `Admission.Config.boot`, `Push.boot`, `Uploads.boot`, `HttpHosts.boot`, release/mix tasks) — the only runtime offenders are the three seams in A2/A3.
- No process-state reaching: no production `:sys.get_state`; `LiveIntrospection` uses `Process.info(pid, [:message_queue_len, :memory])` metrics through its own declared boundary.
- cicchetto direction otherwise clean: 95 component-level edges form a DAG, zero `export let` mutable bindings in `lib/`, and `identityScopedStore` centralizes cross-store identity-reset instead of ad-hoc cross-store writes.
- Wire-module discipline holds: per-context `*.Wire` modules everywhere PubSub payloads originate, with `wireTypes.ts` generated from the `lib/grappa/**/wire.ex` glob as a single source.

---

## Architecture review 2026-07-20 — Type system leverage agent

**Severity count: 0 CRITICAL, 4 HIGH, 4 MEDIUM, 3 LOW**

---

### A1. Envelope `kind: String.t()` residue defeats the codegen discriminator in ~8 Wire modules
**Concern:** Type system leverage
**Scope:** `lib/grappa/scrollback/wire.ex` (lines 49, 61, 187, 221), `lib/grappa/notify/wire.ex:34`, `lib/grappa/query_windows/wire.ex:35`, `lib/grappa/read_cursor/wire.ex:49`, `lib/grappa/server_settings/wire.ex:82`, `lib/grappa/session_log/wire.ex:34`, `lib/grappa/networks/wire.ex:222`; codegen at `lib/mix/tasks/grappa/gen_wire_types.ex`
**Severity:** HIGH
**Problem:** The S14 fix (documented at length in `scrollback/wire.ex` `to_json/1` moduledoc) established the correct pattern: type `kind` as a literal atom, pass the atom through, let Jason stringify — so codegen emits a TS literal union and the auto discriminated union (`WireXEvent`, which requires ≥2 arms with literal `kind:` to fire). `Session.Wire` and `AdminEvents.Wire` were migrated (every arm is `kind: :joined`, `kind: :circuit_open`, …). But the envelope/list-payload types in at least 8 sibling Wire modules still declare `kind: String.t()` — including `Scrollback.Wire.event` (the single highest-volume payload in the system, wrapping every scrollback message), `archive_changed_payload`, `archive_purged_payload`, and the list payloads of notify/query_windows/read_cursor/server_settings/session_log. Codegen renders these as `kind: string`, erasing the closed set.
**Impact:** cic cannot discriminate these events from generated types, forcing the hand-written parallel unions in `api.ts` (see A2) and hand-checked `r.kind === "..."` narrowing. A server-side rename of an event kind string is invisible to `tsc` and to the `gen_wire_types --check` drift gate. This is exactly the half-migrated state CLAUDE.md's "Total consistency or nothing" rule warns about — the codebase now demonstrates both patterns, and the next Wire module will copy whichever is nearer.
**Recommendation:** Mechanical sweep: convert every remaining `kind: String.t()` in `lib/grappa/**/wire.ex` to its literal atom (`kind: :message`, `kind: :archive_changed`, …), pass atoms through builders, regenerate `wireTypes.ts`. The S14 precedent proves the wire bytes are identical. Then delete the corresponding hand-written discriminators on the cic side arm by arm.

### A2. Generated `wireTypes.ts` is consumed indirectly through a hand-rolled mirror layer with opt-in equality asserts
**Concern:** Type system leverage
**Scope:** `cicchetto/src/lib/api.ts` (~900 lines of hand-written wire types: `WireChannelEvent` @630, `WireUserEvent` @924, `WireAdminEvent` @1209), `cicchetto/src/lib/wireTypesAssert.ts`, `cicchetto/src/lib/wireTypes.ts`
**Severity:** HIGH
**Problem:** The codegen pipeline exists and is CI-gated, but almost no call site imports from `wireTypes.ts` directly. Instead `api.ts` hand-transcribes each shape and `wireTypesAssert.ts` pins ~15 of them via `Equal<A,B>` compile-time asserts. Coverage is manual and per-type opt-in: any `api.ts` type *without* an assert is an unguarded parallel transcription (the assert file's own comments admit ~90% of the wire was unguarded before S3). Critically, the three big discriminated unions — `WireChannelEvent`, `WireUserEvent`, `WireAdminEvent` — have **no** assert at all ("validated via their runtime narrowers"), even though codegen already auto-emits `WireSessionEvent` (wireTypes.ts:919) covering most of their arms.
**Impact:** Three layers describe one contract (Elixir typespec → generated TS → hand-rolled TS), with the weakest link (hand-rolled, assert-optional) being the one the app actually compiles against. New wire types default to a fresh transcription; forgetting the assert silently reopens the drift class the whole apparatus was built to close.
**Recommendation:** Invert the dependency: make `api.ts` *re-export* generated types (`export type ScrollbackMessage = ScrollbackWireT`) instead of mirroring them, keeping hand-written types only where genuine cic-side enrichment exists (and compose those enrichments *from* generated per-arm types, e.g. `WireChannelEvent = SessionWireTopicChangedPayload | ...`). Each conversion deletes both a mirror and its assert. End state: `wireTypesAssert.ts` shrinks toward empty and drift becomes structurally impossible rather than assert-guarded.

### A3. Runtime narrowers are ~1,400 hand-maintained lines that the codegen cannot see
**Concern:** Type system leverage
**Scope:** `cicchetto/src/lib/wireNarrow.ts` (983 lines), `cicchetto/src/lib/userTopic.ts`, `cicchetto/src/lib/sessionLog.ts`; source of truth `lib/mix/tasks/grappa/gen_wire_types.ex`
**Severity:** HIGH
**Problem:** The `unknown`-narrowing discipline at the WS edge is correct and consistently applied — but every narrower is a hand-written field-by-field `typeof` check duplicating information the Elixir typespec already encodes and the codegen already parses. The type asserts (A2) pin *types* against *types*; nothing pins *narrowers* against types beyond the return-type annotation, which cannot catch an omitted or over-strict check. The file's own history documents both failure modes shipping: `visitor_deleted` kept validating a dropped `network_slug` and blanked the admin tab (#211 phase 7 comment), and `join_failed.numeric` typed non-null made the narrower drop the reconnect "failed tab" snapshot (S13/CP15-B3).
**Impact:** Every wire-shape change costs three synchronized edits (typespec, api.ts mirror, narrower), and only two of the three are compiler-checked. The narrower is the one that fails at runtime, in production, by silently dropping events.
**Recommendation:** Extend `gen_wire_types.ex` to emit runtime guards alongside types — it already walks the full typespec AST (scalars, literal-atom unions, nullable fields, arrays, nested maps cover ~95% of what the hand narrowers check). Generate `narrowX(raw: unknown): X | null` per emitted type; keep hand-written narrowers only for genuinely enriched shapes. This collapses the three-edit cadence to one and closes the narrower-drift class the same way `--check` closed type drift.

### A4. The entire AdminWire surface (10 modules) sits outside the codegen glob
**Concern:** Type system leverage
**Scope:** `lib/grappa/**/admin_wire.ex` (10 files: accounts, admission/network_circuit, live_introspection, networks, networks/credentials, networks/featured_channels, networks/servers, subject_search, vhosts, visitors); glob `lib/grappa/**/wire.ex` in `gen_wire_types.ex:48`
**Severity:** MEDIUM
**Problem:** The codegen glob matches only files named `wire.ex`, so the ten `AdminWire` modules — a full second wire surface for the admin REST tabs — emit no TypeScript at all (and `wire_module?/1`, which keys on last segment `== "Wire"`, would classify them as "external" if referenced). Their typespecs also lag the main Wire discipline: `live_introspection/admin_wire.ex:52` types `subject_kind: String.t()` where sibling `session_log/wire.ex:21` uses `:user | :visitor`.
**Impact:** Every admin listing shape (`adminListSessions`, visitors, credentials, vhosts, …) is a hand-written cic type with no drift gate whatsoever — not even the opt-in asserts of A2. The admin surface is exactly where DB-state/live-state honesty fields (`live_state: null`) make shape precision matter most.
**Recommendation:** Widen the glob to `lib/grappa/**/{wire,admin_wire}.ex` (and teach `wire_module?/1` about `AdminWire`), atom-ify the `subject_kind`-style closed sets, regenerate, and pin or replace the cic-side admin types. Cheap: the codegen needs no new type-mapping capability.

### A5. Web-layer modules re-declare Wire shapes with widened types
**Concern:** Type system leverage
**Scope:** `lib/grappa_web/channels/grappa_channel.ex:187-201`, `lib/grappa_web/controllers/me_json.ex:97-108`, `lib/grappa_web/controllers/auth_json.ex:26-28`, `lib/grappa/networks.ex:640`
**Severity:** MEDIUM
**Problem:** `GrappaChannel` declares its own `topic_changed_payload` / `channel_modes_changed_payload` with `kind: String.t()` and `topic: map()` / `modes: map()` — while the canonical, fully-typed versions exist in `Grappa.Session.Wire` (`kind: :topic_changed`, typed `topic_entry_wire`) a module it already aliases and, for other payloads (`members_seeded_payload`, `query_windows_list_payload`), correctly references. `MeJSON` and `AuthJSON` similarly build subject/wire shapes with local `kind: String.t()` typespecs outside any Wire module, so they're invisible to codegen and to the atom-union discipline.
**Impact:** Two sources of truth for one payload: the widened web-layer copy is the one Dialyzer checks at the push site, so the Session.Wire literal type can drift without any error. New channel payloads copy the nearest (widened) pattern.
**Recommendation:** Delete the local redeclarations in `GrappaChannel` in favor of `SessionWire.topic_changed_payload()` etc. (the mechanism is already half-adopted in the same attribute block). For `me_json`/`auth_json`, move the wire shape into the owning context's Wire module per the established "wire conversion is per-context responsibility" invariant.

### A6. Folded vs raw nick is a convention, not a type — and the two sides implement *different* folds
**Concern:** Type system leverage
**Scope:** `lib/grappa/irc/identifier.ex` (`canonical_nick/1` @199, `@spec ... term() :: term()`), `cicchetto/src/lib/nickEquals.ts`; zero `@opaque` declarations anywhere in `lib/`
**Severity:** HIGH
**Problem:** The GH #121 invariant ("EVERY server-side nick compare routes through `canonical_nick/1`") is enforced purely by review. `canonical_nick/1` is spec'd `term() :: term()` — a folded nick and a raw nick are the same `String.t()` (actually the same `term()`), so Dialyzer can never flag a compare-site that forgot to fold, and the pass-through-on-non-binary clause erases even the string typing. On the client, the same convention gap let policy diverge: `normalizeNick` is plain `.toLowerCase()`, which does **not** fold `[ ] \ ~` → `{ } | ^`, so `[user]` and `{user}` are one identity to the server (bahamut rfc1459) and two identities to cic — precisely the window/identity-fork class #121 was filed for. The `nickEquals.ts` header comment even mis-states its own behavior ("`{user}` matches `[user]` under our rule" — it doesn't) and predates the server-side #121 ruling.
**Impact:** Nick-keyed client stores (members, mentions, query windows) can fork or miss on bracket nicks; server-side, any new nick lookup compiles clean whether or not it folds. No compiler on either side has anything to check.
**Recommendation:** (1) Align the client fold with the server: extend `normalizeNick` with the four bracket replacements — the file's own comment declares single-source-of-truth migration as the intended path. (2) Give fold-ness a type: TS `FoldedNick = string & {brand}` produced only by `normalizeNick` (the `ChannelKey` pattern already in-repo, `channelKey.ts:21-25`); Elixir at minimum `@spec canonical_nick(String.t() | nil) :: String.t() | nil`, ideally an `@opaque folded_nick` with constructor in `Identifier` so fold-MATCH sites take `folded_nick()` and Dialyzer flags raw strings.

### A7. `:map` columns don't follow the `Scrollback.Meta` custom-type pattern
**Concern:** Type system leverage
**Scope:** `lib/grappa/user_settings/settings.ex:86` (`data`), `lib/grappa/themes/theme.ex:44` (`payload`), `lib/grappa/admin_events/event.ex:25` (`payload`); reference pattern `lib/grappa/scrollback/meta.ex`
**Severity:** MEDIUM
**Problem:** `Meta` exists precisely to close the "atom keys in-memory / string keys after round-trip, two shapes via two paths" footgun, with a Dialyzer-visible key allowlist. The other three `:map` columns don't use it or anything like it. `user_settings.data` documents the exact footgun as a live convention ("ALL code that reads `data` MUST use string keys") plus a *markdown table* as the key registry — the closed set lives in prose, invisible to Dialyzer, and `t()` types it `%{optional(String.t()) => term()}`. `themes.payload` is sanitized to a closed token vocabulary by `TokenModel.sanitize/1` at the changeset, yet its schema type is bare `map() | nil` — the canonical-form guarantee the sanitizer establishes is erased one line later. (`admin_events.payload` is a justified opaque pass-through; no action.)
**Impact:** New settings keys can collide or typo silently (registry is doc-only); theme payload consumers get `map()` and re-validate or trust blindly; the codebase again exhibits two patterns for the same problem, and new `:map` columns will copy the weaker one.
**Recommendation:** For `user_settings.data`: a `Meta`-style custom Ecto type with the known-key allowlist lifted from the markdown table (keeping values loosely typed, as Meta does). For `themes.payload`: a custom type whose `cast/dump/load` route through `TokenModel`, so the schema type *is* the sanitized canonical shape. Document in `Meta`'s moduledoc that it is the pattern for any non-opaque `:map` column.

### A8. `ChannelKey` brand leaks through ~10 scattered `as ChannelKey` casts
**Concern:** Type system leverage
**Scope:** `cicchetto/src/lib/selection.ts` (5 sites @394-467), `lib/activeWindows.ts:159`, `lib/archive.ts:111`, `lib/presenceFilter.ts:85`, `lib/subscribe.ts:772`, `Sidebar.tsx:180`
**Severity:** LOW
**Problem:** The branded `ChannelKey` (`channelKey.ts`) is well-designed and pervasively used, but `Object.keys()` / `Object.entries()` over `Record<ChannelKey, T>` returns `string[]`, so every iteration site hand-casts `rawKey as ChannelKey` — the exact unchecked assertion the brand exists to forbid, duplicated at ~10 sites where a non-key string could be smuggled in.
**Recommendation:** One typed helper in `channelKey.ts` (`channelKeys<T>(rec: Record<ChannelKey, T>): ChannelKey[]`, and/or an entries variant) containing the single sanctioned cast; ban ad-hoc `as ChannelKey` outside that module by convention (or a biome/lint rule).

### A9. Timestamp representation is convention-only; codegen erases it to bare `string`/`number`
**Concern:** Type system leverage
**Scope:** `lib/grappa/scrollback/message.ex` (`server_time` epoch-ms `integer()`), `Session.Wire`/`AdminEvents.Wire` (`at`/`set_at`/`opened_at`/`created_at` as ISO-8601 via `DateTime.t()` → `string`), `Scrollback.Wire.archive_wire_entry.last_activity` (epoch integer); `gen_wire_types.ex:420` maps `DateTime.t()` → `"string"`
**Severity:** LOW
**Problem:** Two timestamp encodings coexist on the wire (epoch-ms numbers and ISO-8601 strings), each documented locally but indistinguishable by type from any other number or string on either side. The codegen even has the information (`DateTime.t()`) and discards it.
**Recommendation:** Have codegen emit `export type Iso8601 = string;` (optionally branded) and map `DateTime.t()` to it; alias epoch fields as `epoch_ms :: integer()` in a shared Elixir typedef so both the docs and the generated TS carry the unit. Cheap, and makes mixed-unit bugs (`server_time` vs `at` comparisons) type-visible.

### A10. Network identity: id vs slug both bare, and the slug travels under two key names
**Concern:** Type system leverage
**Scope:** `Scrollback.Wire.t` (`network: String.t()` — carries the *slug*), `Session.Wire` events (`network: String.t()` slug; `isupport_changed.network_id: pos_integer()`), `AdminEvents.Wire` (`network_id` + `network_slug`), cic mirrors throughout
**Severity:** LOW
**Problem:** The same identity is `network` (slug) on scrollback/session events, `network_slug` on admin events, and `network_id` (number) on others — with no type distinguishing a slug from any other string despite `valid_network_slug?/1` existing as a boundary validator. cic keys stores by slug; nothing stops a `network_id`-as-string or a display name from being used as a key.
**Recommendation:** At minimum a shared `@type network_slug :: String.t()` alias referenced by every Wire typespec (codegen will surface it as a named TS alias per its external-type mechanism); a TS brand mirroring `ChannelKey` if store-key misuse ever bites. Standardize new payloads on `network_slug` naming.

### A11. Per-kind `meta` shapes exist only in prose; both sides consume `Record<string, unknown>`
**Concern:** Type system leverage
**Scope:** `lib/grappa/scrollback/meta.ex` (`t()` values are `term()`; six per-kind shapes documented in the moduledoc table), `cicchetto/src/lib/api.ts:600` (`meta: Record<string, unknown>`), renderers in `ScrollbackPane.tsx`
**Severity:** MEDIUM
**Problem:** `Meta` nails the *key* allowlist but deliberately punts on the *value* shapes ("encoding all six per-kind shapes would require a discriminated union keyed on `Message.kind`, which is the schema's job") — and the schema never picks the job up. So `%{kick: %{target: ...}}`, `%{nick_change: %{new_nick: ...}}` etc. are documented contracts with zero type presence: server producers write `term()`s, and cic renderers reach into `Record<string, unknown>` per kind with ad-hoc `typeof` checks. The natural home exists: `Scrollback.Wire.t` already carries `kind: Message.kind()` — the discriminant is right there next to the untyped `meta`.
**Impact:** Adding/renaming a meta field for a kind is checked by nothing on either side; the moduledoc table is the only contract and it drifts freely. The kick/mode/nick_change render paths are exactly the unchecked-access surface `noUncheckedIndexedAccess` was pinned to eliminate elsewhere.
**Recommendation:** Define per-kind meta typespecs in `Scrollback.Wire` (e.g. `kick_meta :: %{target: String.t()}`) and make `t()` a discriminated union over `(kind, meta)` pairs — codegen then emits a TS discriminated union for free, and cic's per-kind render arms get typed meta with `assertNever` exhaustiveness. `Meta`'s allowlist stays as the storage gate; the union is the wire contract.

---

**Verified clean (one line each):**
- `cicchetto/tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `verbatimModuleSyntax` all pinned.
- Dialyzer config (`mix.exs`): `:underspecs`, `:extra_return`/`:missing_return`, `:unmatched_returns`, `:unknown` all enabled and CI-gated via `ci.check`.
- `@spec` discipline: `Credo.Check.Readability.Specs` at `priority: :high` in `.credo.exs` — specs enforced on every owned function.
- `assertNever` is used at every closed-union switch found (ScrollbackPane, adminEvents, AdminEventsTab, AdminSessionLogTab, userTopic, friendlyApiError, friendlyChannelError).
- `ChannelKey` branded type exists, is constructor-gated, and is the pervasive store key (modulo A8's iteration casts).
- `unknown`-narrowing at WS edges is systematic — no direct `as WireX` casts on Phoenix payload entry remain (the pre-bucket-G cast pattern is fully migrated).
- Closed sets on the server are overwhelmingly `Ecto.Enum`/atom unions (`Credential.connection_state`, `Message.@kinds`, `Session.Server.window_states`); `Scrollback.Meta` is a genuinely strong custom-Ecto-type reference pattern.
- `MESSAGE_KIND_PRESENCE: Record<MessageKind, true>` (wireNarrow.ts:67) is a good tsc-enforced type-to-runtime-set bridge worth replicating.

---

## Architecture review 2026-07-20 — Extension & maintainability agent

**Severity count: 0 CRITICAL, 3 HIGH, 5 MEDIUM, 1 LOW**

All touch-counts below are measured from git history (`#247` series `31bcc24d..0f2fe3c4`, verb commit `b2cf231a` (#127), `356d0050` (#221), context commit `31bcc24d`), not estimated.

---

### A1. Env-var registry is a 5-to-7-file hand-copied contract with no gate, and it is already broken
**Concern:** Extension & maintainability
**Scope:** `config/runtime.exs`, `compose.yaml`, `.env.example`, `infra/freebsd/grappa.env.example`, `bin/start.sh`, `cicchetto/e2e/compose.yaml`, `docs/OPERATIONS.md`/`INSTALL.md`
**Severity:** HIGH
**Problem:** One new env var must be declared in up to 7 places, and nothing checks agreement. Measured drift today: `.env.example` is missing `EXTRA_CHECK_ORIGINS`, `GRAPPA_CAPTCHA_PROVIDER/SECRET/SITE_KEY`, `VAPID_SUBJECT`, and `RELEASE_COOKIE` (all read by `runtime.exs` and plumbed through `compose.yaml`); `infra/freebsd/grappa.env.example` still exports `GRAPPA_OUTBOUND_V6_POOL`, which is **dead** — `lib/grappa/outbound_v6_pool.ex:16` says it was replaced by the DB-driven vhosts pool — and is missing the captcha trio and `EXTRA_CHECK_ORIGINS`. Meanwhile `compose.yaml` carries `GRAPPA_MAX_USERS`/`GRAPPA_DIRTY_SCHEDULERS` that exist only in `bin/start.sh`, invisible to anyone reading `runtime.exs` as the "registry."
**Impact:** Every miss is SILENT until a prod boot fails (`runtime.exs` raise) or, worse, silently degrades (captcha unset → whatever the fallback is; jail operator sets a dead var and believes it works). The example files actively mislead new deployments.
**Recommendation:** Make `config/runtime.exs` the declared registry (a module attribute or a small `Grappa.Config.Env` manifest listing `{name, required_in, default}`), then add a drift pin in the existing pattern (`test/grappa/deploy/preflight_test.exs` style): parse `.env.example`, `grappa.env.example`, and `compose.yaml` `${VAR}` references in a test and assert set-equality against the manifest (with an explicit allowlist for shell-only vars like `GRAPPA_MAX_USERS`, each carrying a pointer to its reader). The repo already has 10+ drift-pin tests — this is the highest-value missing one. Delete `GRAPPA_OUTBOUND_V6_POOL` from the jail example now.

### A2. Load-bearing contracts are quoted verbatim in multiple docs and the quotes have drifted — including inside CLAUDE.md itself
**Concern:** Extension & maintainability
**Scope:** `CLAUDE.md`, `lib/grappa/session/window_state.ex` moduledoc, `cicchetto/src/lib/windowState.ts` header comment, `docs/DESIGN_NOTES.md` (25,844 lines)
**Severity:** HIGH
**Problem:** The `window_states` enum is written out in at least 3 doc locations and 2 of them are stale: `window_state.ex`'s moduledoc *quotes CLAUDE.md* as `:pending | :joined | :failed | :kicked | :parked` (no `:invited`) while actual CLAUDE.md includes `:invited`; `windowState.ts:10`'s header comment has the same omission while line 31's actual type includes `"invited"`. Separately, CLAUDE.md's admin-endpoint rule still instructs editing "`infra/nginx.conf` + e2e `cicchetto/e2e/nginx-test.conf` … both the `:80` and `:443` server blocks" — but commit `15392923` hoisted the location surface into `infra/snippets/locations-api.conf`, the single file both configs now `include`. The authority file mandates a workflow that no longer matches the code, in a repo whose stated rule is "if code contradicts the docs, the code is wrong."
**Impact:** CLAUDE.md is the per-session instruction set: a stale invariant is propagated by every future session that trusts it (the repo's own engineering-standards preamble predicts exactly this). Quoted-enum drift means the next state addition gets copied from a stale quote. The line review's ~15 drift findings in one pass confirm the class is systemic, not incidental.
**Recommendation:** (1) Fix the three instances now. (2) Adopt a "reference, don't quote" rule for enums/types in prose — moduledocs and cic comments should say "see `WindowState.state()` / `windowState.ts` `WindowState`" instead of restating the members. (3) For the few contracts that MUST be restated across the language boundary (window states, message kinds), extend the existing drift-pin pattern (the fold-SQL pin in `identifier_test.exs` is the template) — a test that greps the doc line and compares against the code enum is ~10 lines and permanently closes the class.

### A3. `Session.Server` state shape is pinned by ~98 `:sys.get_state` assertions in one 7,844-line test file — the planned extractions will pay a large mechanical tax
**Concern:** Extension & maintainability
**Scope:** `test/grappa/session/server_test.exs` (7,844 lines, 98 `:sys.get_state` calls), `lib/grappa/session/server.ex` (4,699 lines)
**Severity:** HIGH
**Problem:** The server tests are outcome-shaped at the boundary (they drive via the `Grappa.IRCServer` in-process fake and assert emitted lines/PubSub — good), but ~98 assertions reach into the GenServer's raw state struct. Every field rename or field-bundling refactor (exactly the extractions the cohesion review proposes; the CP-era `WindowState` bundling of 4 fields → 1 struct already hit this) breaks dozens of tests that were not testing behavior. The file's size (7.8k lines; `event_router_test.exs` is 4.4k, `ScrollbackPane.test.tsx` 3.7k, `compose.test.ts` 2.0k) is a symptom of the hub-module problem (A5): tests accrete where the code accretes.
**Impact:** Tests *block* rather than *enable* the proposed decompositions: an extraction that changes zero observable behavior still reds ~100 assertions, which pressures future sessions to skip the refactor or weaken assertions wholesale.
**Recommendation:** Don't ban `:sys.get_state` — it's legitimate for genuinely internal invariants — but route it through one test-support accessor per inspected concern (e.g. `SessionStateAssertions.window_state(pid, chan)`), so a state-shape change is a 1-file test fix. Enforce direction-of-travel: new tests assert via wire output/PubSub/snapshot; `:sys.get_state` only via the helpers. Split `server_test.exs` along the same seams as the planned server.ex extraction (window-state, presence, labels/correlation) so test files move with their modules; note `event_router_test.exs` already proves the codebase can do 4.4k lines with **zero** `:sys.get_state`.

### A4. Adding an IRC verb costs ~26 files across ~14 layers, with the 3-layer command-plumb triplet and per-verb numeric collection as the reducible core
**Concern:** Extension & maintainability
**Scope:** `lib/grappa/irc/client.ex`, `lib/grappa/session.ex`, `lib/grappa/session/server.ex`, `event_router.ex`, `numeric_router.ex`, `wire.ex`, `grappa_channel.ex`; cic: `slashCommands.ts`, `compose.ts`, `api.ts`, `socket.ts`, `userTopic.ts`, component + CSS; e2e
**Severity:** MEDIUM
**Problem:** Measured: `b2cf231a` (#127, `/info` `/version` `/motd`) = 26 files, +1,209 lines; `356d0050` (#221, `/who <mask>`) = 8 files even as a fix. The per-verb cost decomposes into (a) a hand-written delegate triplet — `Session` public fn → `Server` handle_call → `Client` send fn — that is pure boilerplate per verb, and (b) per-verb "accumulate numerics until END numeric, then emit bundle" logic in `event_router.ex` re-derived each time (`whois_bundle`, `lusers_bundle`, `who`, `motd`… same shape, separate arms).
**Impact:** Every layer miss is compile-loud (good — this is why it's MEDIUM not HIGH), but the count itself deters small verbs, and each new bundle arm grows the two hub files (A5). The cic side additionally hand-writes a narrower arm per reply event (A6).
**Recommendation:** Extract the generic "solicited numeric bundle" collector: a declarative spec per verb (`%{start: 371, lines: [...], end: 374, wire: &Wire.info_bundle/1}`) driven by one collection engine in `EventRouter`, so a new read-only verb declares data instead of writing a router arm. The `Session`→`Server`→`Client` triplet is harder to collapse without macro magic (which this codebase rightly avoids) — accept it, but document the 14-layer checklist once (a `docs/` "adding a verb" recipe or a DESIGN_NOTES anchor) so the count stays mechanical rather than archaeological.

### A5. Feature funnel: every feature transits the same four hub files, which are growing without bound
**Concern:** Extension & maintainability
**Scope:** `lib/grappa/session/server.ex` (4,699), `lib/grappa/session/event_router.ex` (3,286), `cicchetto/src/lib/api.ts` (2,968), `cicchetto/src/lib/userTopic.ts` (1,213, containing TWO per-kind switches — narrower + handler), `grappa_channel.ex` (1,613)
**Severity:** MEDIUM
**Problem:** In the #247 series, all three server commits touched `server.ex` + `event_router.ex`; the cic commit touched `api.ts` + `userTopic.ts` + `compose.ts`. The same holds for #127 and #221. Extraction of pure sub-modules has started (`NumericRouter` 672 lines, `WindowState` 309, `Presence` 201 — all clean) but the hubs keep absorbing the dispatch arms, so concurrent sessions (this project explicitly runs several) collide in the same files, and file-level navigation cost grows linearly with features.
**Impact:** Merge/rebase contention across concurrent worktrees; review diffs dominated by hub-file noise; the "copy the nearest pattern" failure mode gets worse as hubs mix more concerns per screen.
**Recommendation:** Continue the established decomposition direction with dispatch-table seams: `event_router.ex` arms that only accumulate-and-emit should live beside their Wire verb (per-feature `Session.Handlers.Notify`-style modules registered in one table), leaving the hub as routing only. In cic, split `userTopic.ts`'s narrower switch per feature domain (the file's own comment already designates `wireNarrow.ts` as "the precedent for future per-topic narrowers" — follow it). No big-bang: adopt "new arms go in feature modules" and move old arms opportunistically — but per the repo's own total-consistency rule, schedule the completion, don't leave it half-migrated.

### A6. New event kinds are tsc-loud everywhere except the hand-written runtime narrower, which is the one drop-on-miss layer
**Concern:** Extension & maintainability
**Scope:** `cicchetto/src/lib/userTopic.ts` (61 `return null` sites), `wireNarrow.ts`, `wireTypesAssert.ts`, `scripts/check.sh` codegen gate
**Severity:** MEDIUM
**Problem:** The kind pipeline is impressively gated: server `Wire` typespec → `mix grappa.gen_wire_types --check` (CI drift gate) → `wireTypesAssert.ts` structural pins → tsc-exhaustive presence maps (`MESSAGE_KIND_PRESENCE`, `UPLOAD_ACTIVE_HOST_PRESENCE`) → `assertNever` handler switches. But the runtime *narrowers* (payload validation arms) are hand-written per event, duplicate the shape the codegen already knows, and fail only at runtime (drop + console log). Message kinds got a bespoke tsc pin (S14) precisely because a forgotten narrower silently dropped a whole kind — that fix was per-incident, not per-class; a new user-topic event kind whose narrower arm is forgotten still ships and drops every payload until someone reads the console.
**Impact:** The weakest link defines the cost: authors must remember one runtime-only touch point in a pipeline that is otherwise compile-time-loud, and each narrower is ~10 lines of shape-checking boilerplate that must be kept in sync with the generated type by hand.
**Recommendation:** Either (a) generalize the S14 presence-map trick: one `Record<UserTopicKind, (r) => Event | null>` narrower table typed against the union, so a missing arm fails tsc — this converts 61 scattered `return null`s into a table and closes the class; or (b) have `gen_wire_types` emit runtime guards alongside types (it already has the full shape). Option (a) is a cic-only afternoon; option (b) is the durable fix if narrower count keeps growing.

### A7. Admin-resource nginx allowlist: single-sourced now, but the regex is unverified against the router and the authority doc points at the old shape
**Concern:** Extension & maintainability
**Scope:** `infra/snippets/locations-api.conf` (lines 112, 150), `infra/nginx.conf`, `infra/freebsd/nginx.conf`, `infra/freebsd/jail_install_nginx.sh`, `cicchetto/e2e/compose.yaml` (mounts `../../infra/snippets`), `lib/grappa_web/router.ex`, `CLAUDE.md`
**Severity:** MEDIUM
**Problem:** The landmine was half-defused by `15392923`: one snippet, `include`d by prod docker nginx, FreeBSD jail nginx (copied at install by `jail_install_nginx.sh`), and the e2e nginx (bind-mounts the real `infra/snippets` — genuinely shared). What remains: (1) the admin regex (`location ~ ^/admin/(visitors|sessions|…|test)(/|$)`) and the REST allowlist regex are still hand-maintained lists with no check that every `router.ex` route is covered — a new resource missing from the regex 404s **at the proxy**, invisible to the entire Phoenix test suite, surfacing only if an e2e spec happens to hit it; (2) the jail gets a *copy* at install time, so snippet edits don't reach prod until the install script re-runs — whether deploy-m42 re-runs it is not verifiable from the repo alone; (3) CLAUDE.md still teaches the pre-snippet two-file workflow (see A2).
**Impact:** The failure mode is the worst kind for this review's rubric: silent on miss, environment-specific (test proxy vs prod proxy drift if the jail copy is stale), and now contradicted by the instruction file that's supposed to prevent it.
**Recommendation:** Add a drift pin (the repo's own idiom): a test that reads `infra/snippets/locations-api.conf`, extracts the two regex alternation lists, and asserts every top-level path prefix in `GrappaWeb.Router` (API scope + `/admin` scope) matches — `test/grappa/deploy/preflight_test.exs` proves infra-file-parsing tests are accepted practice here. Update the CLAUDE.md passage to name the snippet. Confirm/deploy-script the jail copy step so snippet edits can't strand.

### A8. New window-state cost is low server-side but the per-topic vs user-topic broadcast decision is a runtime-silent fork
**Concern:** Extension & maintainability
**Scope:** `lib/grappa/session/window_state.ex`, `server.ex` (`apply_effects`, `broadcast_window_state_dual/3`), `cicchetto/src/lib/windowState.ts`, `userTopic.ts`, `subscribe.ts` pre-subscribe loop
**Severity:** MEDIUM
**Problem:** The storage side is in good shape post-decomposition (`WindowState` struct, 5 mutators, `to_wire/3` single-source snapshot that raises FunctionClauseError on an unhandled state — loud). The structural trap is the topic split: chicken-and-egg states (`:pending`, `:invited`) must broadcast on the *user* topic because cic hasn't subscribed per-channel yet; post-subscribe states go per-channel. A new state author who picks the wrong topic gets an event that is emitted, wire-valid, type-correct — and never received, because no one is subscribed. Nothing at compile time or test time forces the decision; the rule lives in comments and the CLAUDE.md invariant (which, per A2, has already drifted once on this exact enum).
**Impact:** The cheapest-looking extension point in the system (CLAUDE.md: "cic just mirrors") hides its one silent failure mode exactly where a future `:locked`-style state would step on it.
**Recommendation:** Encode the decision in the type: make the emit go through one function whose spec takes `state :: pre_subscribe | post_subscribe` (or derive it from a `@pre_subscribe_states` list in `WindowState` that `to_wire/3`'s `{:error, :not_tracked}` clause *also* derives from — today those two facts are maintained separately and can disagree). One list, two consumers, and the fork becomes data instead of tribal knowledge.

### A9. DESIGN_NOTES.md at 25,844 lines is grep-only working memory with durable contracts buried inside
**Concern:** Extension & maintainability
**Scope:** `docs/DESIGN_NOTES.md`
**Severity:** LOW
**Problem:** The append-only decision log has grown to ~26k lines. That's fine for its stated role (chronological log, grep-to-find), but several *load-bearing current contracts* (snapshot/event byte-identicality, topic routing rules, per-feature caps like the 64-entry notify limit) exist only as entries somewhere in the stream, duplicated into moduledocs at varying freshness (A2 shows the duplication drifts). The doc's usefulness now depends entirely on knowing the right grep term.
**Impact:** Rising cost-to-answer "what is the current rule?" vs "what was decided in June?"; the two questions have different homes but one file.
**Recommendation:** No restructuring of the log itself (append-only is the right design). Instead enforce the direction the docs map already states: current-contract text lives in the owning moduledoc/CLAUDE.md with the DESIGN_NOTES entry as *history pointer* only — and for the handful of cross-boundary contracts, prefer drift pins (A2) over prose. Consider an index header (topic → date anchors) regenerated occasionally; 20 lines of index removes most of the grep tax.

---

**Verified clean (one line each):**
- **Wire codegen pipeline** — `mix grappa.gen_wire_types --check` in `scripts/check.sh` + `wireTypesAssert.ts` structural pins + tsc-exhaustive maps + `assertNever` switches make message-kind addition high-touch (~7 files) but loud at every layer except the one flagged in A6.
- **New-context cost** — `Grappa.Notify` (`31bcc24d`): 5 files (context, schema, wire, migration, test), in-module `use Boundary`, zero supervision-tree or application.ex touch; REST surface was a further clean 6-file commit. This extension point is genuinely cheap.
- **NumericRouter** — pure data routing matrix with documented priority order and a safe `$server` fallback ("no silent loss" posture); unknown numerics degrade visibly, not silently.
- **nginx location surface** — single snippet shared by prod docker, jail, and e2e (e2e bind-mounts the real file), a textbook fix of the two-copy landmine (residual gaps in A7).
- **`event_router_test.exs`** — 4,400 lines, zero `:sys.get_state`, fully boundary-driven; proof the outcome-shaped style scales in this codebase.
- **e2e/full-suite ship gate** — the `scripts/integration.sh`-green-before-ship rule plus the scoped-grep incident writeup (#268) shows the test-gate culture is self-correcting.
