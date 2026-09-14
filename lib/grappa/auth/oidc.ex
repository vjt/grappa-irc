defmodule Grappa.Auth.Oidc do
  @moduledoc """
  OIDC login (authorization code + PKCE) against a single, operator-
  configured provider — #1911. The context owns the provider conversation:
  discovery, the authorization URL, the token exchange, `id_token`
  verification, and the `(issuer, subject) → user` link table.

  ## The flow

    1. `GrappaWeb.OidcController.authorize/2` mints a
       `Grappa.Auth.Oidc.Transaction` (verifier + nonce + intent) and
       redirects the browser to `authorize_url/2`'s target with a signed
       `state` naming the transaction.
    2. The provider authenticates the human and returns a `code`.
    3. `GrappaWeb.OidcController.callback/2` consumes the transaction,
       calls `exchange/2`, and gets back an identity that has survived
       every check in `Grappa.Auth.Oidc.IdToken`.
    4. `:login` resolves the identity through `find_identity/2` and the
       controller mints an ordinary bearer session;
       `:link` writes the row through `link_identity/4`.

  ## Provisioning: group-gated, off by default (#1911c)

  An unseen `sub` is refused `not_linked` unless the operator armed the
  gate: `GRAPPA_OIDC_USERS_GROUP` names the ONE provider group whose
  members may log in, and a member's first login provisions a
  passwordless account (the provider's `sub` is then its only
  credential — the password door refuses it, see
  `Grappa.Accounts.verify_password/2`). This narrows #1911's
  "no auto-provisioning, ever" without reversing its reason: a provider
  answering "this is whoever" still cannot conjure an account, because
  the GROUP LIST is the operator's, not the user's — being vouched for
  is being in `grappa_users`, which only the IdM admin grants. With the
  var unset the door behaves exactly as #1911 shipped it.

  `GRAPPA_OIDC_ADMINS_GROUP` is the sibling gate for roles: when set,
  every successful login syncs `is_admin` to membership, so
  `grappa_admins` is the admin list and demotion is "remove from the
  group, next login demotes". The two are independent — admins mapping
  alone works for hand-linked accounts, provisioning alone creates
  non-admin users.

  ## What is deliberately NOT here

    * No user-info fetch. The `sub` is the identity; `email` and
      `preferred_username` are display strings at best (see
      `Grappa.Auth.Oidc.Identity`).
    * No token storage. The access token in the exchange response is
      opaque to grappa and never persisted: grappa is not a resource
      server, and a stored provider token would be a second secret to
      leak and rotate for nothing it buys.
    * No logout propagation (no RP-initiated logout / front-channel
      back-channel). Local logout stays `DELETE /auth/logout`, which
      revokes the bearer — the provider session is the provider's
      business, and silently ending it on grappa logout is surprising
      behaviour on a shared machine, not a feature.
  """

  @moduledoc since: "1.6.0"

  use Boundary,
    top_level?: true,
    deps: [Grappa.Repo],
    # `Identity` — the link schema the web layer renders. `Transaction` —
    # the round-trip store the controller mints and consumes (a supervised
    # child, so `lib/grappa/application.ex` names it too). `Config`,
    # `Discovery`, `IdToken` and `Jwks` stay INTERNAL: the config carries
    # the operator's `client_secret`, and the web layer is handed it
    # opaque through `config/0` rather than being able to open it.
    exports: [Identity, Transaction]

  import Ecto.Query, only: [from: 2]

  alias Grappa.Auth.Oidc.{Config, Discovery, IdToken, Identity}
  alias Grappa.Repo

  require Logger

  @http_timeout_ms 5_000

  # `lib/grappa/application.ex` `start/2`, the CLAUDE.md-designated boot
  # seam site. Reached through the context rather than `Config` directly
  # so the config module — which carries the operator's `client_secret`
  # in its structs — stays behind the boundary even for this one call.
  @doc false
  @spec boot() :: :ok
  def boot, do: Config.boot()

  @doc "Is the OIDC door configured? `false` → every route answers 404."
  @spec enabled?() :: boolean()
  def enabled?, do: not is_nil(Config.config())

  @doc """
  The provider config, or `nil` when disabled. Handed back to this
  module opaque: callers pass it to `authorize_url/2` / `exchange/2` and
  never open it — `client_secret` stays inside the boundary, which is
  the whole reason the accessor is here rather than on the schema.
  """
  @spec config() :: Config.t() | nil
  def config, do: Config.config()

  @doc """
  The authorization URL to send the browser to.

  `@spec authorize_url(Config.t(), %{state: String.t(), nonce: String.t(),
     challenge: String.t()}) :: {:ok, String.t()} | {:error, :provider_unavailable}`
  """
  @spec authorize_url(Config.t(), %{state: String.t(), nonce: String.t(), challenge: String.t()}) ::
          {:ok, String.t()} | {:error, :provider_unavailable}
  def authorize_url(config, %{state: state, nonce: nonce, challenge: challenge}) do
    with {:ok, discovery} <- Discovery.fetch(config) do
      # Every parameter string-typed and URI-encoded in one place. `scope`
      # is already space-separated, which is the form the spec asks for and
      # what `URI.encode_query` percent-escapes correctly.
      query =
        URI.encode_query(%{
          "response_type" => "code",
          "client_id" => config.client_id,
          "redirect_uri" => config.redirect_uri,
          "scope" => config.scopes,
          "state" => state,
          "nonce" => nonce,
          "code_challenge" => challenge,
          "code_challenge_method" => "S256"
        })

      {:ok, discovery.authorization_endpoint <> "?" <> query}
    end
  end

  @doc "PKCE S256 challenge: BASE64URL(SHA256(verifier)), no padding (RFC 7636 §4.2)."
  @spec pkce_challenge(String.t()) :: String.t()
  def pkce_challenge(verifier) when is_binary(verifier) do
    :sha256 |> :crypto.hash(verifier) |> Base.url_encode64(padding: false)
  end

  @doc """
  Redeems the authorization `code` for a verified identity.

  `@spec exchange(Config.t(), %{code: String.t(), verifier: String.t(),
     nonce: String.t()}) ::
    {:ok, %{issuer: String.t(), subject: String.t(), label: String.t() | nil,
           username: String.t() | nil, groups: [String.t()]}} |
    {:error, :provider_unavailable | :invalid_code | :invalid_token | :expired_token}`

  `username` is the raw `preferred_username` claim (nil when absent) and
  `groups` the `groups` claim's binaries ([] when absent): both are
  provider-supplied TEXT, consumed only by the group gates and the
  provisioning-name derivation, never as identity.
  """
  @spec exchange(Config.t(), %{code: String.t(), verifier: String.t(), nonce: String.t()}) ::
          {:ok, %{issuer: String.t(), subject: String.t(), label: String.t() | nil, username: String.t() | nil, groups: [String.t()]}}
          | {:error, :provider_unavailable | :invalid_code | :invalid_token | :expired_token}
  def exchange(config, %{code: code, verifier: verifier, nonce: nonce})
      when is_binary(code) and is_binary(verifier) and is_binary(nonce) do
    with {:ok, discovery} <- Discovery.fetch(config),
         {:ok, id_token} <- request_id_token(config, discovery, code, verifier) do
      case IdToken.verify(id_token, config, discovery, nonce, now()) do
        {:ok, verified} ->
          {:ok,
           %{
             issuer: discovery.issuer,
             subject: verified.subject,
             label: display_label(verified.claims),
             username: first_string(verified.claims, ["preferred_username"]),
             groups: claim_groups(verified.claims)
           }}

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  @doc """
  The `groups` claim's binaries, `[]` when the claim is absent or not a
  list. A provider that granted no `groups` scope is therefore read as
  "member of nothing" — the gates refuse, which is the honest reading of
  a provider that did not speak.
  """
  @spec claim_groups(%{optional(String.t()) => term()}) :: [String.t()]
  def claim_groups(claims) do
    case Map.fetch(claims, "groups") do
      {:ok, list} when is_list(list) -> Enum.filter(list, &is_binary/1)
      _ -> []
    end
  end

  @doc """
  Is `group` among the claim `groups`? Matches the bare name AND the
  `name@realm` (SPN) spelling, because Kanidm emits every group TWICE —
  once as a UUID and once as `grappa_users@localhost` (measured, 1.11.1,
  #1911c) — while other providers emit bare names. A UUID contains no
  `@`, so its local part is itself and cannot false-match a group name.
  """
  @spec group_member?([String.t()], String.t()) :: boolean()
  def group_member?(groups, group) when is_list(groups) and is_binary(group) do
    Enum.any?(groups, fn entry -> entry == group or local_part(entry) == group end)
  end

  @doc """
  The account-name candidate for a provisioned account: the
  `preferred_username`'s LOCAL part. Kanidm's claim is the SPN
  (`testuser@localhost`) and the realm half is not grappa's to store; a
  provider with a bare name is unaffected — the split is a no-op. `nil`
  when there is no claim: provisioning refuses rather than invent a
  name. Whether the candidate is STOREABLE is `User.provisioned_changeset/2`'s
  to say — the format rule lives with the schema, once.
  """
  @spec provisioning_name(String.t() | nil) :: String.t() | nil
  def provisioning_name(nil), do: nil

  def provisioning_name(username) when is_binary(username),
    do: local_part(username)

  @spec local_part(String.t()) :: String.t()
  defp local_part(value), do: value |> String.split("@", parts: 2) |> hd()

  @doc """
  `display_label/1` — the human-readable handle for the settings page.
  Display only; it is never read back by a decision.
  """
  @spec display_label(%{optional(String.t()) => term()}) :: String.t() | nil
  def display_label(claims) do
    first_string(claims, ["preferred_username", "email", "name"])
  end

  @spec first_string(%{optional(String.t()) => term()}, [String.t()]) :: String.t() | nil
  defp first_string(claims, [key | rest]) do
    case Map.fetch(claims, key) do
      {:ok, value} when is_binary(value) and value != "" -> value
      _ -> first_string(claims, rest)
    end
  end

  defp first_string(_, []), do: nil

  # `retry: false` is deliberate and worth the line: the body carries a
  # single-use authorization `code`, so a transparent replay after a
  # timeout is guaranteed to burn the code and hand the user a failure
  # the retry then makes permanent. A token endpoint that cannot answer
  # inside the window is the same `:provider_unavailable` either way.
  @spec request_id_token(Config.t(), Discovery.t(), String.t(), String.t()) ::
          {:ok, String.t()} | {:error, :provider_unavailable | :invalid_code}
  defp request_id_token(config, discovery, code, verifier) do
    case Req.post(discovery.token_endpoint,
           # RFC 6749 §2.3.1 — HTTP Basic with the client credentials. Req's
           # `{:basic, userinfo}` takes ONE binary (`user:pass`), not a
           # two-tuple: the tuple form is a FunctionClauseError inside
           # `Req.Steps.auth/2` that surfaces to the user as
           # `:provider_unavailable`, which is why it is worth naming here.
           auth: {:basic, config.client_id <> ":" <> config.client_secret},
           form: %{
             "grant_type" => "authorization_code",
             "code" => code,
             "redirect_uri" => config.redirect_uri,
             "code_verifier" => verifier
           },
           receive_timeout: @http_timeout_ms,
           retry: false
         ) do
      {:ok, %Req.Response{status: 200, body: %{"id_token" => id_token}}}
      when is_binary(id_token) and id_token != "" ->
        {:ok, id_token}

      # RFC 6749 §5.2 — the provider refused THIS code (spent, expired,
      # redirect mismatch, verifier mismatch). A provider problem is
      # `:provider_unavailable`; a spent code is not.
      {:ok, %Req.Response{status: status, body: %{"error" => error}}}
      when status in [400, 401] and is_binary(error) ->
        {:error, :invalid_code}

      _ ->
        log_token_failure(:unexpected_response)
        {:error, :provider_unavailable}
    end
  rescue
    # A malformed endpoint URL, a refused connection, a timeout. Named in
    # the log: an operator diagnosing "provider unavailable" needs to know
    # WHICH, and a silent rescue here is the CLAUDE.md silent-swallow.
    exception ->
      Logger.warning("oidc token endpoint: #{Exception.format(:error, exception)}")
      {:error, :provider_unavailable}
  end

  # The catch-all above is the one arm that has nothing of its own to say;
  # it still says what it observed rather than nothing.
  @spec log_token_failure(term()) :: :ok
  defp log_token_failure(reason) do
    Logger.warning("oidc token endpoint: unexpected response (#{inspect(reason)})")
    :ok
  end

  defp now, do: System.system_time(:second)

  ## Identity link table

  @doc "The account linked to `(issuer, subject)`, if any."
  @spec find_identity(String.t(), String.t()) :: {:ok, Identity.t()} | {:error, :not_found}
  def find_identity(issuer, subject) when is_binary(issuer) and is_binary(subject) do
    case Repo.one(from(i in Identity, where: i.issuer == ^issuer and i.subject == ^subject, limit: 1)) do
      nil -> {:error, :not_found}
      identity -> {:ok, identity}
    end
  end

  @doc """
  Links `user_id` to `(issuer, subject)`. `{:error, :already_linked}`
  when the remote identity is held by another account — one remote
  identity may answer for one local account, and a second claimant is a
  collision to refuse, not to re-point.
  """
  @spec link_identity(Ecto.UUID.t(), String.t(), String.t(), String.t() | nil) ::
          {:ok, Identity.t()} | {:error, :already_linked | :invalid_identity}
  def link_identity(user_id, issuer, subject, label)
      when is_binary(user_id) and is_binary(issuer) and is_binary(subject) do
    %Identity{}
    |> Identity.changeset(%{user_id: user_id, issuer: issuer, subject: subject, label: label})
    |> Repo.insert()
    |> case do
      {:ok, identity} ->
        {:ok, identity}

      # The one failure a second claimant produces, and the one a link
      # collision is: `already_linked`, not a generic refusal.
      {:error, %Ecto.Changeset{errors: errors}} ->
        # Matched on the constraint KIND, not its index name: the changeset
        # carries exactly one unique constraint, so `:unique` is unambiguous
        # without a second copy of the index name to keep in step.
        if unique_violation?(errors) do
          {:error, :already_linked}
        else
          # Every input here is server-derived from a verified `id_token`,
          # so a validation failure is a bug in this module, not user input
          # to bounce back — refused, and named as such at the caller.
          {:error, :invalid_identity}
        end
    end
  end

  # A changeset error entry is `{:field, {message, opts}}` — the message
  # and its options are a TUPLE, and `opts` carries `constraint_name:`
  # after the kind, so the kind is read with `Keyword.get` rather than
  # matched: a keyword-list PATTERN is positional and a one-entry one
  # (`[constraint: :unique]`) refuses the two-entry list Ecto actually
  # produces, which drops the refusal into the catch-all below.
  @spec unique_violation?([tuple()]) :: boolean()
  defp unique_violation?(errors) do
    Enum.any?(errors, fn
      {_field, {_message, opts}} when is_list(opts) -> Keyword.get(opts, :constraint) == :unique
      _ -> false
    end)
  end

  @doc """
  Refreshes a link's display `label` — the #1911c rename story. Kanidm's
  `sub` is the person's UUID and survives
  `kanidm person update --newname`, while `preferred_username` moves with
  the rename (measured, 1.11.1): the link keeps answering for the same
  account, and this keeps what the settings page SHOWS truthful. Called
  with the label already computed, and only when it moved — the caller's
  no-change check keeps this off the happy path.
  """
  @spec update_identity_label(Identity.t(), String.t() | nil) ::
          {:ok, Identity.t()} | {:error, :invalid_identity}
  def update_identity_label(%Identity{} = identity, label) when is_binary(label) or is_nil(label) do
    identity
    |> Identity.changeset(%{label: label})
    |> Repo.update()
    |> case do
      {:ok, identity} -> {:ok, identity}
      # Same narrow refusal as `link_identity/4`: the input is
      # server-derived, so a validation failure here is a bug in this
      # module, not input to bounce.
      {:error, %Ecto.Changeset{}} -> {:error, :invalid_identity}
    end
  end

  @doc """
  Removes this account's link at `issuer`. `{:error, :not_found}` when
  there was nothing to remove (idempotent-refused, not idempotent-ok: the
  settings page is telling the user something they should know).
  """
  @spec unlink_identity(Ecto.UUID.t(), String.t()) :: :ok | {:error, :not_found}
  def unlink_identity(user_id, issuer) when is_binary(user_id) and is_binary(issuer) do
    case Repo.delete_all(from(i in Identity, where: i.user_id == ^user_id and i.issuer == ^issuer)) do
      {0, _} -> {:error, :not_found}
      {_, _} -> :ok
    end
  end

  @doc "This account's links, oldest first — the settings-page read."
  @spec list_identities(Ecto.UUID.t()) :: [Identity.t()]
  def list_identities(user_id) when is_binary(user_id) do
    Repo.all(from(i in Identity, where: i.user_id == ^user_id, order_by: [asc: i.inserted_at]))
  end
end
