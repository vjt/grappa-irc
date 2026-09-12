defmodule Grappa.IRC.DCC.Offer do
  @moduledoc """
  A parsed, well-formed `DCC SEND` offer — the ONLY DCC shape this
  bouncer accepts (issue 2089).

  Every field here is peer-supplied and therefore untrusted. What the
  type buys is that each one has been *decoded into its domain* rather
  than carried around as a string: the address is an `:inet` tuple, so a
  caller cannot accidentally dial a hostname, and the port is a
  `1..65535` integer, so the passive-DCC sentinel (`0`) cannot reach a
  connect call at all — `Grappa.IRC.DCC.parse/1` refuses it before an
  `Offer` exists.

  ## `filename` is display metadata, never a path

  The on-disk name is a minted slug (the `Grappa.Avatars` precedent), so
  this field never reaches the filesystem. It is preserved VERBATIM,
  traversal shapes and all, because a parser that quietly rewrote it
  would hide from the display layer what the peer actually sent.

  ## `size` is a CLAIM, not a fact

  It is what the sender says it will send. It is load-bearing before the
  connect (the per-transfer cap is checked against it, so an oversized
  offer costs no socket) and it is NOT trusted after: the drained stream
  is truncated at this many bytes regardless, because a sender that lies
  low is a sender trying to outrun the cap.
  """

  @enforce_keys [:filename, :ip, :port, :size]
  defstruct [:filename, :ip, :port, :size]

  @type t :: %__MODULE__{
          filename: String.t(),
          ip: :inet.ip_address(),
          port: 1..65_535,
          size: non_neg_integer()
        }
end
