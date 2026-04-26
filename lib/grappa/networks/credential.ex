defmodule Grappa.Networks.Credential do
  @moduledoc """
  Per-(user, network) IRC binding: nick, optional realname/SASL identity,
  the upstream auth method (`:auto | :sasl | :server_pass | :nickserv_identify | :none`),
  an optional auth-command template (free-form NickServ verbs), and the
  channel autojoin list.

  ## Encrypted password

  `password_encrypted` is a `Grappa.EncryptedBinary` (Cloak AES-GCM). The
  virtual `:password` field is the input-only plaintext; the changeset
  copies it into `password_encrypted` only when the changeset is otherwise
  valid, mirroring the Argon2 deferral in `Grappa.Accounts.User`. The
  virtual field is `redact: true` so plaintext never appears in
  `inspect/1` or Logger output.

  ## auth_method validation

  `:none` accepts any (or no) password — there's nothing to authenticate
  against upstream. Every other method REQUIRES a non-empty password;
  validation returns a normal changeset error on failure.

  ## Composite primary key

  `(user_id, network_id)` is the natural key — a user has at most one
  credential per network. We don't carry a surrogate `id` because
  every callsite (the operator mix tasks, future REST credentials
  surface, the Session.Server boot path) already has both halves.
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.EncryptedBinary
  alias Grappa.Networks.Network

  @auth_methods [:auto, :sasl, :server_pass, :nickserv_identify, :none]

  @type auth_method :: :auto | :sasl | :server_pass | :nickserv_identify | :none

  @type t :: %__MODULE__{
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          network_id: integer() | nil,
          network: Network.t() | Ecto.Association.NotLoaded.t() | nil,
          nick: String.t() | nil,
          realname: String.t() | nil,
          sasl_user: String.t() | nil,
          password_encrypted: binary() | nil,
          password: String.t() | nil,
          auth_method: auth_method() | nil,
          auth_command_template: String.t() | nil,
          autojoin_channels: [String.t()],
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key false
  schema "network_credentials" do
    belongs_to :user, User, type: :binary_id, primary_key: true
    belongs_to :network, Network, primary_key: true

    field :nick, :string
    field :realname, :string
    field :sasl_user, :string
    field :password_encrypted, EncryptedBinary
    field :password, :string, virtual: true, redact: true
    field :auth_method, Ecto.Enum, values: @auth_methods, default: :auto
    field :auth_command_template, :string
    field :autojoin_channels, {:array, :string}, default: []

    timestamps(type: :utc_datetime_usec)
  end

  # IRC RFC 2812 nickname grammar (with the typical relaxations clients
  # already tolerate — leading digit allowed because some networks
  # do, length capped to a sane 30 instead of the legacy 9).
  @nick_format ~r/^[a-zA-Z\[\]\\`_^{|}][a-zA-Z0-9\[\]\\`_^{|}\-]*$/

  @doc """
  Builds a create/update changeset. The plaintext `:password` (when
  given) is copied into `:password_encrypted` only when the changeset
  is otherwise valid — the Cloak Ecto type encrypts on dump. For
  `auth_method != :none`, either a new `:password` OR an existing
  `:password_encrypted` from a prior bind must be present (so an
  unrelated update — e.g., renaming `:nick` — doesn't force the
  caller to re-supply the password).
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(credential, attrs) do
    credential
    |> cast(attrs, [
      :user_id,
      :network_id,
      :nick,
      :realname,
      :sasl_user,
      :password,
      :auth_method,
      :auth_command_template,
      :autojoin_channels
    ])
    |> validate_required([:user_id, :network_id, :nick, :auth_method])
    |> validate_length(:nick, min: 1, max: 30)
    |> validate_format(:nick, @nick_format, message: "must be a valid IRC nickname (no spaces, no leading digit-only)")
    |> validate_password_for_auth_method()
    |> put_encrypted_password()
  end

  # Either a new plaintext `:password` arrives in this changeset, OR the
  # row already carries a stored `password_encrypted` from a prior bind
  # AND the auth_method isn't being changed. Validating only the virtual
  # field would force every update of an unrelated attribute (nick,
  # autojoin) to re-supply the password. But silently inheriting an
  # existing password across an auth_method CHANGE would let an operator
  # accidentally promote a NickServ-IDENTIFY password into a SASL
  # credential — different upstream auth surface, almost certainly a
  # typo. So when auth_method is in `cs.changes`, we require a fresh
  # `:password`.
  @spec validate_password_for_auth_method(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_password_for_auth_method(cs) do
    case get_field(cs, :auth_method) do
      :none ->
        cs

      _ ->
        new_pw = get_field(cs, :password)
        stored = get_field(cs, :password_encrypted)
        auth_method_changed? = Map.has_key?(cs.changes, :auth_method)

        cond do
          is_binary(new_pw) and byte_size(new_pw) > 0 ->
            cs

          auth_method_changed? ->
            add_error(cs, :password, "must be re-supplied when auth_method changes")

          is_binary(stored) and byte_size(stored) > 0 ->
            cs

          true ->
            add_error(cs, :password, "required for auth_method != :none")
        end
    end
  end

  @spec put_encrypted_password(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp put_encrypted_password(%{valid?: true, changes: %{password: pw}} = cs)
       when is_binary(pw) do
    put_change(cs, :password_encrypted, pw)
  end

  defp put_encrypted_password(cs), do: cs

  @doc """
  Returns `:realname` if set, otherwise `:nick`. The nil-fallback is
  encoded once here so callers (Session.Server.init, IRC.Client opts
  builder) never have to write `credential.realname || credential.nick`
  inline — that pattern was flagged in the 2f code review (I1) for
  silently masking the contract that `realname` defaults to `nick`.
  """
  @spec effective_realname(t()) :: String.t()
  def effective_realname(%__MODULE__{realname: nil, nick: nick}) when is_binary(nick), do: nick
  def effective_realname(%__MODULE__{realname: r}) when is_binary(r), do: r

  @doc """
  Returns `:sasl_user` if set, otherwise `:nick`. Same rationale as
  `effective_realname/1`.
  """
  @spec effective_sasl_user(t()) :: String.t()
  def effective_sasl_user(%__MODULE__{sasl_user: nil, nick: nick}) when is_binary(nick), do: nick
  def effective_sasl_user(%__MODULE__{sasl_user: s}) when is_binary(s), do: s
end
