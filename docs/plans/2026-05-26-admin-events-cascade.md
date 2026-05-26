# 2026-05-26 — AdminEventsTest cross-test pollution cascade

## TL;DR

`Grappa.AdminEventsTest` setup_1 hook polls `SessionRegistry` for up
to 5s waiting for prior-test fake-session registrations to drain.
When the suite is run in full (`scripts/check.sh` or `scripts/test.sh`
with no args) the registry still holds 4+ stale entries after 5s →
`flunk/1` fires inside setup → **9 failures all originating from
setup_1** (`test/grappa/admin_events_test.exs:40`). In isolation
(`scripts/test.sh test/grappa/admin_events_test.exs`) the same file
passes 10/10.

This was masked for 9+ days by `mix.exs` `ci.check` alias step
exit-code propagation bug (fixed in `fc4575a`, 2026-05-26). With the
truthful check.sh exit code restored, this is the first latent bug
the suite re-surfaces. There are likely more.

## Repro

```
# In-isolation: green
scripts/test.sh test/grappa/admin_events_test.exs
# → Finished in N.Ns. 10 tests, 0 failures.

# Full suite: 9 failures
scripts/check.sh
# OR
scripts/test.sh
# → 9 failures, all in Grappa.AdminEventsTest, all from setup_1
```

The 9 failing tests (every test in the file that needs setup to succeed):

1. `session-lifecycle adapter (U-5) skips broadcast when network deleted`
2. `record/1 + snapshot/0 buffer is capped at 200 events`
3. `session-lifecycle adapter :terminated subtracts self from its subject_kind bucket`
4. `telemetry adapter translates :capacity, :reject`
5. `session-lifecycle adapter (U-5) broadcasts but does NOT enter the snapshot ring buffer`
6. `session-lifecycle adapter :spawned synthesizes :cap_counts_changed with post-transition counts + caps`
7. `record/1 + snapshot/0 newest event is first in the buffer`
8. `telemetry adapter skips :circuit, :close :operator_reset (synthetic-only path)`
9. `record/1 + snapshot/0 broadcasts on Topic.admin_events/0 + prepends to buffer`

Every failure stack ends at `wait_for_empty_session_registry!/0` at
`test/grappa/admin_events_test.exs:40` (via the setup block at
line 29).

## Root-cause hypothesis (UNCONFIRMED — bucket A first action is
                              to verify)

`AdminEventsTest` uses `register_fake_session/2`
(`test/grappa/admin_events_test.exs:285`) to insert
`{:session, subject, network_id}` keys into `Grappa.SessionRegistry`
under the test pid. On test exit, `on_exit/1` calls
`Registry.unregister/2` — but that only unregisters the **caller's**
entries; `on_exit` runs in a fresh process per ExUnit (see source
comment at line 38). The cleanup actually relied on is the
Registry-monitor-DOWN that fires when the original test pid dies.
That cleanup is **async**.

The setup_1 drain (`wait_for_empty_session_registry!`,
`test/grappa/admin_events_test.exs:312`) polls every 10ms for up to
5s (500 iterations) waiting for the match-spec count to hit 0. The
budget was bumped 50→200→500 iterations over the suite's history
(GREEN-CI batch 2, BUGHUNT-2 pre-baseline) as load grew. Today, 5s
is again insufficient on local-dev full-suite load.

But that's a symptom-level reading. The real questions:

1. **Is the leftover from `AdminEventsTest` itself**, or from
   genuinely other tests in the suite that spawn real
   `Session.Server` processes (T31/U-5/M-11/etc.)?
2. **Are those other tests cleaning up properly**? `Session.Server`
   under DynamicSupervisor terminates via `GenServer.stop/3`; if
   they `Process.exit/2` instead (see
   `feedback_process_exit_vs_genserver_stop`) the Registry
   monitor-DOWN waits on the supervisor's `terminate/2` to finish
   before unregistering, which itself depends on the broadcast
   fan-out completing.
3. **Could `AdminEventsTest` truncate the Registry deterministically
   in setup** rather than polling? `Registry.select/2 + Registry.unregister_match/3`
   is a synchronous API — for a test-singleton lane (`async: false`
   per max_cases: 1) the registry can simply be wiped of `{:session, _, _}`
   keys at setup boundary instead of waiting for async DOWN
   propagation.

Hypothesis ranking (most → least likely):

(a) Cross-test pollution: prior tests (M-11 / T31 / U-5 / Session
    integration suites) leak Registry entries that ExUnit's
    sandbox rollback doesn't catch because Registry is not Repo-
    backed. The drain budget is fighting a losing race with
    sustained load. **Fix in those tests' teardown contracts,
    not in AdminEventsTest's polling budget.**

(b) Drain budget genuinely too short under load — but with the
    history of 50→200→500 bumps, "bump it again" is the wrong
    answer. The polling shape is the bug; we need synchronous
    truncation.

(c) `AdminEventsTest`'s own test bodies leak entries that
    monitor-DOWN can't catch within 5s when the test pid exits
    cleanly but Registry's purge handler is queued behind other
    work.

Most likely: (a) + (c) combined, with (b) as the band-aid that's
been bumped twice.

## Scope (cluster A/B/Z draft)

### Bucket A — root cause + minimal fix

1. **Run setup_1 with diagnostic logging** before any fix. Capture
   the leftover entries on cascade failure:
   - which `subject` shapes (`{:visitor, _}` vs `{:user, _}`)
   - which `network_id` values
   - which test pids registered them (Registry stores pid in third
     match field — exposed via `Registry.select/2`)
   - whether those pids are alive (`Process.alive?/1`) at the
     moment of cascade
2. From the diagnostic, identify whether the leakers are
   `AdminEventsTest`'s own test pids or sibling-suite pids.
3. Fix at the source:
   - If leakers are AdminEventsTest's own: replace `on_exit` +
     monitor-DOWN reliance with synchronous `Registry.unregister/2`
     called from the test body BEFORE `on_exit` runs (i.e. inside
     the test, not after).
   - If leakers are sibling suite: audit those tests'
     `Session.Server` teardown — they should `GenServer.stop/3`
     and await the supervised terminate before letting their
     test return.
   - Either way, replace `wait_for_empty_session_registry!` in
     setup with `purge_session_registry!` — a synchronous select +
     unregister_match that drops all `{:session, _, _}` keys
     deterministically. `async: false` + `max_cases: 1` makes this
     safe (no concurrent registrar).

### Bucket B — audit other test files for the same pattern

1. Grep for `Registry.register(Grappa.SessionRegistry`,
   `Process.exit`, and `register_fake_session` across test/.
2. Any test that registers under its own pid without a
   synchronous unregister at end-of-test body is a cascade
   poisoner candidate.
3. Apply the bucket-A teardown contract uniformly.

### Bucket Z — close

1. Run `scripts/check.sh` full suite in isolation 3× to confirm
   stability (no failures on any run).
2. Document the teardown contract in a new memory:
   `feedback_session_registry_test_teardown.md`.
3. Update CLAUDE.md "Testing Standards" if the pattern is broad
   enough to warrant a rule.

## Why this matters

This is a real bug masked for 9+ days by the alias-doesn't-halt bug
fixed in `fc4575a`. Same masking class likely hides more bugs.
Before declaring the suite green, the full `scripts/check.sh` must
exit 0 with no failures — that's the new ground truth post-fc4575a.

Per `feedback_landed_claim_evidence.md`: every LANDED claim from
2026-05-26 onward requires literal check.sh tail + truthful exit
code. We've spent 9 days shipping under a false-green oracle.

## Lineage

- Surfaced 2026-05-26 in the same session that landed `fc4575a`
  (`fix(mix.exs): ci.check alias halts on doctor/test/etc failure`).
- Predecessor memories:
  - `feedback_mix_alias_doesnt_halt` (NEW 2026-05-26) — alias step
    exit-code propagation
  - `feedback_landed_claim_evidence` — full check.sh tail paste +
    exit code; partial gates lie
  - `feedback_check_sh_working_tree_trap` — verify `git diff
    --quiet HEAD` before LANDED claims
  - `feedback_cascade_not_load` — rotating victim cascade triage
  - `feedback_process_exit_vs_genserver_stop` — external
    GenServer teardown uses `GenServer.stop/3`, not
    `Process.exit/2`; affects Registry monitor-DOWN timing
  - `feedback_subagent_driven_development` — Plan + code_search +
    review skill on cluster work

## Source-of-truth references

- `test/grappa/admin_events_test.exs:29-65` — setup block
- `test/grappa/admin_events_test.exs:285-289` — register_fake_session
- `test/grappa/admin_events_test.exs:312-334` —
  wait_for_empty_session_registry! polling helper (with growth
  history in source comments)
- `lib/grappa/admin_events.ex` — production GenServer under test
- `lib/grappa/session/server.ex` — `registry_key/2` + terminate path
- `lib/grappa/application.ex` — Registry + SessionRegistry boot order

## Exit criteria

- `scripts/check.sh` exits 0 with zero failures on 3 consecutive
  full-suite runs (per `feedback_bisect_sample_size_required`:
  single-shot iso is insufficient signal).
- `Grappa.AdminEventsTest` passes in isolation (10/10) AND inside
  the full suite (10/10).
- New teardown contract documented as a memory.
- No leftover stale `{:session, _, _}` keys in `SessionRegistry`
  at the boundary between any two test files.

## Out of scope

- Bumping the `wait_for_empty_session_registry!` budget further.
  500 iterations × 10ms is already 5s; bumping again is band-aid
  on band-aid.
- Refactoring `Session.Server` teardown semantics beyond what test
  contracts require.
- Migrating to a different Registry abstraction.

## Open questions for bucket A

1. Should `purge_session_registry!` live in `Grappa.DataCase` (so
   every test using `Grappa.SessionRegistry` benefits) or stay
   local to `AdminEventsTest`?
2. Is there a Registry API for "wait for monitor-DOWN of pid X to
   complete" that we should be using instead of either polling or
   force-unregistering?
3. Does T31/admission have its own cascade poisoner candidates?
   (worth checking pre-bucket-A so we size bucket B correctly)
