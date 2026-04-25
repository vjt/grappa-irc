# Todo

The pending-work backlog. Completed items are deleted (not annotated) —
done work lives in the active checkpoint, not here.

Priority tiers: **Immediate** (this session), **High** (this week),
**Medium** (this month), **Low / Observation** (parked).

---

## Immediate

- Phase 1 Task 1 done (`Grappa.Config` TOML loader, 4 tests, all gates
  green). Next: Task 2 — Ecto Repo + sqlite schema + migrations. See
  `docs/plans/2026-04-25-walking-skeleton.md`.

## High

- Phase 1 Tasks 2-10 per the walking-skeleton plan.
- Smoke-test the docker compose flow end-to-end on the Pi: `docker
  compose build && docker compose up -d && curl
  http://192.168.53.11:4000/healthz`. Will only pass after Task 4
  (Phoenix endpoint) lands.
- Update `docs/plans/2026-04-25-walking-skeleton.md` Task 1 section
  with the three deviations folded into commit b9620e8: dialyzer-driven
  error pattern fixes, recursive `traverse/2` over `reduce_while`, and
  the empty-users guard. Plan currently says reduce_while + 3-tuple
  Toml error.

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
