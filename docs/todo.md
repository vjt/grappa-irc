# Todo

The pending-work backlog. Completed items are deleted (not annotated) —
done work lives in the active checkpoint, not here.

Priority tiers: **Immediate** (this session), **High** (this week),
**Medium** (this month), **Low / Observation** (parked).

---

## Immediate

- Phase 1 Task 8 — code merged to main at `75e29b9`; sub-task 8e
  (operator smoke + Pi deploy) pending. Plan at
  `~/.claude/plans/toasty-twirling-creek.md`.
  - Sub-tasks 8a-pre / 8a / 8b / 8c / 8d ✅ — all merged.
  - Code review round-trip ✅ — subagent pass: 0 BLOCKING / 4
    SHOULD-FIX (all addressed) / 3 CONSIDER (deferred) / 4 NIT.
  - Sub-task 8e — `scripts/deploy.sh` → `scripts/healthcheck.sh` on
    the Pi. Operator-driven; awaiting confirmation. Unblocks the
    long-deferred live `/healthz` round-trip. Needs `grappa.toml` at
    repo root (gitignored — copy `.example` and customize).
  - Stats: 121 tests + 5 properties green, all gates clean.
  - Worktree `phase1-task8-session` can be pruned after deploy
    confirms.

## High

- Phase 1 Tasks 9–10 per the walking-skeleton plan (Task 8 done
  except deploy; Tasks 9 = REST writes mapped to `IRC.Client` outbound,
  Task 10 = Boundary annotations + `mix boundary.spec` in CI).
- Phase 5 hardening: lift `signing_salt` (currently `"rotate-me"` in
  `lib/grappa_web/endpoint.ex`) to `runtime.exs` so it reads from an
  env var like `SECRET_KEY_BASE` already does. Same for the
  `verify: :verify_none` TLS posture noted in CLAUDE.md.
- Phase 5 hardening: synchronous `IRC.Client.connect` in `init/1`
  blocks supervisor boot for the connect-timeout window. Add
  `{:continue, :connect}` (or move connect into `handle_info` after
  `init` returns) so Session start is non-blocking. Code-review
  CONSIDER #7 from S11.

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
