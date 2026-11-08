defmodule GrappaWeb.Validation do
  @moduledoc """
  Boundary-shape validators and path-parameter normalisers shared by the
  JSON REST controllers.

  These check input *shape* (channel-name well-formedness, etc.) before
  the controller hands the value to a context. They surface as
  `{:error, :bad_request}` so the `FallbackController` returns 400 —
  distinct from the wire-injection guard inside
  `Grappa.IRC.Identifier.safe_line_token?/1` which surfaces as
  `:invalid_line` once the channel name reaches `Grappa.Session`.

  `slug_from_path/1` is the second kind: not a verdict but a
  normalisation, reducing a `:slug[.ext]` path segment to the slug the
  context will look up. It lives beside the validators for the same
  reason they live here — two controllers need it and neither owns it.

  Live here (not in a per-controller `defp`) so both
  `MessagesController` and `ChannelsController` share one definition
  per CLAUDE.md "Implement once, reuse everywhere." Belongs to the
  `GrappaWeb` boundary (no explicit `use Boundary`) — controllers
  import it the same way they import other helpers.
  """

  alias Grappa.IRC.Identifier

  @doc """
  Returns `:ok` if `name` is a syntactically valid IRC channel name
  (`#`/`&`/`+`/`!` sigil per RFC 2812 §1.3 — a lone `#` or `&` is a whole
  name, issue 2424; `Identifier.valid_channel?/1` owns the rule), else
  `{:error, :bad_request}`.
  """
  @spec validate_channel_name(String.t()) :: :ok | {:error, :bad_request}
  def validate_channel_name(name) do
    if Identifier.valid_channel?(name), do: :ok, else: {:error, :bad_request}
  end

  @doc """
  Returns `:ok` if `name` is a non-empty RFC1459 comma-separated channel
  LIST (`#a,#b,#c`) in which EVERY element is a syntactically valid
  channel name, else `{:error, :bad_request}`.

  #382 — the JOIN path (`ChannelsController.create/2`) accepts the
  RFC1459 multi-channel form the client already forwards as one string.
  This is the LIST-aware sibling of `validate_channel_name/1`, wired ONLY
  at the create/JOIN door: PART / membership / TOPIC keep the strict
  single-channel `validate_channel_name/1` (a comma there is genuinely
  malformed). It reuses `validate_channel_name/1` per element so the
  per-channel shape rule can never drift between the two doors
  (implement-once). A single channel (no comma) is a list-of-one → `:ok`,
  so the single-channel POST body is byte-identical behaviour. Fails the
  WHOLE line if ANY member is invalid (no partial JOIN) and rejects the
  empty string (`""` → `[""]` → invalid element) and a trailing comma
  (empty trailing element).
  """
  @spec validate_channel_list(String.t()) :: :ok | {:error, :bad_request}
  def validate_channel_list(name) when is_binary(name) do
    channels = String.split(name, ",")

    if Enum.all?(channels, fn channel -> validate_channel_name(channel) == :ok end),
      do: :ok,
      else: {:error, :bad_request}
  end

  @doc """
  Returns `:ok` if `name` is a syntactically valid IRC PRIVMSG read
  target — either a channel name (`#`/`&`/`+`/`!` sigil per RFC 2812
  §1.3), a peer nick as the upstream allows it (`Identifier.wire_nick?/1`,
  issue 2599: IRCnet's `foo~`, a collision UID), or the Grappa-internal
  synthetic `"$server"` pseudo-target used for the server-messages window.

  `"$server"` is not a real IRC target — it is a Grappa-internal name
  written by `Grappa.Session.Server` when persisting server NOTICEs,
  MOTD lines, and other messages without an explicit channel context.
  The synthetic must be accepted here so `loadInitialScrollback` REST
  fetch succeeds for the Server window in cicchetto.

  **Read-only** — used by `MessagesController.index/2` (GET) and
  `ChannelsController` for membership reads.
  `MessagesController.create/2` (POST) uses the stricter
  `validate_post_target_name/1` because RFC 2812 §3.3.1 server-mask
  syntax (`$mask`) is a real IRC target form: a write to `"$server"`
  would smuggle a `PRIVMSG $server :body` upstream and probe operator
  privileges. Read paths are safe — they only consult the local DB.
  """
  @spec validate_target_name(String.t()) :: :ok | {:error, :bad_request}
  def validate_target_name("$server"), do: :ok

  def validate_target_name(name) do
    if Identifier.valid_channel?(name) or Identifier.wire_nick?(name),
      do: :ok,
      else: {:error, :bad_request}
  end

  @doc """
  Like `validate_target_name/1` but rejects the `"$server"` synthetic.

  Codebase review 2026-05-08 W1: PRIVMSG to `$server` is a server-mask
  write per RFC 2812 §3.3.1 — accepting it on POST lets a client smuggle
  bytes upstream, pollute the synthetic Server-window scrollback via the
  single-source echo path, and probe operator privileges. The synthetic
  is for *reading* server-window scrollback, never for *writing*.

  Used by `MessagesController.create/2`'s plain arm, where the target is
  ALSO the persist key. The notice/CTCP arms take
  `validate_wire_recipient_name/2` instead, and the ops-only PRIVMSG arm
  `validate_statusmsg_recipient/4` — see there for why a wire recipient may
  carry a STATUSMSG sigil and a window key may not.
  """
  @spec validate_post_target_name(String.t()) :: :ok | {:error, :bad_request}
  def validate_post_target_name("$server"), do: {:error, :bad_request}

  def validate_post_target_name(name), do: validate_target_name(name)

  @doc """
  Like `validate_post_target_name/1` but for a WIRE RECIPIENT: additionally
  accepts a channel addressed at a membership level (`@#chan`, `@%#chan`),
  peeling the network's advertised STATUSMSG sigils before testing the name
  behind them. `statusmsg` comes from `Grappa.Session.statusmsg/2`.

  #1301 — `/notice @#chan` was refused as malformed. A STATUSMSG sigil is
  neither a channel prefix nor a nick character, so the raw target matched
  neither validator and the POST 400ed. `@` and `%` were refused outright;
  `+#chan` and `&#chan` passed, but by accident — `+` and `&` are RFC
  channel prefixes, so the voice-level notice worked while the ops-level
  one, the common case, did not.

  ## Why this is a separate validator, not a widening

  `validate_post_target_name/1` also guards the plain `channel_id` arm,
  where the target IS the persist key. Admitting `@#chan` there would key
  scrollback to a window nobody is in — the outbound twin of the phantom
  `+#chan` window #1303 fixes on the inbound side. On the notice/CTCP arms
  the recipient is not a key: the echo row is keyed to the SOURCE window and
  the recipient rides `meta.notice_target`, so a sigil costs nothing there.
  The two arms differ in what the target IS, so they take different doors.

  The peeled remainder is what gets validated; the target reaches the wire
  **verbatim**. Peeling to validate is not permission to rewrite — what
  `@%#chan` means is the ircd's ruling, and a target we canonicalised (or
  refused on our own authority) would answer a question nobody asked.
  """
  @spec validate_wire_recipient_name(String.t(), [String.t()]) :: :ok | {:error, :bad_request}
  def validate_wire_recipient_name(name, statusmsg)
      when is_binary(name) and is_list(statusmsg) do
    {peeled, _} = Identifier.peel_statusmsg(name, statusmsg)
    validate_post_target_name(peeled)
  end

  @doc """
  Returns `:ok` if `recipient` is a CHANNEL addressed at one or more of the
  membership levels this network ADVERTISES in `STATUSMSG=` (`@#chan`,
  `@%#chan`) **and** `window` — the URL `channel_id` the echo will render in —
  names that same channel under `casemapping`. `{:error, :bad_request}`
  otherwise.

  issue 2179 — the PRIVMSG door for an ops-only channel message. It is the
  sibling of `validate_wire_recipient_name/2` and deliberately NARROWER on
  both axes, because the two arms differ in what the recipient IS.

  ## Why narrower, not the same validator

  On the notice/CTCP arms the recipient may be anything the ircd will take —
  a nick, a channel, a channel at a level — because the echo is keyed to the
  SOURCE window and the recipient is pure payload (`meta.notice_target`).
  Here the recipient DECIDES the window: the channel behind the sigil is
  where the row lands, mirroring `EventRouter`'s ingress peel, which is what
  puts every other member's copy of the same wire line in `#chan`. So:

    * a BARE name (`#chan`, `bob`) is refused — nothing was peeled, there is
      no membership level, and that send is the plain arm's;
    * a sigil over a NICK (`@bob`) is refused — `peel_statusmsg/2` already
      declines to peel unless a channel starts behind the run, so this falls
      out of the same call rather than needing a second rule;
    * a sigil the network does NOT advertise (`%#chan` on bahamut's `@+`) is
      refused, NOT silently stripped. Stripping it would send to the whole
      channel a line the operator addressed to half of it.

  ## Why the window is compared here

  Because the recipient decides the key, the URL would otherwise be a
  parameter nobody reads — and a client that POSTed `@#chan` to `#other`
  would get a row filed somewhere its own URL denies. Comparing turns that
  silent misfile into a 400. The fold is `canonical_target/2` under the
  network's CASEMAPPING, the same ingress fold `MessagesController.index/2`
  applies, so `#CHAN` and `@#chan` agree on bahamut and `#foo[1]` /
  `@#foo{1}` agree on solanum.

  The recipient still reaches the wire **verbatim** — peeling to validate is
  not permission to rewrite (`validate_wire_recipient_name/2`'s rule, and it
  holds here for the same reason).
  """
  @spec validate_statusmsg_recipient(
          String.t(),
          String.t(),
          [String.t()],
          Identifier.casemapping()
        ) :: :ok | {:error, :bad_request}
  def validate_statusmsg_recipient(recipient, window, statusmsg, casemapping)
      when is_binary(recipient) and is_binary(window) and is_list(statusmsg) do
    case Identifier.peel_statusmsg(recipient, statusmsg) do
      {channel, level} when is_binary(level) -> same_channel(channel, window, casemapping)
      {_, nil} -> {:error, :bad_request}
    end
  end

  @spec same_channel(String.t(), String.t(), Identifier.casemapping()) ::
          :ok | {:error, :bad_request}
  defp same_channel(channel, window, casemapping) do
    with :ok <- validate_channel_name(channel) do
      if Identifier.canonical_target(channel, casemapping) ==
           Identifier.canonical_target(window, casemapping),
         do: :ok,
         else: {:error, :bad_request}
    end
  end

  @doc """
  Atomizes a whitelisted subset of string-keyed `params` into an
  atom-keyed attrs map — the shared PATCH/POST helper for the admin
  JSON controllers (`servers`, `users`, `networks`, `featured_channels`,
  `credentials`).

  Only keys **present** in `params` land in the result: a whitelisted
  key absent from `params` is omitted, never `nil`-filled, so an empty
  result map is a valid no-op update. Every retained key resolves via
  `String.to_existing_atom/1` — the caller MUST have already rejected
  non-whitelisted keys (extra keys → `{:error, :bad_request}`), so the
  atom is guaranteed to exist.

  The `/2` form is identity-valued — the correct behavior for a
  controller with no per-field normalization. The `/3` form threads each
  retained value through `value_fun.(key, value)`, letting a controller
  normalize a field at the boundary (e.g. `credentials` atomizes the
  `auth_method` `Ecto.Enum` string so a typo surfaces as a changeset
  validation error against the enum allowlist rather than a silent
  no-op). Both share one reduce so the whitelist semantics can never
  drift between controllers (a widened/narrowed copy is a security
  regression — CLAUDE.md "Implement once, reuse everywhere").
  """
  @spec take_atomized(map(), [String.t()]) :: map()
  def take_atomized(params, keys), do: take_atomized(params, keys, fn _, v -> v end)

  @spec take_atomized(map(), [String.t()], (String.t(), term() -> term())) :: map()
  def take_atomized(params, keys, value_fun) do
    Enum.reduce(keys, %{}, fn key, acc ->
      case Map.fetch(params, key) do
        {:ok, v} -> Map.put(acc, String.to_existing_atom(key), value_fun.(key, v))
        :error -> acc
      end
    end)
  end

  @doc """
  The minted slug inside a `:slug[.ext]` path segment — everything up to
  the first dot, or the whole segment when there is none.

  Both public byte-serving routes mint a type-carrying URL
  (`/uploads/<slug>.<ext>` since #418, `/dcc_files/<slug>.<ext>` since
  issue 2127) and both must look up by the BARE slug: the slug is the
  access token, the extension is an advisory hint for the client and is
  IGNORED here. A base32 slug never contains a dot, so the first
  dot-delimited segment is always the slug; a legacy extensionless link
  reduces to itself.

  That the extension cannot reach the lookup is the load-bearing half. A
  lying `.html`/`.svg` therefore changes neither the row found nor the
  Content-Type served — each controller serves what its own row says,
  with `nosniff` blocking any browser MIME-sniff on top.

  Returns a string, never a verdict: a slug that survives this and is
  still malformed is rejected by the context's own shape guard
  (`Grappa.Uploads.valid_slug?/1`, `Grappa.Dcc.get_by_slug/1`), which
  collapses it into the route's uniform 404 rather than a distinct 400.
  """
  @spec slug_from_path(String.t()) :: String.t()
  def slug_from_path(segment) when is_binary(segment) do
    segment |> String.split(".", parts: 2) |> hd()
  end
end
