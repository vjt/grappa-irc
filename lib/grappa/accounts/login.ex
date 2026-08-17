defmodule Grappa.Accounts.Login do
  @moduledoc """
  The password door's decision for an account: does this credential open,
  and which second-factor door (if any) is still in the way.

  ## Why this exists (#1395)

  The user ladder used to be a `defp` chain inside
  `GrappaWeb.AuthController`, reachable only from an HTTP action and
  untestable without a `Plug.Conn` — all 64 tests over it needed one. The
  decision itself needs neither: it is a name, a password and the account's
  own second-factor configuration. So the decision moved and everything
  request-shaped stayed at the edge.

  ## What deliberately did NOT move

  This is a decision, not an orchestrator, and the boundary is drawn where
  the twin `Grappa.Visitors.Login` already draws it:

    * **The throttles.** `Grappa.Visitors.Login` contains no rate limiting at
      all — the visitor door's window lives in the controller, above the call
      into the context, and `GrappaWeb.LoginThrottle` argues the placement in
      its own moduledoc: a window keyed on the source IP is request-edge
      policy. `Grappa.Accounts` depends on neither `Grappa.RateLimit` nor
      `Grappa.AdminEvents`, exactly as `Grappa.Visitors` does not, and
      widening it to hold one would be the trade that module rejects. The
      caller charges; see the `:passwordless` note below for what makes that
      possible.

    * **The second-factor challenge.** Minting it needs
      `Phoenix.Token.sign/3` against `GrappaWeb.Endpoint`, and the passkey
      options need `GrappaWeb.PasskeyOrigin`. `GrappaWeb` already depends on
      `Grappa.Accounts`, so reaching back would close a cycle that `Boundary`
      rejects outright. This function names the door; the caller opens it.

    * **The client-token door.** `Accounts.authenticate_client_token/5` is
      already a context function and already returns a tagged outcome. It
      mints a session row, so it is an effect rather than a decision, and it
      is tried ahead of this function by the caller exactly as before.

    * **Rendering, and the 22 `visitor_error_response/4` clauses**, which
      belong to the visitor half of that controller and are untouched.

  ## The `:passwordless` outcome is not a spelling of `:invalid_credentials`

  Both reach the client as the same uniform 401 — the caller maps them — but
  they must stay distinct here because only one of them is a guess. A wrong
  password charges the login window; an account in `:passwordless` passkey
  mode presented the RIGHT password and is refused because this door is shut
  for it, so charging it would spend a user's own window on a configuration
  choice. Collapsing the two tags would silently change the throttle.
  """

  alias Grappa.Accounts
  alias Grappa.Accounts.{TOTP, User}

  @type input :: %{required(:name) => String.t(), required(:password) => String.t()}

  @typedoc """
  `{:ok, user}` — verified, nothing further to prove.
  `{:second_factor, which, user}` — verified, one door left.
  `{:error, :invalid_credentials}` — the credential did not verify.
  `{:error, :passwordless}` — it did, but this door is shut for the account.
  """
  @type outcome ::
          {:ok, User.t()}
          | {:second_factor, :passkey | :totp, User.t()}
          | {:error, :invalid_credentials | :passwordless}

  @doc """
  Verifies `name` + `password` and returns the door the account still has to
  walk through.

  The name is matched the account way — `Accounts.get_user_by_credentials/2`,
  which folds it (#1353) — and a miss is indistinguishable from a wrong
  password, both on the wire and in timing.
  """
  @spec authenticate(input()) :: outcome()
  def authenticate(%{name: name, password: password})
      when is_binary(name) and is_binary(password) do
    case Accounts.get_user_by_credentials(name, password) do
      {:ok, %User{} = user} -> second_factor(user)
      {:error, :invalid_credentials} = error -> error
    end
  end

  # `passkey_mode` is a closed three-value enum, so all three are spelled out:
  # a fourth value added later must fail here loudly rather than inherit the
  # no-second-factor exit from a catch-all.
  @spec second_factor(User.t()) :: outcome()
  defp second_factor(%User{passkey_mode: :passwordless}), do: {:error, :passwordless}

  defp second_factor(%User{passkey_mode: :second_factor} = user),
    do: {:second_factor, :passkey, user}

  defp second_factor(%User{passkey_mode: :disabled} = user) do
    if TOTP.enabled?(user), do: {:second_factor, :totp, user}, else: {:ok, user}
  end
end
