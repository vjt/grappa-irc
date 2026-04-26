# Todo

The pending-work backlog. Completed items are deleted (not annotated) —
done work lives in the active checkpoint, not here.

Priority tiers: **Immediate** (this session), **High** (this week),
**Medium** (this month), **Low / Observation** (parked).

---

## Immediate

**Phase 2 COMPLETE.** Live in prod (`192.168.53.11:4000`), bouncer
connected to Azzurra as `grappa`, joined `#grappa`, NickServ
IDENTIFY accepted. All 12 plan sub-tasks done; 35 commits pushed
to `origin/main` from `phase2-auth`. Active checkpoint rotated
CP07 → CP08.

**Phase 3 walking skeleton (cicchetto PWA) — sub-tasks 1-7 LANDED on
`phase3-cicchetto-walking-skeleton`:**
- [x] REST gaps: `GET /networks` + `GET /networks/:nid/channels` (523dc20)
- [x] cicchetto/ scaffold + day-1 PWA shell (1333e66) — SolidJS + TS +
      Vite + Bun + Biome stack picked, see DESIGN_NOTES 2026-04-26
- [x] Login + token store + protected route (ac92bcc)
- [x] Channel list + Phoenix Channels client (69eea69)
- [x] Scrollback fetch on select + compose + send (ccdc367)
- [x] compose + nginx + DNS plumbing (29ec512) —
      `compose.prod.yaml` restructured: grappa drops `vlan53` →
      `grappa_internal` Docker bridge; nginx joins `vlan53` `.53.11` +
      bridge with `infra/nginx.conf` (SPA `try_files` + reverse-proxy
      `/auth /me /networks /healthz /socket` to `grappa:4000` with WS
      upgrade headers + HTTP/1.1); `cicchetto-build` oneshot
      `oven/bun:1` produces `dist/` into named volume `cicchetto_dist`;
      `scripts/deploy.sh` extended (`--no-deps` refresh of dist +
      healthcheck via nginx :80/healthz); `scripts/healthcheck.sh`
      switches port on `GRAPPA_PROD`; `scripts/register-dns.sh` new
      (idempotent Technitium API call reading `/srv/dns/.env`, NOT
      auto-run from `deploy.sh`).
- [x] Docs (this commit): DESIGN_NOTES SolidJS-stack entry +
      README cicchetto-stack note + Phase 3 roadmap tick.

**Phase 3 sub-task 8 (deploy + iPhone round-trip) — PENDING:**
- [ ] `scripts/check.sh` + cicchetto `bun run check` (post-doc gates).
- [ ] superpowers:code-reviewer agent on full `phase3-cicchetto-walking-skeleton`
      branch (not just last commit); fix any findings.
- [ ] Rebase onto main from worktree → ff-merge to main.
- [ ] `scripts/deploy.sh` from `/srv/grappa` (refuses non-main; builds
      grappa prod image + runs `cicchetto-build` oneshot + brings up
      `grappa+nginx --no-deps` + runs migrations + waits `/healthz`
      via nginx).
- [ ] `scripts/register-dns.sh` (operator-run; reads `/srv/dns/.env`
      `TECHNITIUM_API_TOKEN`; idempotent; default registers
      `grappa.bad.ass A 192.168.53.11 TTL 300`).
- [ ] Verify nginx + DNS:
      `dig @ns1.bad.ass grappa.bad.ass A` → `192.168.53.11`;
      `curl -fsS http://192.168.53.11/healthz` → 200;
      `curl -fsS http://grappa.bad.ass/healthz` → 200 (LAN-side).
- [ ] iPhone PWA install round-trip: open `http://grappa.bad.ass` on
      iPhone Safari (same LAN OR home VPN — vlan53 is not WAN); Share
      → "Add to Home Screen"; launch installed PWA; log in; see
      `#grappa` in channel list; live PRIVMSG arrives in scrollback
      when sent from another connected IRC client (azzurra); send a
      PRIVMSG from PWA, round-trip visible in the other client.
- [ ] `git push origin main` + worktree cleanup
      (`git worktree remove ~/code/IRC/grappa-phase3-cicchetto` +
      `git branch -d phase3-cicchetto-walking-skeleton`).
- [ ] CP09 S3 entry: Phase 3 wrap (all 7 commits, gates, deploy
      timestamp, iPhone round-trip evidence, what works + what's
      deferred to Phase 4).

**Worktree cleanup:** `phase2-auth` worktree at
`/home/vjt/code/IRC/grappa-phase2` is dead weight post-merge;
remove via `git worktree remove ~/code/IRC/grappa-phase2`.

**Post-Phase-2 hygiene cluster (carried from S29 + 2j review):**
- M3 nick-regex consolidation (3 implementations drifting)
- M5 error-string-casing inconsistency
- H11 central User wire shape (MeJSON vs AuthJSON)
- M2 web→Repo dep cleanup (preload via context)
- M12 `Application.put_env` 6× duplication across mix tasks +
  Bootstrap (extract `Grappa.MixTaskBoot` helper)
Combined ~half-session. Land before Phase 3 OR ride naturally as
Phase 3 surfaces invocation.

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
