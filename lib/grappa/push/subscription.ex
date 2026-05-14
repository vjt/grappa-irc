defmodule Grappa.Push.Subscription do
  @moduledoc """
  Schema for `push_subscriptions` — one row per (user, browser-push
  endpoint).

  Push notifications cluster B1 (2026-05-14). Stores the three opaque
  fields the W3C Push API hands out (`endpoint`, `p256dh_key`,
  `auth_key`) plus per-device metadata (`user_agent`, `last_used_at`)
  that drives the "see + revoke my devices" UX in the cic settings
  drawer (B3).

  ## User-only

  No `belongs_to :visitor` — visitors are ephemeral by design, don't
  install the PWA, and a subscription tied to a visitor would dangle
  past visitor reaping. Schema is intentionally narrower than
  `Grappa.Scrollback.Message` (which carries the user/visitor XOR).

  ## Endpoint length cap

  Endpoint URLs are vendor-opaque tokens; observed lengths span
  ~100B (Mozilla autopush) to ~600B (Chrome FCM). The 2048-byte
  changeset cap is defensive — push specs don't formally bound the
  URL, but rejecting comically long values at the boundary stops
  pathological cases from filling sqlite text pages.

  ## Public API

  Callers receive `%Subscription{}` structs through `Grappa.Push`
  context functions (`create/2`, `list_for_user/1`, `delete/1`,
  `touch_last_used/1`, `delete_dead/1`). The Boundary annotation on
  `Grappa.Push` exports this module so the `t()` cross-module
  reference resolves cleanly in published docs.
  """

  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          endpoint: String.t() | nil,
          p256dh_key: String.t() | nil,
          auth_key: String.t() | nil,
          user_agent: String.t() | nil,
          last_used_at: DateTime.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}

  schema "push_subscriptions" do
    belongs_to :user, User, type: :binary_id

    field :endpoint, :string
    field :p256dh_key, :string
    field :auth_key, :string
    field :user_agent, :string
    field :last_used_at, :utc_datetime_usec

    timestamps(type: :utc_datetime_usec)
  end

  @required ~w(user_id endpoint p256dh_key auth_key)a
  # `last_used_at` is intentionally NOT in the cast allowlist — it's
  # server-controlled (set via `Grappa.Push.touch_last_used/1`'s bare
  # `Ecto.Changeset.change/2` path after a successful B2 Sender
  # delivery). A caller cannot supply an arbitrary timestamp on
  # create. `user_agent` IS optional; B1 review (B1.r1, 2026-05-14).
  @optional ~w(user_agent)a

  @doc """
  Insert / update changeset.

  ## Length caps

  W3C Push API spec sizes:
    * `endpoint` — vendor-opaque URL, observed range ~100 B (Mozilla
      autopush) to ~600 B (Chrome FCM). Cap at 2048 B is defensive,
      stops pathological vendor URLs from filling sqlite text pages.
    * `p256dh_key` — uncompressed P-256 EC point: 65 B raw → 88 chars
      base64url. Cap at 256 B is ~3× spec, allows for vendor
      base64url variants without padding ambiguity.
    * `auth_key` — auth secret: 16 B raw → 24 chars base64url. Cap
      at 64 B is ~2.5× spec.
    * `user_agent` — best-effort device identifier from request
      header. Cap at 512 B drops obviously-spoofed long values.

  ## assoc_constraint vs unique_constraint

  `assoc_constraint(:user)` surfaces FK violations as a friendly
  `:user_id` changeset error (mirrors `Grappa.QueryWindows.Window.
  changeset/2` post-M6).

  `unique_constraint([:user_id, :endpoint], error_key: :endpoint)`
  matches the migration's default-name unique index
  `push_subscriptions_user_id_endpoint_index`. The `error_key:
  :endpoint` override routes the constraint error to the field that
  actually carries the offending value — without it Ecto routes to
  the first field of the list (`:user_id`), which gives cic an
  unhelpful `{user_id: ["has already been taken"]}` envelope when
  the conflict is really about the endpoint URL.

  Re-subscription from the same browser on the same device produces
  the same endpoint URL — the upsert path in `Grappa.Push.create/2`
  intentionally lets this surface as `field_errors.endpoint` so cic
  can detect the replay condition and refresh local cache.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(sub, attrs) do
    sub
    |> cast(attrs, @required ++ @optional)
    |> validate_required(@required)
    |> validate_length(:endpoint, max: 2048)
    |> validate_length(:p256dh_key, max: 256)
    |> validate_length(:auth_key, max: 64)
    |> validate_length(:user_agent, max: 512)
    |> assoc_constraint(:user)
    |> unique_constraint([:user_id, :endpoint], error_key: :endpoint)
  end
end
