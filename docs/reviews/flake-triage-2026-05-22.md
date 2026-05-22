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

### Class C — testnet load class (27 specs, ONE bug, ONE fix bucket)

All 27 specs at 31s timeout share root cause: bahamut accumulates
orphan channel/membership state under sustained sequential traffic,
then a new JOIN against a fresh channel name doesn't get a clean
handshake. Documented in `project_bahamut_load_flake`. **Same-triplet
recurring** per `feedback_recurring_e2e_not_flake` — these are NOT
"meltdown" / "environmental" / "load" in the run-once-flake sense;
they're a real testnet contract bug that surfaces deterministically
once the suite crosses a load threshold.

```
b0-invite-from-server-window:30          (31.9s)
b2-inbound-invite-cta:33                 (31.9s)
cp22-bnames-names-rows:35                (31.5s)
ios-z-cluster-journey:47                 (31.2s)
m10-admin-networks-cap-editor:61         (31.4s)
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
