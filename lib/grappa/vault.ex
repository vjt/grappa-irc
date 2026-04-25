defmodule Grappa.Vault do
  @moduledoc """
  Cloak vault holding the symmetric key(s) used for at-rest column
  encryption.

  Started BEFORE `Grappa.Repo` in the supervision tree so any schema
  loaded by Ecto can resolve the `Grappa.EncryptedBinary` type at boot
  (Cloak's Ecto types reach into the Vault GenServer at dump/load time;
  if the Vault isn't running, schema loads crash with `:noproc`).

  ## Key sourcing

  - **prod**  — `GRAPPA_ENCRYPTION_KEY` env var (base64-encoded 32 bytes),
    read in `config/runtime.exs` and raised on if absent.
  - **dev/test** — hard-coded base64 key checked into `config/dev.exs` /
    `config/test.exs`. The key is non-secret (anyone with the repo has it)
    and the dev/test sqlite files are not shipped.

  ## Operator workflow

  Generate a fresh key with `scripts/mix.sh grappa.gen_encryption_key`,
  copy into `.env` as `GRAPPA_ENCRYPTION_KEY=...`, restart. Back up the
  key separately — losing it means losing all stored upstream credentials
  (Phase 5 hardening adds an HSM-keyed Vault path; the Cloak abstraction
  here is the seam).

  ## Crypto layering

  This is encryption-AT-REST only. End-to-end privacy (operator-can't-read)
  is OTR-in-cicchetto, not a server-side concern. See CLAUDE.md auto-memory
  `project_crypto_layering.md`.
  """

  use Boundary, top_level?: true, deps: []

  use Cloak.Vault, otp_app: :grappa
end
