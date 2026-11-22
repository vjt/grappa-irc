# Architecture Review — 2026-11-21

**Base:** `origin/main` @ `3a247669d`.
**Baseline:** 2026-09-22 @ `c678ea5a` (`docs/reviews/architecture/2026-09-22-architecture-review.md`), 60 days and 1,134 commits earlier. The dependency reviewer compared its edge and layering counts against `189aaf2c8`; the other five compared against `c678ea5a`.
**Concerns:** six reviewers per `docs/reviewing.md` §2, one per concern, dispatched in parallel, each on a detached worktree at `3a247669d`:

1. Abstraction boundaries (`BND`)
2. Responsibility & cohesion (`COH`)
3. Duplication (`DUP`)
4. Dependency architecture (`DEP`)
5. Type system leverage (`TYP`)
6. Extension & maintainability (`EXT`)

**Method.** Read-only. No `mix`, `bun`, `tsc`, docker or compiler was run, so the verdicts of Boundary, Dialyzer and tsc were never observed. Every number below is a `grep`, `wc`, `git log`/`git show` or small Python pass that a reviewer ran on the tree. The dependency reviewer also parsed every code-level `use Boundary` block (134 blocks, 508 declared edges) and the cicchetto import graph (440 non-test modules, 1,912 relative-import edges). This document compiles the six reports and re-measures nothing. Where two reviewers measured the same quantity differently, both numbers are given (see *Where the reviewers disagree*). Each reviewer marked a consequence derived from reading code, rather than observed, as INFERRED, and those labels are kept here.

**IDs.** Each finding keeps its reviewer's numbering behind a concern prefix: `DUP-A2` is the duplication reviewer's A2. Findings that several reviewers raised are merged into `X1`–`X11` (see *Cross-cutting themes*).

**What changed in the window.** Issue 2430, end-to-end encryption, dominated: 178 of the 1,134 commits (DUP). On the server it added four contexts (`E2eKeys`, `E2eInbox`, `E2eRequests`, `E2ePairing`), three session helpers (`E2ePacer` at 1,198 lines, `E2eReassembly`, `E2eKeyAnswers`), `IRC.E2e` and `E2eController` (BND). The client gained 8,559 lines under `cicchetto/src/lib/e2e/`; shottino gained 8,125 lines in `e2e.{c,h}` (DUP). Sizes, raw newline counts taken the same way at both revisions (COH):

| | `c678ea5a` | `3a247669d` | Δ |
|---|---:|---:|---:|
| server `lib` | 111,305 | 123,368 | +10.8% |
| cicchetto `src` (non-test) | 94,965 | 116,749 | +22.9% |
| `session/server.ex` | 8,789 | 10,374 | +18.0% |
| `frontends/shottino/shottino.c` | 23,790 | 30,981 | +30.2% |

## Severity summary

Distinct findings after merging duplicates. The last column gives each reviewer's own count.

| Concern | CRITICAL | HIGH | MEDIUM | LOW | Distinct | As reported (C/H/M/L = total) |
|---|---:|---:|---:|---:|---:|---|
| Abstraction boundaries | 0 | 0 | 4 | 4 | 8 | 0/0/6/4 = 10 |
| Responsibility & cohesion | 0 | 3 | 3 | 1 | 7 | 0/3/3/1 = 7 |
| Duplication | 0 | 2 | 8 | 5 | 15 | 0/2/10/5 = 17 |
| Dependency architecture | 0 | 0 | 3 | 7 | 10 | 0/0/6/7 = 13 |
| Type system leverage | 0 | 1 | 3 | 2 | 6 | 0/1/5/3 = 9 |
| Extension & maintainability | 0 | 3 | 3 | 2 | 8 | 0/4/6/2 = 12 |
| **Total** | **0** | **9** | **24** | **21** | **54** | **0/10/36/22 = 68** |

**How duplicates were merged.** Two raw findings were merged only when they describe the same defect and propose the same cure. Findings that merely touch the same module stay separate, and so do two findings from the same reviewer. Eleven merged findings (`X1`–`X11`) absorb 25 raw findings, which takes 68 raw findings down to 54 distinct ones: 1 HIGH, 12 MEDIUM and 1 LOW were removed as duplicates. Each merged finding is counted once, at the highest severity any reviewer gave it, in the row of the concern that gave that severity. On a tie it goes to the concern listed first in the table. Where reviewers gave it different severities, the finding records each one. Where each merged finding is counted: X1 and X5 under Responsibility & cohesion; X2, X6, X8, X9, X10 and X11 under Duplication; X3 under Type system leverage; X4 under Extension & maintainability; X7 under Abstraction boundaries.

**Zero CRITICAL.** As in the baseline, security hardening is outside this document.

### What this review says, in one paragraph

**None of the 2026-09-22 findings was fixed in this window, and the new debt sits where the E2E work landed.** The reviewers re-checked 58 prior concern-rows and found 0 FIXED, 9 PARTIAL, 30 OPEN and 19 worse. As the boundaries reviewer put it, "the 1,134 commits went into E2E and around these findings, not into them." The one clear gain is shottino's wire copy: the five drifts the last review measured are all cured, and a source-reading parity test now exists, so that HIGH drops to MEDIUM.

Inside its own layers, E2E is in good shape. The client stack is well layered (COH), and the four server contexts mostly follow the house pattern and render through `*.Wire` (BND). Two things went wrong at the edges:
- **Placement.** Its process glue went into the two god modules: E2E is 64.5% of `Session.Server`'s regrowth and 84.7% of `shottino.c`'s.
- **The protocol.** The protocol between the relay and the cryptography is implemented by hand in four codebases, against a spec that lives in issue comments and a gitignored plan.

`Session.Server` is again growing faster than the codebase (8.41% of `lib`, up from 7.90%), and #2133 still has no answer on its ceiling. The wire-contract machinery is still split. The version pin reads all 13 web views from the beams, while the codegen reads a hand list, and REST casts rose from 55 to 63. The protocol number went from 30 to 63 in 60 days and is still typed by hand in four files and three languages.

### Distinct HIGH findings

| # | Finding | Raw findings merged | Reviewer severities |
|---|---|---|---|
| X1 | `Session`/`Session.Server` keeps growing with no ceiling; #2133 unanswered | COH-A2, DEP-A5 | HIGH / MEDIUM |
| COH-A1 | E2E relay absorbed into `Session.Server` (64.5% of its regrowth) | — | HIGH |
| X2 | E2E protocol hand-kept in four codebases; interop spec not committed | DUP-A1, BND-A2, TYP-A9 | HIGH / MEDIUM / LOW |
| X3 | Codegen reads a 4-module hand list; the pin reads 13 views; REST casts 55 → 63 | TYP-A1, DUP-A8, BND-A6 | HIGH / MEDIUM / MEDIUM |
| X4 | `@protocol_version` hand-edited in four files, 33 bumps in 60 days | EXT-A1, DUP-A9 | HIGH / MEDIUM |
| X5 | `shottino.c` +30% past its no-split ruling, E2E glue inside | COH-A3, EXT-A4 | HIGH / HIGH |
| DUP-A2 | Member list kept by two state machines; the client MODE walker missed #216 | — | HIGH |
| EXT-A2 | Kind/window-state classification in hand `Set`s that fail open; kind CHECK forces a table rebuild | — | HIGH |
| EXT-A3 | `orchestrate/SKILL.md` is a 515 KB append-only incident log loaded whole | — | HIGH |

## Prior findings (2026-09-22) — status

Status as each reviewer reported it. A row is one prior finding *within one concern*. The same underlying prior can appear in several concerns (shottino's closed sets appear in five), so the totals count concern-rows, not distinct findings. "Worse" is the reviewer's own label: REGRESSED, worse, or grew.

| Concern | 2026-09-22 rows re-checked | FIXED | PARTIAL | OPEN | Worse | Older carried items (2026-08-15 and earlier) |
|---|---:|---:|---:|---:|---:|---|
| Abstraction boundaries | 18¹ | 0 | 3 | 8 | 7 | included in the 18¹ |
| Responsibility & cohesion | 8 | 0 | 1 | 6 | 1 | 7 OPEN (incl. #2133), 1 not re-measured |
| Duplication | 11 | 0 | 2 | 4 | 5 | 1 FIXED, 1 PARTIAL, 4 OPEN; plus the duplication half of the prior Abstraction A4, OPEN |
| Dependency architecture | 6 | 0 | 1 | 5 | 0 | 2 PARTIAL, 4 OPEN, 1 REGRESSED |
| Type system leverage | 6 | 0 | 1 | 4 | 1 | 8 OPEN, one of them partly REGRESSED |
| Extension & maintainability | 9 | 0 | 1 | 3 | 5 | 1 OPEN and worse, 1 PARTIAL, 1 OPEN |
| **Total (concern-rows)** | **58** | **0** | **9** | **30** | **19** | |

¹ The boundaries reviewer re-checked every row of the 2026-09-22 abstraction section, including the 2026-08-15 items that section carried (A3–A14). It tallied 0 FIXED / 3 PARTIAL / 15 OPEN, with 7 of the 15 grown or worse. Its table labels A3 "PARTIAL, one new copy", while its tally counts A3 among the 15 OPEN that grew. This document follows the tally. A1–A2 were recorded FIXED on 2026-09-22 and were not re-checked. The dependency reviewer marks two of its OPEN rows "under-counted" (wider than reported in September), which is not the same as worse.

**The 2026-09-22 HIGHs:**

| # | Finding | Status | Evidence, as reported |
|---|---|---|---|
| H-N1 | shottino is a third, ungated copy of the wire contract; five measured drifts | **PARTIAL** | All five drifts are FIXED (`failing`, `admin`, `row_count`, `text/markdown`, event kinds), per BND, DUP, DEP, TYP and EXT. A source-reading parity test now exists. There is still no generated C artefact. Re-raised at MEDIUM as **X6** |
| H-N2 | The wire pin cannot see inline controller bodies | **OPEN** | BND: 34 `json(conn, %{` + 132 `\|> json(%{` line hits, of which 111 are error envelopes and 13 trivial, leaving roughly 40 that carry domain data. EXT: 41 such literals; the new E2E doors render through `*.Wire`. COH: 34 `json(conn, %{` sites in 21 files. No reviewer re-filed it as a new finding |
| H-N3 | `@protocol_version` is a global serialization point | **OPEN, worse** | 30 → 63 in 60 days; **X4** |
| H-N4 | `shottino.c` monolith past its ruling's premise | **REGRESSED** (COH) / **OPEN, worse** (EXT) | 23,790 → 30,981 lines; **X5** |

Per-row tables follow at the end of each concern section.

## Cross-cutting themes

### Merged findings

#### X1. `Session` / `Session.Server` keeps growing with no ceiling, and #2133 still has no ruling
**Raised by:** COH-A2 (HIGH), DEP-A5 (MEDIUM). Counted once, HIGH.
**Location:** `Grappa.Session.Server`; `Grappa.Session` (facade and its `use Boundary` deps); `test/grappa/session/server_test.exs`; issue #2133; `Grappa.Push.BadgeSource`; `Grappa.WindowCounts.PushSource`; `Grappa.WSPresence`.
**What is wrong:**
- **Cohesion: the process keeps absorbing domains.**
  - The previous review's mitigating note ("no longer growing faster than the codebase") no longer holds.
  - The process now carries about 15 distinct domains, enumerated from its callback tags and section banners: connect and backoff, the effect interpreter, ~35 outbound `send_*` verbs, the live read model, ghost/recover, away, the channel directory, `/notify`, DCC, E2E, peer profile caches, labeled-response, accumulator TTL, ignores, and flood/auto-reply budgets.
  - Every new per-session feature defaults here, because this is the only place that holds `(subject, network, client)` together.
  - #2133 (open since 2026-09-15) asks for a choice between (a) a read model off the GenServer and (b) "state a ceiling and gate it". It ends with "the ruling is yours". There is still no ruling, ceiling, gate or DESIGN_NOTES entry.
- **Dependencies: the boundary is the graph's hub.**
  - `Session`'s `deps:` grew from 23 to 28: +`Accounts`, +`E2eInbox`, +`E2eKeys`, +`E2eRequests`, +`ServerSettings`, +`WSPresence`, −`NickMigration`.
  - Every boundary Session reaches is forbidden from calling Session statically. That is the mechanism behind the `Push.BadgeSource` and `WindowCounts.PushSource` seams.
  - Two of the new edges run synchronously inside the WHOIS drain: a `GenServer.call` into `WSPresence` (default 5 s timeout) and a DB read through `Accounts.last_known_ip/1`.
  - Session's moduledoc still says its deps list "can omit `Repo` / `Networks` / `Accounts`", while it declares `Accounts`.

**Evidence (MEASURED).**

| Quantity | Then | Now |
|---|---:|---:|
| `server.ex` lines | 8,789 | 10,374 (+18.0%, against `lib` +10.8%) |
| `server.ex` share of `lib` | 7.90% | 8.41% |
| `server_test.exs` lines | 14,783 | 16,188 |
| state keys (COH regex over the `@type t` block) | 83 | 94 (+11, none removed, 7 of them `e2e_*`) |
| callback clauses | 132 | 143 |
| `defp` | 237 | 328 |
| `Session.*` modules among the 65 aliased | 28 | 31 |
| `Session` deps | 23 | 28 |

`server.ex` took 62 commits and 1,585 net lines in the window; it is the #2 code hotspot (COH). Session reaches 50 of 124 lib boundaries transitively. DEP did not measure latency for the synchronous calls.

**Impact:**
- The crash boundary keeps widening: one bad clause in any of the ~15 domains drops the user's IRC link.
- 40% of the lib graph can never call back into the session layer statically.
- Each new feature lands as one more Session dep and, sooner or later, one more inverted seam.

**Direction:**
- Put #2133 to vjt as a ruling now, with today's numbers rather than the 8,297 lines it was filed on.
- Whatever the ruling says, add the cheap half of (b) at once: a CI ratchet that fails when any of these rises without a same-commit bump of the recorded value and a DESIGN_NOTES line:
  - the `@type t` key count, or the `handle_call`/`handle_info` clause count (COH);
  - any boundary's `deps:` count or transitive reach (DEP).
- Move per-feature persistence that does not need session state out of the process: through a sibling process (COH-A1) or through effects applied by the feature boundary (DEP).
- Resolve WHOIS client-IP data before the drain.
- Fix the moduledoc.

COH-A1's extraction plus the still-open DCC intake extraction would together remove ~1,140 lines, 8 state keys and 6 callback clauses (COH).

**Kept separate:** COH-A1 (the E2E relay specifically), TYP-A2 (the state type is routed around), and EXT's prior row "conflict epicentre, OPEN and worse". The state-key count is disputed; see *Where the reviewers disagree*.

#### X2. The E2E protocol is implemented by hand in four codebases, its interop spec is not in the repository, and the server owns neither the frame arithmetic nor the payloads it writes
**Raised by:** DUP-A1 (HIGH), BND-A2 (MEDIUM), TYP-A9 (LOW). Counted once, HIGH.
**Location:**
- cic `lib/e2e/*`: `wire.ts` (`linesNeeded`, `MAX_FRAGMENTS`, `fold`, `ReceiveVerb`, `parseKeys`), `engine.ts`, `sas.ts`, `pairingMessages.ts`.
- shottino `e2e.{c,h}` (`e2e_lines_needed`, `E2E_MAX_FRAGMENTS`, `e2e_did`).
- Server: `Grappa.IRC.E2e` (`fragment/5`, `chunk_size/3`, `@max_fragments`); `Grappa.E2eKeys` (`answer/3`, `claim/4`, `master_block/1`, `entry_block/1`); `E2eKeys.{Device,DeviceList,Key,Wire}`; `Session.Server` (inline payload encodes).
- The external irc-olm engine.
- `docs/CLIENT_PROTOCOL.md` §4f.
- Tests: `limits_parity_test.exs`, `e2eWire.test.ts`, shottino `test_e2e.c`.

**What is wrong:**
- **Only the ends are implemented once.** The relay (server) and the cryptography (vodozemac, "One Olm, not two") each exist once. Everything in between is done once per client, by hand: payload shapes, signed strings, did derivation, fragment arithmetic, the nick fold, SAS, pairing and orders (DUP).
- **No committed spec** (DUP).
  - `e2e/wire.ts` cites issue 2430 *comments* as its spec.
  - `e2e.h` cites `docs/plans/shottino-e2e-spec.md` §16, which is a gitignored ephemeral plan. CLAUDE.md requires durable rationale to move to a living doc before a plan is deleted.
  - `CLIENT_PROTOCOL.md` §4f is, by its own heading, "the relay half".
- **The frame arithmetic exists three times** (BND, DUP):
  - `IRC.E2e.fragment/5` is authoritative;
  - cic `linesNeeded` builds the frame head as a literal string;
  - shottino has `e2e_lines_needed`.

  #1108 published `frame_budget_base` so that cic "never computes the relayed-line reserve itself"; the E2E code then rebuilt the layer above it on the client. Parity is held by numbers copied into test comments, with no shared fixture (BND).
- **Server-written payloads have no server owner** (BND). The v2 payloads grappa sends on the user's behalf (KEYS, NACK, ACCEPT, REFUSE) are hand-encoded as `Jason.encode!(%{v: 2, …})` at 5 sites in two modules: `E2eKeys.answer/3`, inside a persistence context, and inline in `Session.Server`.
- **The KEYS blocks are untyped and nested** (TYP).
  - `master_block/1` and `entry_block/1` are specced `:: map()`, encoded, and carried as `E2eKeys.Wire.claimed :: %{keys: String.t()}`: a JSON string inside JSON.
  - The block shapes are typed nowhere on the server, although `E2eKeys.Wire` already types `device`/`device_list` with the same fields.
  - cic hand-declares `IdBlock`/`MasterList`/`KeysEntry` and parses them with `parseKeys`; shottino parses them again in C.
  - `ReceiveVerb` hand-copies the generated `SessionWireE2eVerb`.
- **Pinning is partial and one-sided** (DUP).
  - `limits_parity_test.exs` pins 2 constants (`DEVICE_CAP`, `MAX_HOSTED_ONE_TIME_KEYS`) between the server and cic only. shottino's copies and every cic↔shottino pair are unpinned.
  - `test_e2e.c` names its vectors "cicchetto's" but never reads cic.
  - cic↔irc-olm is exercised end to end (`issue2430-interop-bot.spec.ts`); shottino↔either is not.
  - DESIGN_NOTES records cross-client SAS as "not yet run between cicchetto and shottino by hand".

**Evidence (MEASURED unless marked).**
- **Size of the copies.** cic 8,559 lines with 31 exported constants; shottino 8,125 lines with 39 `#define E2E_*`.
- **Strings.** 9 domain-separation strings are byte-identical today across `e2e/wire.ts`, `e2e/sas.ts`, `e2e/pairingMessages.ts` and `e2e.h`. 3 of them appear a third time on the server (`DeviceList`, `Device`, `Key`).
- **Logic and vectors.** The did derivation exists three times. The test vectors are pasted into 9 test files in 3 languages.
- **Drift already visible in the prose copy.** `CLIENT_PROTOCOL.md` says a master vouches for "up to 4 devices" in one place and "Three is the most an identity holds" in another; the code agrees with three (`@max_devices 3`).
- **No live code divergence claimed.** DUP compared the domain strings, the caps and `MAX_FRAGMENTS` and found them matching. The only divergences it cites are that doc line and the ruled irc-olm NACK case.

**Impact:**
- An interop change (a new verb, a signed-string version, the list cap, the fragment head) must be made in up to four codebases with no failing test in between. A cic change that shottino misses fails closed in the field: messages do not decrypt, and keys alarm (DUP).
- A frame-head change compiles and passes on all three sides. Clients then mis-predict until the server's 413 at send time; if the head shrinks, they over-split silently (BND, INFERRED from code).
- Every new consumer, the Phase-6 facade next, inherits another copy.

**Direction:**
1. Commit `docs/E2E_PROTOCOL.md`, lifted from the issue-2430 comments and the gitignored plan, and point `e2e.h` and `e2e/wire.ts` at it. Fix the "4 devices" line (DUP).
2. Build one conformance corpus, `priv/e2e/vectors/*.json`, iterated by ExUnit, vitest and `test_e2e.c`: the `shouldNotifyTruthTable.json` pattern (DUP). It should cover:
   - did and fb vectors;
   - the signed strings for each prefix;
   - `lines_needed` cases, including the 64-line edge;
   - payload accept/reject cases for each verb;
   - fold cases.
3. Keep the frame arithmetic on the server (BND). Either publish a per-verb budget next to `frame_budget_base`, or have the send door accept an over-long message and regroup it server-side. Then delete `linesNeeded`/`e2e_lines_needed`. Until then, generate the head layout and the cap into the wire artefacts.
4. Give the payloads a server owner:
   - an `IRC.E2e.Payload` builder for KEYS/NACK/ACCEPT/REFUSE (BND);
   - named `@type`s for the KEYS blocks in `E2eKeys.Wire`, so cic can alias `KeysPayload` and `ReceiveVerb` to generated types (TYP).
5. Give shottino's `e2e.h` constants the same `read_repo_file` pin `test_commands.c` already uses (DUP).

**Related, kept separate:** BND-A7 (the device cap), DUP-A4 (the E2E fold), DUP-A10 (`MAX_FRAGMENTS` in three languages), COH-A3 / X5 (shottino E2E glue). BND-A7 and DUP-A1 disagree on whether the device cap is pinned.

#### X3. Codegen still takes a hand-listed set of modules while the version pin reads all 13 web views from the beams, so REST stays hand-typed and cast
**Raised by:** TYP-A1 (HIGH), DUP-A8 (MEDIUM), BND-A6 (MEDIUM). Counted once, HIGH.
**Location:**
- Server: `Mix.Tasks.Grappa.GenWireTypes` (`@extra_modules`, `@wire_glob`); `Mix.Tasks.Grappa.WirePin` (`@json_view_beam_glob`); `GrappaWeb.{UserSettings,Ignores,PushSubscription,Networks,ClientToken,Channels,Archive,Members,Messages,Auth}JSON`.
- cic `lib/api.ts`: `MeResponse`, `fetchMe`, `RawNetwork`/`tagNetwork`, `listNetworks`, `IgnoresResponse`, `LoginResponse`, `getPasskeyStatus`, `passkeyRequest`.
- cic `lib/userSettings.ts`, `push.ts`, `themesApi.ts`, `serverSettings.ts`, `wireNarrow.ts`.

**What is wrong:**
- **Two rules decide what counts as "wire", and they disagree** (TYP; BND prior A4).
  - `wire_pin` derives its set of `GrappaWeb.*JSON` views from the compiled beams, and fails closed.
  - `gen_wire_types` takes `lib/grappa/**/*wire.ex` plus a hand list: `AuthJSON`, `BootJSON`, `ErrorTokens`, `MeJSON`.
  - The 2026-09-22 fix, "a glob resolved by module rather than path", was applied to the pin and not to the generator.
- **`IgnoresJSON` is pinned but not generated** (TYP, BND). It was created on 2026-09-26 precisely so the pin could see the ignore list. It is not generated, so cic hand-types `IgnoresResponse`/`IgnoreAddResponse`/`IgnoreRemoveResponse` and casts to them.
- **The settings door regressed** (TYP, DUP).
  - `UserSettingsJSON` grew from 11 to 14 named `@type`s, with 13 `@spec`s; none of them reaches the client.
  - `userSettings.ts` imports nothing from `wireTypes`, re-declares 16 object types, and its casts went from 20 to 26.
  - The three settings added since the last review (`away_nick_suffix`, `ban_mask_form`, `command_counts`) each brought one hand type and two casts.
- **`/me` is validated, then widened** (BND).
  - `fetchMe` narrows against the generated `S_MeJSONMeJson`, in which six fields are required.
  - It then returns the hand union `MeResponse`, in which those fields are optional "so test mocks predating the field don't need touching". `api.ts` has 11 such justifications.
  - CLAUDE.md: "Never weaken production code to make tests pass."
- **`GET /networks` is still a cast** (BND, DUP, TYP prior A13): `(await res.json()) as RawNetwork[]`, with 15 optional fields, re-shaped by `tagNetwork`.
- **Being on the list is not enough** (TYP).
  - `AuthJSON.login/1` has an inline `@spec`, and the generator emits only named types. So `LoginResponse` is hand-typed and cast, while the `S_AuthJSON*Subject*` schemas sit unused.
  - `getPasskeyStatus` returns an implicit-`any` `await res.json()`, and `passkeyRequest` has an unconstrained `as T`. Both are still open since 2026-09-22.

**Evidence (MEASURED, the same `git grep` at both revisions).**
- **Casts.** `(await …json()) as` went 55 → 63:

  | File | 2026-09-22 | Now |
  |---|---:|---:|
  | `api.ts` | 29 | 31 |
  | `userSettings.ts` | 20 | 26 |
  | `push.ts` | 3 | 3 |
  | `themesApi.ts` | 2 | 2 |
  | `serverSettings.ts` | 1 | 1 |

- **Narrowed reads.** About 62 REST reads go through `narrow*` (TYP). DUP counts narrowed reads at 43 → 84.
- **Views outside codegen.** 8 of 12 → 9 of 13 (TYP).
- **Hand types.** `api.ts` holds 42 hand `export type X = {` literals (BND, DUP).

**Impact:**
- Rename a field in any of the 9 uncovered views and the pin forces a protocol bump, while cic compiles green and reads `undefined` at runtime (TYP, DUP).
- The same setting has a checked type on the WS door (`S_UserSettingsWire*`) and an unchecked one on REST.
- The cast count is a ratchet that only goes up, by two per new setting.
- Every consumer of `me()` handles `undefined` for fields the server always sends, and a field that really disappears is not caught by tsc (BND).

**Direction:**
1. Have `gen_wire_types` take its view set from the same beam glob the pin uses, and delete `@extra_modules`. The two gates then agree by construction.
2. Name the inline envelope specs (`AuthJSON.login`, `ClientTokenJSON.create/1 :: map()`) as `@type`s, as `BootJSON` already does.
3. Route `userSettings.ts`, `push.ts`, `themesApi.ts` and the remaining `api.ts` casts through `narrowRest(S_…)`.
4. Make `me()` return `MeJSONMeJson` and delete `MeResponse`; fix the fixtures with a full-shape factory.
5. Delete `RawNetwork`/`tagNetwork`, and validate `listNetworks` against the two generated network schemas.
6. Add a cast-count ratchet to the cic check script.

The reviewers disagree on how many of the 13 views the codegen reaches (3 or 4).

#### X4. `@protocol_version` is still a hand-edited integer in four files and three languages, with three parallel changelogs
**Raised by:** EXT-A1 (HIGH), DUP-A9 (MEDIUM). Counted once, HIGH. This is the 2026-09-22 H-N3. DUP says it rated only the duplication half, not the merge-contention half.
**Location:** `Grappa.Protocol` (`@protocol_version`, the `version/0` spec); `priv/wire/shape.pin`; cic `lib/socket.ts` (`CLIENT_PROTOCOL_VERSION`); shottino `wire.h` (`WIRE_PROTOCOL_VERSION`); `Mix.Tasks.Grappa.{WirePin,GenWireTypes}`; `docs/CLIENT_PROTOCOL.md`.
**What is wrong:**
- **The number.** It went 30 → 63 in 60 days: 33 bumps, about four a week.
- **Four hand literals:**
  - `@protocol_version` and `@spec version() :: 63` in `protocol.ex`;
  - `CLIENT_PROTOCOL_VERSION = 63` in `socket.ts`;
  - `WIRE_PROTOCOL_VERSION 63` in `wire.h`.

  The Channel-E2E commit message says it plainly: "Protocol 62 -> 63 (all four sites + wireTypes/wireSchema + shape pin)".
- **Three changelogs.** Each bump appends rationale to `protocol.ex`, to `socket.ts` and to `CLIENT_PROTOCOL.md`. Only shottino's `wire.h` says "Replace this note … not a changelog".
- **A ritual, not a gate.**
  - Collision risk is handled by hand: "Checked for a collision before claiming N" appears 30 times in `protocol.ex`.
  - `protocol.ex` itself documents a site merging clean with the wrong value.
  - `gen_wire_types` emits no version, and `wire_pin` has no `--bump` mode.

**Evidence (MEASURED).**
- **Churn.** 41 commits touched `protocol.ex`. All four files are in the repo's top 13 by commits since 2026-09-22: `shottino/wire.h` 43 (#9), `protocol.ex` 41 (#11), `shape.pin` 40 (#12), `socket.ts` 39 (#13).
- **Prose growth.**

  | Quantity | Then | Now |
  |---|---:|---:|
  | `protocol.ex` lines | 877 | 1,692 |
  | `protocol.ex` comment share | 89% | 94% (1,596 lines) |
  | `socket.ts` comment preamble above the constant (contiguous lines) | 206 | 395 |

  `socket.ts` has about 42 per-version `// N → M` blocks and 34 "`MIN_SERVER_PROTOCOL_VERSION` stays at 9" lines (DUP). `CLIENT_PROTOCOL.md` §4f lists 11 versions.
- **Cost of the smallest bump.** 3–4 files and 33–41 inserted lines, almost all of it prose.

**Impact:**
- Every wire-touching branch serialises on one number and pays a four-file, three-language edit, plus about 20 lines of prose that conflict on rebase.
- At four bumps a week, the collision check is the project's most-repeated manual step, and the one a tired author skips.
- The parallel prose logs go stale; X2's "4 devices" line is one example.

**Direction:**
1. Generate the number everywhere from `Grappa.Protocol.version/0`: `PROTOCOL_VERSION` in `wireTypes.ts`, and a `#define` in a generated shottino header. Delete the hand literals so `--check` covers them (both reviewers).
2. Add a CI step against `origin/main`: if the `shape.pin` digest differs, `@protocol_version` must equal main's + 1. That turns the 30 prose notes into a red build (EXT).
3. Keep one changelog, in `CLIENT_PROTOCOL.md`, and cut the `protocol.ex`/`socket.ts` blocks to a pointer, adopting `wire.h`'s "replace, don't append" rule (both).

This shares its cure with X6: one generated C artefact carries both the version and the closed sets.

#### X5. `shottino.c` grew another 30% past the ruling that declined to split it, and the E2E glue went into it
**Raised by:** COH-A3 (HIGH), EXT-A4 (HIGH). Counted once, HIGH. This is the 2026-09-22 H-N4.
**Location:** `frontends/shottino/shottino.c` (`struct app`, `handle_command_dispatch`, `try_oper_verb`/`oper_verbs[]`), `e2e.c`, `atrest.c`, `keyring.c`, `ircd.c`, `llm.c`, `docs/REVIEW-2026-08.md` (P4.7), `tests/*.c`.
**What is wrong:**
- **Still one translation unit.**
- **The E2E split stopped at the engine.** `e2e.c` (6,839 lines) is "a port of cicchetto/src/lib/e2e/wire.ts and engine.ts". The orchestration that cic keeps in `lib/e2e/client.ts` + `encryptedChats.ts` lives in the monolith (COH).
- **The ruling was not revisited.** P4.7 has not been touched since base, and its premise was 14.7k lines.
- **The seams it named are still inside.** Per EXT, the ircd bridge, the bot cluster, the REST reader and the event dispatch all remain in the file. Per COH, `ircd.c`/`llm.c` exist but did not change size.

**Evidence (MEASURED).**

| Quantity | Then | Now |
|---|---:|---:|
| `shottino.c` lines | 23,790 | 30,981 (+30.2%) |
| share of shottino's top-level `.c` total (43,486) | — | 71% |
| static function definitions | 672 | 930 |
| `struct app` field lines (COH regex) | 170 | 191 |
| test files that `#include "../shottino.c"` | 6 | 7 |
| `e2e_` references in `shottino.c` | 0 | 1,255 |

- **Dispatcher.** `handle_command_dispatch` is 1,221 lines with ~99 `strcmp`/`strncmp`/`verb_args` arms; only the oper verbs moved to a table.
- **E2E functions.** `shottino.c` now defines 113 `e2e_*` functions.
- **Where the growth came from.** 84.7% of it came from E2E-tagged commits: 36 of 53 commits, +6,094 of +7,191 net lines (COH).

**Impact:**
- shottino's E2E client cannot be read, tested or reviewed apart from terminal state.
- Each of the 7 test binaries recompiles a 31k-line file.
- The parallel with cic is lost exactly where it would help: shottino has no unit to diff against cic's `client.ts`.
- Every wire bump shottino must follow lands here.

**Direction:**
1. Re-open P4.7 on today's numbers, in a DESIGN_NOTES entry.
2. Take the first split. The reviewers propose different ones:
   - COH: an `e2e_client.c` mirroring cic's `lib/e2e/client.ts`, behind a narrow `struct e2e_host` vtable;
   - EXT: the REST reader, behind typed `wire_narrow_<endpoint>` functions in `wire.c`, which also closes X6's legacy reads.
3. Then the event dispatch and a verb/command table (`oper_verbs[]` already proves the shape).
4. Make the tests link against headers instead of `#include`-ing the `.c`.

#### X6. shottino's closed sets: the measured drifts are cured, the structural cause stays, and `--ircd` still advertises `CASEMAPPING=rfc1459`
**Raised by:** DUP-A11, DEP-A6, TYP-A6 (all MEDIUM). Counted once, MEDIUM. This is the 2026-09-22 H-N1, downgraded by all three.
**Location:**
- `frontends/shottino/wire.{c,h}`: the `*_NAMES` tables including `MESSAGE_KIND_NAMES` and `CONNECTION_STATE_NAMES`; `wire_message_kind`, `wire_presence`, `wire_counts_severity`; the `wire_narrow_*` functions.
- `shottino.c`: `rows_of`, raw `json_get`, the `--ircd` 005.
- Tests: `tests/test_commands.c` (`pin_closed_set`, `the_closed_sets_are_the_servers_in_the_servers_order`), `tests/test_wire.c`.
- `docs/CLIENT_PROTOCOL.md` §2.

**What is wrong:**
- **Fixed** (all three): `failing`, `admin`, the `row_count` read and `md`. `WIRE_PROTOCOL_VERSION` is 63, matching the server.
- **New gates:**
  - A source-reading test pins `@connection_states` and `@server_reply_sources` against `credential.ex` and `session/wire.ex`.
  - Event kinds are checked by scraping `case "…"` out of cic's `userTopic.ts`/`wireNarrow.ts`. DEP notes that this is a client-derived gate, not a server-derived one.
  - `pin_closed_set` pins five E2E sets against `wireTypes.ts` (TYP, DEP; DUP disagrees).
- **Still self-mirrored: message kind, presence and counts severity** (TYP).
  - `wire_message_kind` (11 names) is tested against a list typed in the test itself; presence and severity are not pinned at all. Generated consts exist for all three.
  - Message kind is the set that grows most, and `test_wire.c` asserts that an unknown kind is rejected. So a new kind makes shottino drop every row of that kind with all its tests green. EXT-A2 reaches the same conclusion.
- **No generated artefact.** There is no generated C artefact and no language-neutral `priv/wire/closed_sets.json` (all three).
- **REST is decoded two ways inside one binary** (DUP). The new E2E/pairing REST goes through 17 typed `wire_narrow_*` functions. The older endpoints use raw `json_get` (69 calls) with `rows_of()` envelope guessing.
- **The protocol doc is silent on unknown values.** `CLIENT_PROTOCOL.md` §2 says nothing about an unknown value in an existing enumerated field: 0 matches (DEP).
- **The `--ircd` 005 still hardcodes** `CHANTYPES=#&+! … CASEMAPPING=rfc1459 NICKLEN=32 CHANNELLEN=64`; only `PREFIX` is relayed. irssi behind `--ircd` keeps folding `[`/`{` together on an ASCII-casemapping network (DEP).

**Impact:** the next literal added to an unpinned set repeats the 2026-08-22 → 2026-09-22 silent drop (DEP). It is the same failure class as `:failing`, on the busiest set (TYP).
**Direction:**
- Now: extend `pin_closed_set` to `SCROLLBACK_MESSAGE_KIND`, `WINDOW_COUNTS_SEVERITY` and presence, which is three lines with the existing helper (TYP). Or generalise the pin into a loop over every table (DUP), or over every generated const (DEP).
- Then: emit a generated header (`wire_gen.h`) from `gen_wire_types` under `--check`, and delete the hand enums and the scrapes. This also cures X4's C constant.
- Move the legacy REST reads behind `wire_narrow_*` and delete `rows_of`.
- Add the unknown-enum sentence to §2.
- Relay `isupport_changed`'s casemapping/chantypes/nicklen/channellen into the 005.

The reviewers disagree on how many sets are pinned.

#### X7. Session's registry key is hand-spelled in match specs outside `registry_key/2`, out of Boundary's sight, and Admission's caps fail open if it drifts
**Raised by:** BND-A3, DEP-A4 (both MEDIUM). Counted once, MEDIUM.
**Location:** `Session.Server.registry_key/2`; `Grappa.Session` (`whereis/2` and two match specs); `Grappa.LiveIntrospection` (`lookup_session/2`, three match specs); `Grappa.Admission` (`count_live_sessions/2`, `live_counts_by_network/0`, `check_network_total/2`); test helpers in `admin_overview_test.exs`, `test/support/admission_state_helpers.ex` and `admission_state_helpers_test.exs`.
**What is wrong:**
- **The single source of truth is not single.**
  - `registry_key/2` documents itself as the single source of truth for `{:session, subject, network_id}`.
  - A match spec cannot call a function, so the scans spell the tuple out themselves. BND counts five sites in two other boundaries (Admission ×2, LiveIntrospection ×3), each with a comment saying it mirrors `registry_key/2`.
  - DEP adds the two inside `Session`, one of which also pins the registry VALUE shape `{nick, label, true}`: 7 match specs in 3 boundaries.
- **Out of Boundary's sight.** Admission reads `Grappa.SessionRegistry` by atom and does not declare `Grappa.Session`, so Boundary sees no edge.
- **Copies and leaks.**
  - `LiveIntrospection.lookup_session/2` is a byte copy of `Session.whereis/2`.
  - LiveIntrospection uses `Session.Server` in production, although `Session` says `Server` is exported "for the test path only".
  - Three test helpers hand-spell the tuple too.

**Impact (INFERRED consequence; today the shapes agree, both reviewers).** A key change is a compile-green edit. After it, `count_live_sessions/2` counts 0 and the per-network cap stops refusing anyone: admission control fails open. The admin live counts read 0 at the same moment.
**Direction:**
- Give `Grappa.Session` the registry verbs and make them the only readers: `count_live/2`, `live_counts_by_network/0`, `list_live/0`, `count_by_user/0`. `Admission → Session` closes no cycle once DEP-A1's phantom edge is gone (DEP).
- Replace `lookup_session/2` with `Session.whereis/2`, and drop `Server` from Session's exports.
- Switch the three test helpers to `registry_key/2`.

The reviewers disagree on whether an existing test would catch a key change.

#### X8. Server logic mirrored in the clients is held by four pinning disciplines and a family of ad-hoc source scrapers; the shared JSON truth table is the proven pattern and the least used
**Raised by:** DUP-A3, EXT-A6 (both MEDIUM). Counted once, MEDIUM.
**Location:**
- cic mirror modules: `pushTriggers.ts`, `presenceFilter.ts`, `frameBudget.ts`, `mircFormat.ts`, `servicesSender.ts`, `statusmsg.ts`, `modeApply.ts`, `uploadCategory.ts`, `loginIdentifier.ts`, `mediaLink.ts`, `isupport.ts` (`DEFAULT_ISUPPORT`), `e2e/*`.
- ExUnit: `should_notify_parity_test.exs`, `presence_payload_parity_test.exs`, `e2e_keys/limits_parity_test.exs`, `presence_filter_test.exs`, `protocol_test.exs`, `router_sw_denylist_test.exs`, `messages_limit_mirror_test.exs`, `irc/{line_split,mirc_format,identifier}_test.exs`.
- shottino `tests/test_commands.c`, `test_e2eapp.c`.
- `scripts/client-protocol-gate.sh`.

**What is wrong:** cic declares itself a "twin", "mirror" or "transcription" of a named server function in at least 23 modules (DUP). Four pinning disciplines coexist (DUP):

| # | Discipline | Instances |
|---|---|---|
| 1 | A shared JSON fixture read by both suites. Strongest: one table, two consumers | `shouldNotifyTruthTable.json`, `presencePushPayloads.json` |
| 2 | The server test reads the cic source as text | `limits_parity_test`, `presence_filter_test`; shottino's `test_commands.c` for 2 sets |
| 3 | The same table duplicated verbatim in both suites, so the test data is itself the duplication | `line_split_test` ↔ `frameBudget.test.ts`; `mirc_format_test` ↔ the mircFormat tests |
| 4 | Comment only | `servicesSender.ts` (its allowlist exists three times, once as a literal in `identifier_test.exs`), `uploadCategory.ts`, `statusmsg.ts`, `modeApply.ts` (the one that drifted, DUP-A2) |

shottino reads none of the shared fixtures, and its mention predicate is a third answer to the question the truth table pins (DUP).

EXT adds that `gen_wire_types` emits TypeScript only. So every other cross-language fact (closed sets, kind subsets, limits, the version, routes, event kinds) is pinned by a bespoke `strstr`, regex or awk parser of another language's source text. Two of those parsers have recorded blind spots:
- `test_commands.c`: its event-kind shape "once stopped at the digit, so the nine E2E kinds slid past this test unread";
- `client-protocol-gate.sh`: a grep read prose about `parted` as an emitted kind.

**Evidence (MEASURED, EXT).**
- 36 of 431 ExUnit test files read repo source text, plus 18 cic tests using `readFileSync` and 40 `themeCss` callers.
- shottino's test asserts `checked > 20` precisely because a scraper's silence can mean "matched nothing".

**Impact:**
- Whether a mirror can drift silently depends on who wrote it, not on what it mirrors. The comment-only class is where the measured drift is (DUP-A2).
- Each new mirrored set means writing and maintaining another parser.
- Reformatting a TS literal can break an Elixir test.

**Direction:**
- Pick the shared-data discipline as the rule and record it in DESIGN_NOTES (DUP).
- Have `gen_wire_types` also write a language-neutral `priv/wire/manifest.json` holding the closed sets, the classification maps (EXT-A2), the version (X4) and the shared limits (DUP-A10), and generate the C header from it (EXT).
- Put the vectors under one directory (`priv/wire/vectors/`), read by ExUnit, vitest and the C tests.
- Migrate disciplines 3 and 4 first: `frameBudget` and `mircFormat`, then `servicesSender` (deleting its third copy), `statusmsg` and `modeApply`.
- Keep source scraping only for facts that are not data, such as "`ci.yml` runs gate X".

X2's E2E corpus and X6's generated header are instances of the same cure.

#### X9. The user-topic event vocabulary is declared nowhere on the server, so the client hand-assembles its union and a new event costs 26–28 files
**Raised by:** DUP-A7, EXT-A5 (both MEDIUM). Counted once, MEDIUM.
**Location:** `Grappa.Session.Broadcaster.to_user/2`; the user-topic emitters in 17 modules; cic `lib/api.ts` (`WireUserEvent`), `lib/wireTypesAssert.ts` (`CrossModuleArm`, `DeliberatelyWidened`, the `_Assert_` pins), `lib/userTopic.ts`; `docs/CLIENT_PROTOCOL.md`; `scripts/client-protocol-gate.sh`; shottino `wire.c`.
**What is wrong:**
- **No server type** (DUP). `to_user/2` takes `map()`, and no server type names what rides the user topic. So the codegen can emit only `WireSessionEvent`, and cic rebuilds the rest by hand:
  - `WireUserEvent`, about 500 lines with 42 inline arms plus 11 named;
  - `CrossModuleArm`, a 22-entry hand registry, 7 of whose entries were added for E2E/pairing/requests since the last review;
  - `DeliberatelyWidened`, 5 entries.
- **A duplicate arm.** `isupport_changed` is still declared twice in `api.ts`, each with the stale "Absent → `["b"]`" comment, which contradicts `wireNarrow.ts`.
- **Four hand edits per event on the client** (EXT):
  1. a union arm;
  2. a narrower. This half is improving: `userTopic.ts` imports 55 distinct generated `S_*` schemas;
  3. a dispatch arm, which tsc forces through `assertNever`;
  4. by convention, an `_Assert_` pin: 37 pins against 164 runtime-reachable schemas, still unenforced.
- **The protocol doc is gated for kinds, not fields.** `CLIENT_PROTOCOL.md` grew from 1,090 to 2,315 lines and is the #2 hotspot (64 commits).
- **shottino learns new kinds only through the case-label scraper.**

**Evidence (MEASURED, EXT, traced commit by commit).**

| Event | Unique files | Lines | Commits |
|---|---:|---:|---:|
| #1894 `away_nick_suffix_changed` | 26 | +1,115 | 5 |
| #2577 `e2e_incoming` / `_lost` | 28 | +1,567 | 4 |

Each split into roughly 5 server, 6 protocol and generated, 6–9 cic, 5 test, 2 e2e, 2 docs and 1–3 shottino files. The 2026-09-22 measurement (`network_attached`) was 20 files for the first commit alone, so the cost is flat to slightly up.

**Impact:**
- Three of the four client edits restate the server's payload type, and the assert only proves the restatement matches.
- The field-level accuracy of the protocol doc depends on memory.

**Direction:**
- Declare one server union in the module that owns the topic, e.g. `@type user_topic_event :: Session.Wire.wire_event() | UserSettings.Wire.… | E2eRequests.Wire.… | …`, and type `to_user/2` with it.
- Have the codegen emit `WireUserTopicEvent`, and alias `WireUserEvent` to it minus the widened arms.
- Delete `CrossModuleArm`, the 42 inline arms and the duplicate `isupport_changed`.
- Extend `client-protocol-gate.sh` to check fields, or generate a field table into the doc between markers.

#### X10. The per-channel topic is not schema-validated, and one server shape gets two client narrowers with different tolerance
**Raised by:** TYP-A5, DUP-A6 (both MEDIUM). Counted once, MEDIUM.
**Location:** cic `lib/wireNarrow.ts` (`narrowChannelEvent`, `narrowScrollbackMessage`, `narrowMembers`, `narrowMembersIndexResponse`, `ADDITIVE_DETAIL_FIELDS`), `lib/userTopic.ts` (`narrowUserEvent`), `lib/api.ts` (`WireChannelEvent`, `WireUserEvent`), `lib/socket.ts` (`.receive("ok", …)` callbacks); server `Session.Wire.member()`, `members_index_payload`, `members_seeded_payload`.
**What is wrong:**
- **Coverage by arm** (TYP):

  | Surface | Schema-validated | Hand-narrowed |
  |---|---|---|
  | User topic (`narrowUserEvent`) | 49 arms | 7 arms, plus 4 that delegate to hand narrowers |
  | Per-channel topic (`narrowChannelEvent`) | 0 of 11 kinds | 11 kinds |

  - The 7 hand arms are `whois_bundle`, `bundle_hash`, `server_settings_changed`, `lusers_bundle`, `recover_progress`, `recover_result` and `web_session_severed`: 173 code lines (DUP).
  - The per-channel topic is the highest-volume surface: every live row and every window-state snapshot.
- **The same row through two validators** (TYP). `ScrollbackWireT` goes through `narrowRest({a: S_ScrollbackWireT})` on REST and through the hand `narrowScrollbackMessage` live; the latter re-casts `kind` and `meta` after its checks. They agree today apart from integer vs number.
- **One typespec, opposite tolerance on two doors** (DUP). `Session.Wire.member()` is one typespec, shared by the REST `members_index_payload` and the WS `members_seeded_payload`.
  - REST validates `S_SessionWireMember`, so an unknown gender rejects the whole member list.
  - WS uses the hand `narrowMembers`, which degrades the same value to `null` per member.
  - So the same value is valid on one door and fatal on the other.
- **`any` through library typings** (TYP). It enters through phoenix.js: four `.receive("ok", (reply: {…}) => …)` callbacks annotate a concrete type over `any`. The explicit-`any` count of 0 cannot see these.

**Impact:**
- A server change to a per-channel payload is checked only by whoever remembers to edit `narrowChannelEvent`.
- A server adding a gender breaks the members REST fetch while the WS path keeps working, and nothing in either file shows the difference.
- "One feature, one code path, every door" is violated at the client edge.

**Direction:**
- Run `narrowChannelEvent` off a generated per-channel union schema, as #429 did for `narrowAdminEvent`. Keep hand code only for documented policy (the `read_cursor_set` badge default).
- Make `narrowScrollbackMessage` call `validate(S_ScrollbackWireT, …)`.
- Decide the tolerance once, as data: apply `ADDITIVE_DETAIL_FIELDS` to `member.gender`, and move `members_seeded` onto `S_SessionWireMembersSeededPayload`.
- Wrap channel pushes in one helper that hands callbacks `unknown`.

**Related:** COH-A7 (where `narrowUserEvent` lives).

#### X11. The e2e suite grew 32% past its shard sizing, is organised by ticket number, and its duplicated helpers grew with it
**Raised by:** EXT-A9, DUP-A12 (both MEDIUM). Counted once, MEDIUM. EXT itself names the helper half as the prior Duplication A8.
**Location:** `cicchetto/e2e/tests/` (one flat directory), `cicchetto/e2e/fixtures/` (38 files, including `grappaApi.ts` and `cicchettoPage.ts`), `cicchetto/e2e/playwright.config.ts` (`workers: 1`), `.github/workflows/integration.yml`.
**What is wrong:**
- **Size** (EXT). #1519 (2026-08-20) sized four shards on 33.6 min of serial time, with `workers: 1` "load-bearing inside every shard". Since then the suite went from 411 to 538 spec files and from 766 to 1,014 `test(` calls.
- **Organisation.** 389 of the 538 specs are named `issueNNNN-*`, all in one flat directory.
- **Duplicated helpers.**
  - DUP counts names defined in ≥3 spec files: 25 helpers / 105 copies, up from 23 / 98. The most copied: `scrollbackGeometry` ×9, `openChannel` ×7, `scrollToTop` ×6, `deleteNetworkBestEffort` ×6.
  - EXT counts names defined in more than one spec: 78 names / 218 copies → 94 / 266.
  - `deleteNetworkBestEffort` still has three signatures.
  - `type NetRow` is re-declared in 3 specs, while only 2 e2e files import `wireTypes`.

**Evidence.** The counts above are MEASURED. The estimate of ≈ 44 min serial and ≈ 18 min per shard is INFERRED, scaling the 2026-08-20 measurement by test count.
**Impact:**
- The mandatory full-suite ship gate grows linearly, runs serially inside each shard, and needs a docker stack that only one run per host can use at a time.
- A fix lands in one helper copy, and each new spec copies its nearest neighbour.

**Direction:**
- Re-measure the shard knee on today's suite.
- Promote helpers used in ≥3 specs into `e2e/fixtures/`, with one `deleteNetworkBestEffort(token, id)` and `NetRow` typed as the generated network row.
- Add a check that fails when a spec defines a name that `fixtures/` exports, or a name defined in another spec.
- Group new specs by feature directory.

### Related findings kept separate

- **The identity fold.**
  - DUP-A4 (five client fold implementations) and TYP-A3 (folded keys have no type on either side) overlap on the E2E `fold`, and both recommend replacing it with `asciiFold`.
  - They stay separate because their main cures differ: deleting the copies versus branding the key.
  - EXT-A11 cites `Identifier.services_sender?/1`'s `String.downcase` as evidence that the fold rule has no gate; DUP-A4 recommends `canonical_target/1` there.
  - The two reviewers count the E2E `fold` call sites differently.
- **Boundary hygiene after #1398.**
  - The findings: BND-A5 (`E2eInbox` declares the whole `E2eKeys`), DEP-A1 (phantom `Admission → Networks`), DEP-A2 (≥23 phantom deps), DEP-A7 (`Application`'s deps).
  - The common thread: Boundary 0.10.4 reports neither unused nor over-broad deps, so the declared graph drifts from the real one. DEP-A2 proposes a ~60-line `mix` check.
  - The two reviewers frame the full-context-for-one-struct class differently.
- **The authority documents disagree with the code.**
  - CLAUDE.md:
    - BND-A10: the window-state invariant lacks the encrypted-window carve-out.
    - DEP-A3 and DEP-A8: supervision-ordering prose and comments.
    - EXT-A8: session-protocol steps point at `docs/checkpoints/` and `todo.md`, which no longer exist.
  - Code comments:
    - TYP-A2: a `server.ex` comment misstates what Preflight reads.
    - DEP-A1/A2: stale cycle justifications.
    - BND-A1: `Topic.server_settings/0` documents a trigger that nothing subscribes to.
  - DESIGN_NOTES:
    - EXT-A10: archived rulings that were later reversed carry no forward pointer.
- **Generated closed sets versus hand classifications.**
  - The findings: DUP-A5 (25 of 34 generated consts have no runtime consumer; TYP's baseline agrees, 9 of 34 used), EXT-A2 (hand classification `Set`s fail open), TYP-A4 (`FONT_FAMILIES` beside the unconsumed `THEMES_TOKEN_MODEL_FONT_FAMILY`), X6 (shottino's message-kind table).
  - EXT-A2 and X6 both recommend pinning `MESSAGE_KIND_NAMES`.
- **E2E as the driver of this window's findings.**
  - The findings it touches: COH-A1, X2, X5, BND-A5, BND-A7, DEP-A12, DUP-A4, DUP-A5, COH-A5 (E2E decoration in `ScrollbackPane`), DUP-A14 (a new `Wire.Time` shim in `E2eRequests.Wire`).
  - The reviewers agree that the cic E2E stack is well layered internally (COH), and that the server's E2E contexts each hold one job and render through `*.Wire` (COH, BND, DUP). The defects are placement and mirroring.

## Where the reviewers disagree

No count below was re-run for this document.

| Quantity | Reviewers' numbers | Note |
|---|---|---|
| Is the E2E device cap pinned? | BND-A7: a server change to the cap "shows wrong 'revoke one first' copy in the client, and nothing fails". DUP-A1: `limits_parity_test.exs` pins `DEVICE_CAP` between the server and cic | Both agree shottino's copy is unpinned |
| shottino closed sets pinned | DUP-A11: 7 hand `*_NAMES` tables, 2 pinned, and it lists the five E2E sets among the unpinned. TYP-A6: 7 of 10 wire enums pinned (2 server sets + 5 E2E sets via `pin_closed_set`). DEP-A6: the five E2E sets pinned, 29 of the 34 generated sets unpinned. BND and EXT (prior-status rows) agree the E2E sets are pinned against `wireTypes.ts` | Four reviewers against one on the E2E pins. The denominators (7 tables, 10 enums, 34 generated sets) differ by construction |
| shottino `rows_of` readers | BND: 9 readers. DUP: cites 4 call sites | DUP may be listing examples |
| Web views reached by codegen | DUP: `@extra_modules` lists 4 of the 13 views. TYP: 9 of 13 outside codegen. BND lists the same four modules, `ErrorTokens` among them, and counts 3 of the 13 views as generated | |
| E2E `fold` call sites (cic) | DUP-A4: 30 in 8 modules. TYP-A3: 38 | |
| `user_settings` keys in use | TYP-A4: 18 (17 `@*_key` + `"highlight_patterns"`). BND (prior A11 row): 19 (17 + `"highlight_patterns"` ×7 + `"muted_targets"` ×2) | Both count the schema registry at 8 rows; COH agrees on 17 key constants |
| `Session.Server` state keys | COH: 83 → 94 (regex over the `@type t` block). TYP: 96 keys in `Server.t()`, "grew from 82 to 96" | 2026-09-22 had reconciled 82 at `c678ea5a` |
| `shottino.c` commits in window | COH: 53 (36 E2E-tagged). EXT: 52 | |
| Components importing `api.ts` | BND (prior A8 row): 40 of 110 (was 35/99). DEP-A11: 42 of 114, 32 for values (was 35/96) | Different component globs |
| Duplicated e2e spec helpers | DUP-A12: 25 helpers / 105 copies (defined in ≥3 specs). EXT-A9: 94 names / 266 copies (defined in >1 spec) | Different thresholds, not a contradiction |
| Inline controller literals carrying domain data (prior H-N2) | BND: roughly 40. EXT: 41 | Same method lineage. BND says the line-scoped grep can move by a few |
| Registry-key test coverage (X7) | BND: `admission_test.exs` registers via `registry_key/2`, so some admission tests would likely go red (INFERRED). DEP: found no test pinning the match specs to `registry_key/2` (not exhaustively searched) | |
| Full-context-for-one-struct deps | BND-A5: a regression of H13, which 2026-09-22 recorded FIXED. DEP-A2: `Mentions → Scrollback` and `Push → Scrollback` are still-open instances of the same class | |
| Hotspot ranks | `default.css`: #1 code hotspot (COH), #3 overall (EXT, after two prose files), both at 64 commits. `server.ex`: #2 code hotspot (COH), "the repo's #1 hotspot file" (TYP) | |
| Severities of merged findings | X1 HIGH/MEDIUM; X2 HIGH/MEDIUM/LOW; X3 HIGH/MEDIUM/MEDIUM; X4 HIGH/MEDIUM | Counted at the highest; see each finding |

---

## Concern: abstraction boundaries

The reviewer filed 10 new findings: 0 CRITICAL, 0 HIGH, 6 MEDIUM, 4 LOW. After the merge, 8 distinct findings are counted here: BND-A3 is the home of X7, BND-A2 went to X2 and BND-A6 to X3. Method: grep, `wc` and `git log`/`git show`/`git diff` only.

### MEDIUM

#### BND-A1. Domain events and use-case orchestration are emitted from the web layer, and the context-side bus for one of them has no production subscriber
**Severity:** MEDIUM
**Location:** `GrappaWeb.ReadCursorAdvance.advance/4`; `GrappaWeb.{Messages,ReadCursor,Archive}Controller`; `GrappaWeb.Admin.SettingsController` (`reapply_auto_away/1`); `GrappaWeb.GrappaChannel` (query-window close); `Grappa.ServerSettings.put_many/1`; `Grappa.PubSub.Topic.server_settings/0`; `Grappa.Push.BadgeCount`; `Grappa.QueryWindows.close/4`; `Grappa.Scrollback.delete_for_*`.
**What is wrong:** In four state changes, the context writes the state and the web door emits the event clients see.
- **Read-cursor advance (#2407, new).**
  - `advance/4` writes the cursor, folds the badge, broadcasts `read_cursor_set` and re-seeds `window_counts`. It is called from two controllers.
  - Its moduledoc says a context home "would close that cycle". That holds only for `Grappa.ReadCursor` itself. `Push.BadgeCount` is already a separate top-level boundary for exactly this reason, and a sibling boundary with deps `[ReadCursor, Push.BadgeCount, WindowCounts, Subject]` closes no cycle (INFERRED from the declared deps, not compiled).
  - The second rationale (#2407) is that `POST …/messages` "is the subject typing" and "the only send door". So the fact "authored by the subject" is encoded by which HTTP route the request took.
- **Server settings.**
  - `put_many/1` broadcasts on `Topic.server_settings/0`, but only tests subscribe to that topic (grep). `Session.Server` subscribes to `user_settings` and `ws_presence`, not to this one.
  - The per-user fan-out over `WSPresence.list_user_names/0`, and the push to running sessions, live in the controller.
  - The topic's doc calls it "the intra-server signal that triggers" the fan-out. `server_settings.ex` calls it "Retained as an in-process signal for tests", which is production code kept for tests.
- **Archive purge.** `ArchiveController.delete/2` picks the delete verb by sigil, calls Scrollback, and broadcasts `archive_purged` itself.
- **Query-window close.** `QueryWindows.close/4` broadcasts `query_windows_list`; the `archive_changed` that follows is broadcast by the channel handler.

**Impact:**
- Every non-HTTP door that makes one of these changes skips the event without any error. CLAUDE.md already names one such door: the Phase-6 `+draft/read-marker` MARKREAD facade needs exactly `advance/4`. So would an rpc/`Operator` settings write, or a future WS send verb.
- A reader of `ServerSettings` or `Topic` is told an event drives the fan-out when none does.

**Direction:**
- Move `advance/4` into a top-level `Grappa.ReadCursor.Advance` (the `BadgeCount` pattern), using `Grappa.Subject.label/1`.
- Make "subject-authored" an explicit argument of the send verb.
- For settings, pick one shape: either the fan-out and `reapply_auto_away_site_default/0` subscribe to the topic and the controller stops broadcasting, or the topic and its test-only broadcast are deleted.
- Move the `archive_purged`/`archive_changed` emissions into `Scrollback.delete_for_*` and `QueryWindows.close/4`.

#### BND-A3. Session's registry key is hand-spelled in match specs in two other boundaries. Merged into X7, counted here.

#### BND-A4. `Vhosts` re-derives "last known IP" from Accounts' sessions table, and answers differently from the verb Accounts now exports
**Severity:** MEDIUM
**Location:** `Grappa.Vhosts` (private `last_known_ip/1`, from #647); `Grappa.Accounts.last_known_ip/1` (#2597) and `newest_touch_by_subject_ids/2`; the `Grappa.Accounts.Session` leaf; `Session.Server` (the WHOIS path).
**What is wrong:** There are now two implementations of the same fact.
- **`Accounts.last_known_ip/1`** answers with the `ip` of the subject's newest session row by `last_seen_at`, which may be `nil`. It feeds the admin listings and the WHOIS card. Its doc says it is not `visitors.ip`, which is "identity-wide, frozen at first sight".
- **Vhosts' private copy** works differently:
  - For users, it queries `Accounts.Session` directly with `where: not is_nil(s.ip)`, so it skips to an older row that has an address.
  - For visitors, it reads `visitors.ip`, the field Accounts' own doc describes as a different fact.
- **The intent is the admin view.** Vhosts' comment says it means to reconnect from the address "the operator could SEE … in admin".
- **The leaf promotion made this legal.** The `Accounts.Session` promotion (#1398) is what allowed the table query without the context dep. Calling the verb instead would close no cycle.

**Impact:** Mode-2 addressing and the operator's view of a subject's address can disagree: for visitors always, and for users whenever the newest session has no address. A third caller will copy whichever implementation it finds first.
**Direction:**
- Have Vhosts call `Accounts.last_known_ip/1`. If mode 2 really needs "newest non-nil", add that variant to Accounts under its own name and say why it differs.
- Drop Vhosts' `Accounts.Session` dep.

#### BND-A5. `E2eInbox` declares the whole `E2eKeys` context to reach one schema, the pattern #1398/#1399 eliminated (regression of prior H13)
**Severity:** MEDIUM
**Location:** `Grappa.E2eInbox` (`use Boundary` deps); `E2eInbox.Entry`; `Grappa.E2eKeys` (which exports `Device`, `DeviceList`, `Key`); the `Session.Server` struct matches on `E2eKeys.Device`/`Key`.
**What is wrong:**
- **E2eInbox calls no `E2eKeys` function** (`grep "E2eKeys\.[a-z_]*("` is empty). What it uses is the `Device` struct plus three queries over the devices table.
- **CLAUDE.md is explicit.** A boundary that needs only a schema declares the schema, not the context. Its own measurement shows that declaring the context lets any verb call compile green.
- **The class was recorded closed.** 2026-09-22 recorded it FIXED (H13).
- **The same edge carries other references.** `E2eKeys` exports its schemas as context members instead of promoting them as leaves, so `Session.Server`'s struct matches ride the same whole-context edge.

**Impact:** The checker says nothing if E2eInbox starts calling key-management verbs. This is now the closest pattern for every E2E follow-up.
**Direction:**
- Promote `E2eKeys.Device` (and `Key`/`DeviceList` if they are named outside) to `top_level?: true` leaves with their own measured deps.
- Change E2eInbox to `deps: [Grappa.E2eKeys.Device, …]`.
- Verify with `mix compile --force --warnings-as-errors` under both `dev` and `test`.

DEP-A2 records other full-context-for-one-struct instances as still open since September, so it does not treat the class as having been closed.

#### BND-A2. The E2E outer-frame arithmetic is implemented three times. Merged into X2.

#### BND-A6. cicchetto validates REST bodies against generated exact types, then returns hand-widened copies. Merged into X3.

### LOW

#### BND-A7. Four E2E contexts, three wire-placement disciplines, no facade, and a server policy constant hand-mirrored in the client
**Severity:** LOW
**Location:**
- Wires: `E2eKeys.Wire` (its own top-level boundary); `E2eRequests.Wire` and `E2ePairing.Wire` (exported members of their contexts); `Session.Wire` (`e2e_message/3`, `e2e_inbox/3`, `e2e_copied/1`).
- `GrappaWeb.E2eController.inbox/2`.
- The cap: `E2eKeys.DeviceList.max_devices/0`; cic `lib/e2e/wire.ts` (`DEVICE_CAP`), used in `PairResults.tsx`, `PairJoin.tsx`, `EncryptedRail.tsx` and `AddDevicePanel.tsx`.

**What is wrong:**
- **Three ways to place a Wire.**
  - `E2eKeys.Wire` is a separate boundary.
  - `E2eRequests.Wire` and `E2ePairing.Wire` are exported members of their contexts.
  - `E2eInbox` has no Wire at all: its `Entry` is projected by `Session.Wire` (2,291 lines). CLAUDE.md's rule is a context-owned `*.Wire`.
- **The controller composes the inbox read.** `inbox/2` chains `E2eKeys.device/3`, `E2eInbox.list/2`, `E2eKeys.seen/1` (the rule "reading marks the device active") and `Session.Wire.e2e_inbox/3`, across three contexts.
- **The device cap is never published.** The server enforces `max_devices/0` (`@spec max_devices() :: 3`) but does not publish it. cic hard-codes `DEVICE_CAP = 3`, with a comment pointing at the server function, and renders it in four components.

**Impact:** small today, but this is the template the next E2E slice will copy. BND: a change to the cap shows wrong "revoke one first" copy in the client, and nothing fails. DUP-A1 says a parity test pins this constant, so the two reviewers disagree on that point.
**Direction:**
- Give `E2eInbox` its own Wire (Session.Wire can delegate to it for the user-topic push), and pick one placement for the four Wires.
- Move "list + mark seen" into an `E2eInbox` verb.
- Publish `max_devices` on the E2E devices response or in `/api/config`.

#### BND-A8. A web controller decodes a changeset's constraint options to detect a composite-PK collision, so the two bind doors answer the same conflict differently
**Severity:** LOW
**Location:** `GrappaWeb.Admin.CredentialsController` (`bind_with_conflict_classification/3`, `pk_collision?/1`); `GrappaWeb.SessionController`; `Grappa.Networks.Credentials.bind_credential/3`.
**What is wrong:**
- **The admin door** pattern-matches `%Ecto.Changeset{errors: errors}` and looks for `opts[:constraint] == :unique` on `:user_id`/`:network_id`. It answers 409 `already_exists`.
- **`SessionController`** calls the same `bind_credential/3`, passes the changeset on, and answers 422 `validation_failed` for the same conflict.

**Impact:** persistence details (PK layout, Ecto's error encoding) sit in the web layer, and two doors give two status codes for one domain error.
**Direction:** have `bind_credential/3` return `{:error, :already_exists}` for the collision, delete `pk_collision?/1`, and let FallbackController map it once for both doors.

#### BND-A9. `GrappaChannel` re-resolves its subject by a user-name DB lookup at 9 sites although the socket already carries it; a domain module parses Plug assigns
**Severity:** LOW
**Location:** `GrappaWeb.GrappaChannel` (`resolve_subject/1`; `safe_get_user/1`, which rescues `Ecto.NoResultsError`; the moduledoc); `GrappaWeb.UserSocket`; `Grappa.Subject.from_assigns/1`; `GrappaWeb.Subject.to_session/1`.
**What is wrong:**
- **Two derivations of one identity.** `UserSocket` assigns `:current_subject` at connect, and 5 handlers use it. Nine others rebuild the subject from `:user_name`, the topic display label, through `Subject.from_topic_label/1` and `Accounts.get_user_by_name!/1`. That is one DB read per WS command, keyed on a display string. The 2026-07-20 review counted 17 such sites; 9 remain.
- **A stale moduledoc.** It still says `UserSocket` "hardcodes the socket's `user_name` as `"vjt"`".
- **Two spellings of one conversion.** `Grappa.Subject.from_assigns/1` is a core module pattern-matching `conn.assigns.current_subject`. It duplicates `GrappaWeb.Subject.to_session/1`, and the web layer is split between them: 34 calls in 5 controllers against 35 calls in 21 files.

**Impact:**
- A redundant round trip on every affected WS command.
- Identity resolution depends on a display label staying unique and stable. BND did not establish that a rename door exists, so it claims redundancy, not a live bug.

**Direction:**
- Use `socket.assigns.current_subject` everywhere, and delete `resolve_subject/1` and `safe_get_user/1`.
- Delete `Grappa.Subject.from_assigns/1` in favour of `GrappaWeb.Subject.to_session/1`.
- Fix the moduledoc.

#### BND-A10. CLAUDE.md's window-state invariant does not name the client-only encrypted window it now has an exception for
**Severity:** LOW
**Location:** CLAUDE.md invariants ("Window state model lives on the server", "Read state is server-owned"); cic `lib/encryptedChats.ts`, `lib/encryptedWindow.ts`, `lib/windowKinds.ts`; DESIGN_NOTES (the 2430 ruling, comment 6333417572, and the same reversal on #39's metadata strip).
**What is wrong:**
- **The exception is real and recorded.** The encrypted query window lives "in cic only". Its open/closed state, rows and unread count are device-owned, in IndexedDB, keyed `$e2e:<nick>`. The server cannot hold them, and DESIGN_NOTES records the decision.
- **CLAUDE.md still states the absolute.** It still says "cic NEVER originates state … no parallel client-side state machine" and "Read state is server-owned".
- **Two window models now coexist.** cic holds the server-mirrored `windowStateByChannel` and the client-owned encrypted chats, in one `ChannelKey` namespace separated only by the `$` prefix.

**Impact:** the next reader either "fixes" the encrypted window back onto the server, or treats it as precedent for client-owned state elsewhere.
**Direction:** add a one-sentence carve-out to both invariants, pointing at the 2430 ruling: encrypted windows and their read state are device-owned because the server cannot read them, and that is the only exception.

### Prior findings (2026-09-22, abstraction boundaries) — status

| Prior | Finding | Status | Evidence |
|---|---|---|---|
| A1 | EventRouter 4-key contract | FIXED (2026-09-22) | not re-checked |
| A2 | Reply-bundle accumulators as `map()` | FIXED (2026-09-22) | not re-checked |
| A3 | `Grappa.Subject` SSOT partially adopted | PARTIAL in the table, OPEN and grown in the tally; one new copy | 4 literal re-declarations remain, plus a 5th inline one in the new `Accounts.last_known_ip/1` spec (#2597); `Session.put_subject_id/2` still has 8 callers in `server.ex`; `Admin.UploadsController` still re-derives the XOR |
| A4 | Codegen membership by name; `Push.Payload` outside | OPEN | three nominal rules unchanged; the push shape is still declared twice (`Push.Sender`, `Push.Payload`); `IgnoresJSON` is pinned, not generated (X3) |
| A5 | `readError` bypasses | OPEN | `readCursor.ts` advances optimistically, then only `console.warn`s and skips the 401 hook; `serverSettings.ts`; `userSettings.ts` builds errors from `statusText` at 5 GET sites |
| A6 | `RawNetwork`/`tagNetwork` | OPEN | 15 optional fields, cast in `listNetworks` (X3) |
| A7 | Hand-written REST shapes on both sides | OPEN, grew | 42 hand `export type X = {` in `api.ts` (was 41); controller schema projections remain; `Admin.SettingsController` now also hand-assembles `dcc` and `auto_away` |
| A8 | `api.ts` size, exports, importers | OPEN, grew | 4,065 lines (was 3,604); 134 value + 112 type exports; 120 non-test importers; 40 of 110 components (was 35/99) |
| A9 | Flat `lib/`; join+focus spellings | OPEN, grew | 290 root modules (was 258) plus `lib/e2e/` (20 files); `HomePane.tsx` still focuses with the raw name |
| A10 | `compose.ts` / `queryTopicJoin` seam | PARTIAL, unchanged | `compose.ts` 1,592 lines (was 1,529); `subscribe.ts` still boots its tree at import |
| A11 | UserSettings key registry is prose only | OPEN, worse | registry 8 rows; code uses 19 keys (TYP counts 18) |
| A12 | Generated validators largely unwired | PARTIAL, improving | 232 generated / 88 imported / 164 reachable / 68 never read (was 196/64/132/64); the REST edge now imports narrowers (32 `narrow*` calls); 31 casts remain in `api.ts` (was 29) |
| A13 | Channel `{:reply, {:ok, …}}` bypasses Wire | OPEN | 4 sites in `GrappaChannel` |
| A14 | `ownNickForNetwork` dead parameter | OPEN, grew | 19 non-test callers (was 11) |
| A15 (HIGH) | Wire pin blind to inline controller bodies | OPEN | roughly 40 domain-data literals; `IgnoresJSON` moved out and became pinned but not generated |
| A16 (HIGH) | shottino's two wire disciplines and drift | PARTIAL, downgraded to MEDIUM | five drifts fixed; closed-set tests pin against `credential.ex` and generated consts; legacy REST still guesses envelopes (`rows_of` ×9, 69 raw `json_get(`) (X6) |
| A17 | IRC positional params decoded in a cic view | OPEN | `ScrollbackPane.tsx` has 6 per-verb arms; `RawEvent`/`NumericEvent` are local hand types |
| A18 | REST transport spread across modules | OPEN, grew | 35 `authorization:` header literals outside `api.ts` (was 29); raw `fetch(` in `userSettings.ts` 26 (was 20); `lib/e2e/pairing.ts` is a ninth transport module, though it is the one that does it right |
| A19 | Session API returns wire payloads | OPEN | `dcc_offer_payload`, `invited_windows` |
| A20 | shottino overrides window classification | OPEN | `route_target`, comment unchanged ("Until then") |

---

## Concern: responsibility & cohesion

The reviewer filed 7 new findings: 0 CRITICAL, 3 HIGH, 3 MEDIUM, 1 LOW. All 7 are counted here: COH-A2 is the home of X1 and COH-A3 the home of X5. Method: raw newline and regex counts, with the same regex at both revisions.

**Size data (MEASURED).**

| Module | `c678ea5a` | now | Δ | Note |
|---|---:|---:|---:|---|
| `session/server.ex` | 8,789 | 10,374 | +18.0% | faster than `lib`; state keys 83 → 94; callback clauses 132 → 143; `defp` 237 → 328; stored timer refs 7 → 10 |
| `session.ex` (facade) | 2,514 | 2,956 | +17.6% | public `def` 76 → 88 |
| `session/event_router.ex` | 5,549 | 5,669 | +2.2% | |
| `user_settings.ex` | 2,940 | 3,169 | +7.8% | key consts 14 → 17 |
| `fallback_controller.ex` | 916 | 1,102 | +20.3% | `call/2` clauses 73 → 93; sanctioned (see refusals) |
| `ScrollbackPane.tsx` | 4,597 | 5,346 | +16.3% | component closure 3,299 → 3,821 |
| `lib/api.ts` | 3,604 | 4,065 | +12.8% | exports 222 → 246, importers 107 → 120 |
| `SettingsDrawer.tsx` | 3,216 | 3,419 | +6.3% | |
| `Shell.tsx` | 1,265 | 1,423 | +12.5% | 74 imports, 47 of them components |
| `lib/userTopic.ts` | 1,574 | 1,759 | +11.8% | 120 `case` labels, 55 lib imports |
| `lib/subscribe.ts` | 1,542 | 1,526 | −1.0% | |
| `themes/default.css` | 16,043 | 17,452 | +8.8% | 64 commits in window |
| `shottino.c` | 23,790 | 30,981 | +30.2% | |

**Where the growth came from.** Each commit was tagged as E2E when its subject names 2430, its siblings, e2e, encrypt or pairing, and net lines were summed per file:
- `session/server.ex`: 31 of 62 commits, and 1,023 of 1,585 net lines (64.5%).
- `shottino.c`: 36 of 53 commits, and 6,094 of 7,191 net lines (84.7%).

### HIGH

#### COH-A1. The E2E relay was absorbed into `Session.Server` in the #1390 shape, and it accounts for 64.5% of the module's regrowth
**Severity:** HIGH
**Location:**
- `Grappa.Session.Server`.
- The `Grappa.Session` facade: `send_e2e/8`, `copy_e2e/6`, `ask_e2e/5`, `answer_e2e/5`, `dismiss_e2e/4`, `e2e_send_verbs/0`, `e2e_priorities/0`.
- `Session.{E2ePacer,E2eReassembly,E2eKeyAnswers}`.
- `Grappa.{E2eInbox,E2eKeys,E2eRequests}`.
- The Reaper children in `Grappa.Application`.

**What is wrong:**
- **The third foreign domain to land here.** #1390 removed the channel-directory ETL from `Session.Server` as "a domain of its own". DCC then landed in the same place (prior COH A1). E2E is the third foreign domain there, and the largest.
- **The pure parts were extracted.** `E2ePacer` (1,198 lines, "Pure data"), `E2eReassembly` and `E2eKeyAnswers` hold the logic.
- **The process glue stayed:**
  - one contiguous ~847-line section, under the banner "issue 2430 — end-to-end encrypted queries";
  - 5 `handle_call`s (`send_e2e`, `copy_e2e`, `e2e_ask`, `e2e_answer`, `e2e_dismiss`);
  - 3 `handle_info`s (`:e2e_pacer_tick`, `:e2e_inbox_sweep`, `:e2e_reassembly_sweep`);
  - an `apply_effects` arm for `{:e2e_fragment, …}`;
  - 7 new state keys;
  - 3 timers under a discipline the module uses nowhere else: a stored ref cancelled with `Process.cancel_timer` and never drained. The other 7 stored timers go through `cancel_and_drain`.
- **The session process does persistence and retention work for three DB-backed contexts, inline.**
  - Call sites: `E2eRequests.*` 22, `E2eInbox.*` 6, `E2eKeys.*` 4.
  - Two hourly retention sweeps (`sweep_e2e_inbox/1`, `sweep_e2e_requests/1`). Everywhere else in the tree, retention is a dedicated supervised Reaper (Uploads, Avatars, Dcc, Accounts, Visitors).
- **A context API was bent to protect the host process.** DESIGN_NOTES 2026-10 (#2430 multi-device): SQLite's FK failure would make Ecto raise, "and in `Session.Server` that would take the IRC link down". So `E2eInbox.put/2` and `E2eKeys.upload/2` check the device inside their immediate transaction.
- **A sibling process was never weighed.** The only placement alternative on record is the pure router. Yet the pacer does not need session state to pace: it reads the bank from `Client.fake_lag_bank_ms/1` and writes through `Client.send_privmsg/3`.

**Evidence (MEASURED).** 31 of 62 commits, and 1,023 of 1,585 net lines (64.5%), are E2E-tagged. `grep -ci e2e` on `server.ex`: 5 → 336 lines.
**Impact:**
- An encrypted-relay change edits the most contended server file.
- A defect in E2E persistence or sweeping crashes the user's IRC link.
- INFERRED, not tested: the inbox and request sweeps run only while a session is alive, so retention of a parked or detached network's queue is tied to IRC liveness rather than to the TTL.

**Direction:**
1. Move the relay into a per-session sibling process, e.g. `Grappa.Session.E2eLink`, under the same `(subject, network)` key. Hand it the `Client` pid. It would own:
   - reassembly, the pacer and key answers;
   - the unqueued counts;
   - the three timers.

   The session would keep none of the 7 keys. It forwards `{:e2e_fragment, …}` effects, and receives the rare `{:persist, …}` notice rows back as a message, the same shape as DCC's `:dcc_transfer_done`.
2. Move both retention sweeps into an `E2e.Reaper`, beside the other five.
3. Whichever shape wins, record in DESIGN_NOTES why the sibling was adopted or rejected.

DEP-A5 (in X1) recommends emitting effects for the same persistence.

#### COH-A2. `Session.Server` is outgrowing the codebase again, and #2133's ruling is 9+ weeks overdue. Merged into X1, counted here.

#### COH-A3. `shottino.c` grew another 30% past the ruling that declined to split it. Merged into X5, counted here.

### MEDIUM

#### COH-A4. `Shell.tsx` is a composition root that also owns selection policy and store bootstrapping, and spells the window-kind→pane table twice
**Severity:** MEDIUM
**Location:** cic `Shell.tsx`, `lib/selection.ts`, `lib/uploadOrchestrator.ts`, `lib/banMaskPref.ts`.
**What is wrong:** `Shell.tsx` (1,423 lines, 74 imports, 47 of them components) is meant to compose panes. Besides layout, it carries six other jobs:
1. **Cold-load window restore** (~165 lines): a state machine with two closure latches (`coldLoadDone`, `provisionalHome`), including the issue-1985 parked-network redirect. Its comment argues restore versus transition, not why the restore lives in a component.
2. **Admin-demote redirect.**
3. **Three store bootstraps** (`loadUploadTtlSeconds`, `loadUploadConfirmEnabled`, `loadBanMaskForm`). Each was added because its cache stayed empty until SettingsDrawer opened.
4. **A keybinding action table.**
5. **The mobile sidebar mount/scroll lifecycle.**
6. **Mention-click navigation.**

The selection redirect policy is split between store and component: Shell writes `setSelectedChannel(` 10 times, `selection.ts` 5 times.

The layout is also spelled twice, once per form factor:
- the 6-arm window-kind `<Switch>`;
- the 19 self-gated modals, each mounted twice.

The arms differ only in `TopicBar` props. The encrypted window kind had to be added to both.

**Impact:**
- A new window kind or modal is a two-site edit.
- A focus rule has two possible homes, and the comments show contributors re-arguing which one each time.
- Store caches depend on a component mounting to become correct.

**Direction:**
- Move cold-load restore and admin-demote into `lib/selection.ts`, as module-root effects beside bucket D.
- Move the three bootstraps into their own modules' `moduleRoot`, keyed on token/user, as `subscribe.ts` does.
- Extract a `WindowPane` component and a `ShellModals` component that mounts the 19 modals once, above the `isMobile()` split.

#### COH-A5. `ScrollbackPane` keeps absorbing concerns, now including E2E decoration, despite the new source seam (still open since 2026-09-22, prior A10, grew)
**Severity:** MEDIUM
**Location:** cic `ScrollbackPane.tsx`, `lib/scrollbackSource.ts`, `E2eRequestBanner.tsx`, `E2eRequestCard.tsx`.
**What is wrong:**
- **Size.**

  | Quantity | Then | Now |
  |---|---:|---:|
  | `ScrollbackPane.tsx` lines | 4,597 | 5,346 |
  | the single component closure | 3,299 | 3,821 |
  | reactive primitives | 63 | 73 |

- **A good seam landed.** `props.source: ScrollbackSource` (91 lines, 25 uses in the pane) lets the encrypted window reuse the pane.
- **The E2E UI went into the pane anyway, not into the source:**
  - the request banner and card, as a new woven row type `E2eRequestRow`;
  - the "arriving" cloud;
  - the `e2e_undeliverable` renderer;
  - direct imports of `e2eRequests`, `encryptedChats.ownDevice` and `encryptedWindowPeer`.

  `grep -ci 'encrypt\|e2e'` went 4 → 42.
- **Everything the previous review listed is still inside:** the per-kind renderers, the scroll/settle machine and the read-cursor leave-write.

**Impact:** every new row decoration, and every new window flavour, lands in a 3,800-line closure. The seam exists, but it is not the extension point features actually use.
**Direction:**
- Make `ScrollbackSource` carry the decorations its window needs: an `extraRows(): Accessor<WovenRow[]>` and a header slot.
- Move the E2E request rows, the arriving cloud and the undeliverable renderer behind it.
- Then do the prior recommendation: renderers to `ScrollbackLine/*`, and the scroll-settle machine to `lib/scrollSettle.ts` with the cursor write behind one door.

#### COH-A6. `default.css` scatters each surface across distant bands, so the deferred split cannot keep its own byte-identity rule (still open since 2026-09-22 as Extension A4; deferral #2136)
**Severity:** MEDIUM
**Location:** cic `themes/default.css`; the #2136 entry in the 2026-09 DESIGN_NOTES archive.
**What is wrong:**
- **Size.** One 17,452-line (649 KB) sheet: 15,513 at the #2136 deferral, +12.5% since. 64 commits in the window.
- **Locality.** Measured on selectors that start a line with `.<surface>`; a new band starts after a gap of more than 300 lines.

  | Surface | Rules | Bands |
  |---|---:|---:|
  | `.settings*` | 73 | 7 |
  | `.shell*` | 27 | 6 |
  | `.scrollback*` | 66 | 5 |
  | `.rail*` | 77 | 4 |
  | `.e2e*` (new) | 63 | 3 |

- **This collides with the deferral's own plan.** #2136 deferred the split on two conditions:
  - cut along the 519 section comments, by product surface;
  - keep the built bundle byte-identical, because "cascade order IS semantics".

  With one surface spread over 5–7 bands, a per-surface split must either keep the order (and gain no locality) or reorder the rules (and change the bundle, with cascade risk).

**Impact:** sibling rules for one surface drift apart unseen, and the cost of the eventual split grows with each band, not with each line.
**Direction:**
- New rules for an existing surface go in that surface's existing band.
- Add a cheap text-level test in the `themeCss.ts` family that flags a new top-level `.x-*` rule more than N lines from its nearest sibling.
- Then consolidate bands surface by surface, with a byte-identical bundle as the oracle wherever order is provably irrelevant.

### LOW

#### COH-A7. `userTopic.ts` holds a 627-line event narrower that every sibling narrower keeps in `wireNarrow.ts`
**Severity:** LOW
**Location:** cic `lib/userTopic.ts` (`narrowUserEvent`, `narrowWhoisString`, `narrowArray`, `isUploadActiveHost`); `lib/wireNarrow.ts` (`narrowChannelEvent`, `narrowWindowStateEvent`, `narrowIsupportChanged`, `narrowAdminEvent`).
**What is wrong:**
- `userTopic.ts` (1,759 lines) does two jobs over the same closed set:
  - `narrowUserEvent`, 627 lines with 60 case arms;
  - the dispatch switch, 60 arms routing to 55 imported lib modules.
- Every other WS narrower lives in `wireNarrow.ts`, and `userTopic.ts` itself imports two of them.
- The dispatch half is a legitimate router: only 12 branch constructs over ~830 lines.

**Impact:** narrowing policy has two homes, so the #1393 schema-adoption work has to be done twice and argued twice.
**Direction:** move `narrowUserEvent` and its helpers into `wireNarrow.ts`, or into a sibling `wireNarrowUser.ts`.

### Prior findings (responsibility & cohesion) — status

| Prior | Finding | Status | Evidence |
|---|---|---|---|
| 09-22 A1 | DCC lifecycle in `Session.Server` | OPEN | intake-to-report still in `server.ex`; `grep -ci dcc` 97 → 98; the unstored `:dcc_offer_expired` timer unchanged |
| 09-22 A2 | `EventRouter` "pure" but starts an HTTP+DB+disk task | OPEN | moduledoc unchanged; `dispatch_avatar_fetch` still calls `Task.Supervisor.start_child` |
| 09-22 A3 | `shottino.c` monolith | REGRESSED | X5 |
| 09-22 A4 | shottino re-derives server decisions | PARTIAL | `chantypes` now parsed, but used only for order challenges; `is_channel_name` still hardcodes `# & + !`; `message_mentions_me` still a substring match on the nick only |
| 09-22 A5 | Session-spawn assembly scattered | OPEN, +1 | `requesting_subject:` production sites 10 → 11 (`Operator` 3 → 4); `NetworksController` still holds `resolve_plan/3`, `apply_transition/5`, `live_apply_identity/3`, `identity_capacity_input/2` |
| 09-22 A6 | IRC framing hand-spelled outside `IRC.Client` | OPEN | `\r\n"` literals: `server.ex` 7, `ghost_recovery.ex` 3, `recover_identity.ex` 4; `MODE` still framed twice |
| 09-22 A7 | `UserSettings` absorbing domains | OPEN, growth slowed | +7.8% (below `lib`); key consts 14 → 17; `ignores` still inside |
| 09-22 A8 | `SettingsDrawer` 5 of 12 pages inline | OPEN, growth slowed | 3,419 lines; `createSignal` 55 → 58; 33 `await`s |
| 08-15 A7 | `GrappaChannel` verb router + snapshot assembler | OPEN | 2,403 lines; 39 `do_handle_in`; `push_*` 12 → 13 |
| 08-15 A8 | `api.ts` transport + type library + domain helpers | OPEN, grew | 4,065 lines; 246 exports; 120 importers |
| 08-15 A9 | Admin components own fetch/state | OPEN | `AdminNetworksTab` 1,526 lines, 29 `await`s; 25 components both import `api` and `await` |
| 08-15 A10 | `ScrollbackPane` renderer + scroll machine + cursor | OPEN, grew | COH-A5 |
| 08-15 A11 | Read-cursor 4 doors | OPEN | `setReadCursor(` at 3 sites in `scrollback.ts` and 1 in `selection.ts` |
| 08-15 A12 | REST envelopes inline in controllers | OPEN | 34 `json(conn, %{` sites in 21 files |
| 08-15 A13 | `Bootstrap` 3 boot jobs | not re-measured | — |
| #2133 | `Session.Server` size/arms, (a) vs (b) | OPEN, no ruling | X1 |

---

## Concern: duplication

The reviewer filed 17 findings: 0 CRITICAL, 2 HIGH, 10 MEDIUM, 5 LOW (8 new, 9 re-raised as still open since 2026-09-22). After the merge, 15 distinct findings are counted here. DUP-A1, A3, A6, A7, A11 and A12 are the homes of X2, X8, X10, X9, X6 and X11. DUP-A8 went to X3 and DUP-A9 to X4. Method: `grep`/`awk`/`python3 -I`. DESIGN_NOTES was grepped before each defect call, and recorded rulings are said so.

### HIGH

#### DUP-A1. The E2E protocol has four hand-kept implementations, and its interop spec is not in the repository. Merged into X2, counted here.

#### DUP-A2. The channel member list is maintained by two state machines, and the client's MODE walker never followed the server's #216 move
**Severity:** HIGH
**Location:** cic `lib/modeApply.ts` (`applyModeString`), `lib/members.ts` (`applyPresenceEvent`), `lib/isupport.ts`, `modeApply.test.ts`; server `Session.EventRouter` (`apply_mode_string/5`, `walk_modes/5`), `ISupport.user_prefix/2`, `ISupport.takes_param?/3`.
**What is wrong:**
- **Two derivations of one list.** The server owns the member map and pushes it only as a snapshot (`members_seeded`, on 366 and on the after-join cold subscribe). Between snapshots, cic re-derives the list from scrollback rows with its own copy of the IRC semantics: join, part, quit, kick, nick_change and mode.
- **The ruling said both walkers move together.** The 2026-04 ruling: "both server EventRouter and cic `modeApply` hard-code `(ov)@+`. Phase 5+ swaps both at once."
- **Only the server moved.** It swapped on 2026-07-13 (#216): `walk_modes/5` asks `ISupport.user_prefix/2` for user modes, and `takes_param?/3` to pop the argument of a param-taking channel mode. cic did not:
  - It hardcodes `{o:"@", h:"%", v:"+"}`.
  - It consumes no argument for a non-`ohv` letter, with the comment "a mismatched arg consumption doesn't matter for this function's contract".
  - Its header cites `EventRouter.@user_mode_prefixes`, which #216 deleted.
  - The file was touched after #216 (2026-08-29, casemapping) without the PREFIX move.
- **cic already holds the inputs.** `isupport_changed` seeds `prefix`, `prefix_order` and `chanmodes_a..d`.
- **The tests do not cover the gap.** `modeApply.test.ts` has no case mixing a param-taking channel mode with a user mode.

**Evidence (INFERRED from the two code paths, not executed).**
- `MODE #c +bo *!*@h alice`: the server pops the mask for `b` and ops `alice`. cic gives `@` to a member named `*!*@h` (a no-op), and `alice` stays unopped.
- On a `PREFIX=(qaohv)` network, `+q`/`+a` are never applied client-side.
- Either way, the list stays wrong until the next `members_seeded`. It is unchecked whether a later snapshot masks this in practice.

**Impact:** two state machines hold one piece of server-owned state, and the client's copy is wrong exactly where the server learned per-network semantics. That conflicts with CLAUDE.md's "cic NEVER originates state … no parallel client-side state machine".
**Direction:**
- Preferred: delete the client derivation. Have the server push the member delta it already computes, as a `members_changed` event or as a `members_seeded` after each membership-affecting row, and reduce `applyPresenceEvent` to applying it.
- Otherwise:
  1. pass the network's `prefix` + `chanmodes` into `applyModeString`;
  2. port `takes_param?`;
  3. pin the walker with a shared `(isupport, modes, args) → member deltas` vector file that `event_router_test.exs` and `modeApply.test.ts` both iterate.
- Delete the stale header either way.

### MEDIUM

#### DUP-A3. Server logic mirrored in the clients is pinned four different ways. Merged into X8, counted here.

#### DUP-A4. Five client implementations of the identity fold, two of them in modules that each say they are the only one
**Severity:** MEDIUM
**Location:**
- cic: `lib/nickEquals.ts` (`asciiFold` and its call-site registry), `lib/e2e/wire.ts` (`fold`), and in the e2e tree `e2e/fixtures/cicchettoPage.ts` (`canonicalChannelName`) and `e2e/fixtures/ircClient.ts`.
- shottino: `ircd.c` (`fold_char`, `ircd_fold`, `ircd_name_equal`), `e2e.c` (`e2e_fold`, `e2e_nick_eq`).
- Server: `Grappa.IRC.Identifier` (`services_sender?/1`).

**What is wrong:** CLAUDE.md mandates one fold, `canonical_target/1`.
- **Each client claims a single fold.**
  - cic's `nickEquals.ts` calls itself "the SINGLE client-side nick fold", with an explicit registry of the call sites allowed to stay ASCII-only.
  - shottino says "ONE fold in this binary … a second implementation here is what would drift".
- **In both binaries the E2E subsystem shipped its own anyway:**
  - cic's `e2e/wire.ts` `fold()` has 30 call sites in 8 modules. It is not in the registry and is invisible to a `grep asciiFold`.
  - shottino's `e2e_fold`/`e2e_nick_eq` has 30 uses, beside `ircd_fold`.
- **No fork today.** The bodies are byte-equivalent, and the arity-1 choice matches the server's E2E stores (`E2eRequests` and `E2eInbox` use `canonical_target/1`). The defect is the extra copies.
- **The e2e tree.** Four specs and `fixtures/ircClient.ts` fold nicks with Unicode `toLowerCase()`, beside the fixture's correct `canonicalChannelName`.
- **The server.** The SSOT module itself compares `String.downcase(s) in @services`: a Unicode fold on a sender nick, next to `fold_ascii/1`.

**Impact:** the next change to the fold has to find copies that the "single" helper's own registry does not list. The two changes in view are the rfc1459 national tier #1861 added for chat windows, and the channel-axis gap the registry names.
**Direction:**
- Make `e2e/wire.ts` import `asciiFold` (re-exported as `fold` if the name matters), and add the E2E stores to the `nickEquals.ts` registry with the reason: arity-1 on purpose, matching `E2eRequests`/`E2eInbox`.
- Make `e2e_fold`/`e2e_nick_eq` call `ircd_fold`/`ircd_name_equal`.
- Change the services check to `canonical_target(s) in @services`.
- Point the e2e fixture at one exported fold, and replace the spec-local `toLowerCase()` compares with it.

TYP-A3 counts the same `fold` at 38 call sites and takes the type angle.

#### DUP-A5. Generated closed sets: unconsumed consts grew to 25 of 34, every new E2E set among them, with hand spellings beside them (still open since 2026-09-22, REGRESSED)
**Severity:** MEDIUM
**Location:**
- cic: `lib/wireTypes.ts`; `lib/userTopic.ts` (recover arm); `lib/wireNarrow.ts` (casemapping, gender, `narrowSeverity`); `ThemeEditor.tsx` (`FONT_FAMILIES`); `lib/e2e/wire.ts` (`ReceiveVerb`).
- Server: `Session.Wire` (`member`, `e2e_verb`); `IRC.E2e` (`verb`); `Networks.Credential` (`@genders`).

**What is wrong:**
- **Unconsumed consts.** A per-const `grep -lw` outside the generated files and tests finds 25 of 34 `export const X = [` closed sets with no runtime consumer (was 20 of 29). All 5 added since the last review are among them: `SESSION_WIRE_E2E_VERB`, `SESSION_WIRE_E2E_DROP_REASON`, `E2E_PAIRING_WIRE_SIDE`, `E2E_PAIRING_WIRE_CLOSE_REASON` and `E2E_REQUESTS_WIRE_WIRE_STATE`.
- **Hand spellings beside them:**
  - the recover `step` (5 values), `status` (3) and `outcome` (2) in `userTopic.ts`. #1393's reason to keep that arm hand-written concerns `reason` only;
  - casemapping and gender in `wireNarrow.ts`;
  - `FONT_FAMILIES`;
  - `ReceiveVerb`, identical to `SessionWireE2eVerb`.
- **The server double-declares too:**
  - `Session.Wire.member` inlines `:male | :female | :nonbinary` beside `Credential`'s `@genders`;
  - `IRC.E2e.verb` and `Session.Wire.e2e_verb` state the same four verbs separately.

**Evidence (MEASURED).** TYP's baseline table agrees: 34 consts, 9 used by non-test, non-generated code.
**Impact:** a server-side member added to any of these sets compiles green in cic, and the hand check then drops or ignores it at runtime.
**Direction:**
- Replace each hand check with `(CONST as readonly string[]).includes(v)`; `narrowSeverity` is the existing model.
- Iterate the const in `ThemeEditor`, and alias `ReceiveVerb` to the generated type.
- On the server, reference `Credential.gender()` and the `IRC.E2e` type.
- Add the unconsumed-const count to `schema_inventory.md`.

#### DUP-A6. One server type, two client narrowers with opposite tolerance. Merged into X10, counted here.

#### DUP-A7. The user-topic event vocabulary is declared nowhere on the server. Merged into X9, counted here.

#### DUP-A10. Server limits are mirrored as client literals with no publication channel; the e2e tree's unpinned copies grew from 17 to 25
**Severity:** MEDIUM
**Location:**
- cic: `lib/scrollback.ts` (`PAGE_LIMIT`), `lib/uploadHost.ts`, `lib/e2e/wire.ts` (`MAX_FRAGMENTS`); `cicchetto/e2e/tests/*.spec.ts`; `src/__tests__/e2eConstantMirrors.test.ts`.
- shottino: `e2e.h`.
- Server: `MessagesController` (`@max_http_limit`), `ServerSettings` (`@default_upload_*_cap_bytes`), `IRC.E2e` (`@max_fragments`), `ConfigController`.

**What is wrong:**
- **`PAGE_LIMIT` is unpinned.** `PAGE_LIMIT = 200` mirrors `@max_http_limit 200` with no pin. The server rejects anything above it with a 400, so lowering the server constant breaks every cic recovery fetch instead of clamping it (INFERRED from code).
- **Other copies.**
  - `uploadHost.ts` restates the four upload caps.
  - `MAX_FRAGMENTS = 64` exists in three languages (X2).
- **No publication channel.** `GET /api/config` publishes none of these limits.
- **The e2e tree.**
  - #1646 pinned the TS-sourced mirrors, and left "2 Elixir module attributes (17 declarations)" as a product call. Today there are 25 unpinned copies: `REST_PAGE_SIZE = 50` ×19 and `MAX_HTTP_LIMIT = 200` ×6.
  - The pinned `SCROLL_BOTTOM_THRESHOLD_PX` is still re-declared in 20 spec files.
- **The six `SERVER_WINDOW = "Server"` declarations mirror a retired value.** #1646 could not establish them. Production has no `"Server"` window name: the only occurrences are two comments in `BottomBar.tsx` saying that tab "is gone", and the production name is `"$server"`. Whether those specs are vacuous or failing was not run.

**Impact:** a server limit change has no failing test on the client side, and the e2e tree keeps growing copies of the one class nobody pinned.
**Direction:**
- Publish operational limits in `/api/config` (or `GET /boot`) as a `limits` object generated from the server attributes; cic reads it, with today's literals as fallbacks.
- In e2e, hoist each mirrored constant into one `e2e/fixtures/mirrors.ts`, so that a re-declaration in a spec is a lint failure.
- Add `REST_PAGE_SIZE`/`MAX_HTTP_LIMIT` to a server parity test that reads that file.
- Delete or repoint the six `"Server"` declarations.

#### DUP-A11. shottino: measured drifts cured, the structural cause stays. Merged into X6, counted here.

#### DUP-A12. e2e spec helpers: 25 helpers × 105 copies, one still forked three ways. Merged into X11, counted here.

#### DUP-A8. The REST edge hand-types shapes whose server `@type`s are never generated. Merged into X3.

#### DUP-A9. Every protocol bump is written into four constants and three changelogs. Merged into X4.

### LOW

#### DUP-A13. The reserved `"$server"` window name is a bare literal in 6 server modules
**Severity:** LOW
**Location:** `Session.EventRouter` (9 code sites), `Grappa.Scrollback`, `GrappaWeb.Validation`, `Scrollback.Message`, `Session.Server`, `IRC.Identifier`; cic `windowKinds.ts` (`SERVER_WINDOW_NAME`); shottino `SERVER_WINDOW`.
**What is wrong:**
- **The clients name it; the server does not.** Both clients have a named constant. The server spells `"$server"` at about 16 code sites, pattern-match heads included.
- **shottino bypasses its own `#define` once.**
- **Nothing generated carries the value.**

**Direction:**
- Add `Grappa.Scrollback.server_window/0`, or an `@server_window` usable in guards, and route every site through it.
- Expose it as a generated const.
- Use the shottino `#define`.

#### DUP-A14. `Wire.Time.iso8601_or_nil/1` has one consumer and five private re-implementations
**Severity:** LOW
**Location:** `Grappa.Wire.Time`; `E2eRequests.Wire` (new since the last review), `Session.Wire`, `LiveIntrospection.AdminWire`, `GrappaWeb.Admin.UploadsController`, `ChannelDirectory.Wire`; admin/visitor wire typespecs (`E2eKeys.Wire`, `Accounts.AdminWire`, …).
**What is wrong:**
- **The helper names the drift it exists to prevent**, in its moduledoc.
- **It has one consumer.** `grep` finds 6 calls, all in `Networks.Wire`.
- **Five private copies.** The same two-clause shim appears privately at the five sites above, under five names.
- **A third discipline.** 18 admin/visitor wire typespecs pass raw `DateTime.t()` to Jason, which the moduledoc says the wire does not do.

**Direction:**
- Replace the five shims with the helper.
- Decide in DESIGN_NOTES whether `DateTime.t()` in a wire typespec is allowed (the codegen maps it to `string` either way), and correct the moduledoc to match.

#### DUP-A15. Three LIKE searches, two disciplines; the directory search bypasses both the LIKE escape and the fold
**Severity:** LOW
**Location:** `Grappa.ChannelDirectory.maybe_search/2`; `Grappa.Ecto.Like.contains/1`; `Accounts.search_users/2`; `Networks.Credentials.search_visitor_credentials_by_nick/2`.
**What is wrong:**
- **The two siblings are consistent.** They go through `Like.contains/1`, which escapes `%`, `_` and `\`, and their nick leg folds through `canonical_target/1` + `nick_fold/1`.
- **The directory search builds `"%#{String.downcase(q)}%"` by hand:**
  - `_` is not escaped, so `foo_b` matches `fooxb`;
  - a Unicode `String.downcase` runs against SQL's ASCII `lower()`, so a query with non-ASCII capitals never matches.

**Direction:** `Like.contains(Identifier.canonical_target(q))` with `ESCAPE '\\'`, as the other two do.

#### DUP-A16. The `[:connected, :failing]` subset is now restated at 9 sites (prior A10, REGRESSED 6 → 9)
**Severity:** LOW
**Location:** `Grappa.Networks` (5 sites), `Grappa.Operator` (2), `Networks.Credentials` (1, plus a doc mention).
**What is wrong:** three more guards and queries spell #1675's "link expected" subset inline since the last review, still with no named guard.
**Direction:**
- Add `defguard is_link_expected(s) when s in [:connected, :failing]`.
- Add `Credential.link_expected_states/0` for the Ecto query.

#### DUP-A17. Server tests: 33 private polling helpers in 18 files and no shared one; `setup_user_and_network` in 9 files (prior A11, REGRESSED)
**Severity:** LOW
**Location:** `test/**/*.exs`, `test/support/`.
**What is wrong:**
- **Polling loops.** 18 test files define 33 distinct `defp eventually*/await*/wait*/poll*` loops. `eventually_rows` alone appears ×7 with different arities and retry budgets. `test/support/` has no generic `eventually/2`.
- **Setup helpers.** `setup_user_and_network` is re-declared in 9 files (was 6), and `visitor_fixture` is still shadowed ×5.

**Direction:**
- Add `Grappa.TestSupport.Eventually.eventually(fun, opts)` and migrate the copies.
- Hoist `setup_user_and_network`.
- Delete the shadowed `visitor_fixture`s.

### Prior findings (duplication) — status

| Prior | Finding | Status | Evidence |
|---|---|---|---|
| 09-22 A1 (HIGH) | shottino: a third hand copy of the wire contract | PARTIAL | five drifts FIXED; a source-reading pin covers 2 of 7 hand tables; no generated C artefact (X6) |
| 09-22 A2 | `narrowChannelEvent` + 7 user-topic arms hand-narrowed | OPEN | 0 `S_` calls in `narrowChannelEvent`; 7 hand arms, 173 code lines (X10) |
| 09-22 A3 | 54 of 59 hand event arms proven identical to generated ones | OPEN | 42 inline + 11 named arms; `isupport_changed` still declared twice (X9) |
| 09-22 A4 | `GET /networks` hand-typed; two REST disciplines | OPEN, REGRESSED | casts 55 → 63; narrowed reads 43 → 84 (X3) |
| 09-22 A5 | Generated closed-set consts unconsumed | OPEN, REGRESSED | 25 of 34 (was 20 of 29) (DUP-A5) |
| 09-22 A6 | Upload MIME taxonomy, 6 places / 3 languages | PARTIAL | shottino's `md` fixed; `uploadCategory.ts` pinned by comment only; the registry still lives in a controller |
| 09-22 A7 | `CONTENT_KIND_PROJECTION` hand mirror | OPEN | `api.ts` vs `Scrollback.Message`; `subscribe.ts` inline `privmsg \|\| action`; shottino spells the content set inline at 5 sites |
| 09-22 A8 | e2e helpers, one forked signature | OPEN, REGRESSED | 25 helpers × 105 copies (X11) |
| 09-22 A9 | Byte-identical `live_state_to_json/1` ×2 | OPEN | `Networks.Credentials.AdminWire` ≡ `Visitors.AdminWire` |
| 09-22 A10 | `[:connected, :failing]` restated | OPEN, REGRESSED | 9 code sites (DUP-A16) |
| 09-22 A11 | Residual server test-helper copies | OPEN, REGRESSED | `setup_user_and_network` in 9 files (DUP-A17) |
| 08-15 A10 | `MentionsRow` `kind: string` | FIXED | `kind: "channel" \| "query"` |
| 08-15 A11 | mention/notify: two ports, a thin truth table | PARTIAL | shared fixture read by both suites; 49 rows, 2 patterns, 0 non-ASCII bodies; shottino's `message_mentions_me` is a third answer and reads no fixture |
| 08-15 A12 | `monitor_targets/1` re-derives the prefix split | OPEN | `EventRouter` |
| 08-15 A13 | `refresh_plan` scaffold ×2 | OPEN | `Networks.SessionPlan`, `Visitors.SessionPlan` |
| 08-15 A14 | Notify REST envelope ≠ WS envelope | OPEN | `NotifyController` vs `Notify.Wire` |
| 08-15 A15 | `web_session_severed` names two payloads | OPEN | `AdminEvents.Wire` vs `RateLimit.Wire`, disambiguated by hand in `wireTypesAssert.ts` |
| Abstraction A4, duplication half | `Push.Payload` shape declared twice on the server | OPEN | `Push.Payload` ≡ `Push.Sender` |

---

## Concern: dependency architecture

The reviewer filed 13 new findings: 0 CRITICAL, 0 HIGH, 6 MEDIUM, 7 LOW. After the merge, 10 distinct findings are counted here: DEP-A4 went to X7, DEP-A5 to X1 and DEP-A6 to X6.

**Method.**
- **Boundary.** A Python parser read 134 `use Boundary` blocks (124 in `lib`), with 508 declared edges (486 in `lib`). The prior review counted 122 / 472 with a different parser, so the two are not compared. Tarjan SCC and reachability ran over the declared graph, and a second script matched each boundary's calls, struct expansions, `use`/`import`/`require` and `in Mod` query sources against its `deps:`.
- **What counts as an edge.** The reviewer read `deps/boundary` 0.10.4: `check: [aliases: false]` is the default, and `mix.exs` sets only `in`/`out`. So a bare module atom is never an edge, whether it is a child spec, a `belongs_to` target, a typespec or a default argument.
- **Headline graph numbers.** The declared Boundary graph and the used-reference graph are both acyclic. cicchetto has 0 value-edge SCCs, and 4 SCCs once type-only edges are included (prior: 2).

### MEDIUM

#### DEP-A1. The phantom `Admission → Networks` edge still shapes eight files and stretches Admission's transitive reach from 12 to 59 boundaries
**Severity:** MEDIUM. Still open since 2026-09-22 (A3 item 1). It is wider than reported then, but has not grown: the same 8 files existed at `189aaf2c8`, and the prior review listed 4.
**Location:**
- `Grappa.Admission` (its deps).
- The workaround sites:
  - `Grappa.Networks`;
  - `Networks.AdminWire`;
  - `Networks.Credentials.AdminWire` (`spawn_error/0`);
  - `Grappa.Release.LiveNode` (`refusal`);
  - `Grappa.SpawnOrchestrator` (moduledoc);
  - `GrappaWeb.NetworkSpawn`;
  - `GrappaWeb.NetworksController`;
  - `GrappaWeb.Admin.NetworksController`.

**What is wrong:**
- **The edge is unused.** `Admission` declares `Grappa.Networks`, but no Admission file calls into it. It aliases only the promoted leaves `Networks.{Credential, Network}`, which are declared separately.
- **The edge still dictates the design:**
  - Spawn orchestration lives in the web layer. `GrappaWeb.NetworkSpawn` exists "because Networks must NOT depend on `Grappa.SpawnOrchestrator` — that closes the `Networks → Admission → Networks` Boundary cycle".
  - Composition moved into two controllers.
  - `SpawnOrchestrator`'s moduledoc still justifies itself with reads that have gone through leaves since #1398.
- **Two hand-spelled types are unnecessary.** Two copies of `Admission.capacity_error/0` are spelled out by hand: `Credentials.AdminWire.spawn_error/0` and `Release.LiveNode.refusal`. Per CLAUDE.md, a typespec reference carries no edge, so these copies would be unnecessary even if the cycle were real.

**Evidence (MEASURED over the declared graph).** With the edge, Admission reaches 59 of 124 lib boundaries, `Session` included. Without it, Admission reaches 12, and `Networks` then does not reach Admission.
**Impact:**
- Domain composition sits in `GrappaWeb`, against the web → contexts → schemas direction.
- Two type copies are documented as drift hazards.
- Any reasoning about "what can Admission touch" is wrong by 47 boundaries.

**Direction:** one mechanical commit, verified with `mix compile --force --warnings-as-errors` under `dev` and `test`:
1. Delete the dep.
2. Replace both hand unions with `Grappa.Admission.capacity_error()`.
3. Move `NetworkSpawn` and the two controller compositions into `SpawnOrchestrator` or `Networks`.
4. Rewrite the four stale cycle paragraphs.

#### DEP-A2. The "metadata atoms carry no edge" rule is applied to `Accounts.User` but not to `Visitors.Visitor` or `Subject`; phantom deps number at least 23
**Severity:** MEDIUM. Still open since 2026-09-22 (A3 items 2–5). It was under-counted there, and it now contradicts itself inside single blocks.
**Location:**
- Contexts declaring `Visitors.Visitor`: `Scrollback`, `ReadCursor`, `QueryWindows`, `Notify`, `ChannelDirectory`, `UserSettings`, `Push`, `Networks`, `Accounts`.
- Contexts with the same shape that declare nothing: `Dcc`, `E2eKeys`, `E2eRequests`, `E2eInbox`, `Uploads`.
- Typespec-only `Subject` deps: `E2ePairing`, `PresenceFilter.Resolver`, `Push.BadgeCount`, `WindowCounts`, `WindowCounts.Pusher`, `Dcc.Policy`.
- Other phantoms: `Themes → Net.Ssrf`, `Accounts → EncryptedBinary`, `Accounts → Visitors.Visitor`, `Vhosts → Net.HostAddresses`, `GrappaWeb → OutboundV6Pool`, `Networks → {Vault, EncryptedBinary}`, `Visitors → IRC`.
- Stale justifications in `WindowCounts.PushSource`, `WindowCounts.Pusher` and `Session` (`services_flavor`).
- `Mentions → Scrollback`, `Push → Scrollback`.

**What is wrong:**
- **Two patterns for one fact.** The `Scrollback` and `Push` dep comments say "No `Grappa.Accounts` dep: `User` is reached only by `Message`'s `belongs_to` and its typespec — metadata atoms". The same two `deps:` lists then declare `Visitors.Visitor` for exactly that kind of use.
  - MEASURED: in all 9 declaring contexts, `Visitor` appears only in `belongs_to :visitor, Visitor` and `visitor: Visitor.t()`. There is no `%Visitor{}`, `Visitor.f()` or `in Visitor`.
  - The five contexts added or grown since carry the identical `belongs_to` and declare nothing. That is correct per CLAUDE.md, and it proves the older nine are phantoms.
  - These edges already existed at `189aaf2c8`; the prior review did not list them.
- **Further phantoms, hand-confirmed:**
  - 6 `Subject` deps used only as `Subject.t()` in specs.
  - `Themes → Net.Ssrf`: 0 references.
  - `Accounts → EncryptedBinary`: used only by the `Accounts.User` leaf, which itself declares `[]`.
  - `Accounts → Visitors.Visitor`: the atom is passed to a dynamic `from(row in schema)`, which is not an edge.
  - Still open from the prior review: `Networks → {Vault, EncryptedBinary}`, `Visitors → IRC`, `Vhosts → Net.HostAddresses`, `GrappaWeb → OutboundV6Pool`.
- **Stale cycle justifications:**
  - `PushSource` and `Pusher` still cite `Session → ReadCursor → Networks → Session`. The real reason is `Pusher → PresenceFilter.Resolver → Session`.
  - `Session` still types `services_flavor` as bare `atom()` "to avoid a Session → Networks Boundary cycle". `Networks.Network` is a leaf, and a typespec makes no edge anyway.
- **Full-context-for-one-struct, still open.** `Mentions → Scrollback` and `Push → Scrollback` reference only `Scrollback.Message`.
- **Nothing catches this.** Boundary 0.10.4 does not report unused deps.

**Impact:**
- CLAUDE.md's "Total consistency or nothing" applies here: the next schema author has a 9-vs-5 split to copy from.
- Each phantom constrains the graph for no code. Together they inflate reach (DEP-A1 is the extreme case) and make the next genuine inversion look ordinary.

**Direction:**
1. Delete every edge whose only users are `belongs_to`, `field`, `Mod.t()` or a runtime-dispatched atom. Keep the runtime-dispatch atoms only if a DESIGN_NOTES line says that deps document runtime dispatch.
2. Fix the two typespecs and the two seam justifications.
3. Promote `Scrollback.Message` to a leaf.
4. Add a ~60-line `mix` check: every declared dep must be referenced by a call, a struct, or a `use`/`import`/`require`. The reviewer's scripts are the prototype.

**Caveat (DEP).** "Phantom" means no reference in the reviewer's scan, confirmed by a hand grep; macro-generated calls are possible. `EncryptedBinary → Vault` was excluded for exactly that reason. Runtime-dispatch atoms were left out of the hard count.

#### DEP-A3. `SourceAliasManager` sits after `Endpoint` and after `SessionSupervisor`, so both its start order and its stop order are wrong for what depends on it
**Severity:** MEDIUM. New; the ordering predates the prior review.
**Location:**
- `Grappa.Application`: the identd block and the `SourceAliasManager` slot.
- `Grappa.Net.SourceAliasManager`: `armed?/0`, `init/1`, `handle_continue`, `publish_arm/1`.
- `Networks.SessionPlan`.
- `Grappa.Vhosts` (`{:hold, :mode2_disarmed}`).
- `Session.Server`: `credential_failer`, and the swallow in `release/1`.
- The CLAUDE.md tree line.

**What is wrong:** one file reasons about the same hazard in two opposite ways.
- **The identd block goes BEFORE `Endpoint`.** The reason given: Endpoint "is the earliest of the two doors that can spawn a session". Identd registration is only an optional cast.
- **`SourceAliasManager` (SAM) goes AFTER `Endpoint`**, "so the reconcile follows the public surface", and is justified only against Bootstrap. Yet its dependency is stronger than identd's:
  - Its arm gate is a `:persistent_term` that defaults to `{false, :not_armed}` until `init/1` publishes it.
  - `SessionPlan` reads `armed?/0` when it builds a plan.
  - A disarmed mode 2 yields `{:hold, :mode2_disarmed}`.
  - A held session runs its `credential_failer`, which marks the credential `:failed`.
- **At stop time.** Children stop in reverse order, so SAM stops before `SessionSupervisor`. Every session's `release/1` then exits `:noproc`, which is swallowed: "the OS alias, if leaked, is reclaimed by the next boot reconcile".
- **The stated reason does not hold.** The reconcile already runs in `handle_continue`, and it needs only the Repo, `ServerSettings` and `Grappa.SourceAliasHolders`. All three start long before `SessionSupervisor`.

**Evidence:**
- Start time, INFERRED: on a mode-2 deployment, a REST connect between `Endpoint` start and SAM's `init/1` produces a terminally failed credential. The window is SAM's `init` (a DB read plus the platform `arm_check`) and was not measured. It matters only on mode 2, and DEP does not know whether prod runs mode 2.
- Stop time, read from the code: every clean shutdown leaks every derived alias until the next boot.

**Impact:**
- A load-bearing ordering is reasoned two incompatible ways in one file, and CLAUDE.md enshrines the weaker one.
- The start window can turn a user's connect into a terminal `:failed` credential.
- The stop order leaks OS state by design.

**Direction:**
1. Move SAM next to the identd children: after `Grappa.SourceAliasHolders`, before `SessionSupervisor`.
2. Drop the `:noproc` swallow, or narrow it to `:timeout`.
3. Update the CLAUDE.md tree line and add a DESIGN_NOTES entry.

#### DEP-A4. `SessionRegistry`'s key and value shape is a cross-boundary contract read by name. Merged into X7.

#### DEP-A5. `Session` is the graph's hub and keeps growing. Merged into X1.

#### DEP-A6. shottino still hand-mirrors closed sets, and `--ircd` still advertises `CASEMAPPING=rfc1459`. Merged into X6.

### LOW

#### DEP-A7. `Grappa.Application`'s Boundary deps are an unchecked list built on a false premise: that supervising a child creates an edge
**Severity:** LOW. New.
**Location:** `Grappa.Application` (its `use Boundary` deps and the #1768 comment); `GrappaWeb` (export of `SessionRevocationListener`).
**What is wrong:**
- **16 of the 34 declared deps are referenced only by a child-spec atom**, which `aliases: false` makes invisible:
  - `Repo`, `Vault`, `PubSub`, `Bootstrap`;
  - `AdminEvents`, `ShareTokens`, `WSPresence`, `E2ePairing`;
  - `Net.PtrCache`, `Net.SourceAliasManager`, `WindowCounts.Pusher`;
  - five `*.Reaper`s.
- **Five supervised boundaries are not declared at all:** `Session.Backoff`, `SessionLog`, `DbLatency`, `Accounts` (for `WebAuthnChallengeStore`) and `Identd`.
- **The comments assert the opposite:** "This edge is on the SUPERVISOR". `GrappaWeb` exports `SessionRevocationListener` "for the same and only that reason".

**Impact:** the list reads like a dependency inventory, nothing checks it, and the rule it implies is false. The next child will be declared or not depending on which comment its author copies.
**Direction:**
- Pick one: keep only the edges the module really calls (18), with one comment saying that children need no dep; or declare every supervised boundary under a documentation heading.
- Drop the `GrappaWeb` export either way.

#### DEP-A8. Ordering and boot-phase documentation has drifted from the code it describes
**Severity:** LOW. Partly still open since 2026-09-22 (A5) and from the 2026-08-15 tree/DI item.
**Location:** `Grappa.Application` comments (NetworkCircuit, the sweeper cadence, `@spec bootstrap_child()`, the `Uploads.base_url` seed); `Grappa.Dcc.public_url/2`; `Session.Server`; CLAUDE.md Architecture section.
**What is wrong:** the CLAUDE.md tree matches `application.ex` child for child. What drifted is the prose around it.
- **In `application.ex`:**
  - "`Grappa.Admission.NetworkCircuit (T31)`: **both** ETS-backed singletons" describes a single child (wording dating from 2026-05-03);
  - "the **three** ambient sweepers" share a cadence that five Reapers use;
  - `@spec bootstrap_child()` is separated from its function by the whole identd block.
- **Still open from the prior review.** `Uploads.base_url` is seeded after the tree, justified because it is "reached only from the CTCP AVATAR reply". `Dcc.public_url/2`, called from `Session.Server`, is a second reader.
- **In CLAUDE.md:**
  - "Backoff/WSPresence/NetworkCircuit before SessionSupervisor (ETS tables read directly…)": `WSPresence` owns no ETS table; it is a `GenServer.call` target.
  - The boot phase (18 pre-tree `boot` seams and 2 post-tree writes) is absent.
  - `held_source_fn` has 0 mentions.

**Impact:** the comments are the only record of why each slot is where it is, and three of them now give wrong counts or wrong readers. A reorder argued from them starts from false premises.
**Direction:**
- Fix the four comments.
- Add a boot-phase block to the CLAUDE.md tree: the 18 seams, `Health.mark_ready` and `Uploads.boot_base_url`.
- Correct the `WSPresence` parenthetical.
- Derive `base_url` before the tree from the Endpoint's `url:`, or seed it from a child placed between `Endpoint` and `Bootstrap`.

#### DEP-A9. `:persistent_term` is still written on request paths, and the Endpoint has two such sites, not one
**Severity:** LOW. Still open since 2026-09-22 (A4); under-counted there.
**Location:** `GrappaWeb.Endpoint` (`cached_cic_static_opts/0`, `cached_session_opts/0`); `Grappa.OutboundV6Pool.apply_pool/1`; `Net.SourceAliasManager.publish_arm/1`; `GrappaWeb.PasskeyOrigin.boot/0`.
**What is wrong:**
- **Census.** `lib` has 43 `:persistent_term.put`/`erase` sites: 18 in `boot`, and the rest test helpers plus 10 runtime sites.
- **The Endpoint lazily writes two terms on the first request:**
  - `cached_cic_static_opts/0` puts a whole `Plug.Static.init/1` result. The prior review missed this site.
  - `cached_session_opts/0` does a runtime `Application.fetch_env!/2`, which CLAUDE.md bans in a plug body, plus a put.
- **Unchanged.** `apply_pool/1` (admin-triggered) and `publish_arm/1`.
- **The prescribed shape already exists next door:** `PasskeyOrigin.boot/0`.

**Impact:** under the #1715 rule, each request-path put serialises behind any dirty NIF parked on a write-lock wait. The first-request puts land right after a restart, when the DB is busiest.
**Direction:**
- Add a `GrappaWeb.Endpoint.boot/0`, called from `start/2`, that builds both opts once.
- Hold the v6 pool and the arm flag in ETS owned by their GenServers, as `Session.Backoff` does.

#### DEP-A10. The IRC boundary, the "one parser" slated for Phase-6 reuse, depends on two application singletons
**Severity:** LOW. New to the review; both edges predate 2026-09-22.
**Location:** `Grappa.IRC` (deps `OutboundV6Pool`, `Net.IpLiteral`, `Identd`); `IRC.Client` (the `do_connect/5` deps map, `OutboundV6Pool.pick()`, the identd cast); the `Grappa.Networks` deps comment (#543 INC-5); `Vhosts.effective_source/3`.
**What is wrong:**
- **The most-depended-on domain boundary has two singleton deps.** `Grappa.IRC` has a fan-in of 26 and depends on `OutboundV6Pool` and `Identd`.
- **Identd.** The client casts to the named identd table. DESIGN_NOTES (issue 227) rules the edge direction; the coupling itself is not ruled.
- **OutboundV6Pool.** The client calls `OutboundV6Pool.pick()` whenever the plan's `source_address` is nil. So a source-address decision is made inside the IRC library, beside `Vhosts.effective_source/3`, which `Networks`' deps comment calls the "single decision point".
- **The right seam already exists.** `do_connect/5` takes a `deps` map carrying `resolver` and `connect_fun`.

**Impact:** the parser and client cannot be lifted out, for the Phase-6 facade or as the hex libs the project has discussed, without pulling two singletons along. Source selection has two owners.
**Direction:**
- Inject `pick_source` and `on_bound` through the existing `deps` map; `Session.Server` supplies `&OutboundV6Pool.pick/0` and `&Identd.register/2`.
- Delete the two edges.

#### DEP-A11. Client layering: `lib → component` inversions regressed again (4 → 6), and components keep growing direct `api.ts`/`socket.ts` use
**Severity:** LOW. Still open since 2026-08-15 (A4, A5), and REGRESSED.
**Location:**
- cic lib modules importing from components:
  - `lib/{swipeRecall,keepKeyboard,messageGestures}.ts` → `DiagFloat.tsx`;
  - `lib/opsMenu.ts` → `ContextMenu.tsx`;
  - `lib/mentionsWindow.ts` → `MentionsWindow.tsx`;
  - `lib/creditsRain.ts` → `MatrixRain.tsx`.
- `lib/api.ts`, `lib/socket.ts`.

**What is wrong:**
- **Inversions.** Six lib modules import from components. The two new ones since `189aaf2c8` are `swipeRecall.ts` (the *value* `isDiagEnabled`) and `opsMenu.ts` (`type ContextMenuAction`). `DiagFloat.tsx` is now a runtime dependency of three lib modules.
- **Direct transport use.**
  - 42 of 114 components import `api.ts`, 32 of them for values (prior: 35 of 96).
  - `api.ts` grew from 3,604 to 4,065 lines.
  - Six components besides `main.tsx` import `socket.ts` push verbs: BanlistModal, HomePane, ModeModal, TopicBar, UmodeModal, UserContextMenu.

**Impact:** the store layer is optional in practice, so REST/WS coordination keeps landing in components, and the diagnostics toggle cannot move without touching gesture code.
**Direction:**
- Move `isDiagEnabled` into `lib/diag.ts`, and the component-owned types into lib type modules or `wireTypes.ts`.
- Add a Biome `noRestrictedImports` rule forbidding `lib/**` from importing `*.tsx`.
- Ratchet the component → `api.ts` count.

#### DEP-A12. Client type-only cycles: the 2026-09-22 cycle is unchanged, and the new E2E subsystem reproduces the same layering inversion twice
**Severity:** LOW. A6 is still open since 2026-09-22; the E2E part is new.
**Location:** cic `lib/api.ts` (type imports from `channelTopic` and from `e2e/wire`); `lib/e2e/{engine,accountStore,sas,chatStore,wire,fileInner,pairingOffer}.ts`; `lib/encryptedChats.ts`; `EncryptedRail.tsx`; `lib/{selection,windowState}.ts`.
**What is wrong:**
- **Four type-including SCCs** (prior: two):
  1. {`api`, `wireNarrow`, `channelTopic`, `identityScopedStore`, `auth`, `passkeys`}: unchanged, still rooted at `api.ts` importing `ModesEntry`/`TopicEntry` from `channelTopic`.
  2. {`selection`, `windowState`}.
  3. {`e2e/engine`, `accountStore`, `sas`, `chatStore`}: `engine.ts` (2,870 lines, the crypto core) takes `OwnIdentity` from `accountStore` and `SasRecord` from `sas`, while both import `engine` at runtime.
  4. {`e2e/wire`, `e2e/fileInner`}.
- **Transport imports from a feature.** `api.ts` imports `type SendVerb` from `e2e/wire.ts`.
- **`lib/e2e/` is not a layer.**
  - `e2e/pairingOffer.ts` imports the stores `../encryptedChats` and `../networks`.
  - `encryptedChats.ts` imports eight `e2e/*` modules.
  - `EncryptedRail.tsx` imports seven, `engine` among them.
- **Lint is green.** There are zero value-edge SCCs, so Biome's `noImportCycles` passes. That it ignores type-only edges is INFERRED from CI being green.

**Impact:** the pattern the prior A6 warned about has been copied into the newest and most security-sensitive client subsystem. Converting any one of these `import type` lines to a value import creates a real cycle.
**Direction:**
- Move `ModesEntry`/`TopicEntry` into `wireNarrow.ts`.
- Move `OwnIdentity`, `SasRecord`, `SendFailure` and `FileInner` into an `e2e/types.ts` that imports nothing from `e2e/*`.
- Give `lib/e2e` one facade (`e2e/index.ts`), and forbid `e2e/**` from importing lib stores via `noRestrictedImports`.

#### DEP-A13. Test-only verbs are compiled into production contexts, and the class has five members, not one
**Severity:** LOW. Still open since 2026-09-22 (A10); the class is wider than reported.
**Location:** `ReadCursor.force_set/4`, `ReadCursor.clear_all_for_user/1`, `Notify.clear_all_for_user/1`, `Push.subscription_clear_all_for_user/1`, `QueryWindows.close_all_for_user/1`; `Grappa.TestSupport.SubjectReset`; `GrappaWeb` deps.
**What is wrong:**
- **Test-only verbs on prod APIs.** Five public context verbs are documented "Intended for `Grappa.TestSupport.SubjectReset` only".
- **Only the callers are gated.** The callers are compile-gated to `:dev`/`:test`, but the verbs themselves ship in the release. All five are unchanged since `189aaf2c8`.

**Impact:** five unscoped "delete everything for this user" and "force cursor" doors sit on production context APIs with no production caller. The dependency arrow points from prod to a test need.
**Direction:** wrap the five in `if Mix.env() in [:dev, :test]`, as `WSPresence.reset_for_test/0` and the `BusyRetry` fault hooks already are. Or move the deletes into `SubjectReset` as Ecto queries over the schema leaves.

### Prior findings (dependency architecture) — status

| Prior | Status | Evidence |
|---|---|---|
| 09-22 A1 shottino closed sets (HIGH) | PARTIAL, now X6 | `failing` added; E2E sets pinned; 29 of 34 still hand-copied; §2 silent |
| 09-22 A2 shottino `--ircd` 005 | OPEN, in X6 | still `CASEMAPPING=rfc1459`; `PREFIX` now relayed |
| 09-22 A3 phantom edges / stale cycle reasons | OPEN, under-counted; now DEP-A1 + DEP-A2 | 8 files around `Admission → Networks`; ≥23 phantoms |
| 09-22 A4 `:persistent_term` on request paths | OPEN, under-counted; now DEP-A9 | a second Endpoint site |
| 09-22 A5 `Uploads.base_url` post-tree seed | OPEN, in DEP-A8 | the comment still names one reader; `Dcc.public_url/2` is a second |
| 09-22 A6 `api.ts` ↔ store type cycle | OPEN, now DEP-A12 | unchanged; two new E2E type cycles |
| 08-15 A1 `Networks → Session` inversion | PARTIAL, hardened | still 11 closures; now total by a compile-time assertion (issue 2137); not re-raised |
| 08-15 A4 `lib → component` | REGRESSED 4 → 6; now DEP-A11 | `swipeRecall.ts`, `opsMenu.ts` new |
| 08-15 A5 components into `api.ts` | OPEN; now DEP-A11 | 42 of 114 (32 value) |
| 08-15 A6 two bearer-death mechanisms | OPEN | `Revocations.announce` in contexts, plus 6 controller `disconnect_subject` calls |
| 08-15 A8 tree doc / DI | PARTIAL, in DEP-A8 | tree matches; boot phase and `held_source_fn` undocumented |
| 08-15 A9 module-global DI / bearer-key copy | OPEN | 39 module-level `let`s in 27 files (was 34/23); `"grappa-token"` still read raw in `uploadHost.ts` |
| 08-15 A10 `ReadCursor.force_set/4` | OPEN, widened; now DEP-A13 | plus 4 sibling test-only verbs |

---

## Concern: type system leverage

The reviewer filed 9 new findings: 0 CRITICAL, 1 HIGH, 5 MEDIUM, 3 LOW. After the merge, 6 distinct findings are counted here: TYP-A1 is the home of X3, TYP-A5 went to X10, TYP-A6 to X6 and TYP-A9 to X2.

**Method.** "Non-test cic" means 438 `.ts`/`.tsx` files (112,151 lines). It excludes tests, the generated `wireTypes.ts`/`wireSchema.ts` and the wasm-bindgen `lib/e2e/vodozemac/`. Every "was → is" delta was re-measured with the same `git grep` at both revisions.

**Baseline re-measured, no finding:**
- **Specs and Dialyzer.** 1,963 public `def` names in `lib`; 0 lack an `@spec`, once `@impl` callbacks are excluded. The pass was first checked on a synthetic fixture. All 11 `defdelegate`s are specced. The Dialyzer flags include `:underspecs`, `:extra_return`, `:missing_return` and `:unmatched_returns`.
- **Client escape hatches.**
  - Explicit `any`: 0.
  - `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`: 0.
  - Non-null `!`: 2, both in `lib/windowKinds.ts`. The prior count was 0, so this is a minor regression.
- **Client strictness.** `strict` and `noUncheckedIndexedAccess` are on. The e2e tsconfig leaves the latter off by a measured, in-file decision (issue 2139).
- **Closed-set columns and renders.** The only closed-set `:string` column left is `admin_events.kind`. Every closed set in the new E2E schemas is an `Ecto.Enum`. All 17 `json(...)` renders in the two E2E controllers go through a `*.Wire` function.
- **Client casts.** 377 non-`const` `as` casts:

  | Kind | Count |
  |---|---:|
  | DOM / platform | 92 |
  | REST `.json()) as` | 63 |
  | `as Record<…>` (mostly a narrowing idiom) | 46 |
  | `as string` / `as number` after a `typeof` check | 50 |
  | `as ChannelKey` | 18 |
  | `as unknown as` | 7 |

- **Generated artefacts.**

  | Artefact | Total | Used directly by non-test, non-generated code | 2026-09-22 |
  |---|---:|---|---|
  | `wireTypes.ts` types | 239 | 116 (22 more only in `wireTypesAssert.ts`; 16 referenced nowhere) | 107 of 201 (13 nowhere) |
  | `wireTypes.ts` consts | 34 | 9 | 9 of 29 |
  | `wireSchema.ts` schemas | 232 | 93 | 69 of 196 |

### HIGH

#### TYP-A1. Codegen reads 4 hand-listed web views while the pin reads all 13; REST casts grew 55 → 63. Merged into X3, counted here.

### MEDIUM

#### TYP-A2. `Session.Server.t()` declares every key required, while 172 reads treat 51 of them as optional; the reads are shaped to evade Dialyzer, the justifying comment misstates Preflight, and none is ever retired
**Severity:** MEDIUM
**Location:** `Session.Server` (`@type t`, the shim comment); `Session.EventRouter` (97 reads); `Session.PartCleanup` (6); `Session.ISupport`; `Session.DirectoryIngest`; `Grappa.Deploy.Preflight` (`collect_state_blocks/1`); `Grappa.HotReload.LongLivedModules`; `test/grappa/session/state_contract_drift_test.exs`.
**What is wrong:**
- **What the type says.** `Server.t()` is a plain-map type of 96 keys, every one of them required. `StateContractDriftTest` pins that `init` builds every declared key.
- **What the code does.**
  - Across `lib/grappa/session`, `Map.get(state, :k …)` appears 172 times in code, over 51 distinct keys, all declared required. 136 of those reads carry an explicit default.
  - At `c678ea5a` the same grep gave 162 reads over 47 keys.
  - `:isupport` alone has 27 tolerant reads, four months after the field landed (#216).
- **The form is chosen to get around Dialyzer.** `server.ex` says so: Dialyzer proves a second clause unreachable "FROM THE TYPE" and reports `pattern_match_cov`, "so the shim has to be a lookup rather than a pattern". CLAUDE.md says the opposite: "Dialyzer warnings are design signals."
- **The stated reason is wrong.**
  - The same comment says `Deploy.Preflight` "has nothing to read and would let one through".
  - In fact `collect_state_blocks/1` matches `@type t :: …` as well as `defstruct`, and `Session.Server` is in `LongLivedModules`.
  - DESIGN_NOTES (#1390) says Preflight "sees the typedef".
  - The operator's memory note on 1.5.14 records a field-add going COLD despite its shim.
  - So each default is reachable only on a `--force-hot` deploy that bypasses the preflight. After the next cold restart, it is dead code.
- **No retirement rule exists.** DESIGN_NOTES records the shim as the per-field pattern (#216). It also lists "29 tolerant `Map.get(state, :k, default)` reads whose defaults are a third place the contract is written" as uncovered (2026-08). Nothing removes them.
- **The drift test covers only part of it.** It pins EventRouter's key *names* only; `server.ex`'s 61 reads and `part_cleanup.ex`'s 6 are not checked even by name.

**Impact:**
- Every default is a third declaration of the field, beside the `@type` and the `init` map, and nothing compares the three.
- A misspelled key reads its default forever.
- The comment instructs every future field to add more shims, in one of the repo's top hotspots.

**Direction:**
- Make the type tell the truth about the hot-reload window. A key added by a hot deploy enters `Server.t()` as `optional(:k)`, which lets Dialyzer accept either a clause or a lookup.
- The first COLD deploy afterwards promotes the key to required, and every `Map.get(state, :k, _)` becomes `state.k`.
- Pin "no `optional(` entry" in `StateContractDriftTest`, so the promotion cannot be skipped.
- Alternatively, migrate live state in one place: `HotReload` calls `:sys.replace_state(pid, &Server.upgrade_state/1)`, filling the missing keys from the `init` defaults. That deletes the 172 scattered defaults.
- Correct the comment either way.

TYP does not call the shims a correctness bug (see the refusals).

#### TYP-A3. Identifier keys have no type on either side: the fold is `term() -> term()` on the server, five fold producers return bare `string` on the client, and network identity has three wire names (still open since 2026-09-22; the counts grew)
**Severity:** MEDIUM
**Location:** server `Grappa.IRC.Identifier.canonical_target/1,/2`; cic `lib/{channelKey,nickEquals,queryWindows,selection,byKey}.ts`, `lib/e2e/{wire,byNick}.ts`.
**What is wrong:** CLAUDE.md's largest invariant, "only KEYs fold; wire + display stay RAW", cannot be expressed in either type system.
- **Server.** `canonical_target/1` and `/2` are specced `term() :: term()`, and a catch-all clause passes `nil` through for the changeset boundary. So all 109 call sites, in 37 files, get `term()` back.
- **Client fold producers.** Five, all returning bare `string`:

  | Producer | Call sites |
  |---|---:|
  | `asciiFold` | 14 |
  | `normalizeNick` | 19 |
  | `canonicalChannel` | 19 |
  | `canonicalQueryNick` | 14 |
  | E2E `fold` | 38 |

  The E2E `fold` and `asciiFold` implement the same A–Z-only rule separately.
- **Brands.** Brands now exist (`ChannelKey`, `SubscriptionId`, and the new `ByKey<T>`/`ByNick<T>` from issue 2453), but `ByNick` enforces folding only inside the E2E records.
- **Network identity.**
  - The generated wire names a network three ways: `network: string` (42 fields), `network_id: number` (35) and `network_slug: string` (24), plus `slug` (6).
  - Client code carries `networkSlug: string` 208 times and `networkId: number` 96 times, with no type separating them.
- **Raw-string keying grew** (the same grep at both revisions):

  | Pattern | 2026-09-22 | Now |
  |---|---:|---:|
  | `Record<string,` | 168 | 236 |
  | `networkSlug: string` | 156 | 208 |
  | `nick: string` | 72 | 250 (125 of the increase in `lib/e2e/*` and `encryptedChats.ts`) |
  | `as ChannelKey` | 17 | 18 (6 in `Object.keys` loops in `selection.ts`) |

**Impact:** passing a raw nick where a folded key is expected, or a slug where an id is expected, compiles on both sides. The #372/#537-class identity forks are caught only by review and tests.
**Direction:**
- **Server:** clause specs, `(String.t()) :: String.t()` and `(nil) :: nil`.
- **Client:**
  - add a `FoldedTarget` brand, returned by `asciiFold`, `normalizeNick` and `canonicalChannel`, and accepted by `channelKey` and the store `Map`s;
  - delete E2E `fold` in favour of `asciiFold`, and make `ByNick` take a `FoldedTarget`;
  - add `NetworkSlug`/`NetworkId` brands at the narrowers;
  - replace the `Object.keys(...) as ChannelKey` loops with a typed `keysOf`, as `byKey.ts` already does.

DUP-A4 counts the E2E `fold` at 30 call sites.

#### TYP-A4. `:map` columns: the server knows the theme payload's shape and still types it `%{String.t() => term()}`; the `user_settings` registry lists 8 of 18 keys (still open since 2026-09-22; the drift grew)
**Severity:** MEDIUM
**Location:** `Grappa.Themes.{Theme,TokenModel,Wire}` (`TokenModel.sanitize/1`); cic `lib/themesApi.ts` (`TokenPayload`, `ThemeColorKey`), `ThemeGallery.tsx`, `ThemeEditor.tsx`, `lib/themeEditor.ts`, `lib/customTheme.ts`; `Grappa.UserSettings` (the moduledoc table); `UserSettings.Settings` (the "Known key registry").
**What is wrong:** there are still 4 `:map` columns (`user_settings.data`, `themes.payload`, `admin_events.payload`, `passkey.transports`), and none uses the `Scrollback.Meta` custom-type pattern.
- **`themes.payload`: the server knows the shape and throws the type away.**
  - `TokenModel.sanitize/1` validates every key: the colours, `font_family`, and `background.{image_id,builtin,size,opacity}`. Yet it returns `token_map :: %{String.t() => term()}`.
  - So the codegen can only emit `ThemesWireT.payload: Record<string, unknown>`.
  - cic re-declares the structure as `TokenPayload` and restores it with 5 `as TokenPayload` casts.
  - `FONT_FAMILIES` sits beside the unconsumed `THEMES_TOKEN_MODEL_FONT_FAMILY`, and `ThemeColorKey` hand-spells `nick_${number}`. Both are still open since 2026-08-15.
- **`user_settings.data`: three key registries disagree.**
  - `user_settings.ex` (3,169 lines) holds 18 string keys: 17 `@*_key` constants plus a bare `"highlight_patterns"`.
  - The context moduledoc table lists 16; it is missing `show_peer_profiles` and `dcc_auto_accept`.
  - The schema's "Known key registry", which says "Future additions MUST be documented here", lists 8.
  - The prior counts were 16 / 14 / 6.

**Impact:**
- A theme-payload change is invisible to cic's type checker: the sanitizer is the real schema, and nothing else can read it.
- Nothing reconciles the three settings registries.

**Direction:**
- Give `themes.payload` a custom Ecto type in the `Scrollback.Meta` style: atomize the known keys on load and declare a struct-shaped `@type`. The codegen then emits the shape, and the five casts become generated-type reads.
- For `user_settings.data`, derive one `@known_keys` list from the `@*_key` constants. Generate the moduledoc table from it, or assert equality in a test, and delete the schema-side table.

BND counts 19 keys in use.

#### TYP-A5. The WS user topic is schema-validated and the per-channel topic is not. Merged into X10.

#### TYP-A6. shottino: 7 of its 10 wire enums are gated by scraping; message kind, presence and severity are not. Merged into X6.

### LOW

#### TYP-A7. `exactOptionalPropertyTypes` has never been measured, though the wire contract relies on "absent ≠ null"
**Severity:** LOW
**Location:** `cicchetto/tsconfig.json`; generated `wireTypes.ts` (11 `?:` fields, e.g. `ScrollbackWireT.dm_with?: string | null`); 314 optional properties in non-test cic.
**What is wrong:**
- **The wire distinguishes absent from `null`**, both in its schemas (`S_ScrollbackWireT` lists `q: ["dm_with"]`) and in code comments ("absent and `null` are different statements").
- **TS does not, without the flag.** It treats `dm_with?: string | null` as also accepting an explicit `undefined`, so client-built rows (optimistic echoes, fixtures) can blur a distinction the narrowers preserve.
- **No record it was ever tried.** A grep of DESIGN_NOTES, its archives and the reviews finds none. Issue 2139 measured the e2e flags, not this one.

**Impact:** a semantic the protocol depends on is enforced at runtime only.
**Direction:** measure the flag as issue 2139 did (error count and error shapes), then adopt it or record the decision in `tsconfig.json`.

#### TYP-A8. Closed unions at the client's edges: DOM values are cast although guards exist, and exhaustiveness is still spelled three ways (2026-09-22 A5, still open)
**Severity:** LOW
**Location:** cic `SettingsDrawer.tsx`, `BanlistModal.tsx`, `ThemeEditor.tsx`, `lib/{banMask,dateFormat,notificationSound}.ts`, `ScrollbackPane.tsx` (`rowTime`), `biome.json`.
**What is wrong:**
- **DOM casts.** Five `e.currentTarget.value as <ClosedUnion>` casts (`TimeFormatKey`, `DateFormatKey`, `NotificationSound`, `BanMaskForm`, `ThemeFontFamily`). Guards already exist for three of them: `isBanMaskForm`, `isDateFormatKey`, `isNotificationSound`.
- **A silent default.** `rowTime()` still ends in `default:` over the `Row` union.
- **Three spellings of exhaustiveness.** Non-test cic has 66 `switch` statements, 12 `assertNever` call sites and 4 `const _exhaustive: never =` sites. `biome.json` enables no exhaustiveness rule.

**Impact:**
- A new union member compiles green and takes a fallback.
- A select whose options drift from the union passes an out-of-set value into a store.

**Direction:**
- Use the existing guards at the DOM door.
- Give `rowTime` explicit arms plus `assertNever`.
- Standardise on `assertNever`.
- Enable Biome's exhaustive-switch rule if the pinned 2.5.x has one (INFERRED, not checked).

#### TYP-A9. The E2E KEYS v2 payload is built from `map()` blocks, travels as JSON inside JSON, and is parsed by hand in three languages. Merged into X2.

### Prior findings (type system leverage) — status

| Prior | Status | Evidence |
|---|---|---|
| 09-22 A1 shottino closed sets (HIGH) | PARTIAL; re-raised at MEDIUM in X6 | `failing`/`admin` fixed; 7 of 10 enums pinned by text scrape; no generated header |
| 09-22 A2 web views outside codegen | REGRESSED; now X3 (HIGH) | casts 55 → 63; views outside codegen 8 of 12 → 9 of 13; `UserSettingsJSON` `@type`s 11 → 14, all unread |
| 09-22 A3 `optional(any())` sibling projections | OPEN | 8 type-level uses (7 before); the +1 is a documented row-polymorphic `e2e_arriving?/1`; `PartCleanup.state_slice` unchanged |
| 09-22 A4 AdminEvents ring | OPEN | `snapshot/0 :: [Wire.event()]` vs `load_recent/1 :: [map()]`; `kind` still `:string` |
| 09-22 A5 exhaustiveness spellings / defaults | OPEN; now TYP-A8 | `rowTime` default; 4 `: never =` sites; no lint rule |
| 09-22 A6 bare `map()` returns | OPEN | 24 single-line `:: map()`/`{:ok, map()}` specs (22 before); `Scrollback.Meta` still declares its key set twice (27 each) |
| 08-15 A2 six reply accumulators as `map()` | OPEN | still `map()` in `Server.t()`, which grew from 82 to 96 keys |
| 08-15 A4 widened wire copies | OPEN | `GrappaChannel` still has `kind: String.t()`, `topic: map()`, `modes: map()` |
| 08-15 A6 per-kind `meta` shapes in prose only | OPEN | `ScrollbackMetaT` values are `unknown`; 5 `meta … as` casts to the hand types `RawEvent`/`NumericEvent`; 12 `typeof …meta` probes (14 before) |
| 08-15 A7 inbound WS verbs untyped | OPEN | 33 distinct bare-string verbs across 38 `do_handle_in/3` clauses; `pushUserChannelVerb(event: string, …)` |
| 08-15 A8 closed sets authored twice | OPEN | `FONT_FAMILIES`, `ThemeColorKey`, `ReceiveVerb` |
| 08-15 A9 / A10 brands and `as ChannelKey` | OPEN / REGRESSED; now TYP-A3 | `as ChannelKey` 17 → 18; raw-string key counts up |
| 08-15 A12 `base_plan/6 :: map()` | OPEN | `Networks.SessionPlan` |
| 08-15 A13 `RawNetwork` legacy optionals | OPEN | 15 optional fields, still read by cast (X3) |

---

## Concern: extension & maintainability

The reviewer filed 12 new findings: 0 CRITICAL, 4 HIGH, 6 MEDIUM, 2 LOW. After the merge, 8 distinct findings are counted here: EXT-A1 is the home of X4. EXT-A4 went to X5, and EXT-A5, A6 and A9 went to X9, X8 and X11.

**Hotspots since 2026-09-22**, by commit count:

| File | Commits |
|---|---:|
| `DESIGN_NOTES.md` (union-merged, expected) | 256 |
| `CLIENT_PROTOCOL.md` | 64 |
| `default.css` | 64 |
| `session/server.ex` | 62 |
| `.claude/skills/orchestrate/SKILL.md` | 59 |
| `shottino.c` | 52 |
| … | |
| `shottino/wire.h` (#9) | 43 |
| `protocol.ex` (#11) | 41 |
| `shape.pin` (#12) | 40 |
| `socket.ts` (#13) | 39 |

Seven of the top 13 files are prose (3) or mainly carry the protocol version number (4).

**Walk-throughs: what one extension costs today.**
1. **A new scrollback message kind.** None has landed since `:server_event` (2026-05-14, 11 files). Enumerated on today's tree, one would touch ≈ 22 source/doc files, ~6 test files and 1–2 migrations, one of which rebuilds the largest table. Of the 7 classification sites, tsc forces 2 and a test pins 1 against the server; the other 4, plus shottino's table, fail open (EXT-A2).
2. **A new user-topic event.** #1894 took 26 files and #2577 took 28 (X9).
3. **A new context.** Cheap and gated, at 4–7 files: `e2e_keys` took 5, `e2e_inbox` 4 and `e2e_requests` 7. Every extra file is forced by the compiler or a census test. `e2e_pairing` took 23, 13 of them its REST door and wire. No finding.
4. **A new window state.** INFERRED at ≈ 28–30 files: `:invited` took 20 files in June, before about 8 now-mandatory layers existed. The type end is clean (`windowState.ts` aliases the generated `SessionWireWindowState`), but the classification end is not (EXT-A2).

### HIGH

#### EXT-A1. `@protocol_version` is still a hand-edited global integer in four files and three languages. Merged into X4, counted here.

#### EXT-A2. Classifying a new message kind or window state is spread over hand-written `Set`s that fail open, and the kind CHECK still forces a rebuild of the largest table
**Severity:** HIGH. The CHECK half is still open since 2026-08-15 (H18) and 2026-09-22; the fail-open classification half is new.
**Location:**
- Server: `Grappa.Scrollback.Message` (`@kinds`, `@content_kind_projection`, `@suppressed_presence_kinds`); the migrations `20260514071049_*` (the `kind_enum` CHECK) and `20261015113204_add_messages_away_window_index.exs`.
- cic:
  - `ScrollbackPane.tsx` (`PRESENCE_KINDS`);
  - `lib/ownPresenceEvent.ts` (another `PRESENCE_KINDS`);
  - `lib/api.ts` (`CONTENT_KIND_PROJECTION`, `isPresenceKind`);
  - `lib/presencePause.ts` (`PAUSABLE_PRESENCE_KINDS`);
  - `lib/windowStateSets.ts` (`NOT_JOINED_STATES`, consumed by `ComposeBox.tsx` and `Sidebar.tsx`).
- shottino: `wire.{c,h}` (`MESSAGE_KIND_NAMES`, `message_kind_of`).

**What is wrong:**
- **The types are generated; the classifications are not.** A new member lands in `SCROLLBACK_MESSAGE_KIND`/`SessionWireWindowState` automatically. But the sets that sort members into buckets are hand `Set` literals:
  - `CONTENT_KIND_PROJECTION`;
  - two different constants both named `PRESENCE_KINDS` (8 members vs 6);
  - `PAUSABLE_PRESENCE_KINDS`;
  - `NOT_JOINED_STATES`.

  A membership test is false for a member nobody added, so a new kind or state silently lands in the default bucket. A new terminal window state renders as **joined**.
- **The right tool is barely used.** `grep 'satisfies Record<'` finds 1 site (`metadataStrip.ts`), and no `Record<MessageKind|WindowState, …>`.
- **A dead helper, restated.** `isPresenceKind` has 0 production importers and is hand-restated in 17 test files (16 on 2026-09-22).
- **shottino.** `MESSAGE_KIND_NAMES` is the one shottino closed set its parity test does not pin. An unknown kind makes `message_kind_of` fail, and the whole row is rejected.
- **The CHECK.**
  - The `kind_enum` CHECK still means a SQLite table rebuild per kind; the May rebuild was 267 lines.
  - A content kind also needs a second migration that rebuilds the partial away-window index. That index's moduledoc estimates ~10 s of write lock on prod's ~5.2M rows (not measured on prod).
  - INFERRED: a rebuild is not an expand operation, so it deploys COLD.
- **The prose copy.** CLAUDE.md restates the window-state set, ungated.

**Evidence.** Walk-throughs (1) and (4) above. The new-kind cost was found by grepping every file that names both `server_event` and `nick_change` and reading each hit. The new-window-state cost is extrapolated.
**Impact:**
- The next kind or state costs about 30 files and two migrations.
- Its correctness depends on someone remembering four client sets and one C table that no build checks.
- The failures are silent: cic mis-buckets the kind or treats the state as joined, and shottino drops rows.

**Direction:**
1. Make the classification total at the source: a server `@kind_class` keyword over every `@kinds` member, with a compile-time `Keyword.keys(@kind_class) == @kinds` assert. Do the same for a `@window_state_class`. Emit both as generated consts.
2. Replace each client `Set` with `const X = {…} satisfies Record<MessageKind, Class>`, or with a filter over the generated const, so a new member is a tsc error at every classifier. Delete `isPresenceKind` and its 17 test restatements.
3. Add `MESSAGE_KIND_NAMES` to shottino's `pin_closed_set` (also X6).
4. Replace the `kind_enum` CHECK with an FK to a seeded `message_kinds` lookup table, so a new kind is an `INSERT` (expand, hot) and not a table rebuild.

#### EXT-A3. `.claude/skills/orchestrate/SKILL.md` is a 515 KB append-only incident log, loaded whole on every `/orchestrate`
**Severity:** HIGH
**Location:** `.claude/skills/orchestrate/SKILL.md`, `.claude/skills/orchestrate/lib/*.sh`; `scripts/union-rebase.sh`; `scripts/bats.sh`.
**What is wrong:**
- **Growth.**

  | Revision | Lines | Size |
  |---|---:|---:|
  | `575e203a` (2026-08-15) | 957 | 90 KB |
  | `c678ea5a` | 4,009 | 372 KB |
  | now | 4,762 | 515 KB |

  That is 5.7× in 98 days. The file is the #5 hotspot (59 commits).
- **Shape.**
  - It is larger than the live `DESIGN_NOTES.md` (492 KB).
  - It carries 271 dated lines and 289 red-circle markers.
  - Seven sections are titled "REGOLE NATE IL 2026-08-xx (permanenti — migrate dall'handoff)", and others "ERRORI MIEI" and "TRAPPOLE DI MISURA". It is a ledger of incidents, not an operating procedure.
- **Recipes in prose duplicate executable verbs.** "RICETTA DESIGN_NOTES — a ogni merge/rebase" is 160 lines of prose, and it cites `scripts/union-rebase.sh`, the script that already automates it.

**Evidence.** Bytes and lines are MEASURED. The ~130k tokens per invocation is INFERRED from a 4-bytes-per-token heuristic; emoji-dense Italian prose likely tokenises worse.
**Impact:**
- Each orchestrator session spends a large share of its context on this file before doing any work. That is INFERRED from the 40%-context clear rule in the operator's memory, not measured for this skill.
- Rules contradict each other across dated sections, and the newest one has to be found by reading all of them.
- Prose recipes drift from the scripts they duplicate.

**Direction:**
1. Cut `SKILL.md` to the decision tree and the verbs, under about 500 lines. Move reference material into files that the skill reads on demand.
2. Move the incident narrative into DESIGN_NOTES or `docs/project-story.md`.
3. Turn each recurring recipe into a script, then delete the prose:
   - the DESIGN_NOTES rebase recipe → `union-rebase.sh`;
   - the protocol collision check → X4's CI step;
   - the gate audit → the existing bats meta-tests.
4. Hold the file with a size gate in `scripts/bats.sh`.

#### EXT-A4. `shottino.c` grew 30% in 60 days and is still one translation unit. Merged into X5.

### MEDIUM

#### EXT-A7. The Logger metadata allowlist lives in a COLD-classified file, and a test forces every new scrollback meta key into it, so a new meta field is a forced cold deploy
**Severity:** MEDIUM. The allowlist's share of `config.exs` is still open since 2026-08-15 (A7); the deploy coupling is new.
**Location:** `config/config.exs` (the Logger metadata allowlist); `test/grappa/logger_metadata_allowlist_test.exs`; `Grappa.Scrollback.Meta.known_keys/0`; `Grappa.Deploy.Preflight` (class 7); `test/grappa/deploy/preflight_test.exs`.
**What is wrong:**
- **The test forces the edit.** `LoggerMetadataAllowlistTest` asserts `Meta.known_keys() -- allowlist == []`, so every new scrollback `meta` key must be added to `config/config.exs`.
- **The edit forces a cold deploy.** Preflight class 7 marks every `config/*.exs` change COLD, `test.exs` and `dev.exs` included (pinned by tests).
- **It happens in practice.**
  - All four `config/config.exs` commits since 2026-09-22 are allowlist edits: `:e2e_undeliverable`, `:e2e_device`, `:msgid`, and removals.
  - A commit touching only `config/test.exs` is also COLD by rule.
- **The cheapest extension is the most expensive to ship.** A meta key is the cheapest way to extend a scrollback row (#2176 used one instead of a kind), and it carries a restart of every IRC session. CLAUDE.md itself declines a rename to avoid one cold deploy.

**Evidence (MEASURED).** The allowlist is 367 of `config.exs`'s 777 lines, 113 atoms.
**Impact:** observability and small wire extensions are forced through a cold deploy. Either unrelated work batches behind a night window, or authors avoid adding log keys and meta fields.
**Direction:**
- Move the formatter metadata list into a module (e.g. `Grappa.Log.metadata_keys/0`). Apply it at boot from `application.ex` with `:logger.update_formatter_config/2`, and re-apply it from the hot-reload path, so that a new key is HOT.
- Re-evaluate class 7 for `config/test.exs` and `config/dev.exs`, which no release loads (INFERRED; verify against the release's `sys.config` sources before narrowing).

#### EXT-A8. The ship gates CLAUDE.md marks red are not executable at the deploy door, and the session protocol still prescribes steps against files that no longer exist
**Severity:** MEDIUM
**Location:** `scripts/deploy-m42.sh`, `infra/freebsd/deploy.sh`, `infra/lib/deploy_common.sh`; CLAUDE.md (Development Cycle step 3; Session Protocol steps 5–7); `.claude/skills/{start,review}/SKILL.md`; `docs/reviewing.md`; `docs/TESTING.md`; `.github/workflows/integration.yml`.
**What is wrong:**
- **No CI check at the door.** CLAUDE.md requires integration CI green before every ship. `deploy-m42.sh` checks only that local `main` is not ahead of `origin/main`. Nothing in the three deploy scripts queries CI: `grep 'gh run|check-runs'` over `scripts/ infra/ bin/` is empty.
- **No tag check.** CLAUDE.md requires the tag to exist before the build. Nothing verifies that `origin/main` HEAD carries `v$(cat VERSION)` beforehand, so the #391 contract is enforced only by a post-hoc version string.
- **Dead protocol steps.** The Session Protocol and `/start` direct agents to update the "active checkpoint" in `docs/checkpoints/` and to edit `todo.md`. The directory does not exist, and `docs/todo.md` is a "RETIRED" pointer. `docs/reviewing.md` repeats both. The 2026-09-22 review already noted the missing directory.
- **A stale number.** `TESTING.md` still says "suite ~3 min — … not re-measured". `integration.yml` records 33.6 min serial (2026-08-20), and the suite has grown 32% since (X11).

**Impact:**
- The two rule violations that cost most, shipping on red and a prod build reporting `X.Y.Z-<sha>`, depend on the operator's memory.
- Dead protocol steps teach every new session that CLAUDE.md instructions may be ignored, and they sit in the same file as its red-marked rules.

**Direction:**
1. In `deploy-m42.sh`, before the ssh, require `gh run list --commit $(git rev-parse origin/main)` to report success for both `ci.yml` and `integration.yml`, with an explicit, logged `--i-know-ci-is-red` escape.
2. On a VERSION-bump deploy, fail when `git describe --exact-match --tags origin/main` is not `v$(cat VERSION)`.
3. Delete the checkpoint and `todo.md` steps from CLAUDE.md, `/start`, `/review` and `docs/reviewing.md`, or recreate what they point at. Do not leave both.
4. Replace the TESTING.md duration with the `integration.yml` figure.

#### EXT-A10. The decision log is 6 MB of grep-only history, and its frozen archives carry reversed rulings with no forward pointer
**Severity:** MEDIUM
**Location:** `docs/DESIGN_NOTES.md`, `docs/design_notes/2026-{04..10}.md`, `.gitattributes`, `scripts/design-notes-gate.sh`, CLAUDE.md, `docs/reviewing.md`.
**What is wrong:**
- **Size.** The live file plus archives grew from 5.13 MB to 5.97 MB in 60 days: 101,965 lines and 1,205 `## 2026` entries. `2026-08.md` alone is 2.59 MB.
- **No topical index.** The archive index lists months and entry counts, not topics.
- **Frozen archives.**
  - They are `merge=text`, "moved verbatim … not one entry was edited", with 0 commits to `2026-07.md`/`2026-08.md` since 2026-10-01.
  - So a reversed ruling stays unannotated. Two examples:
    - "Query window follows a peer NICK change (GH #373)", reversed by issue 1365;
    - "#1287: the version bump is also the directory name", reversed by issue 2057.
  - Neither entry points to its reversal, and CLAUDE.md names at least five such reversals.
- **CLAUDE.md.** It is held flat (73,449 → 73,403 bytes), but carries 76 issue references and 36 "measured / retracted / ruling" lines inside its rules.
- **The review procedure.** `docs/reviewing.md` tells each review agent to *read* DESIGN_NOTES, which is now impossible; this review's own brief forbade it.

**Impact:** a grep for a topic returns the original ruling and its reversal side by side, with nothing marking which one is current.
**Direction:**
1. Allow one kind of archive edit: a single `> Superseded by <!-- entry #NNNN --> (date)` line under a reversed entry's heading, added in the reversing commit and checked by `design-notes-gate.sh`.
2. Generate a topic index (marker → title → tags) as a build artefact.
3. Change `docs/reviewing.md` to say "grep", not "read".

#### EXT-A5. A new user-topic event costs 26–28 files across four languages. Merged into X9.

#### EXT-A6. Cross-language parity is held by ad-hoc source scrapers rather than by the codegen. Merged into X8.

#### EXT-A9. The e2e suite grew 32% past the shard sizing. Merged into X11.

### LOW

#### EXT-A11. CLAUDE.md's code-shape MUST rules have no executable check
**Severity:** LOW
**Location:** `.credo.exs`; CLAUDE.md code-shape rules (the identifier fold invariant, the `Application.get_env` ban, no `\\` defaults); `IRC.Identifier.services_sender?/1`.
**What is wrong:**
- **No checks.** `.credo.exs` enables only stock checks, with 0 custom ones, and no test scans `lib/` for these rules.
- **The rules hold today by review alone.** There are 0 `\\` defaults in `lib`, and every `Application.get_env` in `lib` sits in a `boot/0`.
- **One violation already exists.** The fold rule has an instance inside its own SSOT module: `services_sender?/1` does `String.downcase(s) in @services`. INFERRED harmless today, since the allowlist is ASCII.

**Impact:** the rules that keep the codebase uniform depend on reviewers who start every session with zero memory.
**Direction:** add three small custom Credo checks:
- `\\` defaults in `def`/`defp`;
- `Application.get_env` outside `application.ex`, `boot/0` bodies and `lib/mix/`;
- `String.downcase` in `lib/grappa/{irc,session,scrollback,query_windows}/**`, with an inline-disable escape that requires a reason.

#### EXT-A12. The three production env templates omit runtime knobs, and the full-registry gate covers only Docker's
**Severity:** LOW. Still PARTIAL since 2026-08-15 (A9).
**Location:** `config/runtime.exs`, `.env.example`, `infra/{freebsd,linux,packaging}/grappa.env.example`, `test/grappa/config/env_registry_drift_test.exs`, `substrate_beam_knob_honesty_test.exs`.
**What is wrong:**
- **Uneven coverage.** `env_registry_drift_test` checks the full set only against `.env.example`; the substrate test pins a few knobs in all four templates.
- **Seven knobs missing.** Of the 26 env vars `runtime.exs` reads by literal name, 7 appear in none of the three production templates: `GRAPPA_IDENTD_{ENABLED,BIND,PORT}`, `GRAPPA_PASSKEY_ORIGIN`, `DCC_STORAGE_ROOT`, `PEER_AVATARS_STORAGE_ROOT`, `GRAPPA_SUBSTRATE`.
- **Some may be covered elsewhere.** INFERRED: some may be set by the rc.d/systemd wrappers rather than by operators.

**Impact:** a feature that adds an operator knob documents it for Docker, the substrate that is not production, and nothing reminds the author of the other three.
**Direction:** parameterise the drift test over all four templates, with a per-substrate exemption list that carries a reason for each entry (the `RouterScopeTest` fail-closed pattern).

### Prior findings (extension & maintainability) — status

| Prior | Title | Status | Evidence |
|---|---|---|---|
| 09-22 A1 | Wire pin blind to controller-rendered bodies | OPEN (new code improved) | still digests artefacts plus `*JSON` beams only, with no route table; 41 domain-data inline literals; the new E2E doors render through `*.Wire` |
| 09-22 A2 | `@protocol_version` global serialization point | OPEN, worse | X4 |
| 09-22 A3 | shottino hand-mirrors closed sets | PARTIAL | `failing`/`admin` fixed; 2 server sets, 5 E2E sets and event kinds pinned; `MESSAGE_KIND_NAMES` unpinned; no generated header (X6, EXT-A2) |
| 09-22 A4 | 16,043-line single stylesheet | OPEN, worse | 17,452 lines, still the only `.css`; #3 hotspot (64 commits); `themeCss` text-assert callers 28 → 40 (COH-A6) |
| 09-22 A5 | `shottino.c` monolith | OPEN, worse | X5 |
| 09-22 A6 | Synchronous `vi.mock` factories | OPEN, worse | 393 → 492 synchronous factories (`lib/auth` 50, `lib/networks` 45, `lib/api` 29); no lint gate |
| 09-22 A7 | LockWatch suite quarantined | OPEN | `@moduletag :flaky` unchanged since 2026-09-07 (75 days); 38 tests excluded; `lock_watch.ex` touched once since, with its suite unrun |
| 09-22 A8 | Decision narrative in hot code files | OPEN, worse | `protocol.ex` 89% → 94% comments; `socket.ts` preamble 206 → 395 lines; `server.ex` 48% of 10,374; `vite.config.ts` 64% |
| 09-22 A9 | `wireTypesAssert` pins unenforced | OPEN | 24 → 37 pins vs 164 reachable schemas |
| 08-15 A4 / H20 | `Session.Server` + test as conflict epicentre | OPEN, worse | 8,789 → 10,374 and 14,783 → 16,188 lines (X1) |
| 08-15 A10 | e2e tsconfig with no `extends` | PARTIAL | flags hand-aligned; no `extends`, no alignment test |
| 08-15 H18 | Kind CHECK forces a table recreate | OPEN | EXT-A2 |

---

## Top findings for vjt

Ordered by impact. All severities are as reported.

1. **`Session.Server` keeps absorbing domains, and #2133 has waited 9+ weeks for your ruling** (X1 + COH-A1, HIGH).
   - E2E is 64.5% of the module's +18% regrowth, and E2E persistence and sweeps now share the crash boundary of the user's IRC link.
   - A ratchet gate on keys, clauses and deps is the cheap half of either answer.
2. **The E2E protocol is kept by hand in four codebases, and its spec is not committed** (X2, HIGH).
   - The spec lives in issue comments and a gitignored plan, and the only cross-client test of shottino is a human.
   - Commit `docs/E2E_PROTOCOL.md` and one shared vector corpus.
3. **The client re-derives the member list with a MODE walker that never followed #216** (DUP-A2, HIGH).
   - INFERRED: `+bo` ops the wrong member, and `+q`/`+a` never apply on `(qaohv)` networks, until the next `members_seeded`.
4. **Message kinds and window states are classified by hand `Set`s that fail open** (EXT-A2, HIGH).
   - cic mis-buckets, a new state renders as joined, and shottino drops whole rows.
   - The kind CHECK still forces a rebuild of the largest table, INFERRED COLD.
5. **Codegen membership is a hand list while the pin reads the beams** (X3, HIGH).
   - REST casts went 55 → 63, two per new setting.
   - A renamed field forces a protocol bump but compiles green in cic and reads `undefined`.
6. **The protocol number is hand-typed in four files: 33 bumps in 60 days, with 30 hand collision checks** (X4, HIGH).
   - One generated header or manifest cures this and shottino's unpinned closed sets (X6) together.
7. **`shottino.c` is 30,981 lines (+30%), with E2E glue inside** (X5, HIGH).
   - Its no-split ruling assumed 14.7k lines, and 7 test binaries compile it whole.
8. **`orchestrate/SKILL.md` is 515 KB, 5.7× in 98 days, and loaded whole on each invocation** (EXT-A3, HIGH).
   - About 130k tokens, INFERRED.

Two MEDIUMs carry latent correctness consequences:
- **X7.** A registry-key edit would silently make Admission's per-network caps fail open (INFERRED).
- **DEP-A3.** The `SourceAliasManager` order can turn a mode-2 connect during boot into a terminal `:failed` credential (INFERRED), and it leaks every derived alias on each clean shutdown.

## What the reviewers refused to claim

**Nothing was executed.**
- No compiler, `mix`, `bun`, `tsc` or docker was run. Boundary's verdict was never observed (DEP). Dialyzer's and tsc's output was reasoned from specs, apart from the `pattern_match_cov` behaviour that `server.ex` itself records (TYP).
- BND did not claim that a sibling `Grappa.ReadCursor.Advance` boundary compiles cycle-free; that was inferred from the declared `deps:`.
- DEP inferred Biome's handling of type-only edges from CI being green.

**Consequences INFERRED, not observed.**
- **DUP-A2.** The `+bo` and `+q`/`+a` misapplication comes from reading the two walkers. Nothing was run, and it is unchecked whether a later `members_seeded` masks it.
- **COH-A1.** E2E retention being tied to session liveness was not traced through every enqueue path or tested on a parked network.
- **DEP-A3.** The start window is unmeasured. It matters only on addressing mode 2, and DEP does not know whether prod runs it.
- **X7.** The fail-open is latent: today the key shapes agree. DEP did not search the test tree exhaustively for a pin, and BND did not establish which admission tests would go red.
- **X1 / DEP-A5.** The synchronous calls in the session mailbox are not a measured latency problem.
- **EXT.**
  - It did not claim `main` was red between `5d7ec617f` and `5783f6546`, because CI history was not read.
  - The e2e runtimes (≈ 44 min serial, ≈ 18 min per shard) are scaled from 2026-08-20, not measured.
  - The 28–30 files for a new window state are extrapolated.
  - That a `messages` rebuild deploys COLD is inferred from Preflight's rule, and the ~10 s lock figure is another migration's estimate for a different operation.
  - The 7 missing env vars may be set by the substrate wrappers.
  - Token counts use a 4-bytes-per-token heuristic.
  - Whether the shottino CI job is a required check is unknown, because branch protection is not in the repository.
- **TYP.**
  - The `Map.get` shims are not claimed as a correctness bug: they are dead after a COLD restart and harmless while running. It is not proven that no production deploy used `--force-hot` across a state-shape change.
  - Preflight's handling of `@type t` was read from code and DESIGN_NOTES, not observed in a deploy.
  - Biome's exhaustive-switch rule is unchecked.

**No live divergence claimed.**
- DUP: the E2E implementations agree today on the domain strings, caps and `MAX_FRAGMENTS`. The only divergences cited are the `CLIENT_PROTOCOL.md` line and the ruled irc-olm NACK case.
- The E2E ASCII-only fold:
  - TYP: on `:ascii` it is byte-identical to `asciiFold`, and on rfc1459 it matches the server's own documented DM gap, so TYP does not claim a fork.
  - BND: the server keys on `canonical_target/1` too, so the two sides agree. BND did not establish whether this is the #537 niche gap or a new one.
- `narrowScrollbackMessage` and `S_ScrollbackWireT` agree on live payloads apart from integer vs number (TYP).
- shottino REST: DUP and BND re-verified the five prior drifts but did not walk the 69 legacy `json_get` reads (or the 9 `rows_of` readers) field by field, so no new REST drift is claimed.
- Whether the 6 `SERVER_WINDOW = "Server"` e2e specs are vacuous or failing was not run (DUP).
- BND did not establish that a user rename door exists, so BND-A9 claims redundancy and label-keyed identity, not a live rename bug.
- BND found no ruling on whether encrypted DMs are excluded from the OS icon badge and did not trace the path, so it files nothing.
- EXT does not claim `Identifier.services_sender?/1`'s Unicode downcase is exploitable; it is cited only as evidence that the rule has no gate.

**Not filed, by judgement or because a ruling covers it.**
- **BND.** The 11 `optional(:…)` emit-specs "because a server predating N omits it": one typespec serves two contracts, but the rationale is recorded and still true. Noted, not filed.
- **DUP**, because rulings cover them:
  - the shottino `--ircd` CHATHISTORY facade vs Phase 6 (DESIGN_NOTES 2026-07-29, "this is NOT Phase 6");
  - cic `metadataStrip.ts` vs the server `MetadataStrip` (vjt's F2 ruling, 2026-11-06);
  - the frozen `kind IN (…)` literal of `messages_away_window_user_idx` (pinned by `MentionsTest`);
  - `e2eRequests.ts` re-deriving `expired` (it needs the live clock).
- **DUP, not counted as duplication:** shottino's `fold_ascii_byte` (header/HTML matching, not identity), `strcasecmp` on option words, the E2E contexts' `(subject, network)` partitions (all through `Grappa.Subject`), and the E2E controllers (every response goes through a `*.Wire`).
- **COH.**
  - `subscribe.ts` and `userTopic.ts`'s dispatch half are fan-out hubs whose arms delegate, not god modules.
  - The cic E2E stack (`engine.ts` as a declared pure port of irc-olm, `client.ts`, `encryptedChats.ts`, `EncryptedChatPane.tsx`) is well layered.
  - The four server E2E contexts each hold one job.
  - No schema broadcasts or touches `Repo`, and no controller does `Repo` or IRC parsing; the grep hits were all in comments.
  - `FallbackController`'s growth is the sanctioned single error map.
  - Whether `E2eController`'s hand-parsed params breach "Ecto.Changeset for ALL user input" depends on downstream validation and was not verified.
  - `protocol.ex`'s growth is decision prose, left to EXT.
- **DEP.** No root-strategy defect: no concrete failure was established from `:one_for_one` against the ordering comments, so there is no `:rest_for_one` recommendation.
- **TYP.** The 65 `{:error, term()}` occurrences were not treated as underspecified closed sets without per-site proof, since the repo is green under `:underspecs`.

**Counting caveats.**
- **DEP.** No edge-growth claim from 134/508 vs the prior 122/472, since the parsers differ.
- **BND.** The prior-A15 inline-literal count is a line-scoped grep that can move by a few; the direction (not shrinking) is what it stands behind.
- **COH.**
  - All counts are raw newline or regex counts. The `@type t` key, `struct app` field and CSS band counts depend on the stated regexes, and are comparable across revisions only because the same regex was applied to both.
  - "Hotspot" means commit count in the window, not merge-conflict count.
- **TYP.**
  - The prior review's `nick: string = 68` did not reproduce (72 at `c678ea5a`, and 72 is used).
  - Its pathspec exclusions differ slightly from its Python file list, so deltas are comparable but absolute numbers can differ from the headline file set by a few percent.
- **DUP.**
  - Its severity for the protocol-version finding covers only the duplication half.
  - The Channel E2E (Megolm) client half has not landed, so nothing is claimed about a fifth E2E copy.
