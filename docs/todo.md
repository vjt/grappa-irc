# Todo

The pending-work backlog. Completed items are deleted (not annotated) —
done work lives in the active checkpoint, not here.

Priority tiers: **Immediate** (this session), **High** (this week),
**Medium** (this month), **Low / Observation** (parked).

---

## Immediate

- Phase 1 Task 8 IN PROGRESS on worktree `phase1-task8-session`
  (`~/code/IRC/grappa-task8`). Fresh plan at
  `~/.claude/plans/toasty-twirling-creek.md` (supersedes
  `docs/plans/2026-04-25-walking-skeleton.md` lines 1829-2470 which
  had 14 deviations from current conventions + missing schema
  forward-compat for non-PRIVMSG IRC events).
  - Sub-task 8a-pre ✅ — schema extension (10-kind enum, nullable
    body, typed `meta` Ecto.Type via allowlist), wire shape moved to
    domain (`Grappa.Scrollback.Message.to_wire/1`), 2 prep fixes
    (sqlite `busy_timeout` flake, worktree mount `:ro` → RW for
    Elixir compiler touch). 63 tests green, all gates clean. 4
    commits on worktree branch.
  - Sub-task 8a NEXT — IRC parser (`Grappa.IRC.Parser` +
    `Grappa.IRC.Message`, RFC2812 + IRCv3 message-tags + UTF-8/latin1
    boundary + StreamData property tests).
  - Sub-tasks 8b/8c/8d/8e + code review + docs after.

## High

- Phase 1 Tasks 8-10 per the walking-skeleton plan.
- Live `/healthz` round-trip on the Pi via `scripts/deploy.sh` →
  `scripts/healthcheck.sh` — deferred to Task 8 when Bootstrap wires
  `grappa.toml` into the supervision tree. Until then deploy preflight
  refuses to run without `grappa.toml`, and copying the example would
  satisfy a gate without exercising anything.
- Phase 5 hardening: lift `signing_salt` (currently `"rotate-me"` in
  `lib/grappa_web/endpoint.ex`) to `runtime.exs` so it reads from an
  env var like `SECRET_KEY_BASE` already does. Same for the
  `verify: :verify_none` TLS posture noted in CLAUDE.md.

## Medium

- Set up GitHub repo `vjt/grappa-irc` with CI secrets (codecov token if
  desired, no other secrets required for Phase 1).
- Decide PWA framework (Svelte vs SolidJS vs lit-html) — Phase 3 prep.
  Bundle-size budget ≤200 KB gzip before optional Vosk/piper.
- Open a tracking issue or doc for Phase 6 IRCv3 listener — collect
  IRCv3 specs we'll need (`CAP LS 302`, `CHATHISTORY`, `server-time`,
  `batch`, `labeled-response`, SASL mechanisms). Reuse parser from
  Phase 1.

## Low / Observation

- Investigate `mix release` size on Debian-slim runtime image. If it's
  obnoxiously big, evaluate Alpine + musl rebuild of `ecto_sqlite3`
  NIFs.
- Consider Boundary `mix boundary.spec` integration in CI to enforce
  inter-context call rules from Phase 1 Task 10.
- Telemetry → Prometheus exporter (PromEx). Phase 5 hardening.
- Reconnect/backoff policy when upstream IRC drops. Phase 5.
- Scrollback eviction policy — by row count, by age, or both. Phase 5.

---

## Notes

- Phase 0 (spec) is complete. README + DESIGN_NOTES + walking-skeleton
  plan all in main.
- Phase 1 tasks all have TDD steps with failing-test-first discipline
  in `docs/plans/2026-04-25-walking-skeleton.md`.
- The Italian Hackers' Embassy / Azzurra context is the longer story.
  See `docs/project-story.md` for the narrative thread that survives
  individual sessions.
