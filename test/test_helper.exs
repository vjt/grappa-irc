# Concurrency is controlled by `config :ex_unit, max_cases: 1` in
# `config/test.exs` (CP25 shared-singleton fix). DO NOT add `max_cases:`
# here — `ExUnit.start/1` opts override `config :ex_unit` silently.
#
# 2026-05-13: discovered that the CP25 fix shipped INERT for ~12 hours
# because this line carried `max_cases: 2` which silently overrode the
# config value of 1. ALL ci.yml runs since 25761866724 (the lone
# accidental green) had been red on the bootstrap_test:413 shared-
# singleton class. Per memory `feedback_exunit_start_overrides_config`.
#
# Original sqlite-busy rationale (preserved for context): with
# `async: true` tests checking out concurrent Sandbox owners +
# write-heavy setups (Argon2 hashing in Accounts tests, 505-row inserts
# in Scrollback tests), the default `max_cases: System.schedulers_online()`
# overruns the `busy_timeout` window with cascading "Database busy"
# errors. The `max_cases: 1` config solves both the singleton class AND
# the sqlite-busy class with one knob.
ExUnit.start(capture_log: true)
Ecto.Adapters.SQL.Sandbox.mode(Grappa.Repo, :manual)
Mox.defmock(Grappa.Admission.CaptchaMock, for: Grappa.Admission.Captcha)
