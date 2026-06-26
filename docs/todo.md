# Todo — RETIRED

**The backlog lives in GitHub issues now.** This file is a pointer only.
Do not add work items here — open a `gh` issue instead.

```sh
gh issue list                      # everything open
gh issue list --label phase-5      # Phase 5 hardening cluster (#88–#101)
gh issue list --label tech-debt    # consolidated code-quality backlog
gh issue list --label cicchetto    # PWA client
gh issue list --label bug          # bugs
```

## Where the old todo went (migrated 2026-06-26)

- **Phase 5 hardening** → one issue per line, `phase-5` label (#88–#101).
  HSM-keyed Vault was dropped (we're never doing it).
- **Medium engineering** → Phase 6 IRCv3 listener #102, supply-chain
  digest pinning #103, visitor nick-collision pre-check #104,
  unbind-last-user #105. (Already filed: visitor_network env #42,
  hot-deployable migrations #41, deploy decision-lib #51.)
- **Post-bastille roadmap epics** → Voice TTS/STT #106, UI-polish cluster
  #107, PUBLIC OPEN #108. Wishlist (addressed-msgs-on-return) #109.
  Memory pointer: `project_post_rev_roadmap.md`.
- **Open cic bugs surfaced during cleanup** → `$list` pane doesn't close
  after directory join #110; on-device dogfood verification backlog #111.
- **REV carry-forwards + Low/Observation nits** → one consolidated
  `tech-debt` issue #112 (still-relevant items only; dead nits dropped).
- **Operator follow-ups** (fail2ban exemption rechecks, captcha-on-prod
  discrepancy, sqlite "Database busy" test flake) → moved to
  `docs/OPERATIONS.md` § Pending operator follow-ups.

Current-session state + the active pointer live in the latest
`docs/checkpoints/`. Run `/start` for the dashboard.
