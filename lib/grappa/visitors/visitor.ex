defmodule Grappa.Visitors.Visitor do
  @moduledoc """
  Self-service visitor — collapsed shape for both anon and
  NickServ-as-IDP modes per cluster/visitor-auth.

  ## Lifecycle
  - Created on first `POST /auth/login` with a non-`@` identifier.
  - `password_encrypted` nil = anon (no NickServ password ever observed
    via +r MODE).
  - `password_encrypted` non-nil = NickServ password atomically committed
    after grappa observed +r MODE on the visitor's nick (see
    `Grappa.Visitors.commit_password/2`).
  - `expires_at` slides on user-initiated REST/WS verbs (≥1h cadence) +
    jumps to now+7d on +r MODE observation.
  - Reaped by `Grappa.Visitors.Reaper` when `expires_at < now()`. CASCADE
    wipes related rows in `visitor_channels`, `messages`, `accounts_sessions`.

  ## Per-row network pinning
  `network_slug` is fixed at row creation. A config rotation
  (`GRAPPA_VISITOR_NETWORK` change) renders existing rows orphans —
  `Grappa.Bootstrap` hard-errors with operator instructions to run
  `mix grappa.reap_visitors --network=<old_slug>`.
  """

  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.EncryptedBinary
  alias Grappa.IRC.Identifier
  alias Grappa.Visitors.VisitorChannel

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          nick: String.t() | nil,
          network_slug: String.t() | nil,
          password_encrypted: binary() | nil,
          expires_at: DateTime.t() | nil,
          ip: String.t() | nil,
          channels: [VisitorChannel.t()] | Ecto.Association.NotLoaded.t(),
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id
  schema "visitors" do
    field :nick, :string
    field :network_slug, :string
    field :password_encrypted, EncryptedBinary, redact: true
    field :expires_at, :utc_datetime_usec
    field :ip, :string

    has_many :channels, VisitorChannel, foreign_key: :visitor_id

    timestamps(type: :utc_datetime_usec)
  end

  @doc """
  Builds an anon-visitor create changeset. Required fields: `:nick`,
  `:network_slug`, `:expires_at`. `:ip` is optional. Validates `:nick`
  against `Identifier.valid_nick?/1` and `:network_slug` against
  `Identifier.valid_network_slug?/1` — both are wire-bound (PubSub
  topics + IRC handshake), so syntactic hygiene is enforced at the
  boundary. Uniqueness on `(nick, network_slug)` per W2.

  `:expires_at` must be strictly in the future (B5.4 M-pers-3): a row
  born already-expired would be reaped on the next `Reaper` sweep but
  in the meantime would consume `(nick, network_slug)` uniqueness and
  shadow a legitimate concurrent registration. The `validate_change`
  only fires when `:expires_at` is present (`validate_required` runs
  first), so a missing field surfaces a single "can't be blank" error
  rather than an additional confusing "must be in the future" against
  `nil`.
  """
  @spec create_changeset(map()) :: Ecto.Changeset.t()
  def create_changeset(attrs) do
    %__MODULE__{}
    |> cast(attrs, [:nick, :network_slug, :expires_at, :ip])
    |> validate_required([:nick, :network_slug, :expires_at])
    |> validate_change(:nick, &validate_nick/2)
    |> validate_change(:network_slug, &validate_network_slug/2)
    |> validate_change(:expires_at, &validate_future_expires_at/2)
    |> unique_constraint([:nick, :network_slug])
  end

  @doc """
  Atomically commit a NickServ password (encrypted at rest by Cloak)
  and bump expires_at to the registered-user TTL after grappa observed
  +r MODE on the visitor's nick.

  Caller MUST pass a non-empty binary as `password`. Misuse raises
  `FunctionClauseError` — the +r MODE observation handler in
  `Grappa.Session.Server` is the documented (and only) call site, so
  let-it-crash on a bouncer-internal contract violation is the
  appropriate OTP shape.
  """
  @spec commit_password_changeset(t(), binary(), DateTime.t()) :: Ecto.Changeset.t()
  def commit_password_changeset(%__MODULE__{} = visitor, password, expires_at)
      when is_binary(password) and byte_size(password) > 0 do
    change(visitor, %{password_encrypted: password, expires_at: expires_at})
  end

  @doc """
  Slides `expires_at` forward on user-initiated REST/WS verbs. Caller
  enforces the ≥1h cadence (no-op if last touch <1h) — see
  `Grappa.Visitors.touch/1`. Pure schema-level concern: just bumps the
  column.
  """
  @spec touch_changeset(t(), DateTime.t()) :: Ecto.Changeset.t()
  def touch_changeset(%__MODULE__{} = visitor, new_expires_at) do
    change(visitor, %{expires_at: new_expires_at})
  end

  defp validate_nick(field, value) when is_binary(value) do
    if Identifier.valid_nick?(value),
      do: [],
      else: [{field, "must be a valid IRC nickname"}]
  end

  defp validate_network_slug(field, value) when is_binary(value) do
    if Identifier.valid_network_slug?(value),
      do: [],
      else: [{field, "must be a valid network slug"}]
  end

  defp validate_future_expires_at(field, %DateTime{} = value) do
    case DateTime.compare(value, DateTime.utc_now()) do
      :gt -> []
      _ -> [{field, "must be in the future"}]
    end
  end
end
