# Architecture Review — 2026-08-15

**Base:** `main` @ `575e203a`.
**Method:** 6 concern agents per `.claude/skills/review` (architecture mode), dispatched in parallel, each following its concern across the whole tree — server and client — rather than a directory. Read-only: no `mix`, no `bun`, no docker, no `mix boundary.find_violations`, so every claim is derived from source and from counted greps. Counts below are commands the agents ran, not estimates.
**Previous review:** 2026-07-20 (26 days).

## Severity summary

| Concern | CRITICAL | HIGH | MEDIUM | LOW | Findings |
|---------|---------:|-----:|-------:|----:|---------:|
| Abstraction boundaries | 0 | 4 | 7 | 3 | 14 |
| Responsibility & cohesion | 0 | 4 | 10 | 2 | 16 |
| Duplication | 0 | 3 | 6 | 6 | 15 |
| Dependency architecture | 0 | 2 | 5 | 3 | 10 |
| Type system leverage | 0 | 3 | 5 | 5 | 13 |
| Extension & maintainability | 0 | 5 | 5 | 3 | 13 |
| **Total** | **0** | **21** | **38** | **22** | **81** |

Zero CRITICAL. Three findings recur across five of the six concerns and are really one finding seen from five angles: **the wire codegen was built, proved itself, and stopped at the admin surface.** 162 runtime schemas are generated, CI-gated and formatted; **3** are imported. 165 types are generated; **73** have no consumer, including all three auto-emitted discriminated unions. Meanwhile ~1,150 hand-transcribed narrower lines still stand at the user-topic and per-channel boundaries — the two highest-traffic surfaces — and one of the unpinned arms (`isupport_changed.frame_budget_base`) has already drifted. The #429 entry records that the previous hand transcription silently lost an entire arm and blanked a tab; the mechanism that fixes that class is sitting unused next to the code that still has it.

Two premises from the 2026-07-20 review were **re-measured and retracted** rather than restated, which is the other thing worth reading this document for: the `:sys.get_state` pin tax is gone (98 → 7 occurrences), and hub concentration is flat, not rising (server hubs 20.8% → 20.0% of `lib`, client hubs 20.8% → 17.3%) — the hubs are growing *with* the codebase, not faster than it. What is real is absolute width: `Session.Server` is 7,230 lines with an 83–87-key state map, up 54% in 26 days.

## Triage — must-fix (all HIGH)

| # | Finding | Bucket |
|---|---------|--------|
| H1 | Abstraction A1 — `EventRouter` declares a 4-key state contract and reads 32 fields; `optional(any())` makes Dialyzer accept all of them | A session-decomposition |
| H2 | Abstraction A2 — five reply-bundle accumulators cross three modules as bare `map()`, with 43 `Map.get` reads against a fully-typed output | B accumulator-types |
| H3 | Abstraction A3 — `Grappa.Subject` is the declared SSOT for the subject discriminator and is adopted by three contexts of five; three spellings of one XOR predicate | C subject-SSOT |
| H4 | Abstraction A4 — the codegen's membership rule is a FILENAME glob, and `Push.Payload` is already outside it with a hand mirror on both sides | D wire-codegen |
| H5 | Responsibility A1 — every sub-machine extraction took the pure half and left a bespoke interpreter; two private effect vocabularies `apply_effects/2` cannot see, eight hand-managed timer fields | A session-decomposition |
| H6 | Responsibility A2 — no outbound-line door: 24 free-form send sites against 6 NickServ-capture sites, enforced by comment | E outbound-door |
| H7 | Responsibility A3 — user login policy lives in a 888-line controller while visitor login policy lives in a context; one job, two homes | F login-policy |
| H8 | Responsibility A4 — `compose.ts` is the composer store, the send pipeline and a 59-arm command table in one 2,345-line module | G client-layering |
| H9 | Duplication A1 — 162 generated runtime schemas, 3 used; ~1,150 hand-narrower lines still standing | D wire-codegen |
| H10 | Duplication A2 — six test helpers re-declared 12–20× each; two have already drifted, and the `user_fixture` copies bypass the shared helper's whole reason for existing (Argon2 cost) | H test-harness |
| H11 | Duplication A3 — 60+ copies of nine e2e helpers; 20 admin-login copies under two names, all missing the shared helper's user-topic barrier | H test-harness |
| H12 | Dependency A1 — the `Networks → Session` inversion is unfixed and its escape-hatch population grew in every dimension: 7→10 injected closures, 3→5 `dirty_xrefs`, 2→3 DI seams, 3→4 mechanism kinds | I dependency-inversion |
| H13 | Dependency A2 — one problem ("a boundary needs only a schema") now has three mutually incompatible resolutions, and the correct one (#415) is the least represented | J boundary-schemas |
| H14 | Type leverage A1 — 73 of 165 generated types and 159 of 162 schemas unconsumed; the hot path is still hand-written | D wire-codegen |
| H15 | Type leverage A2 — eleven numeric-bundle accumulators as bare `map()`, 19 producer sites against 43 reader sites joined only by atom spelling | B accumulator-types |
| H16 | Type leverage A3 — 83 `as`-casts on `.json()` at the REST edge while the WS edge narrows from `unknown`; one wire, two disciplines | K rest-boundary |
| H17 | Extension A1 — the runtime-schema codegen stopped at 3 of 162, so two narrowing patterns coexist for one job | D wire-codegen |
| H18 | Extension A2 — a new scrollback kind costs a 267-line `messages` table-recreate, because the CHECK constraint duplicates the `Ecto.Enum` | L enum-cost |
| H19 | Extension A3 — the window-state set is restated in six hand-maintained places, none derived, none gated | M closed-sets |
| H20 | Extension A4 — `Session.Server` at 7,230 lines / 87 state keys, with a 12,491-line test file as the merge-conflict epicentre | A session-decomposition |
| H21 | Extension A5 — one new IRC verb still costs 23 files across five mechanical plumbing layers | N verb-plumbing |

## Triage — gating MEDIUMs

- **A session-decomposition:** Responsibility A6 (channel-directory ETL living inside the session GenServer — 4 state fields, a timer, ~250 lines of a foreign domain on the hottest process), A5 (005 parsed twice with two different merge rules).
- **D wire-codegen:** Abstraction A7 (six client-consumed REST shapes hand-written on both sides, including an `addressing` block the server computes on every request that no client can see or type), Duplication A6 (14 unpinned `WireUserEvent` arms), Type leverage A4 (wire payload typespecs authored outside Wire modules — `grappa_channel.ex` contains both patterns twelve lines apart).
- **C subject-SSOT / J boundary-schemas:** Dependency A2's three populations; 13 boundaries take a full `Grappa.Accounts` dep to name one struct.
- **G client-layering:** Abstraction A8 (`api.ts`: 3,159 lines, 89 exports, 94 importers, holding transport + the shared type vocabulary + domain derivations + a module-global 401 hook), A9 (a flat 218-module `lib/` with no layer distinction — four spellings of the join verb, two of which fold the channel differently), Responsibility A9 (admin components own fetch/state/error while the chat surface has a store layer), Dependency A5 (29 of 91 components reach past their stores into `api.ts`).
- **E outbound-door / H additive-contract:** Responsibility A2's 24 sites.
- **K doc-reality:** Dependency A8 (CLAUDE.md's tree still omits `SourceAliasManager`, whose slot is the single most explained in `application.ex`, and the composition-root DI it performs is documented nowhere), Extension A11 (`CLIENT_PROTOCOL.md` is a per-wire-change hand mirror with no gate at all, while its machine-readable twin is generated and gated).
- **M closed-sets:** Type leverage A8 (the theme vocabulary declared five times across two languages, pinned only to itself on each side), Duplication A5 (same, from the duplication angle), A8 (upload MIME taxonomy: three server copies CI-pinned, the fourth cross-language copy pinned by a comment), Extension A8 (`CONTENT_KIND_PROJECTION` — the one pair CLAUDE.md singles out as THE single source — held together by prose).
- **L enum-cost / N verb-plumbing:** Extension A6 (controller rendering is a hard 9/30/0 two-pattern split with no stated rule), A7 (the Logger allowlist is 306 lines / 47% of `config/config.exs`, and a one-directional sync test forces four self-documented dead entries into it).
- **Duplication A4:** one `SessionEntry` projected to `live_state` three times, already diverged on the `peer_*` fields, with a client comment asserting the opposite and four dead aliases hiding it. **⚠️ Partly falsified 2026-08-18 — the server-side split is a recorded scoping decision (`DESIGN_NOTES.md:23673`) and is NOT a finding; only the client comment + dead aliases survive. See the annotation under "Concern: duplication".**
- **Client hygiene:** Dependency A3 (the one client import cycle is unchanged from the last review, and `biome.json` still does not enable `noImportCycles` — the codebase already paid for this class once and wrote the post-mortem), A4 (`lib → component` inversions, one of them a hand-rolled twin of a generated wire type living in the view layer).

LOW findings (22) are improvement opportunities — see each concern's section.

**Security.** Hardening items are tracked out of band and are deliberately absent from this document.

---

## Concern: abstraction boundaries

**A1 (HIGH).** `EventRouter`'s declared input contract (`lib/grappa/session/event_router.ex:101-107`) names 4 required keys plus `optional(any()) => any()`; the module reads or writes **32** distinct fields of `Session.Server`'s 84-key state (`server.ex:561-956`). The catch-all makes Dialyzer accept every one. The contrast is in the same directory: `NumericRouter` takes a narrow projected view — 4 required keys built by an explicit constructor `new_router_state/4` (`numeric_router.ex:171-176`, `:853`). Same problem, opposite solution, sibling modules. Renaming a `*_pending` field produces no compile error and no warning, only a `nil` at runtime in whichever bundle arm drains it — and the declared contract actively misleads a reader into thinking `EventRouter` is reusable for the Phase-6 facade. **Fix:** apply the `NumericRouter` pattern — an explicit projection built by `Session.Server`, with the real field set enumerated and the catch-all dropped. Two slices (the ~14 accumulators, then the rest) is tractable.

**A2 (HIGH).** The five reply-bundle accumulators are typed `map()` across the whole path: `EventRouter` accumulates into `state.*_pending` (55 references), emits `{:whois_bundle, target, accum :: map(), reply_to}`, and `Session.Wire` unpacks with **43 `Map.get(accum, :key)` calls** — `whois_bundle/3` alone reads 30 keys. The OUTPUT type is fully declared and codegen-mirrored; the shared contract between writer and reader is not. A key typo yields `nil`, which the wire renders as `null`, which the generated TS says is legal — so the client cannot distinguish "the server does not know" from "the peer is not idle". This is the same failure #429 identified one layer up, still open one layer down. **Fix:** five `@type *_accum` declarations next to their `*_payload` twins in `Session.Wire`, referenced by the effect arm and the builder parameter. Bodies unchanged; a writer-side typo becomes a Dialyzer failure. Start with `whois_accum` (30 keys, widest fan-in).

**A3 (HIGH).** `Grappa.Subject`'s moduledoc declares it the SSOT for the `{:user, uuid} | {:visitor, uuid}` discriminator and says `subject_where/2` was "promoted" from the per-context privates. The promotion never finished: `Notify`, `QueryWindows` and `UserSettings` use it (24 call sites); `Scrollback` keeps a private `subject_where/2` (`scrollback.ex:1135`, 13 call sites) and does not reference `Grappa.Subject` at all; `ReadCursor` keeps a third spelling, `subject_filter/2` (`read_cursor.ex:820`), plus a private `subject_attrs/1` duplicating `put_subject_id/2`; and four modules re-declare the type literal verbatim. Neither holdout would create a cycle by depending on `Subject`. Three spellings of one XOR predicate over the most safety-relevant partition in the system — the per-subject isolation boundary. **Fix:** delete the two private spellings, add the dep, replace the four literal re-declarations with `Subject.t()`. One commit, no behaviour change, and the "promoted to" sentence becomes true.

**A4 (HIGH).** Membership in the wire codegen walk is decided by FILENAME (`gen_wire_types.ex:91`, `lib/grappa/**/*wire.ex`, widened once by hand for `error_tokens.ex`). `Grappa.Push.Payload` (`push/payload.ex:76-82`) is a client-consumed wire contract in every respect — including an `optional(:badge)` the emitter handles — but the file is called `payload.ex`, so the client hand-maintains a mirror plus a hand-written narrower. DESIGN_NOTES 2026-07-04 records this as "`push` has no `wire.ex` (hand-written type) — `gen_wire_types --check` green": **the gate reporting green is the symptom.** Two hand copies on the one surface where an old client genuinely meets a newer server (an installed service worker can be many deploys behind). **Fix:** rename or add to `@extra_globs`, and make membership declarative rather than nominal — a `@wire_contract` marker plus a test that every type reachable from a channel push or a `json(conn, …)` carries it. Otherwise A7 keeps recurring.

**MEDIUM.** **A5** — three cic modules (`readCursor.ts:253`, `serverSettings.ts:132`, `userSettings.ts:72`) bypass `readError`, the decoder whose own doc says duplicating it "would silently skip the dead-token detection"; `userSettings.ts` builds the error from HTTP `statusText`, so `friendlyApiError` falls through to the generic arm. **A6** — `RawNetwork` + `tagNetwork` (`api.ts:495-560`) re-declare and re-validate at runtime exactly what the generated discriminated union already guarantees, on `GET /networks`, the boot fetch that seeds the sidebar; the tolerance it defends is three months and one codegen generation old. **A7** — six client-consumed REST shapes hand-written on both sides (TOTP enrolment, passkey options/status, admin uploads, admin settings), including `admin/settings_controller.ex:321`'s half-Wire, which calls `ServerSettings.Wire.upload_view/1` then hand-assembles a sibling `addressing:` block that no client can see or type. **A8** — `api.ts` is 3,159 lines / 87 exports / 112 types imported by 34 of 79 components, holding transport plus the shared type vocabulary plus domain derivations (`ownNickForNetwork`, `displayNick`, `isContentKind`) plus a module-global 401 hook; the domain helpers are why every component imports the transport module. **A9** — `cicchetto/src/lib/` is a flat 218-module namespace with no layer distinction, and the shared-verb rule is already fraying: four spellings of the join verb, two of which differ on whether the channel is folded (`DirectoryPane.tsx:121` folds with a five-line #731 comment; `HomePane.tsx:86` passes the raw name, safe only because the server happens to store folded channels). **A10** — `compose.ts`'s 59-arm switch transitively imports nearly the whole client, which is why the `queryTopicJoin.ts` indirection exists at all. **A11** — `UserSettings`' key registry exists twice as prose, in two states (10 keys vs 6), and nowhere as code; nothing can enumerate the key set.

**LOW.** **A12** — 162 generated runtime validators, 3 wired (a declared #429 follow-up; flagged as debt, not a design flaw). **A13** — channel `{:reply, …}` payloads bypass the Wire convention at four sites, including one projecting an internal cache shape at the WS edge. **A14** — `ownNickForNetwork(net, me)` keeps a parameter it no longer uses, forcing every caller to thread `me()` to satisfy a dependency that is gone.

---

## Concern: responsibility & cohesion

**A1 (HIGH).** `Session.Server`: **7,230 lines, 83 state fields, 108 callback clauses, 219 private functions, 34 `apply_effects/2` clauses.** Three early extractions (`AuthFSM`, `EventRouter`, `NumericRouter`) moved real behaviour out and left one shared interpreter. Every extraction after them moved only the data or the pure predicate and left a bespoke interpreter inline: `GhostRecovery.step/2` and `RecoverIdentity.step/2` both return `{verdict, next, lines}` — a **second, private effect vocabulary** `apply_effects/2` cannot see — so the host carries two hand-written runners of identical shape, plus the same shape again for away, presence and perform/identify. Each owns its own timer field: **eight** timer refs on one state map, each cancelled by hand at each terminal (`server.ex:4585`'s #676 comment documents a release wired to one of two terminals). **Fix:** make the sub-machines emit into the existing `EventRouter.effect()` union and route them through `apply_effects/2` (`{:reply, line}` already exists), then extract one `Session.SubMachine` runner parameterised by `{fsm_module, state_field, timer_fields}`.

**A2 (HIGH).** There is no outbound-line door. **24** free-form send sites (`Client.send_raw` ×9, `send_line` ×8, `send_privmsg` ×5, `send_notice` ×2) against **6** `capture_outbound_ns_secret/2` sites. Whether an outbound line carrying a NickServ password is staged for commit-on-`+r` depends on whether the author of that call site remembered; two comments are the enforcement mechanism, and the generic `{:reply, line}` arm at `server.ex:5925` sniffs nothing. A new outbound path that can carry user text silently drops out of the capture with no failure signal — the symptom arrives later as "my saved password disappeared". **Fix:** one private `send_outbound(state, line)` running the sniff then the send, called by `flush_lines/2` and the `{:reply, _}` arm. Leave the typed verb helpers alone — they cannot carry a password, and that distinction is the real domain boundary.

**A3 (HIGH).** One job, two homes, chosen by subject kind: visitor login policy is a context module with a documented state machine (`visitors/login.ex`, 827 lines); user login policy is a `defp` chain inside `auth_controller.ex` (**888 lines, 67 functions**, including the second-factor ladder, challenge minting, throttles and 21 `visitor_error_response/1` clauses), composing `Accounts`, `TOTP`, `WebAuthn`, `Phoenix.Token` and `LoginThrottle` itself. `Grappa.Accounts` has primitives only and no login orchestration. So the user ladder is unreachable from anywhere but an HTTP action, untestable without a `conn`, and every new failure mode edits a controller. **Fix:** lift it into `Grappa.Accounts.Login` as the sibling of `Grappa.Visitors.Login`, taking a plain input map and returning a tagged outcome; the error clauses move to `FallbackController` where the rest of the token vocabulary lives. *(Placement finding only — no weakness asserted in the ladder itself.)*

**A4 (HIGH).** `compose.ts` (2,345 lines) is three jobs, and the biggest is one function: `submit`'s `switch` has **59 arms** covering 49+ IRC verbs, fanning out to REST posts, ~20 WS pushes and modal openers, while the same module owns the per-window composer store and the send pipeline. The verb closed-set is declared twice — once as `parseSlash`'s kind union in `slashCommands.ts`, once as these case labels. **Fix:** keep `compose.ts` as store + pipeline; move dispatch to `lib/commands/` with one handler per verb family taking an explicit context record rather than closing over `submit`'s locals.

**MEDIUM.** **A5** — 005 parsed in two places with two different merge rules (`ISupport.merge_isupport/2` last-wins vs `Session.Server`'s two `reduce_while` scanners first-wins-within-a-line), a divergence held only by a comment, while `ISupport.raw` already archives both tokens. **A6** — channel-directory ingestion is a full ETL pipeline (parse, buffer, throttle, tally, terminal) living inside the session GenServer: 4 state fields, 3 compile-env constants, a watchdog, 7 private functions, ~250 lines of a foreign domain on the hottest process, with the wire vocabulary split across two modules. **A7** — `GrappaChannel` (2,082 lines) is both the inbound verb router (39 clauses) and the cold-subscribe snapshot assembler (12 `push_*` functions across seven contexts), so "what a freshly-attached client must know" is a domain question with no domain home and can only be exercised through a channel test. **A8** — `api.ts` as the HTTP client + REST type library + global handler registry (see abstraction A8). **A9** — admin components own fetch, state and error mapping (`AdminNetworksTab.tsx`: 1,286 lines, 12 signals, 16 direct API calls across four resources) while the chat surface has a store layer and `ScrollbackPane.tsx` makes **zero** API calls; admin behaviour is therefore only testable through the DOM, and refetch-after-mutate is re-derived 16 times in one file. **A10** — `ScrollbackPane.tsx` (3,985 lines) is a renderer, a scroll-authority machine and a read-cursor policy sharing one closure; the pure per-kind renderer (700 lines, no component state) is welded to the machine only by file position. **A11** — read-cursor advancement has four doors, and the one documented as "the single door for cursor advancement" is bypassed by three; each bypass re-derives a different subset of the two guards. **A12** — REST envelopes are shaped in controllers (37 inline literals across 21 controllers) while WS payloads are shaped in `*.Wire`, so the two doors have different drift-detection guarantees for the same domain data. **A13** — `Bootstrap` is a Task doing three boot jobs (config invariant, outbound-pool install, spawn loop), hiding ordering the supervision tree is supposed to state; `Grappa.OutboundV6Pool` appears in no tree. **A14** — `SettingsDrawer` is half-extracted: six panels are components, ~8 remain inline with 37 signals in one closure.

**LOW.** **A15** — `UserSettings` has become a generic per-subject KV store (10 unrelated preference domains, plus a network-addressing key that is not a preference at all), and exactly one setter broadcasts. **A16** — `host_candidates/0` computes a `Vhosts`/`Net` domain rule inside an admin controller.

---

## Concern: duplication

**A1 (HIGH).** The generated runtime validator is 98% unused: `wireSchema.ts` is 1,571 lines / **162** `S_*` consts, of which **3** are imported, while ~1,150 hand-transcribed narrower lines still stand (`userTopic.ts:174-1021` — 848 lines, plus five narrowers in `wireNarrow.ts`). #429 emitted the schema for the *entire* Wire surface from the same typespec walk, under one `--check` gate, precisely so the hand narrowers could be deleted; the migration took the admin channel (3 shapes) and stopped. The entry also settles the objection: exactly three of ~30 arms needed a hand-written tolerance, and all three are wrappers *around* `validate(S_…)`. **Fix:** continue the slices — `narrowChannelEvent` next, then `narrowUserEvent` — reusing the `wireAdminBoundary.test.ts` mutate-every-field harness, dropping each hand transcription in the same commit. If a slice will not land soon, make the unused-generated count visible at `--check` time.

**A2 (HIGH).** Six test helpers re-declared 12–20× each while the shared modules exist: `user_fixture` ×12, `network_fixture` ×6, `visitor_fixture` ×4, `passthrough_handler` ×19, `start_server` ×20, `await_handshake` ×13, `admin_session` ×14. Two have already drifted. Every local `user_fixture` goes through `Accounts.create_user/1`, i.e. a real Argon2 hash — which is exactly what `AuthFixtures`' moduledoc exists to prevent ("the ~100 ms Argon2 cost is the dominant sqlite-contention contributor under the test suite"), so ~350 call sites take the slow path none of them needs. `await_handshake` waits on `"USER "` in one file and `"USER"` in the other twelve. The structural cause is that `DataCase` does not import `AuthFixtures`, so a context test reaching for a user has no shared helper in scope. **Fix:** import it in `DataCase`, delete the 22 fixture copies, promote the three IRC helpers into `Grappa.IRCServer` and `admin_session/0` into `AuthFixtures`.

**A3 (HIGH).** 60+ copies of nine e2e helpers. `adminLogin` ×12 byte-identical, plus `adminFriendlyLogin` ×8 — **the same body under a second name**, so a reader grepping one finds 12 of 20 sites. `fetchScrollbackPage` ×10 has already forked three ways on the base URL (two inline hardcodes, one spec-local constant, and the exported `GRAPPA_BASE_URL` that none of them use) and two ways on the return type, while `grappaApi.ts` already ships the three verbs these copies re-implement. The concrete cost is a flake source: `loginAs` learned a `waitForUserTopicReady` barrier (`cicchettoPage.ts:167-172`) and the 20 hand copies stop at `expectShellReady`. **Fix:** one `adminLogin` in the fixtures; move `findVjtUserId`/`setAdminFlag`/`adminPatchCaps`/`bootVisitor` into `grappaApi.ts`; delete `fetchScrollbackPage`/`seedCursor` in favour of the existing helpers.

**MEDIUM.** **A4** — one `SessionEntry` projected to `live_state` JSON three times (`live_introspection/admin_wire.ex:126`, `visitors/admin_wire.ex:139`, `credentials/admin_wire.ex:210`); the two private copies are byte-identical to each other and the owner's is a strict superset (`peer_address`, `peer_port`, `peer_name`), so the operator sees the upstream endpoint on `/admin/sessions` and not on the other two, for no stated reason — while a client comment asserts the opposite and four dead `api.ts` aliases hide it. **A5** — the theme token vocabulary declared five times (server `@color_keys`/`@font_families`/`@size_modes` plus four TS declarations), with only one pair pinned, and pinned to each other rather than to the server. **A6** — 18 hand-inlined union arms have no `wireTypesAssert` pin, and `isupport_changed.frame_budget_base` has already drifted (`number | null` vs `number` vs `integer()`); with no pin, a deliberate widening and an accidental one look identical. **A7** — nine `fetch` sites hand-roll the error shape `readError` owns, inside files whose sibling functions already call it; the hand-rolled `err.code` is `"Unauthorized"`, which is not a member of the generated token set, so `friendlyApiError` cannot map it. **A8** — the upload MIME taxonomy has three server copies with a CI pin and a fourth cross-language copy pinned only by a comment. **A9** — three homes for cic unit tests (246 / 23 / 14 files) with three literal same-name pairs both running, written at different times against overlapping surfaces with different mocks.

> **⚠️ A4 — FALSIFIED IN PART, post-review (2026-08-18, measured on `main` @ `ba1bdc20`).**
> The clause **"for no stated reason"** is false, and the server-side half of A4 is
> therefore **not a finding**. `docs/DESIGN_NOTES.md:23673`, inside
> `## 2026-07-30 — #550: the upstream peer each session landed on (netsplit triage)`,
> states the scope decision verbatim: *"Scope is the **Sessions tab** (the
> netsplit-triage door): the operator CLI text formatter (`Grappa.Operator`) and the
> visitors/credentials admin tabs keep their existing `live_state` subset, and
> `peer_name` resolution is the Sessions controller's responsibility."* The three-way
> server split is a deliberate, recorded scoping call, not drift, and **must not be
> "aligned"** — a naive alignment is also technically wrong: `peer_name` is not a
> `SessionEntry` field at all (the Sessions controller resolves it through
> `Net.PtrCache`, #252), so the other two wires could copy two of the three fields and
> would have to synthesise the third.
>
> What survives is **only A4's last clause** — the client comment and the four dead
> `api.ts` aliases — and it survives *because* of the ruling, not despite it: the
> codegen already emits three distinct, correct per-owner types (`wireTypes.ts:587`,
> `:630`, `:1509`), while `api.ts:1831`/`:1833`/`:1875`/`:3087` flattens all three onto
> the owner's superset under a comment asserting the flattening is correct. All four
> aliases have **zero** consumers (`git grep -w` over `cicchetto/src` + `cicchetto/e2e`:
> every hit is the definition itself or the next alias in the chain), so the residue is
> a trap for the next author, not a live defect. Recorded here rather than only in the
> issue because this document still drives ~20 open buckets and a false premise left
> inside it re-raises itself.

**LOW.** **A10** — `MentionsRow` re-declares a generated, asserted type with `kind` widened to `string`, and the narrowed value is assigned straight into it. **A11** — `Mentions.mentioned?/3` and `matchesWatchlist` are two ports of one predicate pinned only transitively, through 11 truth-table rows that use ASCII bodies and no regex metacharacters — so the two escape tables and two flag sets are unexercised. **A12** — `monitor_targets/1` re-derives prefix-nick extraction that `IRC.Parser` owns, against the "one IRC parser" invariant. **A13** — the `refresh_plan` closure scaffold written twice (the rest of the SessionPlan split is correctly separate and should NOT be merged). **A14** — Notify's REST envelope still differs from its WS envelope, half-fixed since the last review. **A15** — `web_session_severed` is one wire discriminator naming two unrelated payloads, currently kept apart only by topic.

**Recorded as correctly separate or already closed** (so a future reader does not re-open them): the `should_notify` two-port predicate with its 44-row shared fixture — this is the model; the client nick fold (2026-07-19 S13 is **closed**, one `asciiFold` now); the three `Identifier` fold implementations (two are SQL twins byte-pinned by `IdentifierTest`); REST JSON views delegating to `*.Wire`; `Networks.SessionPlan` ↔ `Visitors.SessionPlan`; the deploy-script reload-verify duplication (2026-07-19 S6 is **closed**, hoisted into `deploy_common.sh`); the two surviving `chantypes` literals, both justified in the module header; and the three server-side MIME maps, CI-pinned to each other.

---

## Concern: dependency architecture

**A1 (HIGH).** The declared Boundary graph is acyclic — all 93 `use Boundary` blocks parsed, Tarjan run, **zero cycles**. But acyclicity is manufactured: counting `dirty_xrefs` as real edges produces exactly **5** cycles, all sharing one prefix, `Networks → LiveIntrospection → Session → {ChannelDirectory | Scrollback | Notify | QueryWindows | ReadCursor} → Networks`. Measured growth since 2026-07-20: injected closures on `Session.Server` 7 → **10**, `dirty_xrefs` for `Networks.Network` 3 → **5**, DI behaviour seams 2 → **3**, distinct mechanism *kinds* 3 → **4** (the supervisor-level `held_source_fn` added by #543), glue modules whose stated reason is the cycle 1 → 2. Neither of A1's two recommended extractions landed. The closures deserve separate weight: all 10 are `optional(...)` in opts and `| nil` in state, each guarded by `is_function(_, N)`, so an omitted injection is not a compile error, not a crash and not a log line — it is a persist that silently does not happen, which is the opposite of what Boundary buys. **Fix:** split the SURFACE, not the context — extract `Grappa.Session.Control` (`stop_session`, `start_session`, `whereis`, `connection_info`, `current_nick`, `send_quit`, `set_explicit_away`, `Backoff.reset`) as a leaf boundary; `Grappa.Session` can then take real deps and all 10 closures collapse into ordinary calls. Cheapest single step: move `AdminWire`'s live-state join up into `Grappa.Operator`, killing the shared prefix of all 5 latent cycles.

**A2 (HIGH).** One problem — "a boundary needs only a schema" — now has three mutually incompatible resolutions. #415 chose the right one (promote `Visitors.Visitor` to a `top_level?: true` leaf, retiring twelve waivers) and applied it to one of three populations: `Networks.Network` kept 5 `dirty_xrefs`, and `Accounts.User`/`Session` are named as a real dep by 24 boundaries of which **13 reference no `Accounts` function at all**. The result is worse than before #415 — three patterns where there were two, and the correct one is the least represented. `Grappa.Subject` is the sharpest illustration: a real dep on `Grappa.Accounts` for `User` and a real dep on the promoted `Visitors.Visitor` leaf, asymmetric treatment of the two halves of the polymorphism it models. **Fix:** finish it in one mechanical commit — promote `Networks.Network` and `Accounts.User`/`Session` the same way, narrow the 13 struct-only deps, and record the rule in CLAUDE.md next to the Boundary paragraph.

**MEDIUM.** **A3** — a full SCC over the 301-module client graph finds exactly one cycle of size > 1: `selection.ts ↔ windowState.ts`, unchanged from the last review, and `biome.json` still enables only `recommended`, so `noImportCycles` (nursery) is off. The codebase already paid for this class once and wrote the post-mortem in `selection.ts:336-345`. **A4** — the two `lib → component` inversions are unfixed, and one (`mentionsWindow.ts` importing `MentionsBundle` from a `.tsx`) is a hand-rolled sibling of a codegen-emitted type differing in a field name, with the drift gate pinning the element type but not the envelope. **A5** — 29 of 91 components reach past their stores into `api.ts`, because `api.ts` holds the domain derivations they actually want; the Admin surface has stores for its push-driven parts and none for its REST parts, so nine tabs hand-roll the same fetch/loading/error triad. **A6** — two live mechanisms for "bearer death closes the socket", each documented as the single path; `Revocations`' moduledoc says hand-pushing "is a rule and therefore something that drifts: it had, on most of the doors", and the hand-pushed calls were not removed, so several doors now fire both (benign — over-firing — but a reader cannot tell load-bearing from vestigial). **A7** — 11 `top_level?: true` boundaries live inside another boundary's namespace; several are correct carve-outs, but nothing distinguishes a deliberate one from a context internal, so the module name is unreliable in 11 places.

**LOW.** **A8** — CLAUDE.md's tree omits `Grappa.Net.SourceAliasManager`, whose slot is the single most explained in `application.ex` (after Endpoint for the boot reconcile, before Bootstrap because #543 sessions call `acquire/1` on connect) and whose composition-root DI (`application.ex:487`) is the best of the four cycle-avoidance mechanisms and documented nowhere. **A9** — client runtime DI slots are module-level mutable globals; two are well-argued cycle breaks, the third (`uploadHost.ts`) exists for test convenience and duplicates the bearer-storage key literal outside its owner. **A10** — `ReadCursor.force_set/4` bypasses the #233 advance-only clamp, ships in the prod release by its own admission, and is gated only at the route layer.

---

## Concern: type system leverage

**Prior-review deltas verified fixed and NOT re-reported:** `kind: String.t()` is gone from all 19 `wire.ex` + 10 `admin_wire.ex` modules; the codegen glob now covers `admin_wire.ex` and `error_tokens.ex`; `ErrorTokens` enumerates the wire-token space, is AST-drift-tested, and cic consumes the generated arrays; `FallbackController`'s spec no longer drifts from its clauses; the cic nick fold is byte-aligned with the server. The client has **zero** `any`, **zero** `@ts-ignore`, and 2 non-null assertions.

**A1 (HIGH).** 162 generated schemas, **3** referenced; 165 generated types, **73** with no consumer — including all three auto-emitted discriminated unions (`WireSessionEvent`, 37 arms; `WireScrollbackEvent`; `WireNetworksEvent`). The hot path is still a hand-transcribed 42-arm union plus a 42-arm hand narrower, while the generated 37-arm union sits unimported next to it; sampling the arms shows the divergence is comment volume, not shape. **Fix:** `WireUserEvent = WireSessionEvent`, then replace each narrower arm's `typeof` block with `validate(S_…)`, keeping only arms carrying a documented policy — `wireValidate.ts:18-31` already draws that line. Add a gate failing on a generated type with no importer.

**A2 (HIGH).** Twelve of the 83 state keys are `map()`, `nil | map()` or `%{_ => map()}`. For WHOIS alone: **19 producer sites** writing atom-keyed literals in `event_router.ex`, **43 `Map.get` reads** in `Session.Wire`, joined by nothing but the atom spelling. `Map.get(accum, :is_operator, false)` cannot distinguish "upstream said no" from "we misspelled the key". Dialyzer runs with `:underspecs` and catches none of it, because `map()` is inhabited by every map. **Fix:** eleven `@type`s next to the payloads they feed, referenced from the state type, the fold spec and the effect arm. Do all eleven or none.

**A3 (HIGH).** **83** `(await res.json()) as X` casts outside tests, against a WS edge that narrows everything from `unknown` — including the generic `api.ts:1608`, an unconstrained type parameter asserted from parsed JSON. cic deploys independently of the server, so a response one vintage behind is normal, and it lands as a type-checked value with a missing field that surfaces as `undefined` in a renderer rather than as a dropped-and-logged payload. **Fix:** route REST through the same `validate(S_X, raw)`; where a response envelope has no Wire module, that is the reason to create one.

**MEDIUM.** **A4** — 14 wire payload `@type`s authored outside Wire modules, and `grappa_channel.ex` contains both patterns twelve lines apart: `members_seeded_payload` correctly delegates to `SessionWire`, while two locally-widened copies of payloads `Session.Wire` already owns sit directly above. The 8 remaining `kind: String.t()` in `lib/` are all in these web files. **A5** — three `:map` columns never adopted the `Scrollback.Meta` pattern, and the prose registry standing in for one has already drifted (10 keys in one table, 6 in the other — and the stale one is the file whose own text says future additions MUST be documented there). **A6** — per-kind `meta` shapes remain prose-only, so `ScrollbackMetaT` is `Record<string, unknown>` and the client re-derives each contract with 5 casts and 12 probes at the busiest render path. **A7** — the wire is typed in one direction only: **33** inbound verbs are bare string literals server-side and `pushUserChannelVerb(event: string, payload: object)` client-side, while `AdminCredentialCreate.auth_method` says `string` next to the generated literal union for the same field. **A8** — the same closed set authored twice in two type systems with a comment as the only lockstep (theme tokens; window states; and `me_json.ex` re-spelling `WindowCounts.t()` longhand, one shape with three declarations and zero references between them).

**LOW.** **A9** — `ChannelKey` is the only branded type in either codebase; the key/display/wire split that CLAUDE.md spends ~60 lines on is enforced entirely by review everywhere else. **A10** — `as ChannelKey` escapes at 14 non-test sites, up from ~10, because `Object.keys()` over a branded-key record returns `string[]`. **A11** — the e2e tree (427 files) runs under a tsconfig missing 7 of the strictness flags `src` pins, `noUncheckedIndexedAccess` among them. **A12** — representation choices the type system already knows are discarded at the boundary (`DateTime.t()` → bare `string`; two timestamp encodings coexisting; `start_opts()` erased to `map()` by its own producer). **A13** — nine legacy-tolerance optionals on `RawNetwork` with no expiry mechanism, though `protocol_version` exists and would give them one.

---

## Concern: extension & maintainability

**A1 (HIGH).** See duplication A1 / type-leverage A1 — the same finding measured as change-cost: every new wire event pays the hand-narrower tax in a file the codegen cannot see, and #429 proves that tax is paid with silent omissions.

**A2 (HIGH).** A new scrollback kind costs a **267-line** `messages` table-recreate, because the CHECK constraint duplicates the `Ecto.Enum`. SQLite cannot `ALTER TABLE … ADD CONSTRAINT`, so extending the enum forces the recreate dance on the largest, unboundedly-growing table, and the dependent-FK rewrite drags `read_cursors` in with it; the migration's own moduledoc says the author must bring forward every index and column that drifted since 2026-05-04 — i.e. re-derive the physical schema by hand and get it exactly right. **Fix:** drop the CHECK and let `Ecto.Enum` be the sole gate (CLAUDE.md already forbids the raw-SQL inserts the CHECK defends against). A new kind then costs zero migrations.

**A3 (HIGH).** The window-state set is restated in **six** hand-maintained places — the server type, CLAUDE.md's invariant, `windowState.ts`, `pseudoChannels.ts`, and byte-identical `NOT_JOINED_STATES` sets duplicated between `ComposeBox.tsx:112` and `Sidebar.tsx:93`. None derived, none gated, because the type never appears in a `*.Wire` module so codegen never sees it. The last addition touched **20 files**. **Fix:** publish it on `Session.Wire` so codegen emits the const; hoist the two duplicated sets into `windowState.ts`.

**A4 (HIGH).** `Session.Server` 4,701 → **7,230** lines and its test 7,844 → **12,491** in 26 days; `handle_call` 52 → 66, `handle_info` 29 → 40, state 87 keys. **Two premises of the last review are retracted here rather than restated:** the `:sys.get_state` pin tax is gone (98 → 7), and hub concentration is flat (20.8% → 20.0% server, 20.8% → 17.3% client) — the hubs grow with the codebase, not faster. What is real is width: 87 keys is 87 things a new arm can invalidate, and the 12,491-line test is the merge-conflict epicentre for every concurrent session-touching worktree. **Fix:** continue the `WindowState` pattern, grouping by CO-MUTATION — the identity/recovery cluster, the away cluster, the eight injected-callback fields (DI wiring, not state; pulling that bundle alone drops 9 keys and is behaviour-free), the auth-handshake cluster.

**A5 (HIGH).** One new IRC verb costs **23 files** across five mechanical server layers (controller → facade → `handle_call` → `Client` builder → meta) plus four client layers plus 9 test files; measured as the union of the `#1225` commits. Every layer grew since the last measurement. The parallel WS door adds 39 hand-written `do_handle_in` arms. **Fix:** this is the one place a declarative per-verb table earns its keep — name, arity, target shape, echo policy, meta keys — consumed by the facade, the dispatcher and the builder, collapsing three server layers into one row. `slashCommands.ts` already has table shape, so codegen could make the client half free.

**MEDIUM.** **A6** — controller rendering is a hard two-pattern split with **zero** overlap: 9 controllers use a `*_json.ex` view, 30 render inline, and there is no stated rule, so the choice is made by proximity (two recently-added routes landed on opposite sides in the same window). **A7** — the Logger metadata allowlist is 306 lines / 106 atoms / **47% of `config/config.exs`**, and a one-directional sync test forces every scrollback meta key into it whether or not anything logs it — four entries carry apologetic comments saying exactly that. **A8** — the cross-language drift-gate pattern exists and works, but covers 4 mirrors, missing `CONTENT_KIND_PROJECTION`, the one pair CLAUDE.md and both moduledocs single out as THE single source. **A9** — four env templates, three ungated, and the ungated ones already carry three measured divergences; the substrate with no gate is the FreeBSD jail, i.e. production. **A10** — client tests have three placement conventions and 406 e2e specs compile under a materially weaker tsconfig with no shared base. **A11** — DESIGN_NOTES grew 60% in 26 days (26,723 → **42,708** lines) and `CLIENT_PROTOCOL.md` is a per-wire-change hand mirror with no gate at all, while its machine-readable twin is generated and gated.

**LOW.** **A12** — `isPresenceKind` is a dead export while `ScrollbackPane` hand-maintains its exact complement. **A13** — every context holding a network FK buys a `dirty_xref` waiver (6 of 9), though the count is down sharply from the last review. **A14** — **adding a new context is genuinely cheap** (4–8 files, one line each for the tree, Boundary and config) and needs no work; recorded because the context layer is where the design pays off and a review that only lists costs would misrepresent it.

---

## Coverage — what this review did NOT cover

**Nothing was executed.** No `mix`, no `bun`, no docker, no Dialyzer, and — load-bearing for the
dependency concern — **no `mix boundary.find_violations`**. The Boundary analysis reasons from the
ANNOTATIONS, which is sound for cycle-freedom only because `mix.exs:33` puts `:boundary` in
`compilers` with `check: [in: true, out: true]` and CI fails on violations, i.e. declared ≡ actual
is enforced elsewhere. The one class this cannot see is precisely the class finding A1 is about:
runtime edges via injected closures, behaviours resolved from `:persistent_term`, and
`dirty_xrefs`. Those were enumerated by hand and the counts are believed complete for
`Session.Server`'s opts (10, exhaustively listed from the `@type` blocks) and for `dirty_xrefs` (5,
whole-tree grep) — a runtime edge implemented some fourth way would not appear.

**Established rather than sampled** (recorded because these are the claims a future reader may want
to re-run): the full server Boundary graph — all 93 `use Boundary` blocks parsed, deps resolved to
owning boundaries, Tarjan run, zero cycles, then re-run with `dirty_xrefs` promoted, exactly 5
cycles sharing one prefix. The full client import graph — 301 modules, 1,165 resolved relative
edges, value-level SCC finding exactly one cycle of size > 1 (`tsconfig.json` declares no path
aliases, so relative resolution is exhaustive). Schema→context direction — all 23 `use Ecto.Schema`
files checked; no schema calls a context. Runtime `Application.{get,put}_env` — every occurrence in
`lib/` read in context. Web-layer internal direction — all 42 controllers, 3 channels, 9 plugs and
10 JSON views scanned; no view calls a context function and `GrappaWeb` takes no `Repo` dep.
Supervision tree — `application.ex` read in full, every per-child why-comment checked against the
actual sequence; every stated rationale holds.

**Not covered.** Context internals for `visitors.ex` (1,363 lines, the widest dep list in the tree
at 15), `accounts.ex` (1,311), `networks/credentials.ex` (1,360) and `operator.ex` (1,137) — read
by function list and moduledoc only, so an abstraction defect *inside* a well-bounded context would
not surface; `visitors.ex` is where a deeper pass should start. ~6,800 unread lines of
`session/server.ex` handler bodies — the findings are derived from its type and its cross-module
read set, so a fuller read could find more coupling but would not change their shape.
`event_router.ex`'s internal per-verb organisation (a size question, not a cohesion one).
`hot_reload/`, `deploy/`, `release/`, `sys/`, `infra/`, `scripts/` — deploy machinery, outside a
client/server architecture concern, and covered by a dedicated agent in the codebase review.
Component bodies in `cicchetto/src/*.tsx` — import edges and the join/focus paths were traced, but
a store bypass happening through a correctly-imported store's INTERNAL setter would not show in an
import-edge scan; the proposed lint rule is the durable answer rather than a manual sweep. Tests
and `cicchetto/e2e/` as graphs in their own right — excluded by brief, so test-only import cycles
and test→production direction are unmeasured. The e2e spec bodies behind the duplication counts:
those were profiled by helper SIGNATURE (name frequency plus a diffed sample per cluster), so
duplicated INLINE blocks that were never extracted into named functions are not counted and A3 is a
**lower bound**. `GrappaWeb` as a single 51-dep boundary was checked by hand and found disciplined,
but nothing mechanically enforces structure inside the web layer — recorded so the absence of that
gate is on the record rather than mistaken for a clean result.

**`docs/DESIGN_NOTES.md` was grepped per topic, never read linearly.** Every deliberate shape
reported as a finding was checked against its recorded rationale first, and two candidate findings
were **dropped** after reading it: `Visitors.Login` bypassing `SpawnOrchestrator` (argued
explicitly under "reuse the verbs, not the nouns", and the argument holds) and `*.Wire` modules
performing PubSub broadcasts as well as shape conversion (established as the standard). Where a
finding is about a POPULATION rather than a decision — A1, A2, A6 and A7 on the dependency concern
— each instance's rationale is sound and the finding is the count, not the choice.

## Trajectory

The trajectory read for this cycle lives in the companion codebase review
(`docs/reviews/codebase/2026-08-15-codebase-review.md`), which has the session history and the issue
data in front of it. The one thing worth adding from the structural side: **the recurring shape in
this document is not decay, it is arrested improvement.** Every HIGH here sits on top of a
mechanism the project already built and proved — the wire codegen, the `as const` closed-set
emitter, the leaf-boundary promotion, the `WindowState` extraction pattern, the shared-fixture
parity gate. None of them failed. Each was applied to one surface, demonstrated, and then left with
the older pattern still standing beside it, which is why the same finding appears from five
different concerns. The remediation is therefore unusually cheap per unit of risk retired: finishing
migrations that already have a proven mechanism, a working gate and a measurement harness, rather
than designing anything new.
