defmodule Mix.Tasks.Grappa.GenEncryptionKey do
  @shortdoc "Prints a fresh base64-encoded 32-byte encryption key for GRAPPA_ENCRYPTION_KEY"

  @moduledoc """
  Generates a new symmetric key for `Grappa.Vault` (Cloak AES-GCM).

  ## Usage

      scripts/mix.sh grappa.gen_encryption_key

  Save the output into your `.env` as `GRAPPA_ENCRYPTION_KEY=<value>` and
  back it up separately. Losing the key means losing the ability to
  decrypt all stored upstream credentials.

  Run this **once per deployment** at first install. Rotating the key
  later requires a re-encryption migration (out of scope for Phase 2;
  Phase 5 hardening adds the rotation tooling alongside the HSM-keyed
  Vault path).

  Mix tasks are CLI entry points, not runtime callers, but Boundary
  still requires every module to declare a boundary. We mark this as
  its own top-level boundary depending on nothing — `mix run` is the
  only thing that ever calls into it.
  """

  use Boundary, top_level?: true, deps: []

  use Mix.Task

  @impl Mix.Task
  def run(_) do
    32
    |> :crypto.strong_rand_bytes()
    |> Base.encode64()
    |> IO.puts()
  end
end
