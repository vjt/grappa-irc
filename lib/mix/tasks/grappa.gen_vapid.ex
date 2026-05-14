defmodule Mix.Tasks.Grappa.GenVapid do
  @shortdoc "Prints a fresh VAPID keypair (RFC 8292) for Web Push signing"

  @moduledoc """
  Generates a fresh ECDSA P-256 keypair for VAPID-signed Web Push
  delivery (RFC 8292).

  ## Usage

      scripts/mix.sh grappa.gen_vapid

  Output:

      VAPID_PUBLIC_KEY=BJk...
      VAPID_PRIVATE_KEY=z3p...
      # Optional, defaults to "mailto:admin@example.org":
      VAPID_SUBJECT=mailto:you@example.org

  Copy the three lines into the `grappa` service's `environment:` block
  in `compose.override.yaml` (template: `compose.override.yaml.example`).
  Bootstrap reads them at boot via `config/runtime.exs`; missing keys
  raise loudly rather than silently dropping push delivery.

  Run **once per deployment** at first install. Rotating the keypair
  later invalidates every existing `push_subscriptions` row (browsers
  reject pushes signed by an unknown application server key) — operators
  should expect users to re-toggle the master switch in cic settings
  after a rotation, which re-runs `pushManager.subscribe` with the new
  public key.

  ## Why a separate task from `grappa.gen_encryption_key`

  The Cloak encryption key (`GRAPPA_ENCRYPTION_KEY`) protects credentials
  at rest; losing it loses every encrypted column. The VAPID keypair
  signs Web Push payloads; losing it just forces resubscription. Distinct
  rotation lifecycles → distinct generators → operator can run either
  without conflating the two ceremonies.

  ## Boundary

  Mix tasks are CLI entry points; `mix run` is the only caller. Empty
  `deps:` keeps the generator hermetic — it depends only on the BEAM
  crypto + base modules, no project context.

  Mirrors `Mix.Tasks.Grappa.GenEncryptionKey`'s shape (B2 introduces no
  new operator-task convention; the existing one is fine).

  Push notifications cluster B2 (2026-05-14).
  """

  use Boundary, top_level?: true, deps: []

  use Mix.Task

  @impl Mix.Task
  def run(_) do
    {public_key, private_key} = :crypto.generate_key(:ecdh, :prime256v1)

    IO.puts("VAPID_PUBLIC_KEY=#{Base.url_encode64(public_key, padding: false)}")
    IO.puts("VAPID_PRIVATE_KEY=#{Base.url_encode64(private_key, padding: false)}")
    IO.puts("# Optional — defaults to mailto:admin@example.org if unset.")
    IO.puts("# VAPID_SUBJECT=mailto:you@example.org")
  end
end
