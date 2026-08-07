defmodule Grappa.Push.Subscription do
  @moduledoc """
  Schema for `push_subscriptions` — one row per (user, browser-push
  endpoint).

  Push notifications cluster B1 (2026-05-14). Stores the three opaque
  fields the W3C Push API hands out (`endpoint`, `p256dh_key`,
  `auth_key`) plus per-device metadata (`user_agent`, `last_used_at`,
  `label`) that drives the "see + revoke my devices" UX in the cic
  settings drawer (B3).

  ## `label` — the only user-writable field (#964)

  Nullable, set through `label_changeset/2` alone. NULL means "no
  label" and the client falls back to a derived name. The ordinal that
  disambiguates two same-browser devices is deliberately NOT a column:
  it is a function of how many rows currently share a parsed name, so a
  stored copy strands a lone `#2` the moment `#1` is deleted.

  ## Subject XOR

  Mirrors `Grappa.Scrollback.Message` / `Grappa.ReadCursor.Cursor` /
  `Grappa.QueryWindows.Window`: exactly one of `:user_id` /
  `:visitor_id` is set. Enforced at three layers: schema-level
  `validate_subject_xor/1` (errors attach to the synthetic
  `:subject` key), DB CHECK constraint
  `push_subscriptions_subject_xor`, and two partial unique indexes
  (one per subject branch) on `(<subject_id>, endpoint)`. The
  visitor-parity cluster (V1, 2026-05-15) flipped the prior
  user-only shape — visitors with persistent NickServ identification
  install the PWA and own subscriptions co-equal with users; the
  visitor reaping CASCADE wipes anon visitor subscriptions on TTL
  expiry.

  ## Endpoint length cap

  Endpoint URLs are vendor-opaque tokens; observed lengths span
  ~100B (Mozilla autopush) to ~600B (Chrome FCM). The 2048-byte
  changeset cap is defensive — push specs don't formally bound the
  URL, but rejecting comically long values at the boundary stops
  pathological cases from filling sqlite text pages.

  ## Public API

  Callers receive `%Subscription{}` structs through `Grappa.Push`
  context functions (`create/2`, `list_for_subject/1`, `delete/1`,
  `touch_last_used/1`, `delete_dead/1`). The Boundary annotation on
  `Grappa.Push` exports this module so the `t()` cross-module
  reference resolves cleanly in published docs.
  """

  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.Visitors.Visitor

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          visitor_id: Ecto.UUID.t() | nil,
          visitor: Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
          endpoint: String.t() | nil,
          p256dh_key: String.t() | nil,
          auth_key: String.t() | nil,
          user_agent: String.t() | nil,
          label: String.t() | nil,
          last_used_at: DateTime.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}

  schema "push_subscriptions" do
    belongs_to :user, User, type: :binary_id
    belongs_to :visitor, Visitor, type: :binary_id

    field :endpoint, :string
    field :p256dh_key, :string
    field :auth_key, :string
    field :user_agent, :string
    field :label, :string
    field :last_used_at, :utc_datetime_usec

    timestamps(type: :utc_datetime_usec)
  end

  @required ~w(endpoint p256dh_key auth_key)a
  # Subject FK columns (`:user_id` / `:visitor_id`) are NOT in
  # `@required` — XOR enforcement runs through `validate_subject_xor/1`,
  # which errors on the synthetic `:subject` key instead of either
  # column individually.
  # `last_used_at` is intentionally NOT in the cast allowlist — it's
  # server-controlled (set via `Grappa.Push.touch_last_used/1`'s bare
  # `Ecto.Changeset.change/2` path after a successful B2 Sender
  # delivery). A caller cannot supply an arbitrary timestamp on
  # create. `user_agent` IS optional; B1 review (B1.r1, 2026-05-14).
  # `label` is likewise absent from the allowlist: it is the ONE
  # user-writable field, it is never known at registration time (the
  # browser has nothing to name itself with — see #964 on why the machine
  # hostname is not reachable from a page), and it travels on its own
  # `label_changeset/2` so a POST body cannot widen the create surface.
  @optional ~w(user_agent)a
  @subject ~w(user_id visitor_id)a

  # Graphemes, not bytes — the cap bounds what the drawer renders, and the
  # drawer renders characters. Roomy enough for "MacBook del lavoro",
  # tight enough that the row keeps its ellipsis instead of wrapping.
  @label_max 64

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

  `assoc_constraint(:user)` + `assoc_constraint(:visitor)` surface FK
  violations as friendly `:user_id` / `:visitor_id` changeset errors
  (mirrors `Grappa.QueryWindows.Window.changeset/2` post-M6 +
  `Grappa.ReadCursor.Cursor.changeset/2`).

  Two `unique_constraint`s — one per subject branch — match the
  partial unique indexes
  `push_subscriptions_user_id_endpoint_index` and
  `push_subscriptions_visitor_id_endpoint_index`. Both route the
  constraint error to `:endpoint` via the `error_key:` override —
  without it Ecto routes to the first column of the index (the
  subject FK), which gives cic an unhelpful
  `{user_id: ["has already been taken"]}` envelope when the
  conflict is really about the endpoint URL.

  Re-subscription from the same browser on the same device produces
  the same endpoint URL — the upsert path in `Grappa.Push.create/2`
  intentionally lets this surface as `field_errors.endpoint` so cic
  can detect the replay condition and refresh local cache.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(sub, attrs) do
    sub
    |> cast(attrs, @subject ++ @required ++ @optional)
    |> validate_required(@required)
    |> validate_length(:endpoint, max: 2048)
    |> validate_length(:p256dh_key, max: 256)
    |> validate_length(:auth_key, max: 64)
    |> validate_length(:user_agent, max: 512)
    |> validate_subject_xor()
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
    |> unique_constraint([:user_id, :endpoint], error_key: :endpoint)
    |> unique_constraint([:visitor_id, :endpoint], error_key: :endpoint)
    |> check_constraint(:subject,
      name: :push_subscriptions_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
    )
  end

  @doc """
  Rename changeset — the ONE user-writable field on a subscription (#964).

  Separate from `changeset/2` on purpose: `label` is not knowable at
  registration, so keeping it off the create allowlist means the POST
  surface cannot grow a field by accident, and this changeset cannot be
  talked into touching an endpoint or a key.

  The stored contract, and who enforces each half:

    * **blank → NULL**, so "cleared" has exactly ONE representation and
      the read side tests `is_nil/1` and never also `== ""`. This is what
      makes clearing the label fall back to the derived
      `Browser on OS [#n]` default instead of rendering an empty name.
      Enforced by `cast/3` itself: its default `:empty_values` already
      folds `""` AND a whitespace-only string to `nil`. Measured, not
      assumed — a hand-written blank arm here was proven dead by removing
      it and watching the blank/whitespace tests stay green. The tests
      pin the CONTRACT, so it survives whoever implements it.
    * **trim** of a non-blank value — a label is a display string, and
      invisible padding would make two labels compare unequal. This half
      Ecto does NOT do, so it lives here.
    * **cap at #{@label_max} graphemes**, applied AFTER the trim, so a
      value that only exceeds the cap by padding is accepted rather than
      rejected on characters the user cannot see.

  A non-string value fails `cast/3` with `"is invalid"`; the controller
  rejects that shape earlier with a 400 so the 422 envelope stays about
  values, not types.
  """
  @spec label_changeset(t(), map()) :: Ecto.Changeset.t()
  def label_changeset(%__MODULE__{} = sub, attrs) do
    sub
    |> cast(attrs, [:label])
    |> update_change(:label, &normalize_label/1)
    |> validate_length(:label, max: @label_max)
  end

  @spec normalize_label(String.t() | nil) :: String.t() | nil
  defp normalize_label(nil), do: nil

  defp normalize_label(label) when is_binary(label), do: String.trim(label)

  # Mirror of `Grappa.ReadCursor.Cursor.validate_subject_xor/1`.
  @spec validate_subject_xor(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_subject_xor(changeset) do
    user_id = get_field(changeset, :user_id)
    visitor_id = get_field(changeset, :visitor_id)

    case {user_id, visitor_id} do
      {nil, nil} -> add_error(changeset, :subject, "must set user_id or visitor_id")
      {_, nil} -> changeset
      {nil, _} -> changeset
      {_, _} -> add_error(changeset, :subject, "user_id and visitor_id are mutually exclusive")
    end
  end
end
