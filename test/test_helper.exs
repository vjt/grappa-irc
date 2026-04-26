# SQLite has a single-writer transaction model. With `async: true` tests
# checking out concurrent Sandbox owners + write-heavy setups (Argon2
# hashing in Accounts tests, 505-row inserts in Scrollback tests), the
# default `max_cases: System.schedulers_online()` overruns the
# `busy_timeout` window with cascading "Database busy" errors. Capping
# at 2 keeps the writer-queue depth bounded while still parallelising
# the read-heavy + non-Repo tests. Bumping back up requires either
# `async: false` on the heavy tests or migrating off sqlite.
ExUnit.start(capture_log: true, max_cases: 2)
Ecto.Adapters.SQL.Sandbox.mode(Grappa.Repo, :manual)
