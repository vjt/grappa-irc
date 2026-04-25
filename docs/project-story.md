# grappa — project story

The narrative history of the codebase. One episode per significant
session: what happened, what went wrong, what right call we made and
why. The story is written in the human voice, not the AI's.

If a session has no obvious drama, find the small thing — the
assumption that turned out wrong, the pattern we settled on, the
moment the plan met reality. Routine sessions still get an episode,
because the project's institutional memory is built from them.

Format per episode:
- **`## Sn — {date} — {one-line title}`** (n = sequential session number)
- 2-5 paragraphs of prose
- (optional) **Law:** a one-line generalization that goes into
  `docs/claude-lessons.md` if applicable

---

## S1 — 2026-04-24/25 — picking the language for real

The first session. The README was already written; the spec was
already there. The walking-skeleton plan was drafted in Rust because
Rust felt like the obvious systems language for someone with a
suxserv/Bahamut background and a preference for static binaries.

Then we actually pressure-tested it.

The conversation went through three rounds of "wait, what about" — first
Elixir/OTP because the architecture (one supervised process per user,
fault-isolated, always-on) is BEAM's textbook example; then back to
Rust because the `irc` crate exists and Claude generates Rust ~15-20%
better on first pass; then back to Elixir for keeps once we asked the
right question: which factors actually matter for this project.

The decisive ones: **Phoenix Channels has no Rust equivalent** — not
"a worse one," none — and the client-experience cost of building it from
scratch (~1500 LOC server + ~800 LOC TS client + months of mobile-network
polish) was real. **Phase 6 IRCv3 listener** is materially easier in
Elixir because binary pattern matching is what Erlang was built for at
Ericsson. **BEAM's 35-year backwards-compat track record** is the only
real evidence base for "live on for 20 years."

What got rejected and recorded: hot code reload was specifically NOT
the deciding factor — reconnect-on-deploy is acceptable, and trying to
preserve TLS+IRC connection state across upgrades is research-project
territory in Rust. We picked Elixir on architecture, Channels, Phase 6,
and longevity, with the LLM-codegen quality gap explicitly acknowledged
and mitigated by rigid CI tooling (Dialyzer + Credo strict + Sobelow +
mix_audit + doctor + Boundary, every gate mandatory).

Two commits before the pivot: one snapshotting the Rust-era artifacts
as the historical record, one flipping the entire spec to Elixir
cleanly without superseded-annotations cohabiting confusingly. Then
Docker + scripts + mix scaffold + CLAUDE.md.

**Law:** when a language choice question reopens, ask which goals
actually weigh. The first answer is usually the loudest, not the truest.
Pressure-test against the spec's named priorities before committing.

---
