# Todo

The pending-work backlog. Completed items are deleted (not annotated) —
done work lives in the active checkpoint, not here.

Priority tiers: **Immediate** (this session), **High** (this week),
**Medium** (this month), **Low / Observation** (parked).

---

## Immediate

(none — compose oneshot fix landed S17 via `compose.oneshot.yaml`
override.)

## High

- Investigate flake in
  `test/grappa_web/channels/grappa_channel_test.exs:76` — `assert_receive
  %Phoenix.Socket.Message{}` intermittently times out with
  `{:event, ...}` bare tuple in the mailbox. Race between channel join
  and PubSub subscribe before broadcast lands. ~1-in-5 hit rate under
  `mix ci.check` parallelism. Likely fix: re-examine the channel's join
  handshake — does the broadcast get sent before the subscriber is
  fully attached? Hit S17.

- Phase 1 Task 10 — `use Boundary` annotations on top-level contexts
  + `mix boundary.spec` in CI (covers architecture review A11). Last
  Phase 1 walking-skeleton task before Phase 2 auth opens. (Task 9
  outbound landed S18.)
- Phase 5 hardening: Session.Server should `terminate/2` cleanly —
  send QUIT to upstream + close socket. Currently :normal exit kills
  IRC.Client via link, which silently dies; OK for prod but emits
  ugly `tcp_closed terminating` test-stdout noise.
- Phase 5 hardening: Bootstrap warning split (originally A20). S14
  partially fixed via `Config.format_error/1` + per-tag log lines;
  remaining work is operator-facing UX polish (e.g. suggest fix on
  invalid_config errors, point at the failing field name).
- Phase 5 hardening: lift `signing_salt` (currently `"rotate-me"` in
  `lib/grappa_web/endpoint.ex`) to `runtime.exs` so it reads from an
  env var like `SECRET_KEY_BASE` already does. Same for the
  `verify: :verify_none` TLS posture noted in CLAUDE.md.
  (Architecture review A21 — must precede Phase 2 auth landing.)
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
