# Todo

The pending-work backlog. Completed items are deleted (not annotated) —
done work lives in the active checkpoint, not here.

Priority tiers: **Immediate** (this session), **High** (this week),
**Medium** (this month), **Low / Observation** (parked).

---

## Immediate

- Phase 1 Task 5 done (`GET /messages` paginated DESC; 28 tests green;
  ci.check ~17s on the Pi). Next: Task 6 — `POST
  /networks/:net/channels/:chan/messages` per
  `docs/plans/2026-04-25-walking-skeleton.md` line 1572. First write
  resource; introduces `Phoenix.PubSub.broadcast/3`.

## High

- Phase 1 Tasks 6-10 per the walking-skeleton plan.
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
