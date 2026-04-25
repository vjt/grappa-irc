# Todo

The pending-work backlog. Completed items are deleted (not annotated) —
done work lives in the active checkpoint, not here.

Priority tiers: **Immediate** (this session), **High** (this week),
**Medium** (this month), **Low / Observation** (parked).

---

## Immediate

- **CI fix**: `mix docs` step in `.github/workflows/ci.yml:81` runs in
  `MIX_ENV=test` (job-level env line 23) but `ex_doc` is `only: [:dev]`
  in mix.exs:101. Step will fail on first push. Pick one: (a) move
  `mix docs` into the `dialyzer` job (already MIX_ENV=dev), or (b) add
  `:test` to ex_doc's `only:`. Option (a) keeps test deps minimal.
- Phase 1 Task 3 done (Grappa.Scrollback context — insert/1, fetch/4,
  max_page_size/0; 19 tests green; 13s ci.check on the Pi). Next:
  Task 4 — Phoenix Endpoint + /healthz per
  `docs/plans/2026-04-25-walking-skeleton.md`.

## High

- Phase 1 Tasks 4-10 per the walking-skeleton plan.
- Once Task 4 (Phoenix endpoint + /healthz) lands: end-to-end smoke
  via `scripts/deploy.sh` → `scripts/healthcheck.sh`. Until then,
  deploy step in the dev cycle is N/A — Task 3 landed a context but
  still no exposed surface, so deploy is still skipped.

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
