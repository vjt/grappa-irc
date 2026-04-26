# Todo

The pending-work backlog. Completed items are deleted (not annotated) —
done work lives in the active checkpoint, not here.

Priority tiers: **Immediate** (this session), **High** (this week),
**Medium** (this month), **Low / Observation** (parked).

---

## Immediate

**Phase 2 implementation** per `docs/plans/2026-04-25-phase2-auth.md`
— 9 of 12 sub-tasks done (2a-pre, 2a, 2b, 2c, 2d, 2e, 2h, 2f, 2g).

**Remaining:**
- **2i** (one-line UserSocket.connect/3 token verify; authz already
  wired in 2h)
- **2j** (Bootstrap reads from DB + grappa.toml + Config schema +
  compose.yaml bind-mount + README rewrite)
- **2k** (live deploy + smoke against real Azzurra PASS + Libera SASL
  + DESIGN_NOTES Phase 2 close pass + CP rotation)

**Codebase review trip:** S15 was last; CP07 closes at S28 →
threshold hit. **Recommend codebase review BEFORE 2i** to catch drift
across the 19-commit Phase 2 push before 2j's big-delete pass.

**CP rotation:** CP07 at 505 lines after S28 flush — ROTATE TO CP08
needed (CP07 → status: done; CP08 opens at next session).

Branch state: `phase2-auth` 19 ahead of unpushed local main. Merge
+ push after 2k.

## High

- Investigate flake in
  `test/grappa_web/channels/grappa_channel_test.exs:76` — `assert_receive
  %Phoenix.Socket.Message{}` intermittently times out with
  `{:event, ...}` bare tuple in the mailbox. Race between channel join
  and PubSub subscribe before broadcast lands. ~1-in-5 hit rate under
  `mix ci.check` parallelism. Likely fix: re-examine the channel's join
  handshake — does the broadcast get sent before the subscriber is
  fully attached? Hit S17. **May resolve naturally during 2h (PubSub
  topic shape change) or 2i (Channel auth) refactors** — re-evaluate
  after each.

- Phase 5 hardening: Session.Server should `terminate/2` cleanly —
  send QUIT to upstream + close socket. Currently :normal exit kills
  IRC.Client via link, which silently dies; OK for prod but emits
  ugly `tcp_closed terminating` test-stdout noise.
- Phase 5 hardening: Bootstrap warning split (originally A20). S14
  partially fixed via `Config.format_error/1` + per-tag log lines;
  remaining work is operator-facing UX polish (e.g. suggest fix on
  invalid_config errors, point at the failing field name).
  **Note:** `Grappa.Config` is DELETED in Phase 2 sub-task 2j; this
  item moves into Phase 2 Bootstrap rewrite scope (operator-facing
  warning shape on invalid DB state).
- Phase 5 hardening: TLS `verify: :verify_none` posture (`lib/grappa/irc/client.ex`)
  → CA chain verification with proper bundle. Document operator's
  TLS-trust-store config strategy. Independent of Phase 2 auth work.
- Phase 5 hardening: synchronous `IRC.Client.connect` in `init/1`
  blocks supervisor boot for the connect-timeout window. Add
  `{:continue, :connect}` (or move connect into `handle_info` after
  `init` returns) so Session start is non-blocking. Code-review
  CONSIDER #7 from S11.
- Phase 5 hardening (NEW from S20 Phase 2 plan): post-registration
  `+r` umode check on Session connect. If after `001 RPL_WELCOME`
  the client did NOT receive `+r` (or equivalent network-specific
  registered-user umode), fall back to explicit `PRIVMSG NickServ
  :IDENTIFY <pwd>` retry. Catches PASS-not-bound-to-services edge
  cases and lost-PASS races where `auth_method='auto'` chose the
  PASS path but the network silently didn't forward it.
- Phase 5 hardening (NEW from S20 Phase 2 plan): NickServ NOTICE
  reply parsing (success/failure detection per network
  Anope/Atheme/etc), nick-collision recovery (GHOST/RECOVER dance
  when our nick is already in use). Shared correlation machinery
  with NickServ REGISTER proxy below.
- Phase 5 hardening (NEW from S20 Phase 2 plan): NickServ REGISTER
  proxy as REST endpoint. Async request → wait for NickServ NOTICE
  reply → translate to HTTP response. Same correlation machinery as
  reply parsing above. Phase 2 manual workaround: operator runs
  `/msg NickServ REGISTER pass email` from any IRC client once,
  captures resulting password, drops into grappa via `mix
  grappa.bind_network`.
- Phase 5 hardening (NEW from S20 Phase 2 plan): multi-server
  failover logic. Phase 2 schema includes `network_servers` (irssi
  shape: priority + enabled), but Phase 2 logic only uses first.
  Phase 5 adds: try server 0 → on connect fail try server 1 → ...
  → exponential backoff → reset on success.
- Phase 5 hardening (NEW from S20 Phase 2 plan): HSM-keyed
  Cloak.Vault. Operator escape from "env on disk" key storage.
  Cloak.Vault supports custom key sources (yubico-hsm, TPM, AWS
  KMS, etc.) — configurable swap, no code change in Grappa.
  Document operator's hardening path in README.

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
- `Grappa.version/0` (`lib/grappa.ex:28`) has zero callers. Either
  wire it into `/healthz` JSON response (one-line change in
  `HealthController`) or drop the function. Surfaced by S19 Task 10
  code review as L4. Empty `Grappa` boundary annotation is
  independently justified.
- Sqlite "Database busy" intermittent test flake — hit once during S19
  ci.check on a re-run. 3 tests (`Repo` / `Scrollback` / `Wire`)
  simultaneously failed inserts with `Exqlite.Error: Database busy`.
  Likely contention between `async: true` Repo writes and the live Pi
  container also writing to `runtime/grappa_dev.db`. Distinct from the
  channel test flake at `grappa_channel_test.exs:76`.
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
