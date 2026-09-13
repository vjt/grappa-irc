defmodule GrappaWeb.OidcController do
  @moduledoc """
  The OIDC doors (#1911): `GET /auth/oidc/authorize` sends the browser to
  the provider, `GET /auth/oidc/callback` takes the answer back, and the
  `/me/oidc` trio manages the account link.

  ## This is a browser round trip, not a REST call

  Every sibling controller answers JSON because its caller is cic's
  `fetch`. The two `/auth/oidc` actions' caller is a NAVIGATION: the
  provider 302s the browser at us mid-flow, so a JSON error body would be
  read by a human standing in a blank tab. Every outcome there therefore
  ends in a redirect back to the SPA with a **fragment** code — `#oidc=`
  + base64url JSON — the #1404 move: a fragment is not transmitted with a
  request and never reaches `Referer`, which is what a bearer in a URL
  needs. cic's `lib/oidc.ts` owns the codec; the shapes here are its
  mirror, deliberately NOT a `GrappaWeb.*JSON` view — see "Wire" below.

  Kinds cic understands: `session` (bearer + subject — the exact
  `AuthenticatedLoginResponse` envelope), `totp` (a challenge token to
  spend at `/auth/totp/verify`), `linked`, `error`.

  ## Wire

  Nothing here is registered on the wire contract, and that is a DEBT,
  not an exemption. `mix grappa.wire_pin` digests the `GrappaWeb.*JSON`
  views; a controller that answers with inline `json/2` and a redirect is
  invisible to it, so these shapes could drift with the gate green.
  Registering them means regenerating `wireTypes.ts`/`wireSchema.ts` and
  bumping `protocol_version` (additive-included, per CLAUDE.md), which
  this slice does not do: #1911's browser flow ships together with the
  one client that speaks it, and the moment a third party can be handed
  these fragments the registration becomes load-bearing.

  The ONE wire shape this feature DID register is the throttle door:
  `:oidc_login` joined `Grappa.AdminEvents.Wire.login_throttle_door()` in
  v19, because a credential door whose window shuts silently is exactly
  the gap `GrappaWeb.LoginThrottle` exists to close — the landing
  fragments above reach only this repo's own client, while the
  `login_throttled` event reaches the operator's Events tab either way.

  ## Second factor

  A provider assertion is a CREDENTIAL door, and it inherits the house
  rule that minting a full session depends on the account's local second
  factor: the ladder is `Grappa.Accounts.Login.second_factor/1`, the same
  one `POST /auth/login` descends. An account whose only factor is a
  passkey is REFUSED — `oidc_error` `second_factor_unsupported` — never
  silently logged in. The factor is not waived because a provider already
  authenticated the human: it is the account's own configuration, and the
  provider knows nothing about it.

  ## Gate

  `/me/oidc` sits in the `:full_session` scope like every other
  credential surface — linking changes what the account IS, so a
  per-client token is refused here by the pipeline, not by this module.
  """

  @moduledoc since: "1.6.0"

  use GrappaWeb, :controller

  alias Grappa.Accounts
  alias Grappa.Auth.Oidc
  alias Grappa.Auth.Oidc.Transaction
  alias Grappa.RateLimit.FailureWindow
  alias GrappaWeb.AuthController
  alias GrappaWeb.AuthJSON
  alias GrappaWeb.LoginThrottle
  alias GrappaWeb.RemoteIP

  require Logger

  # `state` binding — the #1395 shape, one field wider: the transaction
  # id. `{ip, client_id}` ties the answer to the browser that asked for
  # it, so a `state` minted at one address cannot be spent from another;
  # the id names the single-use transaction holding the PKCE verifier.
  @state_salt "oidc-state-v1"
  # Never longer than the transaction it names: a state that outlives its
  # transaction can only refuse, so the two clocks agree on the shorter.
  @state_max_age_seconds Transaction.ttl_seconds()

  # S6's window, one door over. Same counter infrastructure
  # (`Grappa.RateLimit`), own bucket: this door's failure is not a wrong
  # password, it is a forged or replayed round trip, and coupling it to
  # the password door would let one kind of attack spend the other's
  # budget. The bucket atom IS the
  # `Grappa.AdminEvents.Wire.login_throttle_door()` value —
  # that identity is what lets the charge below go through
  # `GrappaWeb.LoginThrottle`, so a tripped window is an admin event and
  # not a silent refusal.
  @oidc_max_failures 10
  @oidc_window_ms :timer.minutes(15)

  @type oidc_error ::
          :invalid_state
          | :invalid_token
          | :invalid_code
          | :expired_token
          | :provider_unavailable
          | :not_linked
          | :unknown_account
          | :already_linked
          | :invalid_identity
          | :second_factor_unsupported
          | :too_many_attempts
          | :name_taken
          | :invalid_name

  @doc """
  `GET /auth/oidc/authorize` — start a login round trip. 302 to the
  provider, or a bare 404 when no provider is configured: the door does
  not exist on this deployment, which is also how cic's capability probe
  discovers it.
  """
  @spec authorize(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def authorize(conn, _params) do
    if Oidc.enabled?() do
      start_transaction(conn, :login, nil)
    else
      send_resp(conn, 404, "not found")
    end
  end

  @doc """
  `GET /auth/oidc/callback` — the provider's answer. Consumes the
  transaction, verifies the `id_token`, then either mints a session
  (`:login`) or writes the link (`:link`). Ends in a 302 to the SPA in
  every branch, success included.

  Gated on the door existing, like `authorize/2`: a deployment that turned
  the provider off mid-flight answers the redirect a user is still
  standing in with the same bare 404 rather than running a round trip
  against a nil config.
  """
  @spec callback(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def callback(conn, params) do
    if Oidc.enabled?() do
      do_callback(conn, params)
    else
      send_resp(conn, 404, "not found")
    end
  end

  @spec do_callback(Plug.Conn.t(), map()) :: Plug.Conn.t()
  defp do_callback(conn, %{"state" => state, "error" => error})
       when is_binary(state) and is_binary(error) do
    # The provider refused the human (access_denied) or its own request.
    # Not a failure of ours to charge anybody for — the browser is simply
    # sent home with the provider's own word for it.
    Logger.info("oidc callback: provider returned error=#{error}")
    finish(conn, %{kind: "error", code: "provider_refused"})
  end

  defp do_callback(conn, %{"state" => state, "code" => code})
       when is_binary(state) and is_binary(code) do
    ip = format_ip(conn)
    client_id = conn.assigns[:current_client_id]

    with {:ok, txn_id} <- verify_state(state, ip, client_id),
         {:ok, txn} <- consume_transaction(txn_id),
         :ok <- check_throttle(ip),
         {:ok, identity} <-
           Oidc.exchange(Oidc.config(), %{code: code, verifier: txn.verifier, nonce: txn.nonce}),
         # Inside the chain, not in the do block: a `with` runs `else` only
         # for a FAILED `<-` step, so an error tuple returned from the body
         # would walk past every arm here and out to `FallbackController`,
         # which has no clause for a domain reason. The matched `conn` is
         # the REDIRECTED one `settle` finished; the arms below keep the
         # request conn, since a refusal is rendered from there.
         %Plug.Conn{} = conn <- settle(conn, txn, identity) do
      conn
    else
      {:error, :invalid_state} ->
        # A forged, replayed, expired or foreign-bound state. The one
        # refusal here that charges the window.
        charge_failure(ip)
        log_refusal(:invalid_state)
        finish(conn, %{kind: "error", code: "invalid_state"})

      {:error, :too_many_attempts} ->
        finish(conn, %{kind: "error", code: "too_many_attempts"})

      {:error, reason} when reason in [:invalid_token, :invalid_identity] ->
        log_refusal(reason)
        finish(conn, %{kind: "error", code: "invalid_token"})

      {:error, :unknown_account} ->
        log_refusal(:unknown_account)
        finish(conn, %{kind: "error", code: "unlinked_account"})

      {:error, :not_linked} ->
        # A provider identity nobody linked and nobody may provision —
        # the normal state with the group gate unset or the human outside
        # the group. Not an attack, so no charge (see log_refusal/1).
        finish(conn, %{kind: "error", code: "not_linked"})

      {:error, :name_taken} ->
        # Provisioning found an existing account with the derived name.
        # The distinct code is the operator's instruction: link that
        # account from settings, or rename one side.
        log_refusal(:name_taken)
        finish(conn, %{kind: "error", code: "name_taken"})

      {:error, :invalid_name} ->
        # The provider's preferred_username does not fit grappa's
        # account-name format — the provider is the only source, so this
        # is a refusal, not a rewrite.
        log_refusal(:invalid_name)
        finish(conn, %{kind: "error", code: "provisioning_refused"})

      {:error, :already_linked} ->
        finish(conn, %{kind: "error", code: "already_linked"})

      {:error, :second_factor_unsupported} ->
        log_refusal(:second_factor_unsupported)
        finish(conn, %{kind: "error", code: "second_factor_unsupported"})

      {:error, :expired_token} ->
        finish(conn, %{kind: "error", code: "expired_token"})

      {:error, :invalid_code} ->
        finish(conn, %{kind: "error", code: "invalid_code"})

      {:error, :provider_unavailable} ->
        Logger.warning("oidc callback: provider unavailable")
        finish(conn, %{kind: "error", code: "provider_unavailable"})
    end
  end

  # Neither a code nor an error — a provider that answered off-contract,
  # a reload after the round trip completed, or a bot poking the path.
  # Same refusal shape, no charge: there is no round trip here to forge.
  defp do_callback(conn, params) do
    Logger.info("oidc callback: malformed callback (params: #{inspect(Map.keys(params))})")
    finish(conn, %{kind: "error", code: "invalid_state"})
  end

  ## :login

  # The intent dispatch: a finished conn on success, a domain refusal for
  # the round trip's one `else` clause otherwise.
  @spec settle(Plug.Conn.t(), Transaction.t(), map()) :: Plug.Conn.t() | {:error, oidc_error()}
  defp settle(conn, txn, identity) do
    case txn.intent do
      :login -> login(conn, identity)
      :link -> link(conn, identity, txn.user_id)
    end
  end

  @spec login(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, oidc_error()}
  defp login(conn, identity) do
    case Oidc.find_identity(identity.issuer, identity.subject) do
      {:ok, linked} ->
        case Accounts.get_user(linked.user_id) do
          %Accounts.User{} = user -> sync(conn, linked, user, identity)
          nil -> {:error, :unknown_account}
        end

      {:error, :not_found} ->
        provision(conn, identity)
    end
  end

  # A linked identity logging in again: the group gates' mirror leg. The
  # link still answers for the SAME account (Kanidm's `sub` is the UUID
  # and survives a person rename, measured #1911c), so what may need
  # writing is what the claims say TODAY: the admin flag (in sync with
  # the admins group) and the display label (the username may have
  # moved). Both are no-ops when nothing changed.
  @spec sync(Plug.Conn.t(), Oidc.Identity.t(), Accounts.User.t(), map()) ::
          Plug.Conn.t() | {:error, oidc_error()}
  defp sync(conn, linked, user, identity) do
    with {:ok, user} <- sync_admin(user, identity),
         :ok <- sync_label(linked, identity) do
      admit(conn, user)
    end
  end

  # `:admins_group` unset → the operator never asked OIDC to speak about
  # roles, and a hand-granted admin flag survives logins untouched.
  @spec sync_admin(Accounts.User.t(), map()) :: {:ok, Accounts.User.t()} | {:error, term()}
  defp sync_admin(user, identity) do
    case Oidc.config().admins_group do
      nil ->
        {:ok, user}

      group ->
        member = Oidc.group_member?(identity.groups, group)

        if user.is_admin == member,
          do: {:ok, user},
          else: sync_admin_flag(user, member, group)
    end
  end

  # The claims say "left the admins group" but the last-admin guard
  # refuses the demote — the guard exists so an operator action never
  # strands the deployment adminless, and a login has no operator
  # watching it fail. Killing the round trip here (measured: the
  # unhandled {:error, :last_admin} crashed the callback with a
  # WithClauseError, a 500 answered /auth/oidc/callback, and the human
  # could not log in at all) punishes the one person who cannot fix the
  # state. The flag is RETAINED, loudly: the operator reads the warning
  # and appoints a second admin, and the next login closes the door.
  @spec sync_admin_flag(Accounts.User.t(), boolean(), String.t()) ::
          {:ok, Accounts.User.t()} | {:error, term()}
  defp sync_admin_flag(user, member, group) do
    case Accounts.update_admin_flags(user, %{is_admin: member}) do
      {:ok, user} ->
        {:ok, user}

      {:error, :last_admin} ->
        Logger.warning(
          "oidc admin sync: #{user.name} left #{group} but is the last admin" <>
            " — is_admin retained; appoint a second admin to let the group close the door"
        )

        {:ok, user}
    end
  end

  @spec sync_label(Oidc.Identity.t(), map()) :: :ok | {:error, :invalid_identity}
  defp sync_label(linked, identity) do
    if linked.label == identity.label do
      :ok
    else
      case Oidc.update_identity_label(linked, identity.label) do
        {:ok, _} -> :ok
        {:error, :invalid_identity} -> {:error, :invalid_identity}
      end
    end
  end

  # The group-gated JIT door (#1911c). With `:users_group` unset this is
  # the #1911 refusal, verbatim. With it set, membership in the group —
  # the operator's list, granted by the IdM admin, not by the human
  # logging in — is what an unseen `sub` may be provisioned on. The
  # account is created passwordless and the link is written in the SAME
  # login, so the second login is the ordinary linked path above.
  @spec provision(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, oidc_error()}
  defp provision(conn, identity) do
    config = Oidc.config()

    cond do
      is_nil(config.users_group) ->
        {:error, :not_linked}

      not Oidc.group_member?(identity.groups, config.users_group) ->
        {:error, :not_linked}

      true ->
        case provisioning_attrs(identity, config) do
          {:ok, attrs} ->
            with {:ok, user} <- Accounts.provision_user(attrs),
                 {:ok, _linked} <-
                   Oidc.link_identity(user.id, identity.issuer, identity.subject, identity.label) do
              admit(conn, user)
            else
              {:error, :name_taken} -> {:error, :name_taken}
              {:error, :invalid_name} -> {:error, :invalid_name}
              {:error, :already_linked} -> {:error, :already_linked}
              {:error, :invalid_identity} -> {:error, :invalid_identity}
            end

          {:error, :invalid_name} ->
            {:error, :invalid_name}
        end
    end
  end

  # Name from the claim (local part of the SPN), admin from the mapped
  # group. No claim → no name → refusal: grappa does not invent names.
  @spec provisioning_attrs(map(), Oidc.Config.t()) ::
          {:ok, %{name: String.t(), is_admin: boolean()}} | {:error, :invalid_name}
  defp provisioning_attrs(identity, config) do
    case Oidc.provisioning_name(identity.username) do
      nil ->
        {:error, :invalid_name}

      name ->
        admin =
          case config.admins_group do
            nil -> false
            group -> Oidc.group_member?(identity.groups, group)
          end

        {:ok, %{name: name, is_admin: admin}}
    end
  end

  # The second-factor ladder, shared with `POST /auth/login`.
  @spec admit(Plug.Conn.t(), Accounts.User.t()) :: Plug.Conn.t() | {:error, oidc_error()}
  defp admit(conn, user) do
    case Accounts.Login.second_factor(user) do
      {:ok, user} ->
        with {:ok, session} <-
               Accounts.create_session(
                 {:user, user.id},
                 format_ip(conn),
                 user_agent(conn),
                 client_id: conn.assigns[:current_client_id]
               ) do
          # THE `AuthenticatedLoginResponse` builder, not a copy of it:
          # `GrappaWeb.AuthJSON.login/1` is what `POST /auth/login`
          # renders through, so this fragment cannot drift from that
          # envelope's shape no matter which field it grows next.
          %{token: token, subject: subject} =
            AuthJSON.login(%{token: session.id, subject: {:user, user}})

          finish(conn, %{kind: "session", token: token, subject: subject})
        end

      {:second_factor, _mode, user} ->
        handoff(conn, user)

      {:error, :passwordless} ->
        {:error, :second_factor_unsupported}
    end
  end

  # A local code is owed. `AuthController.second_factor_challenge/2` is
  # the ONE answer to "does this account have a TOTP or recovery code to
  # spend" — reused rather than copied, so a change to that question
  # cannot leave this door behind.
  @spec handoff(Plug.Conn.t(), Accounts.User.t()) :: Plug.Conn.t() | {:error, oidc_error()}
  defp handoff(conn, user) do
    case AuthController.second_factor_challenge(user, conn) do
      nil -> {:error, :second_factor_unsupported}
      challenge_token -> finish(conn, %{kind: "totp", challenge_token: challenge_token})
    end
  end

  ## :link

  @spec link(Plug.Conn.t(), map(), Ecto.UUID.t()) ::
          Plug.Conn.t() | {:error, oidc_error()}
  defp link(conn, identity, user_id) do
    case Oidc.link_identity(user_id, identity.issuer, identity.subject, identity.label) do
      {:ok, _linked} -> finish(conn, %{kind: "linked", label: identity.label})
      {:error, :already_linked} -> {:error, :already_linked}
      {:error, :invalid_identity} -> {:error, :invalid_identity}
    end
  end

  ## The `/me/oidc` JSON surfaces

  @doc "`GET /me/oidc` — this account's link at the configured provider."
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def show(conn, _params) do
    if Oidc.enabled?() do
      identities =
        conn
        |> subject_user_id()
        |> Oidc.list_identities()
        |> Enum.filter(&(&1.issuer == Oidc.config().issuer))

      case identities do
        [] ->
          json(conn, %{identity: nil})

        [identity | _] ->
          # The single configured provider makes this a one-or-none read;
          # `list_identities/1` stays a list so a second provider needs no
          # schema change.
          json(conn, %{identity: %{label: identity.label, linked_at: identity.inserted_at}})
      end
    else
      {:error, :not_found}
    end
  end

  @doc """
  `POST /me/oidc/link` — mint a `:link` round trip and hand back its URL.
  The transaction — intent AND the account it belongs to — is minted here,
  so the round trip cannot be re-pointed at another account on the way
  back. The SPA performs the navigation it is given.
  """
  @spec start_link(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :too_many_attempts | :upstream_unreachable}
  def start_link(conn, _params) do
    if Oidc.enabled?() do
      user_id = subject_user_id(conn)

      with :ok <- check_throttle(format_ip(conn)),
           %{id: txn_id, transaction: txn} <- Transaction.put(:link, user_id) do
        state_token(format_ip(conn), conn.assigns[:current_client_id], txn_id)
        |> then(fn state ->
          Oidc.authorize_url(Oidc.config(), %{
            state: state,
            nonce: txn.nonce,
            challenge: Oidc.pkce_challenge(txn.verifier)
          })
        end)
        |> case do
          {:ok, authorize_url} -> json(conn, %{authorize_url: authorize_url})
          {:error, :provider_unavailable} -> {:error, :upstream_unreachable}
        end
      end
    else
      {:error, :not_found}
    end
  end

  @doc "`DELETE /me/oidc` — remove this account's link at the configured provider."
  @spec unlink(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def unlink(conn, _params) do
    if Oidc.enabled?() do
      case Oidc.unlink_identity(subject_user_id(conn), Oidc.config().issuer) do
        :ok -> json(conn, %{identity: nil})
        {:error, :not_found} -> {:error, :not_found}
      end
    else
      {:error, :not_found}
    end
  end

  # The `:full_session` gate has already narrowed this subject to a user;
  # a visitor reaching here would be the gate failing, and the match
  # error that follows is the loud kind.
  @spec subject_user_id(Plug.Conn.t()) :: Ecto.UUID.t()
  defp subject_user_id(conn) do
    {:user, %Accounts.User{id: user_id}} = conn.assigns.current_subject
    user_id
  end

  ## Round-trip plumbing

  @spec start_transaction(Plug.Conn.t(), Transaction.intent(), Ecto.UUID.t() | nil) ::
          Plug.Conn.t()
  defp start_transaction(conn, intent, user_id) do
    ip = format_ip(conn)
    client_id = conn.assigns[:current_client_id]

    with :ok <- check_throttle(ip),
         %{id: txn_id, transaction: txn} <- Transaction.put(intent, user_id),
         {:ok, url} <-
           Oidc.authorize_url(Oidc.config(), %{
             state: state_token(ip, client_id, txn_id),
             nonce: txn.nonce,
             challenge: Oidc.pkce_challenge(txn.verifier)
           }) do
      redirect(conn, external: url)
    else
      {:error, :provider_unavailable} ->
        Logger.warning("oidc authorize: provider unavailable")
        finish(conn, %{kind: "error", code: "provider_unavailable"})

      {:error, :too_many_attempts} ->
        finish(conn, %{kind: "error", code: "too_many_attempts"})
    end
  end

  @spec state_token(String.t() | nil, String.t() | nil, String.t()) :: String.t()
  defp state_token(ip, client_id, txn_id) do
    Phoenix.Token.sign(GrappaWeb.Endpoint, @state_salt, {ip, client_id, txn_id})
  end

  # Binding check, `verify_totp_challenge/2`'s shape: the payload must be
  # ours AND this browser's.
  @spec verify_state(String.t(), String.t() | nil, String.t() | nil) ::
          {:ok, String.t()} | {:error, :invalid_state}
  defp verify_state(state, ip, client_id) do
    case Phoenix.Token.verify(GrappaWeb.Endpoint, @state_salt, state, max_age: @state_max_age_seconds) do
      {:ok, {^ip, ^client_id, txn_id}} -> {:ok, txn_id}
      {:ok, _} -> {:error, :invalid_state}
      {:error, _} -> {:error, :invalid_state}
    end
  end

  # The store's own tag is `:invalid_transaction` — a spent or expired
  # round trip. Normalized here so the callback's one refusal shape
  # (and its one charge) stays the binding check's.
  @spec consume_transaction(String.t()) :: {:ok, Transaction.t()} | {:error, :invalid_state}
  defp consume_transaction(txn_id) do
    case Transaction.take(txn_id) do
      {:ok, transaction} -> {:ok, transaction}
      {:error, :invalid_transaction} -> {:error, :invalid_state}
    end
  end

  ## Throttle — the door's own bucket

  @spec check_throttle(String.t() | nil) :: :ok | {:error, :too_many_attempts}
  defp check_throttle(ip) do
    case FailureWindow.check(:oidc_login, ip, @oidc_max_failures) do
      :ok -> :ok
      {:error, :limited} -> {:error, :too_many_attempts}
    end
  end

  # Through the shared verb, not a bare `FailureWindow.record_failure/3`:
  # `LoginThrottle.charge/4` is what turns the window-crossing charge into
  # `Wire.login_throttled` for the Events tab, and a credential door added
  # around it is a door that shuts in silence.
  @spec charge_failure(String.t() | nil) :: :ok
  defp charge_failure(ip) do
    _ = LoginThrottle.charge(:oidc_login, ip, @oidc_window_ms, @oidc_max_failures)
    :ok
  end

  # Forged or replayed round trips are worth a line each; an honest
  # user's "not linked yet" is not. The reason rides along so the log
  # names the check that refused, not just the fact of a refusal.
  @spec log_refusal(atom()) :: :ok
  defp log_refusal(reason) do
    Logger.warning("oidc callback: refused (#{inspect(reason)})")
    :ok
  end

  @doc """
  The SPA landing. ALWAYS a redirect, success included: the callback is a
  GET in a navigation, so the SPA — not this controller — renders the
  outcome. 302 rather than 303: the hop is GET → GET, so there is no
  method to restate.
  """
  @spec finish(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def finish(conn, payload) do
    encoded = payload |> Jason.encode!() |> Base.url_encode64(padding: false)
    redirect(conn, to: "/login#oidc=" <> encoded)
  end

  # Same boundary helpers as every controller that records who asked.
  @spec format_ip(Plug.Conn.t()) :: String.t() | nil
  defp format_ip(conn), do: RemoteIP.format(conn)

  @spec user_agent(Plug.Conn.t()) :: String.t() | nil
  defp user_agent(conn) do
    case get_req_header(conn, "user-agent") do
      [user_agent | _] -> user_agent
      [] -> nil
    end
  end
end
