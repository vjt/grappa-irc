# 2026-05-22 — e2e baseline flake triage (FLAKE-A)

Triage manifest for the flakes cluster (post-REV, per
`project_post_review_ordering_2026_05_22` vjt mandate). Cluster scope
was originally written as "45 e2e + 2 server-side classes"; FLAKE-A
rebaselines against the **current HEAD** (`bf3ba3a`, REV-Z close) and
finds:

| Surface              | Brief said | FLAKE-A measured | Delta |
|----------------------|-----------:|-----------------:|------:|
| e2e baseline fails   |        45  |              41  |    −4 |
| server-side classes  |         2  |               0  |    −2 |

**Source for e2e** = integration.yml run `26299521755` (REV-K HEAD
`8070551`, most-recent integration run on main; subsequent commit
`bf3ba3a` is docs-only so the e2e shape is identical). 41 ✘ failures,
33 distinct spec files.

**Source for server-side** = `scripts/test.sh` against current HEAD
`bf3ba3a` — **8 doctests, 33 properties, 2424 tests, 0 failures** in
55.9s. The brief's two server-side classes (`Grappa.AdmissionTest`
ETS-singleton-leak + `AdminEventsTest:197` `assert_receive` race)
are STALE: the ETS-leak class CLOSED 2026-05-17 commit `7bb3caa`
("IRC.Client dead-socket SEND returns honest `{:error, _}`") per
memory `project_network_circuit_ets_leak`; the assert_receive class
was closed during U-cluster live-cap-counters work + REV-D
silent-swallow audit. Neither surfaces on current HEAD.

Brief was inherited from pre-REV state. Scope is **e2e only**.

## Duration histogram (41 fails)

```
27 × 31.x s   → Playwright 30s test-timeout (load class)
 9 × 5-6s     → assertion-fail @ default 5s/6s timeout
 3 × <1s      → locator-not-found instant fail
 2 × 10-11s   → bumped-timeout assertion fail
```

The 27/41 (≈66%) at 31s clustering is the diagnostic. These specs
ALL share the shape: `loginAs → selectChannel → IRC interaction →
assert on DOM`. The `loginAs/selectChannel` pre-fix establishes a
bahamut connection through `azzurra-testnet`; after ~40-50 specs of
sustained join/kick/part traffic, bahamut state-corrupts and new
JOINs never get clean handshakes — `project_bahamut_load_flake`
(originally cp15-b6-kicked + M9, now ALL 27 specs by induction).

## Per-spec disposition

### Class C — testnet load class (26 specs after FLAKE-B isolation testing)

26 specs at 31s timeout sharing a common shape. Documented in
`project_bahamut_load_flake`. **Same-triplet recurring** per
`feedback_recurring_e2e_not_flake` — these are NOT "meltdown" /
"environmental" / "load" in the run-once-flake sense; they're a
real testnet contract bug that surfaces deterministically once
the suite crosses a load threshold.

**Empirical evidence from FLAKE-B isolated runs (2026-05-22):**

Confirmed PASS in isolation (i.e. truly load-class):

- `push-install:36` — 663ms ✓ (was 31.5s in suite)
- `push-permission-denied:28` — 663ms ✓ (was 31.4s)
- `push-trigger-channel-mention:54` — 2.7s ✓ (was 31.4s)
- `push-trigger-dm:36` — 843ms ✓ (was 31.6s)
- `scroll-on-window-switch:141` — 4.7s ✓ (was 31.1s)
- `scroll-on-window-switch:207` — 354ms ✓ (was 31.1s)

The 6 sampled cover BOTH the seed-dependent + no-IRC-traffic
subclasses, so all 26 are inductively load-class.

Confirmed FAIL in isolation → **NOT load class; moved to Class A**:

- `m10-admin-networks-cap-editor:61` — 30.6s ✘ (`sessionsInput.
  inputValue()` times out). Test-id divergence: spec references
  `admin-network-max-sessions-${slug}` but cic source renamed
  during U-2 split to `admin-network-max-visitor-sessions-${slug}`
  (per `cicchetto/src/__tests__/AdminNetworksTab.test.tsx`).
  Trivial spec rot fix.

```
b0-invite-from-server-window:30          (31.9s)
b2-inbound-invite-cta:33                 (31.9s)
cp22-bnames-names-rows:35                (31.5s)
ios-z-cluster-journey:47                 (31.2s)
m10-admin-networks-cap-editor:61    (31.4s, **MOVED TO CLASS A** post-FLAKE-B isolated test)
m2-irssi-to-chan-defocused:33            (31.6s)
marker-target-window-regression:42       (31.5s)
marker-target-window-regression:73       (31.4s)
members-prefix-regression:24             (31.5s)
message-replay-on-reconnect:38           (31.5s)
nick-case-sensitivity:39                 (31.4s)
p0a-whois-flags:43                       (31.4s)
p0b-peer-away:29                         (31.4s)
p0c-whowas:27                            (31.5s)
p0c-whowas:59                            (31.5s)
p0e-invite-ack:26                        (31.5s)
push-install:36                          (31.5s)
push-permission-denied:28                (31.4s)
push-prefs-whitelist:47                  (31.5s)
push-server-fires-regardless-of-focus:58 (31.4s)
push-trigger-channel-mention:54          (31.4s)
push-trigger-dm:36                       (31.6s)
r6-own-action-no-events-badge:68         (31.5s)
refresh-on-join:50                       (31.5s)
scroll-on-window-switch:141              (31.1s)
scroll-on-window-switch:207              (31.1s)
ux-2-mobile-archive:43                   (31.5s)
```

**Disposition:** ONE bucket fix at the testnet infrastructure layer.
Per `project_bahamut_load_flake`'s pre-staged hypotheses:

- **Hypothesis 1** — docker compose restart between specs (or every
  N specs) via Playwright `globalSetup` hook. Cost ~5-10s per
  restart. Heavy hammer; clean isolation.
- **Hypothesis 2** — per-spec channel-name uniquification. cp15-b6-
  kicked already uses `crypto.randomUUID().slice(0, 8)`-suffixed
  channels but most specs use `AUTOJOIN_CHANNELS[0]` (`#bofh`).
  Per-run uniquify + tear down the credential's autojoin entry
  post-spec. Removes the load source.

Likely **both** (defense in depth). Run `--repeat-each 50` locally
after each fix to measure isolation.

### Class A — real product bugs (need investigation, 12 candidates)

Sub-1s and 5-6s fails are NOT timeout-class — these are assertions
firing against DOM that already settled. Distribution:

```
597ms ux-5-bc2-nick-render:52       (members-pane NickText rendering)
654ms ux-5-bc2-nick-render:210      (scrollback PRIVMSG sender <nick>)
840ms ux-6-d-keyboard-pattern:129   (Admin → Debug tab DiagFloat)
5.7s  ux-5-bc2-nick-render:138      (own nick no @/%/+ prefix glyph)
5.8s  cp13-server-window:53         (ComposeBox on $server slash-only gate)
5.8s  p0d-lusers:24                 (LusersCard pinned in $server window)
5.9s  cic-members-panel-scope:107   (parked channel MembersPane suppression)
5.9s  i2-image-upload:30            (picker → privacy modal → upload)
6.0s  i2-image-upload:86            (privacy modal Cancel)
6.2s  m9-cicchetto-part-x-click:42  (sidebar X-button PART)
6.4s  ux-6-d-keyboard-pattern:101   (iOS PWA :has(:focus) padding collapse)
6.8s  ux-5-bv-mobile-keyboard-react:184 (mobile members drawer auto-close)
```

**Concentrations:**
- `ux-5-bc2-nick-render` × 3 — NickText cluster. One spec at 597ms
  (locator-not-found = `.nick-text` absent in members pane), one at
  6.5s (`<nick>` angle-bracket structure), one at 5.7s (prefix
  glyph). Likely ONE class B fix bucket.
- `cp13-server-window` × 2 — server-window cluster (S8 at 11s
  timeout is class A; S9 at 5.8s is class B candidate). Two
  related-but-distinct asserts on $server-window behaviour.
- `i2-image-upload` × 2 — image-upload cluster. Privacy modal
  flow. Likely ONE class B fix bucket.
- `ux-6-d-keyboard-pattern` × 2 — iOS PWA keyboard cluster. 11-
  attempt saga per `feedback_ux_6_d_anti_patterns`. Class B
  candidate (carry-debt rather than new regression).
- `ux-5-bv-mobile-keyboard-react:184` × 1 — mobile members drawer.
  Adjacent to UX-6-D class.
- `m9-cicchetto-part-x-click:42` × 1 — sidebar X-button PART.
- `cic-members-panel-scope:107` × 1 — parked channel MembersPane.
- `p0d-lusers:24` × 1 — LusersCard.

### Class B — spec rot candidates (1, possibly more)

```
11.0s names-ux-n3-cold-load-auto-select:29  (cold load auto-select first joined channel)
10.8s cp13-server-window:80                  (S8 — unread badge on $server)
```

Both bumped their default assertion timeouts (10/11s) but still
failed. Candidates for spec rot per UX-X structural-change patterns
(N-3 was a UX-7-area regression spec; S8 is part of CP13 server
window cluster). Class A/B distinction requires opening the specs +
diffing against the surface they probe. Carried as **needs-
investigation** in FLAKE-B.

## Bucket plan

### FLAKE-A (this bucket) — triage manifest

LANDED on commit. Docs-only; commit to `main` directly per CP43
docs-only convention.

### FLAKE-B — testnet load isolation (Class C fix bucket)

Single bucket fix: hypothesis 1 + hypothesis 2 combined. Target
SCOPE = the 27 Class C specs all returning to green on two
consecutive `scripts/integration.sh` runs.

**Scope of change:** `cicchetto/e2e/playwright.config.ts`
(`globalSetup` hook), `cicchetto/e2e/fixtures/seedData.ts` or a
new helper for per-run channel-name uniquification, possibly
`compose.yaml` testnet profile if the restart hook needs explicit
container names.

**Estimated reduction:** 27 → 0 if both hypotheses land cleanly;
fall back to 27 → ≤5 if uniquification alone removes the load
source but bahamut state-corruption still hits the most-load-
heavy specs.

**Worktree:** `/tmp/grappa-flake-b`. Reviewer-loop mandatory.
LANDED requires `scripts/integration.sh` on TWO consecutive runs
with Class C set targeted via `--grep`.

### FLAKE-C — Class A product-bug investigation (NickText)

3 specs in `ux-5-bc2-nick-render`. Likely a single product-side
regression (NickText component or theme variable definition).
Open the specs + reproduce locally first to confirm scope.

### FLAKE-D — Class A product-bug investigation (i2-image-upload)

2 specs in `i2-image-upload`. Privacy modal flow regression.
Likely single fix (modal a11y label or button text changed).

### FLAKE-E — Class A product-bug investigation (cp13-server-window)

2 specs. Server-window cluster — possibly two separate fixes; size
after reading current implementation.

### FLAKE-F — Class A product-bug investigation (ux-6-d + ux-5-bv mobile-kb cluster)

3 specs together (ux-6-d × 2, ux-5-bv × 1) — adjacent surfaces
sharing iOS-PWA keyboard root cause per `feedback_ux_6_d_anti_patterns`.

### FLAKE-G — singletons

4 specs each with their own root cause: `m9-cicchetto-part-x-click`,
`cic-members-panel-scope:107`, `p0d-lusers`, `names-ux-n3-cold-load-
auto-select`, `cp13-server-window:80`. May fold into FLAKE-E or
require own micro-buckets — size during investigation.

### FLAKE-Z — closer

Reconciliation: re-run `scripts/integration.sh` on main HEAD post
all buckets; document any remaining quarantines with inline
justification + tracking link per `feedback_recurring_e2e_not_flake`.
DESIGN_NOTES cluster-close entry. README closed-clusters bullet.
Cluster summary memory.

## Hard rules (cluster discipline)

Per `/tmp/orchestrate-next.txt`:

- **No `gh run rerun --failed`** (`feedback_no_ci_retries_on_first_failure`).
  First run is the truth. Use local `--repeat-each` if you need
  determinism evidence.
- **No silent-swallow** (`feedback_no_silent_drops_closed`). If a fix
  hides a failure rather than fixing it, operator + user must both
  see it. Quarantines via `test.skip` with a tracking memory are
  acceptable; silent timeout-bumps are not.
- **No near-identical anchor edits** (`feedback_edit_noop_silent_deletion`).
- **LANDED requires literal gate-tail paste** for code-touching
  buckets (`feedback_landed_claim_evidence`). Docs-only FLAKE-A +
  FLAKE-Z need only push to origin/main + DESIGN_NOTES + todo update.
- **Reviewer-loop mandatory** for code-touching buckets only
  (`feedback_reviewer_gate_evidence`). FLAKE-A is docs-only and
  skips reviewer.

## Cross-refs

- `project_bahamut_load_flake` — the 30s shape, hypotheses
- `project_network_circuit_ets_leak` — CLOSED ETS-leak class
- `feedback_recurring_e2e_not_flake` — same-triplet recurring = real
- `feedback_no_ci_retries_on_first_failure` — no rerun-failed
- `feedback_test_singletons_async_false` — singleton-lane rule
- `feedback_ux_6_d_anti_patterns` — iOS PWA kb anti-patterns
- `feedback_landed_claim_evidence` — gate-tail paste

---

# FLAKE-B Part 2 — per-spec true-isolation triage (2026-05-22)

Re-baselines the FLAKE-A classifications against TRUE isolated runs
(each spec on its own fresh testnet stack via `scripts/testnet.sh
down && up`). FLAKE-A's induction "27 specs are bahamut load class"
was based on 6 sampled specs all passing alone; this Part 2 sampled
ALL 38 distinct failing files from the post-FLAKE-B-Part-1 suite run.

**Major findings**:
1. FLAKE-A's "27 Class C" was WRONG by induction. Real count: ~27
   files (most of the 38) actually pass alone (= true SPEC-ROT
   load class).
2. FLAKE-A's "Class A real product bugs" claims for
   `ux-5-bc2-nick-render` × 3, `ux-5-bv-mobile-keyboard-react`,
   `ux-6-d-keyboard-pattern` × 2 were ALSO WRONG. All pass cleanly
   in isolation — these are SPEC-ROT (load class), not Class A bugs.
3. 7 specs DO fail in true isolation — REAL BUG candidates needing
   per-spec evaluation per vjt mandate 2026-05-22 ("specs may just
   be wrong; triage in browser if needed").
4. **The "two-pass" technique was load-bearing**: Pass 1 (batched,
   stack-reset every 5 files) mis-classified m4/m5/m6/marker-
   target-window/message-replay as "REAL BUG?". Pass 2 (own
   per-spec stack cycle) corrected to SPEC-ROT. Cause: `scripts/
   testnet.sh down + up` between batches does NOT actually reset
   the grappa container's per-spec state contamination from prior
   runs — only a per-spec cycle gives clean signal.

## Per-spec true-isolation results

### SPEC-ROT / load class (true-iso = PASS): 27 files

These pass cleanly in isolation but fail at suite scale. Cause is
upstream isolation failure (NOT addressable by per-spec fix — needs
infrastructure design; session-bounce already disproven per CP43 S2).

```
cic-members-panel-scope
cp14-b1-scroll-marker-vs-bottom
cp14-b2-scroll-up-loadmore
cp15-b6-pending-to-failed-invite-only
m10-admin-networks-cap-editor    (slow but green: 38.6s)
m4-irssi-to-priv-no-window       (Pass-1 false-FAIL; Pass-2 PASS)
m5-irssi-to-priv-window-open     (Pass-1 false-FAIL; Pass-2 PASS)
m6-cicchetto-to-priv             (Pass-1 false-FAIL; Pass-2 PASS)
marker-target-window-regression  (Pass-1 false-FAIL; Pass-2 PASS)
message-replay-on-reconnect      (Pass-1 false-FAIL; Pass-2 PASS)
p0a-whois-flags
p0b-peer-away
p0c-whowas
push-install
push-permission-denied
push-prefs-whitelist
push-server-fires-regardless-of-focus
push-trigger-channel-mention
push-trigger-dm
r6-own-action-no-events-badge
refresh-on-join
scroll-on-window-switch
ux-2-mobile-archive
ux-5-bc2-nick-render             (FLAKE-A claimed "Class A NickText" — WRONG)
ux-5-bv-mobile-keyboard-react    (FLAKE-A claimed "Class A" — WRONG)
ux-6-d-keyboard-pattern          (FLAKE-A claimed "Class A 11-attempt saga" — WRONG)
ux-z-cluster-journey
```

### REAL BUG candidates (true-iso = FAIL): 7 files

These fail in TRUE isolation on a fresh stack. Per vjt mandate
("specs may just be wrong; triage in browser if needed"), each needs
individual evaluation before classifying as PRODUCT BUG vs SPEC ROT.

```
i2-image-upload                  (2 FAIL — vjt note 2026-05-22:
                                  uploads WORK IN PROD → spec is
                                  wrong, not bug)
m9-cicchetto-part-x-click        (1 FAIL — `.shell-main p.muted
                                  "select a channel"` not found
                                  post-PART; page snapshot shows
                                  sidebar still has #bofh after
                                  X-button click. Could be BUG5a
                                  self-PART dismiss broken OR spec
                                  asserts on pre-UX-5/6 empty-state UI)
members-prefix-regression        (1 FAIL — `.members-pane` not in
                                  DOM at assertion time despite
                                  selectChannel succeeding. Members
                                  panel may not be mounting; check
                                  viewport/responsive rules)
names-ux-n3-cold-load-auto-select (1 FAIL — needs investigation)
nick-case-sensitivity            (1 FAIL — `/q` with different casing
                                  focuses existing window, no duplicate)
p0d-lusers                       (1 FAIL — LusersCard pinned in $server)
p0e-invite-ack                   (1 FAIL — `/invite` to peer surfaces
                                  invite-ack row in $server)
```

### FLAKE (Pass 1 mixed; not re-validated in Pass 2): 4 files

```
cp14-b3-dm-history-bidirectional (1 PASS + 1 FAIL across batched runs)
ios-z-cluster-journey            (1 PASS + 1 FAIL)
m9b-admin-sessions-actions       (4 PASS + 4 FAIL — sharp split)
ux-6-k-pm-unread-cursor          (1 PASS + 1 FAIL)
```

May reclassify as SPEC-ROT under true isolation; not yet validated.

## Lessons learned

1. **Batched isolation is unreliable**: `scripts/testnet.sh down &&
   up` does NOT fully reset state between spec runs on the same
   stack instance. Each `docker compose run` against the same
   playwright-runner container shares grappa state across spec
   runs (vjt's `Session.Server`, bahamut leaf state, sqlite WAL).
   Per-spec full stack cycle (down + up before EACH spec) gives
   clean signal.
2. **FLAKE-A manifest's classifications were FALSE INDUCTIONS**.
   Sample of 6 "load class" specs that happened to be clean
   inducted to "all 27 are load class". 5+ "Class A real product
   bugs" actually pass cleanly in isolation.
3. **Suite-level flake is the dominant signal**: 38 distinct files
   show failures at suite scale; only 7 of them actually have
   per-spec issues. The remaining 31 are upstream isolation
   failure (load class + flake).
4. **The fixture-rot fix (FLAKE-B Part 1) unblocks ~6 cases
   cleanly** but suite-level flake (±10 specs/run) dwarfs the
   improvement. Real fix is upstream isolation, not per-spec.

## Next-session work

Per vjt 2026-05-22 mandate "finish this round, we clear and we
evaluate each one":

1. `/clear` + open per-spec triage on the 7 REAL BUG candidates
   with vjt in collaborative browser triage. Most likely outcome:
   most are SPEC ROT (UX-4/5/6/7 sweeps moved DOM around; specs
   assert on stale selectors) — fix by updating specs to match
   current UX contract.
2. Re-classify the 4 FLAKE (Pass 1 mixed) files in true isolation.
3. Re-classify the broader cluster scope based on triage outcomes.
4. Design upstream isolation mechanism for the 27 SPEC-ROT (load
   class) files — NOT session-bounce per CP43 S2 (already disproven).
