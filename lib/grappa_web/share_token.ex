defmodule GrappaWeb.ShareToken do
  @moduledoc """
  The visitor share-link token itself: salt, TTL, signing, verification.

  ## Why this is a module and not two copies

  TWO doors mint this token — `POST /me/share-token`
  (`GrappaWeb.ShareTokenController`, the visitor's own device-to-device
  share) and `POST /admin/visitors/:id/share-token`
  (`GrappaWeb.Admin.VisitorsController`, #982's recovery door for a
  visitor who lost access and, having no password, cannot mint their
  own). ONE door redeems it: `POST /auth/share/consume`.

  A second `Phoenix.Token.sign/3` call site carrying its own copy of the
  salt and the TTL would be two secrets that agree only by inspection —
  and the failure is silent in the worst direction: the mint keeps
  returning 200 with a token the consume endpoint rejects, so the
  operator hands out a dead link and the locked-out visitor stays
  locked out. Signing and verification live together here so a change
  to either constant moves both doors at once.

  ## Why `Phoenix.Token` and not the DB

  Unchanged from the original design: the threat model is benign, the
  TTL is short (10 min), and the one-shot ledger
  (`Grappa.Visitors.ShareTokens`) is ETS, so losing it on a BEAM
  restart opens at most a TTL-bounded reuse window for tokens already
  signed. Zero migrations, HOT-deploy friendly.

  #982 does NOT widen either constant. Ten minutes and single use are
  what keep a leaked link from being a standing key, and the admin door
  hands the link to a third party over some channel the server cannot
  see — the exact case the short TTL is for.
  """

  @salt "visitor-share-v1"
  @max_age_seconds 600

  @doc """
  The `Phoenix.Token` salt. Public so tests assert against the real
  value rather than re-declaring it.
  """
  @spec salt() :: String.t()
  def salt, do: @salt

  @doc """
  Token lifetime in seconds — the same number the mint reports as
  `expires_at` and the consume enforces as `max_age`.
  """
  @spec max_age_seconds() :: unquote(@max_age_seconds)
  def max_age_seconds, do: @max_age_seconds

  @doc """
  Sign a token for `visitor_id`. Returns `{token, expires_at}`, where
  `expires_at` is the absolute UTC instant at which `verify/1` starts
  refusing it — cic renders the countdown from it.

  Cannot fail: `Phoenix.Token.sign/3` is pure over the endpoint's
  secret. Both doors therefore have nothing to roll back at this step.
  """
  @spec mint(Ecto.UUID.t()) :: {String.t(), DateTime.t()}
  def mint(visitor_id) when is_binary(visitor_id) do
    token = Phoenix.Token.sign(GrappaWeb.Endpoint, @salt, visitor_id)
    {token, DateTime.add(DateTime.utc_now(), @max_age_seconds, :second)}
  end

  @doc """
  Verify a token and recover the visitor id it was signed for.

  The two failure atoms are already wire-shaped for
  `GrappaWeb.FallbackController`: `:share_token_expired` → 410 Gone (the
  link was real and ran out), `:unauthorized` → 401 (the signature does
  not hold). Keeping them distinct is what lets cic tell "ask for a new
  link" apart from "this link is not ours".
  """
  @spec verify(String.t()) ::
          {:ok, Ecto.UUID.t()} | {:error, :unauthorized | :share_token_expired}
  def verify(token) when is_binary(token) do
    case Phoenix.Token.verify(GrappaWeb.Endpoint, @salt, token, max_age: @max_age_seconds) do
      {:ok, visitor_id} when is_binary(visitor_id) -> {:ok, visitor_id}
      {:error, :expired} -> {:error, :share_token_expired}
      {:error, _} -> {:error, :unauthorized}
    end
  end
end
