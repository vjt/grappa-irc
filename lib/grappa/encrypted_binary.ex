defmodule Grappa.EncryptedBinary do
  @moduledoc """
  Ecto type for binary columns encrypted at rest via `Grappa.Vault`.

  Use as `field :password_encrypted, Grappa.EncryptedBinary` in a
  schema. Values are encrypted on dump and decrypted on load with the
  Cloak cipher configured for `Grappa.Vault`. Storage column type is
  `:binary` (sqlite `BLOB`).
  """

  use Boundary, top_level?: true, deps: [Grappa.Vault]

  use Cloak.Ecto.Binary, vault: Grappa.Vault
end
