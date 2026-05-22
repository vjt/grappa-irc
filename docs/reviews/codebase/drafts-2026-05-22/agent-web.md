# Web scope — 10 findings (0 CRIT, 1 HIGH, 5 MED, 4 LOW)

Scope: `lib/grappa_web/`. Reviewed router, endpoint, pipelines, plugs,
admin pipeline, all controllers + JSON views, channels, FallbackController,
BodyLimit, Validation, RemoteIP, Subject. Cross-checked nginx admin
allowlist parity (M-9b) — clean, all 9 resources mirrored in
`infra/nginx.conf` + `cicchetto/e2e/nginx-test.conf`. PubSub topic shapes
all flow through `Grappa.PubSub.Topic` — no legacy `grappa:network:*`
drift. Wire-shape discipline is universally honored — every controller
either returns through `Wire.*` modules or has no struct exposure.
Generally the surface is in good shape; findings cluster around boundary
violations, one with-clause hole, a controller silent-swallow, and a few
ergonomic / DRY items.

---

### S1. `dispatch_subject_verb/3` else-clauses miss `{:error, :invalid_line}` — `WithClauseError` → 500

**File:** `lib/grappa_web/channels/grappa_channel.ex:1251-1266`
**Category:** missing error mapping / no-silent-drops
**Severity:** HIGH

`dispatch_subject_verb/3` powers the read-only verbs `whois`, `whowas`,
`who`, `names`, `banlist`, `lusers`. The `thunk.(subject)` call ultimately
hits e.g. `Grappa.Session.send_whois/3`, whose `@spec` is
`:ok | {:error, :no_session | :invalid_line}`. The `else` clauses
(lines 1259-1265) handle `:invalid_channel`, `:invalid_nick`,
`:invalid_mask`, `:invalid_line` (from the validator), and `:no_session`
— but NOT `{:error, :invalid_line}` returned by the Session facade after
the validator has passed. If `Session.send_whois/3` (or any other subject
facade) ever surfaces `:invalid_line` (e.g. an inner `IRC.Client` guard
tightens beyond `validate_args` / `Identifier.valid_nick?`), the `with`
collapses to `WithClauseError` → channel pid crash → cic socket re-join +
state thrash. Compare to `dispatch_ops_verb/3` (lines 1145-1153) which
DOES list `:invalid_line` in its else. The pattern is genuinely a hole —
the validator and the upstream guard are not identical (the validator
accepts ASCII-safe nicks; `IRC.Client.send_whois/2` could grow extra
strictness), and the moduledoc says "defense in depth" exactly for this
class of drift.
**Fix:** Add `{:error, :invalid_line} -> {:reply, {:error, %{reason: "invalid_line"}}, socket}` to the `dispatch_subject_verb/3` else block, mirroring `dispatch_ops_verb/3`. Same defensive belt-and-braces rationale already documented at line 1244.

---

### S2. `ChannelsController.remove_from_autojoin/3` silent-swallow violates M-9b lesson

**File:** `lib/grappa_web/controllers/channels_controller.ex:211-230`
**Category:** silent-swallow at boundary (M-9b class)
**Severity:** MEDIUM

`DELETE /networks/:network_id/channels/:channel_id` runs `Session.send_part`
then attempts `Credentials.remove_autojoin_channel/3`. On
`{:error, reason}` the helper logs at warning and returns `:ok` so the
controller still responds 202. The CLAUDE.md M-9b "no silent-swallow at
boundaries" rule (and `feedback_no_silent_drops_closed` memory)
specifically calls out this shape: a controller helper that wraps an
ok-or-error orchestrator and throws the error away while returning ok.
Today this is a tombstone (a PART succeeded but autojoin sticks) — next
reconnect re-joins a channel the user explicitly left. The comment claims
"best-effort: the next reconnect's autojoin would re-join the channel,
but that's an edge case" — which is precisely the buggy-behavior-by-design
pattern the rule was written to ban.
**Fix:** Propagate the error: return `{:error, changeset}` or `{:error, :credential_missing}` from `remove_from_autojoin/3` and thread through the `with` chain so FallbackController surfaces a 422/404. The PART has fired; that side-effect can't be undone, but the wire response should be honest about the partial failure so cic / operator can retry or re-issue.

---

### S3. `PushVapidController.show/2` runtime `Application.fetch_env!/2` violates CLAUDE.md boot-time-only rule

**File:** `lib/grappa_web/controllers/push_vapid_controller.ex:57`
**Category:** runtime env read
**Severity:** MEDIUM

CLAUDE.md "Application.{put,get}_env/2: boot-time only, runtime banned —
neither read nor written from any controller / GenServer callback / plug
body." This controller's `show/2` action calls
`Application.fetch_env!(:web_push_elixir, :vapid_public_key)` on every
request. The moduledoc documents the third-party library coupling
rationale but the rule itself is unconditional. The `Grappa.Admission.Config`
boot-time `:persistent_term` snapshot is the canonical alternative (also
called out in `FallbackController.captcha_site_key/0`).
**Fix:** Snapshot the key at boot via a `Grappa.Push.Config` (or
`Grappa.Vapid`) GenServer / `persistent_term` lift, mirroring
`Grappa.Admission.Config`. The controller reads the snapshot; key
rotation continues to require a cold restart (the W3C spec already
requires browser re-subscription on rotation, so cold is the operational
ground truth anyway).

---

### S4. `subject_label` string construction duplicated across 3 controllers — no shared helper

**File:** `lib/grappa_web/controllers/archive_controller.ex:189`, `lib/grappa_web/controllers/channels_controller.ex:252`, `lib/grappa_web/controllers/read_cursor_controller.ex:94`
**Category:** DRY violation
**Severity:** MEDIUM

Three controllers each construct the visitor-branch user-topic label as
`"visitor:" <> visitor.id` inline, then pass through
`Topic.user/1`. `UserSocket.id_for_subject/1` + `GrappaWeb.Subject`
already centralize subject-shape conversions; the `subject_label` rule
(documented in `Grappa.Visitors.SessionPlan.build/1` per Q1=a) belongs
in one helper too. The user-branch (`user.name`) is also duplicated.
CLAUDE.md "Implement once, reuse everywhere" — and the comments at all
three sites explicitly say "mirrors `ReadCursorController.maybe_broadcast`'s
subject-label derivation" / "Mirror of `ArchiveController.broadcast_archive_changed/2`'s
subject-label derivation," confirming three sites cribbing from each
other rather than sharing one source.
**Fix:** Add `GrappaWeb.Subject.user_topic_label/1` (or
`Grappa.PubSub.Topic.user_for_subject/1`) that takes the rich-struct
subject and returns the label string. The three callsites collapse to
`Topic.user(Subject.user_topic_label(subject))`. Bonus: makes a future
subject-kind rename auditable in one place.

---

### S5. `ArchiveController.delete/2` strict-match swallows context errors as 500

**File:** `lib/grappa_web/controllers/archive_controller.ex:110-114`
**Category:** error-swallow via MatchError
**Severity:** MEDIUM

`{:ok, _} = case Scrollback.target_kind(target) do :channel -> Scrollback.delete_for_channel(...); :query -> Scrollback.delete_for_dm(...) end` strict-binds on `{:ok, _}`. If either `Scrollback.delete_for_channel/3` or `Scrollback.delete_for_dm/3` ever returns `{:error, _}` (DB error, schema constraint, sandbox timeout), the controller raises `MatchError` → Phoenix 500 with no
typed envelope. The pattern bypasses FallbackController entirely. The
sibling `with :ok <- validate_target_name(target)` properly uses
`with` for the validator; the same `with` should extend through the
delete to keep the failure-typed contract end-to-end.
**Fix:** Replace `{:ok, _} = case ...` with `with` arm:
`with :ok <- validate_target_name(target), {:ok, _} <- delete_for_target_kind(session_subject, network.id, target)` where `delete_for_target_kind/3` is the extracted sigil-dispatch. Any context-side
error then flows through FallbackController as either `validation_failed`
(changeset) or an unmapped tag that surfaces FunctionClauseError (the
loud-fail-on-unknown-tag contract of FallbackController moduledoc).

---

### S6. `UploadsController.disposition_header/1` uses `URI.encode_www_form/1` — RFC 5987 wants percent-encoded spaces

**File:** `lib/grappa_web/controllers/uploads_controller.ex:185`
**Category:** wire-shape bug
**Severity:** MEDIUM

`URI.encode_www_form/1` follows form-URL-encoding rules: space → `+`,
plus-sign → `%2B`. RFC 5987 `ext-value` (used inside
`filename*=UTF-8''...`) requires percent-encoded UTF-8 per RFC 3986
`pct-encoded` — space MUST be `%20`, not `+`. Browsers that strictly
follow the spec will receive `Filename%20With%20Space.png` when correct
or display `Filename+With+Space.png` (literal `+`) when given the form-
encoded shape from this controller. Some browsers leniently translate
`+` → space, some do not.
**Fix:** Use `URI.encode/2` with the unreserved-char predicate, or
hand-roll `for <<b <- filename>>, do: pct_encode_byte(b)`. Mirror the
canonical RFC-5987 encoder used by e.g. `Plug.Conn.put_resp_header`
helpers in upstream libs.

---

### S7. `me_controller.show/2` defensive fall-through clause contradicts `:authn` invariant

**File:** `lib/grappa_web/controllers/me_controller.ex:73-74`
**Category:** defensive code (CLAUDE.md "Let it crash")
**Severity:** LOW

`case conn.assigns[:current_subject] do ... _ -> {:error, :unauthorized} end` — the moduledoc labels this "W8 defensive fall-through guards against
a regressed pipeline." Per CLAUDE.md "Let it crash is the rule for
unexpected errors" + "Defensive programming hides bugs" + "FunctionClauseError on shape drift IS the intended fail-loud signal"
(see `Admin.SessionsController.actor_user_id/1`'s comment for the
correct posture). The defensive 401-on-pipeline-regression silently
hides the regression instead of crashing loudly. If `:authn` ever stops
running upstream of this controller, the correct surface is a 500
crash that pages the operator, not a misleading 401 telling the client
to re-login.
**Fix:** Drop the fall-through clause. Two `case` arms (`{:user, _}`, `{:visitor, _}`) only. A missing assign crashes with FunctionClauseError → 500.
Same edit applies to `AuthController.logout/2` (line 168) — it reads
`conn.assigns[:current_subject]` with bracket access (silently absorbs
nil) and `maybe_*(_)` no-op clauses (line 185, 194). Drop the third
clauses; switch to dot-access.

---

### S8. `MessagesController.index/2` resolves `own_nick` via `Session.current_nick` then silently uses `nil` on `:no_session`

**File:** `lib/grappa_web/controllers/messages_controller.ex:100-104`
**Category:** silent fallback masking degraded state
**Severity:** LOW

`case Session.current_nick(subject, network.id) do {:ok, nick} -> nick; {:error, :no_session} -> nil end`. The downstream
`Scrollback.fetch*` calls accept `nil` and presumably skip the own-nick
mention-marking path. In production this means: when a session is
parked/failed, the read-scrollback endpoint silently returns rows
without own-mention markers. cic has no signal that the marker pass was
skipped — degraded UX masquerading as "no mentions this page." This is
a softer cousin of the M-9b silent-swallow class — the cosmetic data
goes missing without a wire signal.
**Fix:** Either (a) accept the degraded view but emit a response header
`X-Grappa-Session-Live: false` so cic can render a "your session is
parked" banner above the scrollback, or (b) tag the failure path with
a distinct typed error and let FallbackController return 503 so cic
shows the parked-network ribbon already wired for T32. Option (a) is
the lighter touch and aligns with the U-0 "DB state and live state are
separate sources of truth — surface both" rule from CLAUDE.md.

---

### S9. `dispatch_ops_verb/3` and `dispatch_subject_verb/3` else-cascades duplicate 5-7 atom→string mappings

**File:** `lib/grappa_web/channels/grappa_channel.ex:1145-1153, 1259-1265, 1194-1201, 1219-1224`
**Category:** DRY / consistency
**Severity:** LOW

Four `else` blocks (`dispatch_ops_verb`, `dispatch_subject_verb`,
`topic_set_dispatch`, `away_set_dispatch`) each spell out the same
atom-to-string mapping by hand
(`{:error, :invalid_channel} -> {:reply, {:error, %{reason: "invalid_channel"}}, socket}`).
Adding a new atom tag means touching 1-4 sites and remembering to map
it consistently. Pattern is parallel to FallbackController's atom-to-
JSON envelope, but without the single-source guarantee.
**Fix:** Extract `defp reply_error(tag, socket)` that does
`{:reply, {:error, %{reason: Atom.to_string(tag)}}, socket}` plus a
single allowlist of permitted reason atoms. Each `else` arm becomes
`tag when tag in @reasons -> reply_error(tag, socket)`. Future tag
adds become a one-line allowlist edit.

---

### S10. `AdminChannel.handle_in/3` catch-all silently `:ok`s every unknown event

**File:** `lib/grappa_web/channels/admin_channel.ex:71-72`
**Category:** silent acceptance at boundary
**Severity:** LOW

`def handle_in(_, _, socket), do: {:reply, :ok, socket}` — every unknown
client-sent event is replied `:ok` without any logging. The moduledoc
explicitly says "Admin events are server-originated only" but the
catch-all gives a misleading positive ack instead of a typed rejection.
Mirrors the `feedback_no_silent_drops_closed` lesson: silent acceptance
absorbs the next class of bug — a future client author who introduces
a real client→admin verb and gets back `:ok` will believe their feature
works.
**Fix:** Log at `:warning` with the event name + admin actor (already
on socket assigns), and reply `{:error, %{reason: "unknown_event"}}`.
The intent (don't crash the pid on hostile input) is preserved; the
silent positive ack is replaced with a typed rejection that operators
can grep.

---

## Notes (not findings)

- Topic shapes ALL go through `Grappa.PubSub.Topic` — no legacy
  `grappa:network:*` drift detected. Sub-task 2h user-rooting is
  uniformly honored.
- All controllers wire `action_fallback GrappaWeb.FallbackController`
  via `use GrappaWeb, :controller`. No explicit `case` on `{:error, _}`
  in any action (closest is the `with` chains, which delegate properly).
- No `Repo.insert/2` from controllers. Every persist path goes through
  context functions with changesets.
- No `String.to_atom/1` over user input; the three admin controllers
  use `String.to_existing_atom/1` over a hardcoded `@allowed` list —
  safe.
- nginx admin allowlist (`infra/nginx.conf:136` + `cicchetto/e2e/nginx-test.conf:86,153`) covers all 9 admin resources for both :80 and :443.
  No M-9b regressions.
- `signing_salt` rotation deferred to Phase 5 per the explicit
  out-of-scope note — Endpoint moduledoc already calls it out + the
  `runtime.exs` raise gates prod.
- `GrappaChannel.safe_get_user/1` uses `try/rescue Ecto.NoResultsError`
  — flagged as a possible defensive pattern but it IS a real recovery
  case (user row CASCADE-deleted under the live socket). The cleaner
  fix would be a non-bang `Accounts.get_user_by_name/1` returning
  `{:ok, _} | :error`; that's a context-layer change outside this scope.
- `UploadsController` `@sobelow_skip` annotations are well-documented;
  the slug-regex provenance and tmp-file provenance arguments are
  sound.
- `BodyLimit` use is consistent across MessagesController, ChannelsController,
  AuthController.captcha_token, and GrappaChannel via `with_body_check/3`.
  No untyped body endpoints found.
