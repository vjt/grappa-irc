# Todo

The pending-work backlog. Completed items are deleted (not annotated) —
done work lives in the active checkpoint, not here.

Priority tiers: **Immediate** (this session), **High** (this week),
**Medium** (this month), **Low / Observation** (parked).

---

## Immediate

- Codebase review DUE (S11→S12 transition + walking-skeleton end +
  prod live = natural milestone). Recommended for next session with
  fresh context. Reviews live in `docs/reviews/codebase/`.
- Fix `scripts/_lib.sh` compose project-name conflict: when prod
  container is up, dev oneshots collide on the vlan IP
  (`Address already in use`). Either set distinct compose project
  names or detect+skip in `in_container_or_oneshot`. Workaround
  during prod-up: stop prod container before running gates.
- Prune merged worktree `phase1-task8-session` (`git worktree
  remove ~/code/IRC/grappa-task8 && git branch -D
  phase1-task8-session`). Already merged to main as `75e29b9`.

## High

- Phase 1 Tasks 9–10 per the walking-skeleton plan (Task 8 fully
  done — code + deploy + live in #grappa on azzurra; Tasks 9 = REST
  writes mapped to `IRC.Client` outbound, Task 10 = Boundary
  annotations + `mix boundary.spec` in CI).
- Phase 5 hardening: Session.Server should `terminate/2` cleanly —
  send QUIT to upstream + close socket. Currently :normal exit kills
  IRC.Client via link, which silently dies; OK for prod but emits
  ugly `tcp_closed terminating` test-stdout noise.
- Phase 5 hardening: Bootstrap warning conflates three causes
  (missing file / malformed TOML / missing field) into the same
  "no config — running web-only" message. Operator log triage
  benefits from cause split. Code-review CONSIDER #6 from S11.
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
