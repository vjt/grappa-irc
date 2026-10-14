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

  ## The three ceilings: two are now operator settings, one is a ruling

  🔴 **The two BYTE ceilings are `Grappa.ServerSettings` keys since issue
  2185** — `dcc.max_transfer_bytes` and `dcc.global_cap_bytes`, whose
  DEFAULTS and the reasoning behind their values live beside them there.
  They were module attributes, on this paragraph's own former argument:
  *a knob on a stranger-fed ceiling is a knob whose only use is to widen
  the exposure*. vjt overruled that, and the measurement is what decided
  it: a 10 MiB ceiling declines ordinary files, and an operator cannot
  raise it without a rebuild. What a wider ceiling buys an attacker is
  still bounded by the spool budget, by `Grappa.Dcc.Policy`'s daily accept
  quota, and by the fact that every accept costs a human a deliberate
  click on a stranger's file. The promotion is exactly the move the old
  paragraph closed by calling additive.

  **`@max_retention_seconds` stays an attribute**, and not by omission: it
  is vjt's retention ruling rather than a capacity number, and the only
  thing a knob on it could express is "let a stranger's bytes outlive our
  own users' uploads" — which is the thing the ruling exists to forbid.

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
    # issue 2127 — `public_url/2` mints its absolute URL against
    # `Uploads.base_url/0`, the ONE `:persistent_term` the deployment's
    # public origin lives in (seeded from `Endpoint.url/0` once the
    # Endpoint child is up). A second base-url seam here would be a copy
    # of that boot ordering, not reuse of it. No cycle: `Grappa.Uploads`
    # deps are `[Repo, Subject, Sys.HardenedCmd]`.
    #
    # issue 2185 — `Grappa.ServerSettings` because the two byte ceilings
    # are operator settings now. No cycle: its own deps are `[Repo, PubSub,
    # ServerSettings.Wire, HttpHosts, Net.IpLiteral]` and it never names
    # this context.
    deps: [Grappa.Repo, Grappa.ServerSettings, Grappa.Subject, Grappa.Uploads],
    exports: [SpoolFile]

  import Ecto.Query

  alias Grappa.Dcc.SpoolFile
  alias Grappa.{Repo, ServerSettings, Subject, Uploads}

  @slug_byte_size 16
  @slug_regex ~r/\A[a-z2-7]{26}\z/

  # issue 2127 — what an extension may look like in a minted URL. A
  # CHARACTER whitelist, not a list of known extensions: a `DCC SEND`
  # carries anything (`.zip`, `.iso`, `.mkv`, `.torrent`), and a closed
  # vocabulary would drop the extension off most real traffic while
  # buying nothing — the extension is decoration and the three response
  # headers, not this set, are what make a lying `.svg` harmless.
  #
  # What it IS load-bearing for: the extension can never change the URL's
  # STRUCTURE, only its tail. `/`, `?`, `#`, `%`, `:`, whitespace and
  # every control byte fall outside `[A-Za-z0-9]`, so a peer cannot graft
  # a path segment, a query string or a fragment onto a URL we publish
  # into somebody's scrollback.
  #
  # 8 characters: twice the longest extension `Grappa.Uploads.MimeExt`
  # mints (4 — `webm`, `flac`, `webp`, `xlsx`), which comfortably clears
  # `torrent` at 7 and refuses a 200-char tail. Matched case-SENSITIVE
  # and lowercased AFTER, never before: `String.downcase/1` is Unicode
  # and would fold `İ` into two code points, so validating first keeps
  # the value pure ASCII by the time it is folded.
  @url_extension_regex ~r/\A[A-Za-z0-9]{1,8}\z/

  @storage_root_key {__MODULE__, :storage_root}

  # ------------------------------------------------------------------
  # The numbers that are still OURS. The two byte ceilings left for
  # `Grappa.ServerSettings` in issue 2185 — their defaults and their
  # rationale moved WITH them, so there is exactly one place that records
  # why each number is what it is. What remains here is derived from
  # something already in the tree rather than invented, and stays a
  # constant so it can be moved in review without an architecture
  # argument.
  # ------------------------------------------------------------------

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

  # How long to wait dialling the address the sender published.
  #
  # NOT ours to invent: the house already answers this exact question.
  # `Grappa.Net.ImageFetcher.Req`'s `@connect_timeout_ms` is the budget for
  # dialling an address a stranger published, on the operator's behalf,
  # off the CTCP AVATAR path — the same question with a different
  # transport. Reusing its number is the answer; picking a second one
  # would be inventing a disagreement.
  @connect_timeout_ms 5_000

  # How long the sender may go SILENT mid-file before the transfer is
  # called dead. A different axis from the connect budget and from the
  # image fetcher's `@receive_timeout_ms`, which is a TOTAL for a small
  # body: `Grappa.Dcc.Transfer` clamps at the DECLARED size instead, so
  # what is left to bound here is a stall, not a length.
  #
  # 30s is longer than a congested link's plausible pause and short enough
  # that a sender who vanished is reported while the operator still
  # remembers clicking accept.
  #
  # This bounds silence, NOT duration — every arriving byte starts it
  # again. Duration is `@min_rate_bytes_per_second`'s job (issue 2405).
  @idle_timeout_ms 30_000

  # issue 2405 — the floor rate a sender must hold, on average, to finish:
  # `Grappa.Dcc.Transfer` gives a transfer one `@idle_timeout_ms` plus its
  # DECLARED size at this rate, and fails it `:too_slow` past that. Before
  # it, a sender dripping one byte every 29 seconds held a socket, a file
  # handle and a task for as long as it liked.
  #
  # OURS, not ruled. 8 KiB/s is ~64 kbit/s, one ISDN B channel — the
  # slowest link still worth calling one, so no sender actually serving a
  # file should fall under it, while the hold it grants a trickler stays
  # finite and proportional: 30 s on a 1 KiB offer, ~3 h 34 min at the
  # default 100 MiB ceiling. A stranger buys those hours only on a file
  # the operator clicked to accept, ten times a day at most
  # (`Grappa.Dcc.Policy`). A constant, so moving it is a review comment
  # and a HOT deploy.
  @min_rate_bytes_per_second 8 * 1024

  # issue 2404 — how long a spool file may sit with NO row before
  # `Grappa.Dcc.Reaper` calls it an orphan and unlinks it.
  #
  # 🔴 DERIVED, not chosen, from the same two budgets the transfer runs on
  # (issue 2405), so no change to them can leave the reaper unlinking a
  # file a live transfer is still writing. The reaper reads the file's
  # MTIME, so what must fit under the grace is the longest a live
  # transfer can go WITHOUT WRITING — not how long it can run. Before the
  # first chunk that is the dial plus one idle wait; between two chunks,
  # one idle wait, because every wait is capped by `@idle_timeout_ms` and
  # the ack can no longer block (`Grappa.Dcc.Transfer`, "The ack
  # stream"). Past either the transfer fails and removes the file itself.
  # The total deadline does not enter: a transfer writing every 29 s is
  # never 35 s stale however long it runs.
  #
  # The hour on top covers the one gap no budget bounds: a FINISHED
  # transfer whose result is still queued in a busy session's mailbox,
  # waiting for the row — behind, at most, a socket close that
  # `prim_inet:close/1` caps at three minutes. An hour is ~40x the longest SQLite
  # write-lock hold logged on prod (94.1 s, 2026-09-08), which is the
  # stall that queue would sit behind.
  @orphan_grace_seconds div(@connect_timeout_ms + @idle_timeout_ms, 1_000) + 60 * 60

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
  The per-transfer ceiling in bytes — the `dcc.max_transfer_bytes`
  operator setting since issue 2185. This context's ONE door onto it, so
  the policy gate, the report and a test read the number here instead of
  reaching for `Grappa.ServerSettings` themselves or restating it.

  One sqlite point-read per call, which is the cost
  `Grappa.ServerSettings`'s own moduledoc already accepts for every knob
  and the reason it holds no cache. `Grappa.Dcc.Policy` reads it ONCE per
  offer and carries the value in the refusal — see `check_size/1` there.
  """
  # 🔴 Ruling 3 survives the promotion, and this is where it now lives.
  # Explicitly NOT `ServerSettings.get_upload_per_file_cap_bytes/1`: that
  # is keyed by MIME category (`:image | :video | :document | :audio`) and
  # a `DCC SEND` carries no MIME at all, which is the measurement the
  # ruling rests on. The old constant's value happened to EQUAL the
  # `:document` default; the new default (100 MiB) does not, so the
  # coincidence that made the derivation look reasonable is gone and an
  # operator moving upload policy still cannot move DCC policy.
  #
  # The `unquote/1` spec pinning the sibling constants use had to go with
  # the constant: there is no compile-time singleton left to name, and
  # `pos_integer()` is the honest type of a value read at runtime.
  @spec max_transfer_bytes() :: pos_integer()
  def max_transfer_bytes, do: ServerSettings.get_dcc_max_transfer_bytes()

  @doc """
  The whole spool's disk budget in bytes — the `dcc.global_cap_bytes`
  operator setting since issue 2185.
  """
  @spec global_cap_bytes() :: pos_integer()
  def global_cap_bytes, do: ServerSettings.get_dcc_global_cap_bytes()

  @doc """
  The `Grappa.Dcc.Transfer.run/3` opts for a production transfer.

  ONE keyword list rather than three accessors, because `run/3` `fetch!`es
  all of them and a caller that assembled them by hand could satisfy the
  `fetch!` while disagreeing with the house on one of them. `Transfer`
  itself deliberately holds no defaults — that is what makes it testable
  at millisecond budgets — so the production numbers have to live
  somewhere, and this is the context that owns every other DCC number.
  """
  # Same `unquote/1` pinning as the scalar accessors above, and for the same
  # reason: `pos_integer()` is a `:underspecs` supertype of a list whose two
  # values Dialyzer knows exactly. The non-empty `, ...` is part of the
  # success typing too — the list is a literal, so it can never be empty.
  @spec transfer_opts() :: [
          {:connect_timeout_ms, unquote(@connect_timeout_ms)}
          | {:idle_timeout_ms, unquote(@idle_timeout_ms)}
          | {:min_rate_bytes_per_second, unquote(@min_rate_bytes_per_second)},
          ...
        ]
  def transfer_opts,
    do: [
      connect_timeout_ms: @connect_timeout_ms,
      idle_timeout_ms: @idle_timeout_ms,
      min_rate_bytes_per_second: @min_rate_bytes_per_second
    ]

  @doc "The hard retention ceiling in seconds — see the moduledoc."
  @spec max_retention_seconds() :: unquote(@max_retention_seconds)
  def max_retention_seconds, do: @max_retention_seconds

  @doc """
  How long, in seconds, a spool file with no row may sit before the
  reaper treats it as an orphan (issue 2404). Derived from the transfer
  budgets (issue 2405) — see the attribute for why no live transfer can
  look this old.
  """
  @spec orphan_grace_seconds() :: unquote(@orphan_grace_seconds)
  def orphan_grace_seconds, do: @orphan_grace_seconds

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
  over-reserve. That stays true now both numbers are runtime — and it
  means LOWERING the per-transfer ceiling immediately frees reservation
  for queued offers, so there is no migration and no backfill.

  🔴 Reads BOTH settings, never one against a constant. With only one of
  the two runtime this would be half a lever: an operator raising the
  per-transfer ceiling could not raise the budget to fit it.
  """
  @spec budget_available?() :: boolean()
  def budget_available? do
    query = from(f in SpoolFile, select: coalesce(sum(f.bytes), 0))

    Repo.one(query) + max_transfer_bytes() <= global_cap_bytes()
  end

  @doc """
  Looks up a spooled file for the public serving route.

  🔴 **By slug ALONE — no subject conjunct, no network conjunct (issue
  2127 ruling, vjt, 2026-09-14).** Until then the lookup carried both,
  because the route sat behind `:authn` + `ResolveNetwork` and a
  slug-only read would have granted more than that gate proved. The
  ruling moved the route to the public `/dcc_files/:slug` surface for a
  measured reason — `GrappaWeb.Plugs.Authn` reads only an
  `authorization: Bearer` header, cic keeps its token in `localStorage`,
  and a scrollback link opens a plain tab, so the gated URL collected a
  401 on every tap and no shape of URL bought its way out. So the
  conjuncts went with the gate: **the 26-char base32 slug IS the
  credential**, the same 128 bits `/uploads/:slug` has stood on since
  UX-6-B1, and the consent behind these particular bytes is stronger —
  the operator accepted THIS file from THAT nick before a socket was
  opened.

  The expiry conjunct STAYS, and it is now the only thing between a
  leaked URL and an unbounded read: `expires_at` is `NOT NULL`, so the
  retention ruling binds at the read as well as at the reaper.

  `{:error, :not_found}` collapses a bad slug shape, a missing row and an
  expired one — the serving route leaks no oracle, the same collapse
  `Uploads.get_by_slug/2` makes. The slug is UNIQUE
  (`unique_index(:dcc_files, [:slug])`), so dropping the conjuncts
  narrowed nothing: the index already answered this lookup.
  """
  @spec get_by_slug(String.t()) :: {:ok, SpoolFile.t()} | {:error, :not_found}
  def get_by_slug(slug) when is_binary(slug) do
    if Regex.match?(@slug_regex, slug) do
      row =
        SpoolFile
        |> where([f], f.slug == ^slug)
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
  Of `names` — the entries of a spool directory — the minted slugs that
  NO row points at (issue 2404). `Grappa.Dcc.Reaper`'s orphan
  enumeration: the disk against the table, so it needs no record of its
  own.

  A name that is not the minted shape is never returned, whatever it is:
  this spool only ever writes slugs, and anything else in the directory
  is not ours to remove.

  Says nothing about AGE. A file with no row is also what every transfer
  still in flight looks like, so the caller owns the staleness check
  (`orphan_grace_seconds/0`).
  """
  @spec untracked_slugs([String.t()]) :: [String.t()]
  def untracked_slugs(names) when is_list(names) do
    case Enum.filter(names, &Regex.match?(@slug_regex, &1)) do
      [] ->
        []

      slugs ->
        query = from(f in SpoolFile, where: f.slug in ^slugs, select: f.slug)
        tracked = query |> Repo.all() |> MapSet.new()

        Enum.reject(slugs, &MapSet.member?(tracked, &1))
    end
  end

  @doc """
  Hard-deletes a row. No soft-delete, unlike `Grappa.Uploads`.

  The reason is NOT "this spool is private" — since issue 2127 the URL is
  as public as an upload's. It is that `Grappa.Uploads`' tombstone exists
  to distinguish an ADMIN delete of live content from expiry, so a URL
  revoked mid-flight answers 404 rather than resurrecting if the row were
  re-created. This spool has no admin-delete door: the ONLY thing that
  removes a row is `Grappa.Dcc.Reaper` retiring a row that has already
  expired, and an expired row is already unreadable
  (`get_by_slug/1`'s `expires_at` conjunct). A tombstone would record a
  state the read path cannot tell apart from the one before it.

  The caller (the reaper) unlinks the file first.
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
  The absolute public URL for a spooled file —
  `<base_url>/dcc_files/<slug>[.<ext>]` (issue 2127).

  ## Why absolute

  `Grappa.Dcc.Report.render/2` interpolates this into a scrollback BODY,
  and a body is plain text to everyone downstream. cic's `linkify.ts`
  matches a scheme (`https?://`, `ftp://`, `www.`) or a bare `host.tld/`
  — a leading `/dcc_files/…` is neither, so the relative form rendered as
  unclickable text. `Grappa.Uploads.public_url/2` had already answered
  this for own uploads; the base URL comes from there rather than from a
  second seam.

  ## Why the extension, and why it is only decoration

  cic's `mediaLink.ts` classifies a same-origin link by file EXTENSION,
  so a bare 26-char slug stays an opaque download. The type has to come
  from the peer's declared filename: a `DCC SEND` carries name, address,
  port and size and no MIME, and the schema deliberately has no `mime`
  column.

  That filename is ATTACKER-CONTROLLED TEXT, so it is whitelist-
  normalised and never echoed — see `@url_extension_regex`. The
  extension reaches neither the lookup (`GrappaWeb.Validation.
  slug_from_path/1` strips it; `get_by_slug/1` keys on the 26 characters)
  nor the response headers (`GrappaWeb.DccFilesController` has no branch
  to take). A filename with no admissible extension yields the bare URL,
  exactly as an unmapped MIME does for an upload.

  🔴 Takes the RAW peer filename, NOT `Report.display_filename/1`. That
  one truncates at 120 bytes and appends `…`, which would silently eat
  the extension off a long name and, worse, could make the last
  dot-segment something the peer never wrote.
  """
  @spec public_url(String.t(), String.t()) :: String.t()
  def public_url(slug, filename) when is_binary(slug) and is_binary(filename) do
    base = Uploads.base_url() <> "/dcc_files/" <> slug

    case url_extension(filename) do
      {:ok, ext} -> base <> "." <> ext
      :error -> base
    end
  end

  # The LAST dot-segment, admitted only if it is pure ASCII alphanumeric
  # and at most 8 chars. `String.split/2` on the whole string rather than
  # a `parts: 2` from the left: `holiday.tar.gz` is a `gz`, and a name
  # with no dot at all yields a single-element list and no extension.
  @spec url_extension(String.t()) :: {:ok, String.t()} | :error
  defp url_extension(filename) do
    case String.split(filename, ".") do
      [_] -> :error
      parts -> admit_extension(List.last(parts))
    end
  end

  defp admit_extension(candidate) do
    if Regex.match?(@url_extension_regex, candidate),
      do: {:ok, String.downcase(candidate, :ascii)},
      else: :error
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
