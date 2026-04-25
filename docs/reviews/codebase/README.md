# Codebase reviews

Periodic deep reviews of the codebase: architecture trajectory, code
quality, technical debt, areas where a refactor would compound, areas
where the spec drifted from the implementation.

**Cadence:** every 12 sessions OR every 2 weeks, whichever comes first.
Enforced as a gate by the `/start` skill — features cannot land
when a review is overdue. Bug fixes and deploy fixes are exempt.

**Format:** `YYYY-MM-DD-cb-review.md` files in this directory. Each
review covers:

1. **Architecture trajectory** — is the implementation diverging from the
   spec? Are new patterns emerging that should be codified, or rejected?
2. **Code quality** — module-by-module health (size, complexity,
   coupling). Where is the codebase heaviest?
3. **Test quality** — are the tests asserting outcomes or call sequences?
   Coverage trends.
4. **Tooling signal** — Dialyzer / Credo / Sobelow drift. New checks to
   enable or disable.
5. **Documentation drift** — CLAUDE.md / DESIGN_NOTES / plans up to date?
6. **Recommendations** — concrete actions, prioritized.

Reviews are conducted by spawning a `superpowers:code-reviewer` agent
against the current main branch. The agent's report becomes the review
file (after light editing for accuracy).

The first review is due no earlier than 2026-05-09 (2 weeks from Phase 0
landing) or after Session 12, whichever comes first.
