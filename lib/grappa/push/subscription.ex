defmodule Grappa.Push.Subscription do
  @moduledoc """
  Schema for `push_subscriptions` — one row per (user, push endpoint).

  Push notifications cluster B1 (2026-05-14). Stores the three opaque
  fields the W3C Push API hands out (`endpoint`, `p256dh_key`,
  `auth_key`) plus per-device metadata (`user_agent`, `last_used_at`)
  that drives the "see + revoke my devices" UX in the cic settings
  drawer (B3).

  ## `:provider` — `:webpush` | `:unifiedpush` (2026-08-13)

  `Ecto.Enum`-typed (mirrors `Networks.Credential.connection_state`
  / `Accounts.Session.kind`) — the wire shape is still the strings
  `"webpush"` / `"unifiedpush"` (Jason encodes an atom as its
  `Atom.to_string/1` form), only the in-process representation is an
  atom.

  Both provider kinds store the SAME three fields and are delivered
  through the SAME `Grappa.Push.Sender` VAPID+encrypt path,
  unbranched — a UnifiedPush registration generates a real P-256
  keypair + auth secret client-side too, exactly like a browser's
  `PushManager.subscribe()` does internally for Web Push. `endpoint`
  is the only thing that differs in KIND: a Web Push endpoint is a
  vendor push-service URL (Chrome FCM, Mozilla autopush); a
  UnifiedPush endpoint is the URL the device's chosen distributor app
  handed the client on registration. `provider` records which one a
  row is purely for client-facing display ("see + revoke my
  devices") — it carries no delivery-behavior difference and no
  validation difference; see `Grappa.Push.Sender`'s moduledoc,
  "`:provider` (2026-08-13, UnifiedPush)".

  Both provider kinds share this one table (not a parallel schema)
  specifically so `GET /push/subscriptions` keeps listing — and
  `DELETE /push/subscriptions/:id` keeps revoking — every device a
  subject has registered, browser or mobile, from one query.

  ## Subject XOR

  Mirrors `Grappa.Scrollback.Message` / `Grappa.ReadCursor.Cursor` /
  `Grappa.QueryWindows.Window`: exactly one of `:user_id` /
  `:visitor_id` is set. Enforced at three layers: schema-level
  `Grappa.Subject.validate_xor/1` (errors attach to the synthetic
  `:subject` key), DB CHECK constraint
  `push_subscriptions_subject_xor`, and two partial unique indexes
  (one per subject branch) on `(<subject_id>, endpoint)`. The
  visitor-parity cluster (V1, 2026-05-15) flipped the prior
  user-only shape — visitors with persistent NickServ identification
  install the PWA and own subscriptions co-equal with users; the
  visitor reaping CASCADE wipes anon visitor subscriptions on TTL
  expiry.

  ## Endpoint length cap

  Endpoint URLs are provider-opaque tokens; observed Web Push lengths
  span ~100B (Mozilla autopush) to ~600B (Chrome FCM); UnifiedPush
  distributor endpoints observed in the same range. The 2048-byte
  changeset cap is defensive — neither spec formally bounds the URL,
  but rejecting comically long values at the boundary stops
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
  alias Grappa.Subject
  alias Grappa.Visitors.Visitor

  @providers [:webpush, :unifiedpush]

  @type provider :: :webpush | :unifiedpush

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          visitor_id: Ecto.UUID.t() | nil,
          visitor: Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
          provider: provider() | nil,
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
    belongs_to :visitor, Visitor, type: :binary_id

    field :provider, Ecto.Enum, values: @providers, default: :webpush
    field :endpoint, :string
    field :p256dh_key, :string
    field :auth_key, :string
    field :user_agent, :string
    field :last_used_at, :utc_datetime_usec

    timestamps(type: :utc_datetime_usec)
  end

  @required ~w(endpoint p256dh_key auth_key)a
  # Subject FK columns (`:user_id` / `:visitor_id`) are NOT in
  # `@required` — XOR enforcement runs through `Grappa.Subject.validate_xor/1`,
  # which errors on the synthetic `:subject` key instead of either
  # column individually.
  # `last_used_at` is intentionally NOT in the cast allowlist — it's
  # server-controlled (set via `Grappa.Push.touch_last_used/1`'s bare
  # `Ecto.Changeset.change/2` path after a successful B2 Sender
  # delivery). A caller cannot supply an arbitrary timestamp on
  # create. `user_agent` IS optional; B1 review (B1.r1, 2026-05-14).
  # `provider` IS optional — defaults to `"webpush"` (the schema
  # field default) when a caller omits it, so every pre-2026-08-13
  # caller keeps working unchanged.
  @optional ~w(provider user_agent)a
  @subject ~w(user_id visitor_id)a

  @doc """
  Insert / update changeset.

  ## Length caps

  W3C Push API spec sizes:
    * `endpoint` — provider-opaque URL, observed range ~100 B (Mozilla
      autopush) to ~600 B (Chrome FCM / UnifiedPush distributors).
      Cap at 2048 B is defensive, stops pathological URLs from
      filling sqlite text pages.
    * `p256dh_key` — uncompressed P-256 EC point: 65 B raw → 88 chars
      base64url. Cap at 256 B is ~3× spec, allows for vendor
      base64url variants without padding ambiguity.
    * `auth_key` — auth secret: 16 B raw → 24 chars base64url. Cap
      at 64 B is ~2.5× spec.
    * `user_agent` — best-effort device identifier from request
      header. Cap at 512 B drops obviously-spoofed long values.

  `:provider` is `Ecto.Enum`-typed against the closed set (`:webpush`
  | `:unifiedpush`) — `cast/3` rejects anything outside it with the
  same `"is invalid"` token `validate_inclusion/3` would produce, so
  no separate validation call is needed here. It does NOT change
  which fields are required — see moduledoc.

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

  Re-subscription from the same browser/distributor on the same
  device produces the same endpoint URL — the upsert path in
  `Grappa.Push.create/2` intentionally lets this surface as
  `field_errors.endpoint` so the client can detect the replay
  condition and refresh local cache.
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
    |> Subject.validate_xor()
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
    |> unique_constraint([:user_id, :endpoint], error_key: :endpoint)
    |> unique_constraint([:visitor_id, :endpoint], error_key: :endpoint)
    |> check_constraint(:subject,
      name: :push_subscriptions_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
    )
  end
end
