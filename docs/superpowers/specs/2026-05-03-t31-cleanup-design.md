# `cluster/t31-cleanup` — design spec

**Date:** 2026-05-03
**Source review:** `docs/reviews/codebase/2026-05-03-codebase-review.md`
**Worktree branch:** `cluster/t31-cleanup`
**Driver memory pin:** `~/.claude/projects/-srv-grappa/memory/project_post_p4_1_arc.md`

## Goal

Close all 74 findings from the post-T31 codebase review (12 HIGH, 35
MEDIUM, 27 LOW) plus the 6 already-filed Plan 2 micro-followups plus
two non-T31 HIGH (H2 user-logout-WS disconnect, H12 IRC `send_pong/2`
NUL-injection asymmetry). Single bundled cluster; sibling decides
natural sub-seams within the 7 buckets defined below.

Aim is correctness + maintainability; not new feature work, not
Phase 5 hardening.

## Policies (vjt-blessed)

  * **Captcha duplication:** keep duplicate ONLY where it mirrors
    provider wire-shape (Turnstile vs hCaptcha endpoint /
    request-payload / error-code differences are intentional). UNIFY
    OUR-logic duplication — HTTP client setup, response parsing,
    error mapping, config load — into a shared private helper
    module. Judge per call site.
  * **`Application.get_env` runtime reads:** fix per CLAUDE.md ban
    ("boot-time only, runtime banned"). Pass via `start_link/1`
    opts or read once at boot into immutable storage; supervisor
    injects.
  * **`text-polish` cluster:** DEFERRED per vjt — UX feedback, not
    infra. Out of scope here.
  * **Phase 5 hardening:** OUT of scope. Several findings unblock
    once TLS lands (UUID v4 fallback retire, CSP `ws:` clause drop,
    `crypto.randomUUID` simplification) but stay deferred until
    Phase 5 cluster.
  * **Reviewer-template gate-evidence upgrade** (open follow-up
    from CP11 S21+S22): IN scope — touches user-global skill at
    `~/.claude/superpowers/skills/requesting-code-review/SKILL.md`.
    Root-cause fix for the inspection-vs-RUN gates gap.
  * **Worktree branch:** `cluster/t31-cleanup` (vjt directive).
  * **Process:** TDD per task, plan-fix-first when spec drift
    surfaces during execution, reviewer gates-must-be-RUN (template
    upgrade lands inside this cluster — apply the discipline by
    hand until it does), 25% ctx ceiling per session,
    autonomous-push on green ship gates.

## Design decisions

### A. Boot-time captcha-config injection mechanism

**Decision:** `:persistent_term`.

`Grappa.Application.start/2` (or a delegated `Grappa.Admission.boot/0`
helper called from start) reads the `:admission` config keys
(`:captcha_provider`, `:captcha_secret`, `:captcha_site_key`,
`:turnstile_endpoint`, `:hcaptcha_endpoint`) once, validates the
required-when-non-Disabled invariants (provider in
`{Disabled, Turnstile, HCaptcha}`; secret + site_key non-nil for
non-Disabled), constructs an immutable `%Grappa.Admission.Config{}`
struct, and stores it via
`:persistent_term.put({Grappa.Admission, :config}, struct)`.

Readers (`Admission.verify_captcha/2`, the per-provider impls,
`FallbackController.captcha_site_key/0` +
`captcha_provider_wire/0`) call `Grappa.Admission.config/0` which
does `:persistent_term.get({Grappa.Admission, :config})`. Read is
lock-free, non-allocating, ~10ns. Mox path for tests:
`Grappa.Admission.put_test_config/1` writes a different struct;
test setup blocks call it; the helper is `@doc false` and gated
on `Mix.env() == :test` to discourage misuse.

`Application.get_env(:grappa, :admission, ...)` runtime reads in
`Admission`, `Captcha.Turnstile`, `Captcha.HCaptcha`,
`FallbackController` are eliminated. CLAUDE.md "boot-time only"
rule restored.

**Rationale:** persistent_term is the BEAM-idiomatic primitive for
read-heavy never-mutated config (used by Plug, Phoenix, Bandit
internally). Agent rejected per CLAUDE.md "almost never right
call." GenServer-state injection couples config to an unrelated
process. Macro-based compile-time injection forfeits the test-
substitution path.

### B. Captcha shared-logic shape

**Decision:** `Grappa.Admission.Captcha.SiteVerifyHttp` private
helper module.

Shape:

```elixir
defmodule Grappa.Admission.Captcha.SiteVerifyHttp do
  @moduledoc false  # private to Captcha boundary

  @spec verify(endpoint :: String.t(), secret :: String.t(),
               token :: String.t(), remote_ip :: String.t() | nil) ::
          :ok | {:error, Grappa.Admission.Captcha.error()}
  def verify(endpoint, secret, token, remote_ip) do
    # 1. URI.encode_query
    # 2. Req.post with shared headers + timeout
    # 3. response shape match: {:ok, %{status: 200, body: %{"success" => true|false}}}
    # 4. error mapping: connection error → :captcha_provider_unavailable;
    #    400/non-200 → :captcha_provider_unavailable; success false → :captcha_failed
  end
end
```

`Captcha.Turnstile.verify/2` collapses to ~6 lines: `nil` token
guard → fetch endpoint + secret from `Grappa.Admission.config/0` →
delegate. `Captcha.HCaptcha.verify/2` same shape, different
endpoint default.

The `Captcha` behaviour stays at the right granularity — provider
abstraction. `SiteVerifyHttp` recognizes that two of three known
providers happen to share a protocol. A future protocol-divergent
provider (e.g. self-hosted mCaptcha with a different request shape)
implements `Captcha` directly, bypassing `SiteVerifyHttp` —
boundary stays clean.

**Test consolidation:** the duplicate captcha test files
(`test/grappa/admission/captcha/{h_captcha,turnstile}_test.exs`)
collapse to a single shared module exercising the common
`SiteVerifyHttp` flow + per-provider integration smoke (one test
per provider asserting "calls the right endpoint with the right
keys").

### C. NetworkCircuit race fix (H6 + H7)

**Decision:** observation-token capture + state-aware window-reset.

H6 fix: `check/1` captures `cooled_at_ms` at the moment it observes
`:open` and includes it in the `{:cooldown_expire, network_id,
observed_cooled_at}` cast. `handle_cast({:cooldown_expire, ...}, _)`
match-spec lookup matches on `[{_, _, _, :open, ^observed_cooled_at}]`
— if any state mutation has happened (re-open with a different
`cooled_at_ms`, close), the handler no-ops. No more
`:cooldown_expired` close events for an entry that just re-tripped.

H7 fix: `handle_cast({:failure, _}, _)` window-reset branch
distinguishes `prior_state` cases:

  * `prior_state == :closed`, window expired: reset count to 1,
    update `started_at = now`, keep `:closed` (current behaviour).
  * `prior_state == :open`, `now < cooled_at_ms`: drop the failure
    silently (per moduledoc "no half-open"; failure-during-open is
    expected upstream noise).
  * `prior_state == :open`, `now >= cooled_at_ms` but cooldown-
    expire cast hasn't been processed yet: same as `:closed` path
    (window-fresh, count = 1) — the deferred expire-cast will
    no-op via H6 token-check.

ETS reads (the hot path) preserved. No new `GenServer.call`.
Cooldown semantics: window and cooldown remain independent.

Plus: the `compute_cooldown(0, _)` edge-case test + setup-block
comment + the `NetworkCircuit semantics` DESIGN_NOTES entry land
alongside the fix (already-filed follow-ups).

### D. Single `@type Grappa.Admission.error()` union

**Decision:** Unified union.

```elixir
defmodule Grappa.Admission do
  @type capacity_error ::
          :client_cap_exceeded
          | :network_cap_exceeded
          | {:network_circuit_open, retry_after :: non_neg_integer()}

  @type error :: capacity_error() | Grappa.Admission.Captcha.error()
end

defmodule Grappa.Admission.Captcha do
  @type error :: :captcha_required | :captcha_failed | :captcha_provider_unavailable
end
```

`FallbackController` `@spec` references `Grappa.Admission.error()`
directly. cicchetto `AdmissionError` discriminated union becomes
the codegen target for whatever wire-shape contract emerges from
this cluster (codegen out-of-scope here; the type-level fold makes
it possible).

### E. `client_id` rationalization

**Decision:** Tighten plug to UUID v4 + custom `Grappa.ClientId`
Ecto type.

  * `lib/grappa_web/plugs/client_id.ex` regex tightens from
    `~r/\A[A-Za-z0-9_-]+\z/` to UUID v4 format
    `~r/\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/i`.
    Non-UUID values fall back to nil-assign (same as missing
    header) — operator can choose to require it via plug pipeline
    ordering.
  * New `Grappa.ClientId` Ecto type:
    `Ecto.ParameterizedType.init/2` not needed; standard
    `use Ecto.Type` with `:string` underlying storage + format
    validation in `cast/1` and `load/1`. Re-validates on schema
    load — defense in depth.
  * `accounts_sessions.client_id` schema field changes from
    `:string` to `Grappa.ClientId`. Migration is schema-only; no
    DDL change.
  * `Admission.capacity_input` typespec narrows to
    `client_id: Grappa.ClientId.t() | nil` (where
    `@type t :: <<_::288>>` or just `String.t()`).
  * cicchetto-side: `cicchetto/src/lib/clientId.ts` already
    produces UUID v4. Existing fallback path validated.
  * Test changes: existing client_id test fixtures updated to UUID
    v4; non-UUID values become rejected in plug tests.

### F. `update_network_caps/2` clear-cap path (H10)

**Decision:** Extend operator-bind verb with explicit clear flags.

`mix grappa.set_network_caps`:

  * `--max-sessions N` / `--max-per-client N` (existing; sets cap to N ≥ 0)
  * `--clear-max-sessions` / `--clear-max-per-client` (new; sets cap to nil = unlimited)
  * Mutually exclusive with the `--max-sessions` / `--max-per-client`
    pair: passing both for the same dimension errors with
    `Mix.raise("--clear-max-sessions and --max-sessions are mutually exclusive")`.
  * `bin/grappa rpc 'Grappa.Networks.update_network_caps(net,
    %{max_concurrent_sessions: nil})'` parity preserved; the
    context fn already accepts nil cast values — the bug is that
    `Network.changeset` casts but `validate_number` skips nil.
    Confirm cast→nil path with a context test.

### G. IRC `send_pong/2` NUL guard (H12)

**Decision:** Extend parser invariant; rename `Parser.strip_crlf/1`
to `Parser.strip_unsafe_bytes/1`.

`Parser.strip_unsafe_bytes/1` strips `\x00` + `\r` + `\n` (the
three bytes `Identifier.safe_line_token?/1` rejects). Parser
invariant matches the token contract.

`Client.send_pong/2`'s docstring (justifying the omission of the
`safe_line_token?` guard) updates to reference the strengthened
invariant. `send_privmsg/3`'s explicit guard stays — it's the
boundary between the ScrollbackPane-supplied body and outbound
bytes; the parser doesn't transit `PRIVMSG` body chars (those come
from REST input).

Test change: existing parser tests for CR/LF stripping extend to
NUL. Add property test covering all three bytes interleaved
arbitrarily.

### H. Reviewer-template skill upgrade

**Decision:** Update user-global skill at
`~/.claude/superpowers/skills/requesting-code-review/SKILL.md`.

Concrete change: add a "Gates Discipline" section mandating that
the reviewer subagent explicitly RUN each gate command and paste
its tail output into the review (literal output, not asserted from
inspection). Format:

```
## Gates evidence

- `scripts/format.sh --check` — <paste tail>
- `scripts/credo.sh --strict` — <paste tail>
- `scripts/dialyzer.sh` — <paste tail>
- `scripts/test.sh` — <paste tail>
- `scripts/check.sh` — <paste tail>
```

Reviewer claims of "Format/Credo/Dialyzer ✓" without paste are
explicitly disallowed. The CP11 S21 corrective (Plan 1 reviewer
mis-asserted from inspection) becomes a permanent skill-level rule.

This file lives outside the repo. Orchestrator edits it directly.

## 7-bucket task organization

Sibling carves sub-seams inside each bucket; orchestrator does not
prescribe within-bucket ordering. Cross-bucket ordering: B1 + B3 + B4
land first (architectural foundations); B5 + B6 + B7 follow. B2
straddles (frontend can land any time after B1's config injection
exposes the wire shape that frontend renders).

### B1 — Admission boot-injection (decision A)

**Items:** H1 (Application.get_env eliminate), M-arch-2 part
(GrappaWeb Boundary deps += Admission), M-arch-6 part (preflight
config validation — the runtime side; the CSP-CI-test side lands
in B6).

**Tasks:**
  * Add `%Grappa.Admission.Config{}` struct + `Grappa.Admission.boot/0`
    + `Grappa.Admission.config/0` reader.
  * Wire `Grappa.Application.start/2` to call `Admission.boot()` after
    config-load, before child-spec processing (so PromEx/PromEx-like
    boot-time consumers can read).
  * Replace 5 runtime `Application.get_env` reads with
    `Grappa.Admission.config/0`.
  * Add `Grappa.Admission` to `GrappaWeb`'s Boundary deps.
  * Test: boot-time validation — non-`Disabled` provider with nil
    secret crashes `start/2` loud; `Disabled` allows nil secret.
  * Mox: `Grappa.Admission.put_test_config/1` for test override.

**Reviewer gate evidence required:** check.sh + dialyzer.sh
standalone (per `feedback_dialyzer_plt_staleness`).

### B2 — Captcha shared-logic + frontend (decision B + frontend HIGHs)

**Items:** M-arch-1, H3 (mount-error swallow), H4 (friendlyMessage
arm), M-cic-2 (unsafe casts), M-cic-4 (loadScript test gap), M-cic-5
(widget cleanup race), M-cic-6 (auth.ts side-effect), L-cic-1/2/3/4/5/6.

**Tasks:**
  * Extract `Grappa.Admission.Captcha.SiteVerifyHttp` (helper module
    + tests).
  * Refactor `Captcha.Turnstile.verify/2` + `Captcha.HCaptcha.verify/2`
    to delegate.
  * Consolidate captcha test files (one shared module for the common
    flow + one smoke per provider).
  * cicchetto `Login.tsx`: catch on captcha mount promise; clear cleanup
    closure on rapid mount/unmount; submitting toggle around captcha-
    callback login.
  * cicchetto `friendlyMessage`: add `captcha_required` arm.
  * cicchetto `clientId.ts`: try/catch around localStorage; namespace
    version key; rename `grappa.client_id` → `grappa-client-id` for
    separator consistency.
  * cicchetto: harden the `as` casts in Login.tsx with type predicates.
  * cicchetto `auth.ts:51`: move `setOn401Handler` from module-load to
    explicit `bootstrap()` from `main.tsx`.

### B3 — Provider/error canonicalization (decision D + H5)

**Items:** H5 (captcha_provider_wire boundary leak), M-arch-3 (single
@type union), L-cross-4 (default cap config drift).

**Tasks:**
  * Add `wire_name/0` callback to `Captcha` behaviour with default
    impls per provider.
  * `Grappa.Admission.captcha_provider_wire/0` resolves configured
    impl + asks it; FallbackController consumes the verb.
  * Define `@type Grappa.Admission.error :: capacity_error() |
    Captcha.error()`; FallbackController `@spec` references it.
  * `lib/grappa/admission.ex:69` — change
    `@default_max_per_client_per_network 1` to
    `Application.compile_env!(...)` (crash-loud at compile time on
    config drift).

### B4 — NetworkCircuit + Backoff hygiene (decision C + lifecycle MEDIUMs)

**Items:** H6, H7, M-life-1/2/3/4/5, M-arch-2 part
(`JitteredCooldown` extraction), L-life-1/2/3/4, plus 2 already-filed
follow-ups (`compute_cooldown(0, _)` test + setup-block comment;
NetworkCircuit semantics DESIGN_NOTES entry).

**Tasks:**
  * H6: observation-token in `:cooldown_expire` cast.
  * H7: `handle_cast({:failure, _}, _)` state-aware branch.
  * M-life-1: try/rescue `ArgumentError` on ETS reads; safe defaults.
  * M-life-2: telemetry on `Backoff.{reset,success}` to surface
    distinct intent.
  * M-life-3: `Bootstrap.spawn_with_admission/3` shared helper;
    `spawn_one/2` + `spawn_visitor/2` collapse.
  * M-life-4: `Bootstrap` `skipped` counter for cap-rejected +
    already-started.
  * M-life-5: `Backoff.reset/2` call (or doc comment) in
    `Bootstrap.spawn_one/2`.
  * `Grappa.RateLimit.JitteredCooldown` (pure module);
    Backoff + NetworkCircuit consume it.
  * Already-filed: `compute_cooldown(0, _)` edge-case test +
    NetworkCircuit semantics DESIGN_NOTES entry.

### B5 — Schemas + indexes + validation (decision E + persistence + arch)

**Items:** H9 (composite/partial index), H10 (clear-cap path,
decision F), M-pers-1/2/3/4/5/6, L-pers-1/2/3/4, M-arch-4 (client_id
typing, decision E), M-arch-5 (capacity_input subject reshape), 3 of
6 already-filed follow-ups (partial idx, CHECK constraints,
`Network.changeset` test name).

**Tasks:**
  * Decision E: `Grappa.ClientId` Ecto type + plug regex tighten +
    schema field swap + tests.
  * Decision F: `--clear-max-sessions` + `--clear-max-per-client` mix
    flags; context fn already supports nil cast — fix
    `Network.changeset` to allow nil-cast on these fields.
  * H9: composite + partial index migration replacing the plain
    `client_id` index.
  * Already-filed: partial `client_id` index, DB CHECK constraints
    on caps + `auth_method` + `messages.kind`,
    `Network.changeset` test rename.
  * M-pers-1: changeset format validation on `client_id` (folds into
    Decision E custom type).
  * M-pers-2: `validate_subject_xor/1` error-key correctness in
    `Session` and `Message` changesets.
  * M-pers-3: `Visitor.create_changeset/1` future-`:expires_at`
    validation OR document operator paths trusted.
  * M-pers-4: document `slug` immutability in `Network` moduledoc.
  * M-pers-5: composite `(visitor_id, network_id, channel,
    server_time)` index migration.
  * M-pers-6: `find_or_create_network/1` distinguishes
    uniqueness-error from other errors.
  * L-pers-2: `subject_where/2` fall-through clause.
  * L-pers-3: `Session.touch_changeset/2`.
  * L-pers-4: drop redundant `visitor_channels.visitor_id` single-col
    index.
  * M-arch-5: drop unused `subject_kind` + `subject_id` from
    `Admission.capacity_input` (call site only consumes `client_id`,
    `network_id`, `flow`).

### B6 — Web layer + mix task + infra hygiene

**Items:** H2 (user-logout WS disconnect), H8 (mix-task friendly
errors, decision F), H11 (.env.example sync), M-web-1/2/3/4/5,
L-web-1/2/3/4, M-cross-1/2/3/4/5/6/7, L-cross-1/2/3/5, M-arch-6
(CSP-vs-captcha-provider CI test).

**Tasks:**
  * H2: `Endpoint.broadcast("user_socket:#{name}", "disconnect", %{})`
    in `AuthController.logout/2` for both subject branches; regression
    test.
  * H8 + L-cross-2: `Mix.raise/1` for missing `--network` + unknown
    slug; update tests to `assert_raise Mix.Error`.
  * H11: `.env.example` block with `GRAPPA_CAPTCHA_*` keys;
    `runtime.exs` warning extends to secret-nil case.
  * M-web-1: subject discriminator dispatch via single
    `current_subject` consumer pattern (drop the loaded-struct
    convention, OR formalize with a single helper).
  * M-web-2: `AuthController.@visitor_network_slug` switch from
    `compile_env` to runtime read OR document baked-at-compile semantics.
  * M-web-3: `captcha_token` shape validation.
  * M-web-4: `ChannelsController.merge_channel_sources/2`
    deterministic sort.
  * M-web-5: `Plugs.ClientId` moduledoc accuracy.
  * L-web-1: migrate AuthController error envelopes to FallbackController.
  * L-web-2: `format_ip/1` IPv4-mapped IPv6 normalization.
  * L-web-3: `MembersController.index/2` `with` chain cleanup.
  * L-web-4: track `Endpoint.@session_options.signing_salt` for
    Phase 5 (todo entry, not fix).
  * M-cross-1: `runtime.exs` env-var registry comment block + boot-
    time warn-on-missing.
  * M-cross-2: switch `Bypass.expect_once` → `expect` where
    call-count is implementation detail.
  * M-cross-3: parameterize duplicate captcha test files (folds into
    B2 SiteVerifyHttp consolidation).
  * M-cross-4: moduledoc test-only seam annotation OR
    compile-time-only override.
  * M-cross-5: CSP `connect-src` tightening (`'self' ws://grappa.bad.ass
    wss://grappa.bad.ass https://challenges.cloudflare.com`).
  * M-cross-6: nginx security-headers `include` snippet.
  * M-cross-7: widen Admission moduledoc `Application.put_env`
    exception OR refactor tests to function-arg config injection.
  * L-cross-1: `compose.yaml` (dev) captcha env vars (folds into
    `unified-compose` memory pin trajectory; minimum: align dev
    defaults with prod).
  * L-cross-3: add `register-dns.sh` to CLAUDE.md script roster.
  * L-cross-5: decision H reviewer-template skill upgrade lands here
    (touches `~/.claude/superpowers/...` outside repo).
  * M-arch-6 (CSP-vs-captcha-provider): CI test parsing
    `infra/nginx.conf` and asserting that for each `Captcha`
    behaviour impl module in the configured allowlist, the CSP
    `script-src` / `connect-src` / `frame-src` entries cover the
    provider's host. Mechanical static check — catches the CSP
    deploy-bug class earlier than e2e.

### B7 — IRC + DESIGN_NOTES + reviewer-template

**Items:** H12 (decision G), M-irc-1/2/3/4, L-irc-1/2.

**Tasks:**
  * Decision G: `Parser.strip_unsafe_bytes/1` rename + NUL strip;
    update `send_pong/2` docstring; property test for all three bytes;
    tests for the rename.
  * M-irc-1: `parse_prefix/1` empty-string normalization to nil.
  * M-irc-2: `IRCServer.do_wait_for_line/3` synchronous predicate-
    based wait (replace 10ms poll).
  * M-irc-3: `parse_cap_list/1` `@spec` + nil-filter; `Message.tag/2`
    + `Message.tag/3` accessors.
  * M-irc-4: `do_unescape/2` IRCv3 §3.3 comment + doctest.
  * L-irc-1: `Message.sender_nick/1` `"*"` magic-string handling.
  * L-irc-2: `IRCServer.terminate/2` socket close + `:trap_exit`.

## Test discipline

Each task pair-files implementation with a TDD failing test FIRST,
per CLAUDE.md. Sibling pattern:

  * Read failing test name in plan task.
  * Write the failing test in the right `test/` mirror path.
  * Run `scripts/test.sh path/to/test.exs` — confirm RED.
  * Implement minimum code to GREEN.
  * Run gates: format → credo → dialyzer (standalone per
    `feedback_dialyzer_plt_staleness`) → test → check.
  * Reviewer subagent per task or per sub-bucket (sibling judgment;
    decision H gate-evidence discipline applies). Gates RUN, not
    asserted from inspection. Reviewer pastes tail of each gate
    command literally.

## Out of scope

  * Phase 5 hardening (TLS, HSM-Vault, Sobelow strict, JSON logger,
    PromEx).
  * `text-polish` cluster items (deferred).
  * `unified-compose` memory pin (mentioned in L-cross-1 as
    minimum-aligned dev defaults; full collapse stays deferred).
  * cicchetto codegen (Theme 1 from prior reviews; the @type union
    in B3 sets up the codegen target but actual codegen is its own
    cluster).
  * New features.

## Process gates

  * **Worktree:** `cluster/t31-cleanup` branched from local main
    (`git checkout main` first).
  * **TDD:** failing test FIRST per task.
  * **Plan-fix-first:** when sibling discovers spec drift mid-
    execution, fix the plan (or this spec) on main FIRST in a
    docs-only commit, THEN proceed against the corrected plan. Same
    pattern as T31 P1 + P2 used.
  * **Reviewer gate evidence:** decision H is the permanent fix;
    until it lands inside this cluster, sibling reviewers paste
    gate output by-hand.
  * **Standalone dialyzer:** before any task LANDED claim, run
    `scripts/dialyzer.sh` standalone in addition to `scripts/check.sh`
    per `feedback_dialyzer_plt_staleness`.
  * **25% ctx ceiling:** orchestrator triggers proactive clear-cycle
    on sibling at ~25% ctx per `feedback_orchestrator_proactive_clear`.
  * **Push autonomous on green:** sibling reports green ship gates →
    orchestrator instructs push without halting back to vjt per
    `feedback_push_autonomy`.
  * **HALT triggers (orchestrator):** plan deviation, design Q with
    no clear principle-winner, MUST/SHOULD review finding, scope
    creep, shared-infra write outside this cluster.

## Open questions

(none — vjt approved A–H + bucket shape + scope-creep guards on
2026-05-03)

## Continuation

After this cluster LANDS:

  * CP11 S24+ entry summarizing closure.
  * Memory pin `project_t31_admission_control.md` updated to note
    cleanup landed.
  * Next cluster per arc:
    `cluster/anon-webirc-sliding-scrollback` — first verify against
    current code which parts of the original visitor-auth +r MODE
    sliding-bump goal already shipped, then plan deltas + WEBIRC
    overlay.
