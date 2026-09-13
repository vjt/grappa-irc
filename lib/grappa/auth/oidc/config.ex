defmodule Grappa.Auth.Oidc.Config do
  @moduledoc """
  Boot-time OIDC provider configuration. Read once via `boot/0` from
  `Application.get_env(:grappa, :oidc, ...)`, validated, stored in
  `:persistent_term`. Readers call `config/0` / `enabled?/0`.

  Directly modelled on `Grappa.Admission.Config`: a third-party,
  operator-configured, secret-bearing provider that the BEAM talks to
  over HTTPS, single-provider by construction, `nil` (off) by default.
  CLAUDE.md "Application.{put,get}_env: boot-time only" — this is the
  designated boundary; no other module reads `:oidc` config at runtime.

  ## Configuration keys

  Operator-facing (env vars in `compose.yaml` → `runtime.exs` →
  `:grappa, :oidc`). Everything is OPTIONAL; an unset `:issuer` is the
  off state, exactly like an unset `GRAPPA_CAPTCHA_PROVIDER`, so a
  deploy without the vars boots clean and never offers the door:

    * `:issuer` — the OIDC issuer URL, e.g. `https://idm.example.com`.
      The discovery document is read from
      `<issuer>/.well-known/openid-configuration` and every endpoint,
      including the token endpoint, is taken from it — an operator never
      names an endpoint, so a provider cannot be talked into a
      look-alike one by config alone.
    * `:client_id`, `:client_secret` — the OAuth2 client registered at
      the provider. Both REQUIRED when `:issuer` is set (a non-Disabled
      captcha missing its secret refuses to start; same rule here).
    * `:redirect_uri` — the EXACT URL the operator registered at the
      provider. REQUIRED, never derived from the request: a derived
      redirect would let a Host header choose where the code is
      delivered.
    * `:scopes` — space-separated, default `openid profile email`.
      `openid` is not optional and is forced on: without it the provider
      owes no `id_token`, and the `id_token` is the only thing this
      module trusts for identity. Group-gated provisioning (#1911c)
      reads the `groups` claim, so the scopes AND the provider's client
      must grant it (Kanidm: add `groups` to the scope map, see
      `docs/oidc-kanidm.md`).
    * `:users_group` — OPTIONAL, default `nil` (provisioning OFF: an
      unseen `sub` is refused `not_linked`, the #1911 posture). When
      set, a login round trip whose verified `groups` claim carries the
      group provisions a passwordless account for an unseen `sub` —
      the operator's group list, not the provider's say-so alone,
      decides who gets one.
    * `:admins_group` — OPTIONAL, default `nil` (`is_admin` untouched).
      When set, every successful OIDC login syncs the account's
      `is_admin` to membership: in the group → admin, out of it → not.
      Removal from the group demotes at the NEXT login, not before.

  The reference provider for the acceptance test is Kanidm, but nothing
  here knows that: the flow is generic OIDC discovery + authorization
  code + PKCE, so any conformant provider works.

  ## Deliberately absent

    * No `insecure: true` / `verify: false` knob. Outbound TLS anchors
      on the system CA store (#89); a self-hosted provider with a
      private CA joins the OPERATOR'S trust store, it does not get a
      per-provider switch to weaken verification.
    * No multi-provider list. One provider covers the self-hosted case
      that motivated #1911; many is a schema + provider-selection-in-
      `state` + admin-surface cost that no deployment has asked for yet.
  """

  @moduledoc since: "1.6.0"

  @type t :: %__MODULE__{
          issuer: String.t(),
          client_id: String.t(),
          client_secret: String.t(),
          redirect_uri: String.t(),
          scopes: String.t(),
          users_group: String.t() | nil,
          admins_group: String.t() | nil
        }

  @enforce_keys [:issuer, :client_id, :client_secret, :redirect_uri, :scopes]
  defstruct @enforce_keys ++ [:users_group, :admins_group]

  @key {__MODULE__, :config}

  @default_scopes "openid profile email"

  @spec boot() :: :ok
  @doc """
  Reads OIDC config from `Application.get_env/3`, validates, and stores
  in `:persistent_term` for lock-free runtime reads. Called once from
  the application start callback, beside the sibling `boot/0` seams.

  Disabled (nil) is the normal state: `config/0` then answers `nil` and
  every door in `GrappaWeb.OidcController` answers 404.
  """
  def boot do
    :persistent_term.put(@key, build(Application.get_env(:grappa, :oidc, nil)))
    :ok
  end

  @doc """
  Returns the provider config, or `nil` when no provider is configured.
  Reads from `:persistent_term` — lock-free, non-allocating. Callers
  must call `boot/0` first (ensured by supervision order).
  """
  @spec config() :: t() | nil
  def config, do: :persistent_term.get(@key)

  @doc "Is the OIDC door configured? A nil config is the off state."
  @spec enabled?() :: boolean()
  def enabled?, do: not is_nil(config())

  if Mix.env() == :test do
    @doc false
    @spec put_test_config(t() | nil) :: :ok
    def put_test_config(config), do: :persistent_term.put(@key, config)
  end

  @spec build(nil | keyword()) :: t() | nil
  defp build(nil), do: nil

  defp build(raw) when is_list(raw) do
    issuer = required(raw, :issuer)
    client_id = required(raw, :client_id)
    client_secret = required(raw, :client_secret)
    redirect_uri = required(raw, :redirect_uri)
    scopes = Keyword.get(raw, :scopes, @default_scopes)
    users_group = optional_group(raw, :users_group)
    admins_group = optional_group(raw, :admins_group)

    # `openid` is the switch that obliges the provider to hand back an
    # `id_token` at all. Configuring the door without it yields a flow
    # that can never answer "who is this", so it is forced on rather
    # than validated.
    scopes =
      case String.split(scopes || "", ~r/\s+/, trim: true) do
        [] -> String.split(@default_scopes, " ")
        words -> Enum.uniq(["openid" | List.delete(words, "openid")])
      end
      |> Enum.join(" ")

    %__MODULE__{
      issuer: normalize_issuer(issuer),
      client_id: client_id,
      client_secret: client_secret,
      redirect_uri: redirect_uri,
      scopes: scopes,
      users_group: users_group,
      admins_group: admins_group
    }
  end

  @spec required(keyword(), atom()) :: String.t()
  defp required(raw, key) do
    case Keyword.get(raw, key) do
      value when is_binary(value) and byte_size(value) > 0 -> value
      _ -> raise(ArgumentError, "oidc_#{key} is required when the OIDC provider is configured")
    end
  end

  # The two group gates are OPTIONAL keys with an empty-ish value meaning
  # "off", unlike the required five — one reader per shape, so the empty
  # string a compose file leaves behind reads as nil rather than as a
  # group nobody can ever match.
  @spec optional_group(keyword(), atom()) :: String.t() | nil
  defp optional_group(raw, key) do
    case Keyword.get(raw, key) do
      value when is_binary(value) and byte_size(value) > 0 -> value
      _ -> nil
    end
  end

  @doc """
  Trailing-slash-insensitive issuer comparison. Some providers advertise
  `https://host/oidc/v1` and others `https://host/oidc/v1/`; the `iss`
  claim is matched the way the operator configured it, not the way the
  provider happens to spell it.
  """
  @spec normalize_issuer(String.t()) :: String.t()
  def normalize_issuer(issuer) when is_binary(issuer), do: String.trim_trailing(issuer, "/")

  # Named for the tests; the only pure shape rule in this module.
  @doc false
  @spec default_scopes() :: String.t()
  def default_scopes, do: @default_scopes
end
