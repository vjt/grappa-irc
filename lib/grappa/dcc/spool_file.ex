defmodule Grappa.Dcc.SpoolFile do
  @moduledoc """
  Schema for the `dcc_files` table — one row per file a PEER pushed at one
  of our subjects over `DCC SEND`, after that subject accepted the offer
  (issue 2089).

  ## Why a third table and not a flag on `uploads`

  `Grappa.Uploads.Upload` is content OUR user chose to publish. This is
  content a STRANGER chose to push. `Grappa.Avatars.PeerAvatar` already
  split off for the same reason, and the rule it followed is CLAUDE.md's:
  a shared data model with a type flag across two trust domains is a
  boundary violation, not reuse. The on-disk mechanics (a minted slug
  under a storage root) are deliberately identical; the ownership, the
  retention rule and the serving route are not.

  ## `expires_at` is NOT NULL, and that is a ruling in DDL

  On `uploads`, NULL means never expires, and
  `UserSettings.get_upload_ttl_seconds/1` answers `nil` for every subject
  who never touched the setting — the DEFAULT state. Carrying that
  nullability here would have meant a stranger's bytes living forever for
  the average user, the exact inverse of "nothing stranger-pushed persists
  un-reaped". vjt ruled the hard spool cap wins even when the subject's
  TTL is nil; `Grappa.Dcc.retention_seconds/1` is that arithmetic and this
  column is why it cannot be skipped.

  ## No `mime`, deliberately

  Both sibling tables carry one. This one must not: every byte is served
  `application/octet-stream` + `Content-Disposition: attachment` +
  `nosniff`, because issue 2089 forbids PROMOTING a type out of
  stranger-supplied content. A column would be somewhere for a sniffed or
  peer-claimed type to accumulate and eventually be believed.

  ## `peer_nick` and `filename` are DISPLAY, never keys

  `peer_nick` is stored RAW-cased (a nick's case is presentation) and is
  never matched on — nothing here folds, because nothing here looks a peer
  up. `filename` is the already-neutralised display name
  (`Grappa.Dcc.Report.display_filename/1`), not the peer's raw bytes: it
  reaches a `Content-Disposition` header and a rendered row, and the
  on-disk name is the slug, so a traversal shape in the peer's string
  never touches the filesystem.
  """

  use Ecto.Schema

  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.Subject
  alias Grappa.Visitors.Visitor

  # `network_id` is a plain integer field, not a `belongs_to` — the same
  # carve-out `Grappa.Avatars.PeerAvatar` documents, for the same cycle:
  # `Grappa.Networks` depends on `Grappa.Session`, `Grappa.Session` depends
  # on this context, so a `Networks` edge here would close the ring. The
  # DB-level FK in the migration still enforces referential integrity, and
  # nothing here ever preloads or matches a `%Network{}`.
  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          slug: String.t() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          visitor_id: Ecto.UUID.t() | nil,
          visitor: Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
          network_id: integer() | nil,
          peer_nick: String.t() | nil,
          filename: String.t() | nil,
          bytes: non_neg_integer() | nil,
          expires_at: DateTime.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "dcc_files" do
    field :slug, :string

    belongs_to :user, User
    belongs_to :visitor, Visitor

    field :network_id, :integer
    field :peer_nick, :string
    field :filename, :string
    field :bytes, :integer
    field :expires_at, :utc_datetime_usec

    timestamps(type: :utc_datetime_usec)
  end

  @doc """
  Insert-time changeset. Every column is required, `expires_at` included —
  see the moduledoc: a nullable expiry is the one shape this table exists
  to make unrepresentable.

  `bytes` is `greater_than_or_equal_to: 0`, unlike both siblings' strict
  `greater_than: 0`. A zero-byte file is a legal `DCC SEND`
  (`Grappa.IRC.DCC.parse/1` admits `size == 0` on purpose), and rejecting
  it at the last step — after the offer was accepted, the socket dialled
  and the transfer completed — would leave an orphan on disk that no
  sweeper has a row to find.
  """
  @spec insert_changeset(t(), map()) :: Ecto.Changeset.t()
  def insert_changeset(spool_file, attrs) do
    spool_file
    |> cast(attrs, [
      :slug,
      :user_id,
      :visitor_id,
      :network_id,
      :peer_nick,
      :filename,
      :bytes,
      :expires_at
    ])
    |> validate_required([:slug, :network_id, :peer_nick, :filename, :bytes, :expires_at])
    |> validate_number(:bytes, greater_than_or_equal_to: 0)
    |> Subject.validate_xor()
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
    |> unique_constraint(:slug)
    |> check_constraint(:subject,
      name: :dcc_files_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
    )
  end
end
