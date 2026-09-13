defmodule Grappa.Dcc do
  @moduledoc """
  The DCC RECEIVE spool: bytes a PEER pushed at one of our subjects over
  `DCC SEND`, after that subject explicitly accepted the offer (issue
  2089).

  ## A separate context, for the reason `Grappa.Avatars` is one

  `Grappa.Uploads` is content OUR user chose to publish — public,
  permanent by default, theirs. This is content a STRANGER chose to push
  at them. Two trust domains, and CLAUDE.md is explicit that a shared data
  model with a type flag across two of them is a boundary violation rather
  than reuse. So: a third table, a third storage root, a third reaper —
  the same VERBS, separate NOUNS, which is design-discipline (6) applied
  rather than restated.

  ## The three ceilings, and the one that is a ruling

  All three are module attributes rather than operator settings — the
  `Grappa.Avatars` form, chosen deliberately over a `Grappa.ServerSettings`
  knob and argued in the PR body. The short version is that moduledoc's own
  sentence, which describes this spool exactly: *"this cache grows from
  OTHER people's claimed URLs, so it needs its own tight ceiling"*. A knob
  on a stranger-fed ceiling is a knob whose only use is to widen the
  exposure, and promoting a constant to a setting later is additive.

  🔴 **`@max_retention_seconds` is vjt's retention ruling and is not
  optional.** He first said to reuse the per-subject upload TTL of #2094.
  Measured, that alone inverts the requirement:
  `UserSettings.get_upload_ttl_seconds/1` answers `nil` for every subject
  who has never touched the setting — the DEFAULT — and in the uploads
  model `expires_at IS NULL` means NEVER EXPIRES
  (`Grappa.Uploads.list_expired/1` enumerates `not is_nil(expires_at)`).
  So for the average user a stranger's bytes would have stayed forever,
  the exact inverse of "nothing stranger-pushed persists un-reaped". vjt's
  ruling on the contradiction: the hard spool cap wins ANYWAY, including
  when the subject TTL is nil. `retention_seconds/1` is that arithmetic,
  and `dcc_files.expires_at` is `NOT NULL` so it cannot be routed around.

  ## What this context does NOT do

  It does not decide whether an offer may be accepted — that is
  `Grappa.Dcc.Policy`, applied BEFORE a socket is opened, so each refusal
  keeps its own reported reason. It does not move bytes — that is
  `Grappa.Dcc.Transfer`. It does not hold unaccepted offers — those live
  in the session process, because an offer is a peer's live TCP endpoint
  and is worth nothing once that process is gone.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Repo, Grappa.Subject],
    exports: [SpoolFile]

  import Ecto.Query

  alias Grappa.Dcc.SpoolFile
  alias Grappa.{Repo, Subject}

  @slug_byte_size 16
  @slug_regex ~r/\A[a-z2-7]{26}\z/

  @storage_root_key {__MODULE__, :storage_root}

  # ------------------------------------------------------------------
  # The numbers. OURS, not ruled — vjt gave the FORM twice and the value
  # neither time, and said so. Each one is derived from something already
  # in the tree rather than invented, and each is a constant precisely so
  # it can be moved in review without an architecture argument.
  # ------------------------------------------------------------------

  # Ruling 3: a DEDICATED per-transfer ceiling. Explicitly NOT
  # `ServerSettings.get_upload_per_file_cap_bytes/1`, which is keyed by
  # MIME category (`:image | :video | :document | :audio`) — and a `DCC
  # SEND` carries no MIME at all, which is the measurement the ruling
  # rests on.
  #
  # The VALUE is the document-category default (10 MiB), because
  # `:document` is this deployment's existing answer to "a file we cannot
  # otherwise classify", which is what every DCC offer is. Reading the
  # value off that category is not reading the FUNCTION: the source is
  # this constant, so a change to upload policy cannot silently move DCC
  # policy.
  @max_transfer_bytes 10 * 1024 * 1024

  # The whole spool's disk budget: 100 max-size transfers, and a tenth of
  # the `upload.global_cap_bytes` default (10 GiB). Smaller than the
  # uploads budget on purpose and for the Avatars reason — a user's own
  # uploads are bounded by what THEY choose to upload, and this grows from
  # what other people choose to push.
  @global_cap_bytes 1024 * 1024 * 1024

  # Ruling 1: the hard retention ceiling, which wins over the subject's
  # upload TTL in BOTH directions — it supplies the value when that
  # setting is nil, and clamps it when it is larger.
  #
  # The VALUE is `259_200` — three days, the longest rung of the upload
  # TTL ladder (`@allowed_ttl_seconds` in `GrappaWeb.UploadsController`),
  # i.e. the longest retention this deployment offers a user for their OWN
  # content. Stranger-pushed bytes must not outlive that. It BINDS rather
  # than decorates: `UserSettings.put_upload_ttl_seconds/2` accepts up to
  # `31_536_000` (a year), so a subject who set a year is clamped here.
  @max_retention_seconds 3 * 24 * 60 * 60

  @doc """
  Boot-time injection of the spool's storage root — mirrors
  `Grappa.Uploads.boot/1` and `Grappa.Avatars.boot/1`. Read ONCE here into
  `:persistent_term`, never per call: CLAUDE.md bans runtime
  `Application.get_env/2`, and this is the non-process DI seam it names.
  """
  @spec boot(Path.t()) :: :ok
  def boot(path) when is_binary(path) do
    :persistent_term.put(@storage_root_key, path)
    :ok
  end

  @spec storage_root() :: Path.t()
  def storage_root, do: :persistent_term.get(@storage_root_key)

  @doc """
  The per-transfer ceiling in bytes. Public so the policy gate, the report
  and a test read the number instead of restating it.
  """
  # `unquote/1` pins the spec to the compile-time singleton — the codebase
  # idiom for a constant-returning function (`Grappa.Notify.max_entries/0`),
  # and `pos_integer()` is a `:underspecs` supertype that fails the gate.
  @spec max_transfer_bytes() :: unquote(@max_transfer_bytes)
  def max_transfer_bytes, do: @max_transfer_bytes

  @doc "The whole spool's disk budget in bytes."
  @spec global_cap_bytes() :: unquote(@global_cap_bytes)
  def global_cap_bytes, do: @global_cap_bytes

  @doc "The hard retention ceiling in seconds — see the moduledoc."
  @spec max_retention_seconds() :: unquote(@max_retention_seconds)
  def max_retention_seconds, do: @max_retention_seconds

  @doc """
  How long a file accepted by `subject` may sit in the spool.

  The subject's own upload TTL when they set one, the hard ceiling when
  they did not, and the hard ceiling when theirs exceeds it. `nil` is the
  DEFAULT state of that setting, not an opt-out — treating it as "no
  expiry", which is what the uploads model means by it, is the
  contradiction vjt ruled on.

  Takes the TTL as an ARGUMENT rather than reading `Grappa.UserSettings`
  here: this context would otherwise need a dep on it purely to be
  overruled by its own ceiling, and the clamp is the part worth testing in
  isolation.
  """
  @spec retention_seconds(pos_integer() | nil) :: pos_integer()
  def retention_seconds(nil), do: @max_retention_seconds

  def retention_seconds(subject_ttl) when is_integer(subject_ttl) and subject_ttl > 0 do
    min(subject_ttl, @max_retention_seconds)
  end

  @doc """
  Records an accepted, fully-transferred file. Called AFTER
  `Grappa.Dcc.Transfer.run/3` returns `{:ok, _}` and the bytes are on disk
  at `storage_path(slug)` — file first, then the row, the ordering both
  sibling contexts use so a racing read sees a live row and ENOENT rather
  than a dangling reference.

  `filename` must already be neutralised (`Grappa.Dcc.Report.
  display_filename/1`); this is a storage boundary, not a display one.
  """
  @spec store(Subject.t(), integer(), String.t(), map()) ::
          {:ok, SpoolFile.t()} | {:error, Ecto.Changeset.t()}
  def store(subject, network_id, slug, %{} = meta)
      when is_integer(network_id) and is_binary(slug) do
    attrs =
      Subject.put_subject_id(
        %{
          slug: slug,
          network_id: network_id,
          peer_nick: meta.peer_nick,
          filename: meta.filename,
          bytes: meta.bytes,
          expires_at: DateTime.add(DateTime.utc_now(), meta.retention_seconds, :second)
        },
        subject
      )

    %SpoolFile{}
    |> SpoolFile.insert_changeset(attrs)
    |> Repo.insert()
  end

  @doc """
  Whether another `max_transfer_bytes/0` worth of file fits in the budget.

  Pre-estimated at the CEILING rather than at the offer's claimed size,
  and deliberately: the claim is the peer's, and a sender who declares low
  to slip under the budget is exactly the sender this check exists for.
  The transfer truncates at the claim, so the estimate can only
  over-reserve.
  """
  @spec budget_available?() :: boolean()
  def budget_available? do
    query = from(f in SpoolFile, select: coalesce(sum(f.bytes), 0))

    Repo.one(query) + @max_transfer_bytes <= @global_cap_bytes
  end

  @doc """
  Looks up a spooled file for the authenticated serving route.

  Scoped to BOTH the subject and the network, and neither conjunct is
  redundant. The route is mounted under `/networks/:network_id/...` behind
  `ResolveNetwork`, which proves a credential on THAT network — so a
  slug-only lookup would make every subject's spool readable by anyone
  bound to any network, which is wider than the route's gate proves. The
  subject conjunct is the one that matters most here: unlike a cached
  avatar, these bytes were sent TO a person.

  `{:error, :not_found}` collapses a bad slug shape, a missing row, an
  expired one, and another subject's — the serving route leaks no oracle,
  the same collapse `Avatars.get_by_slug/2` makes.
  """
  @spec get_by_slug(Subject.t(), integer(), String.t()) ::
          {:ok, SpoolFile.t()} | {:error, :not_found}
  def get_by_slug(subject, network_id, slug) when is_integer(network_id) and is_binary(slug) do
    if Regex.match?(@slug_regex, slug) do
      row =
        SpoolFile
        |> Subject.subject_where(subject)
        |> where([f], f.network_id == ^network_id and f.slug == ^slug)
        |> where([f], f.expires_at > ^DateTime.utc_now())
        |> Repo.one()

      if row, do: {:ok, row}, else: {:error, :not_found}
    else
      {:error, :not_found}
    end
  end

  @doc """
  Rows whose `expires_at` has passed — `Grappa.Dcc.Reaper`'s enumeration.

  No `is_nil` arm, unlike `Grappa.Uploads.list_expired/1`: the column is
  `NOT NULL` here, so every row is in scope by construction. That is the
  retention ruling holding at the query layer as well as in the DDL.
  """
  @spec list_expired(DateTime.t()) :: [SpoolFile.t()]
  def list_expired(%DateTime{} = now) do
    query = from(f in SpoolFile, where: f.expires_at <= ^now)

    Repo.all(query)
  end

  @doc """
  Hard-deletes a row. No soft-delete, unlike `Grappa.Uploads`: that exists
  there to protect a PUBLIC, cacheable URL that may be in flight when the
  reaper runs, and this spool is served only behind `:authn` +
  `ResolveNetwork`. The caller (the reaper) unlinks the file first.
  """
  @spec delete(SpoolFile.t()) :: :ok
  def delete(%SpoolFile{} = row) do
    Repo.delete!(row)
    :ok
  end

  @doc """
  Composes the on-disk path for a slug. Raises on a slug that is not the
  minted shape — this value reaches `File.read/1`, and the guard is what
  makes the peer's own filename structurally unable to get there (it is
  stored as display metadata and never as a path).
  """
  @spec storage_path(String.t()) :: Path.t()
  def storage_path(slug) when is_binary(slug) do
    unless Regex.match?(@slug_regex, slug), do: raise(ArgumentError, "invalid slug shape: #{inspect(slug)}")
    Path.join(storage_root(), slug)
  end

  @doc """
  Mints an opaque handle: 16 random bytes as 26 lower-case base32 chars,
  the same alphabet and entropy `Grappa.Uploads` and `Grappa.Avatars` use.

  Public because `Grappa.Session.DccOffers` mints its in-memory offer
  handles here too. Same VERB, two namespaces: an offer handle names a
  held offer in one session's memory and dies with the process, a spool
  slug names bytes on disk. Sharing the minter is reuse; sharing one value
  across both would tie a memory handle to a disk name for no measured
  gain.
  """
  @spec mint_slug() :: String.t()
  def mint_slug do
    @slug_byte_size
    |> :crypto.strong_rand_bytes()
    |> Base.encode32(case: :lower, padding: false)
  end
end
