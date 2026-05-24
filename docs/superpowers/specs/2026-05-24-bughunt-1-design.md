# BUGHUNT-1 — Pre-bastille bug-hunt cluster

**Date**: 2026-05-24
**Author**: brainstorm session (vjt + Claude SIBLING autopilot)
**Status**: approved — proceed to plan

## What this fixes

Two user-visible bugs vjt flagged during UX-8 cluster execution.
Must close BEFORE bastille deploy: a new prod runtime substrate
should not inherit known regressions.

Per `docs/todo.md` § "Pre-bastille bug-hunt":

1. **Long-message auto-split (SERVER-SIDE)** — cic POST of a PRIVMSG
   larger than the IRC server's max line length silently truncates.
2. **Archive empty on first open (CIC, MOBILE)** — modal renders
   "no archived windows" until the user archives a window. Root
   cause hypothesis (now confirmed by code-read): `ArchiveModal.tsx`
   opens via `setArchiveModalNetwork(slug)` but does NOT call
   `loadArchive(slug)` on mount. Only `Sidebar.tsx`'s `<details>`
   expand path fires the load. Mobile operators open the modal from
   `BottomBar.tsx`'s chip — never expand the sidebar — and see the
   un-seeded empty state.

Both fit one cluster (BUGHUNT-1) because they share substrate
(`per-bucket deploy + push + CI verify`), the cluster ships in a
single sprint, and the failure modes both produce silent user
confusion.

## Approach

### Bucket A — Long-message auto-split (server-side)

**Where the split MUST happen**: `lib/grappa/irc/client.ex`'s
`send_privmsg/3` is the wire-write seam. Splitting at
`Session.Server` `handle_persisting_send/3` (the persistence + send
caller) is the WRONG layer because the wire-frame envelope
(`PRIVMSG <target> :`) is what consumes the LINELEN budget, and
`Client` is the one that constructs the envelope.

But there's a complication: `Session.Server` also persists ONE
`Scrollback.persist_event/1` row per outbound PRIVMSG. If the split
emits N upstream PRIVMSGs, we need N scrollback rows so the operator's
own scrollback view matches what other channel members see (each
fragment lands as a separate row upstream-side too — that's how every
IRC client renders it). The split needs to be VISIBLE to the caller
so the persist + broadcast loop can iterate.

**Proposed shape**:

- New `Grappa.IRC.LineSplit.split_privmsg_body/3` pure module —
  takes `body :: String.t()`, `target :: String.t()`, `linelen ::
  pos_integer()`. Returns `[String.t()]` of body fragments. The
  envelope budget = `linelen - byte_size("PRIVMSG #{target} :\r\n")`.
  Splits on grapheme boundary (per CLAUDE.md "use String.length/1
  only when you mean graphemes"). Preserves CTCP framing if body
  is `\x01ACTION ...\x01`: the `\x01` envelope bytes count toward
  the budget, and the leading `ACTION ` token stays on the first
  fragment; the trailing `\x01` lands on the last fragment.
- `Session.Server.handle_persisting_send/3` calls
  `LineSplit.split_privmsg_body(body, target, state.linelen)`,
  iterates the resulting list — for each fragment:
  persist_event → broadcast → `Client.send_privmsg` → reply on the
  last iteration.
- `state.linelen` is a new GenServer state field, default 512 per
  RFC 2812. Populated from `005 RPL_ISUPPORT` `LINELEN=<N>` token
  (parsed in `lib/grappa/session/server.ex` line 1663-area where
  `MODES=N` is already parsed — same shape, same pattern).

**Out of scope**: TOPIC / NOTICE / AWAY auto-split. Same class of
bug but PRIVMSG is the only one vjt flagged. Other verbs stay
single-line; if a future bucket adds them, the LineSplit module
generalizes trivially (`split_envelope_body/3` taking the envelope
prefix as a param).

### Bucket B — Archive seed on modal open (cic)

**Root cause** (confirmed by code-read):
`cicchetto/src/ArchiveModal.tsx` opens via the
`archiveModalNetwork()` signal. The signal is set by
`ShellChrome.tsx:52` (`setArchiveModalNetwork(slug())`) from the
mobile chip. NO call to `loadArchive(slug)` accompanies that
setter. `Sidebar.tsx:527` is the ONLY caller of `loadArchive` and
fires from the `<details>` onToggle. Mobile-only because BottomBar
chip exists only in the mobile branch of `Shell.tsx`; desktop
operators always interact via Sidebar.

**Fix** (smallest possible patch): inside `ArchiveModal.tsx`'s
`createEffect` that observes `archiveModalNetwork()`, fire
`void loadArchive(slug)` on edge-trigger open (when
`archiveModalNetwork() !== null` and the prior was null). Mirrors
the existing `pushOverlay`/`popOverlay` edge-trigger shape (lines
56-71). Imports `loadArchive` from `./lib/archive`. Idempotent on
re-open per `archive.ts:18-20` ("Re-loading the same slug is a
deliberate refresh"); user re-opening the modal gets fresh
contents — desirable.

**Why not at the setter site** (`setArchiveModalNetwork(slug)` in
ShellChrome.tsx)? Two reasons:
1. Symmetric concern — Sidebar (desktop) handles its own load
   inside its own setter site; ArchiveModal (mobile) should too.
   Mounting-component-owns-its-state.
2. Decoupling: if a future cluster opens the modal from a different
   surface (URL deep-link, push notification, etc.), the load
   happens automatically — no per-callsite remembering.

**Sentinel test**: cic e2e + a vitest pure for the
`createEffect`. The vitest seeds `archiveModalNetwork(slug)` and
asserts the `loadArchive` was called (mock the `listArchive` API
call). The e2e opens the modal from BottomBar chip with NO prior
sidebar interaction and asserts the archive list count >0 (after a
seeded archive entry from the test fixture).

## Order

A → B is the recommended order:
- A is server-side, no cic involvement, HOT deployable; ships as a
  pure backend fix that future cic doesn't need to know about.
- B is cic-only, needs `scripts/deploy-cic.sh`; lands separately so
  any regression is bisectable to one substrate.

No load-bearing dependency between A and B; reverse order is fine
if needed. Pick A-first per "smaller blast radius first" heuristic.

## Per-bucket deploy cadence

Per `feedback_per_bucket_deploy`:

- **A** — server-side typespec + logic changes; `Session.Server`
  GenServer state-shape gains a `:linelen` field
  (`state :: %{ ..., linelen: pos_integer()}`). **COLD DEPLOY
  REQUIRED** per `feedback_cluster_with_migration_must_cold` (state-
  shape change in long-lived process); preflight in
  `scripts/deploy.sh` SHOULD catch it via
  `lib/grappa/hot_reload/long_lived_modules.ex` — verify the
  module is listed there before bucket commit, else `--force-cold`.
- **B** — cic-only; `scripts/deploy-cic.sh`. Browser smoke MANDATORY
  per `feedback_cicchetto_browser_smoke`: open the Archive chip on
  mobile, confirm list seeds with content; trigger a new archive
  action, confirm list updates.

## Hard rules carry-forward

- Worktree FIRST for production code per CLAUDE.md Development Cycle.
- Per-bucket deploy cadence per `feedback_per_bucket_deploy`.
- `scripts/check.sh` exit-0 + literal tail paste at LANDED.
- Code-reviewer loop per bucket per
  `feedback_subagent_driven_development`.
- A's `state.linelen` field add MUST be reflected in the long-lived-
  modules registry to trigger preflight-cold.
- A test asserts on the BYTE size of EACH fragment ≤ envelope budget,
  not grapheme/codepoint count.
- B test asserts that opening from BottomBar with NO prior sidebar
  interaction populates the list, AND that the existing Sidebar
  expand path still works (no regression).

## Out of scope

- TOPIC / NOTICE / AWAY auto-split (only PRIVMSG flagged).
- Server-side `RPL_ISUPPORT` MAXTARGETS comma-split (different bug
  class, no recorded vjt sighting).
- Desktop Archive seed bug (vjt confirmed not-yet-reproduced; if it
  fires later, bucket B's fix covers it because the createEffect
  doesn't condition on mobile).
- CTCP verbs other than ACTION (DCC, VERSION, etc. — single-line by
  convention, not affected by long-message issue).
- Cic-side rendering of multi-fragment messages as a "joined paragraph"
  (each fragment is its own scrollback row; renderer treats them as
  independent — matches every IRC client's behavior).

## Risks & open questions

- **CTCP ACTION split edge case**: `\x01ACTION very long text\x01`
  with the entire body > LINELEN. Fragmenting yields
  `\x01ACTION text-chunk-1` (no trailing `\x01`!) on fragment 1 and
  `text-chunk-2\x01` (no leading `\x01ACTION`!) on fragment 2. Other
  IRC clients render fragment 1 as `* nick text-chunk-1` (broken
  CTCP) and fragment 2 as a regular PRIVMSG `<nick> text-chunk-2\x01`
  (garbage suffix). **Mitigation**: detect CTCP envelope at split
  time, emit each fragment as its own full CTCP envelope
  (`\x01ACTION chunk-1\x01`, `\x01ACTION chunk-2\x01`). Budget
  accounts for the per-fragment overhead.
- **Grapheme split inside a multi-byte sequence**: `String.split_at/2`
  on graphemes is safe (Elixir handles UTF-8). The budget is in
  BYTES (`byte_size/1` of each fragment ≤ budget). Iterative shrink:
  take graphemes one at a time, accumulate, stop when
  `byte_size(acc) + byte_size(next_grapheme) > budget`.
- **LINELEN=0 ISUPPORT (malformed server)**: validate `linelen > 0`
  at parse time; fall back to 512 default on any garbage value.
- **Bucket B test isolation**: cic test that asserts the seed-on-open
  behavior must NOT leak state from prior tests (modal might be
  already-open from a sibling test). Reset
  `setArchiveModalNetwork(null)` in beforeEach.
- **No actual repro on grappa CI** for the long-msg bug — none of the
  existing testnet IRCDs (Bahamut/InspIRCd/UnrealIRCd) advertise a
  smaller LINELEN. Test fixture artificially sets
  `state.linelen` to a small value (e.g. 80) so the spec runs
  deterministically without testnet manipulation.

## Memory hooks worth re-reading

- `feedback_per_bucket_deploy` — deploy cadence
- `feedback_landed_claim_evidence` — gate-tail at LANDED
- `feedback_cicchetto_browser_smoke` — bucket B browser smoke
- `feedback_subagent_driven_development` — code-review:loop per bucket
- `feedback_plan_vs_production_reality` — record deviations in
  commit body
- `feedback_cluster_with_migration_must_cold` — A's state-shape add
  forces COLD deploy
- `feedback_dialyzer_plt_staleness` — run dialyzer standalone at
  each bucket close
- `project_codegen_cluster_closed` — most recent precedent for this
  cluster cadence
