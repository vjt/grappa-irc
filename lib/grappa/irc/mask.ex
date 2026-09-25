defmodule Grappa.IRC.Mask do
  @moduledoc """
  `nick!user@host` glob masks (#162) — the shape every IRC client uses for
  `/ignore`, and the one thing grappa had no matcher for (ban masks travel as
  opaque strings).

  ## Grammar

  A mask is `nick!user@host` where each of the three parts is a glob: `*`
  matches any run of characters (including none) and `?` matches exactly one.
  A bare token with no `!` or `@` is a NICK mask and normalises to `nick!*@*`
  — so `/ignore spambot` means "that nick from anywhere", which is what an
  operator typing it expects.

  ## Folding

  A mask is a KEY-shaped comparison, so it folds the way every other nick key
  does (#537): the nick part goes through `Identifier.canonical_target/2` with
  the NETWORK's casemapping, on both sides. `normalize/2` is the ingress door
  — the caller supplies the casemapping (`Grappa.Session.casemapping/2` at the
  web edge), so a stored mask already sits in that network's folded space: on
  `CASEMAPPING=rfc1459` (solanum/Libera) `/ignore Foo[1]` stores `foo{1}!*@*`
  and catches the sender the ircd itself calls `foo{1}`; on `:ascii` (all of
  prod) the national chars are untouched and `foo[1]` / `foo{1}` stay two
  people. At delivery `matches?/5` folds the SUBJECT nick with the session's
  casemapping (`state.isupport`), never the pattern — the pattern was folded
  when it was written. The known ingress gap applies here as it does to the
  pre-connect autojoin plan: a mask written before the 005 arrived was folded
  `:ascii`.

  User and host fold plain ASCII-lowercase: idents and hostnames are
  case-insensitive on the wire and carry no national-char fold, and
  `*!*@Evil.Example` must catch `evil.example`.

  ## Compiled once

  `compile/1` turns a stored mask into a `t:compiled/0` — its three parts as
  precompiled regexes, or `:any` for a bare `*` so the common `nick!*@*` shape
  runs one regex, not three. `Session.Server` compiles the list when it loads
  it and on every `ignores_changed`; the delivery filter matches against the
  compiled list. The first cut compiled per match — up to three regexes per
  mask per inbound line, on exactly the users who use the feature (review,
  #1984). The compiled form is casemapping-independent (see Folding), so it
  never goes stale when the 005 lands.

  ## Why glob and not regex

  `*` and `?` are what irssi, mIRC and every ircd's ban list speak. A regex
  door would be a second matching language for the same thing, and it is the
  one an operator would have to learn rather than already know.
  """

  alias Grappa.IRC.Identifier

  @typedoc "A validated, normalised mask: always `nick!user@host`."
  @type t :: String.t()

  @typedoc """
  One compiled part: `:any` for a bare `*`, `:never` for a part of a mask
  that failed to parse (a stored string that is not `nick!user@host` matches
  nothing rather than raising — the storage door normalises, so this is
  corruption, and a session must not die of a settings row), else the regex.
  """
  @type part :: :any | :never | Regex.t()

  @typedoc "A mask compiled for matching; `source` is the string it came from."
  @type compiled :: %__MODULE__{source: t(), nick: part(), user: part(), host: part()}

  @enforce_keys [:source, :nick, :user, :host]
  defstruct [:source, :nick, :user, :host]

  # RFC 2812 caps a mask at what fits on a line; anything past this is not a
  # mask an operator typed, it is garbage or an attack on the regex.
  @max_mask_bytes 200

  @doc """
  Normalises operator input into a full `nick!user@host` mask under the
  network's casemapping, or rejects it.

  * `"spambot"`          → `{:ok, "spambot!*@*"}`
  * `"*!*@evil.example"`  → `{:ok, "*!*@evil.example"}`
  * `"Foo[1]"` on `:rfc1459` → `{:ok, "foo{1}!*@*"}`; on `:ascii` → `"foo[1]!*@*"`
  * `""`, spaces, CR/LF, too long, or `!`/`@` in the wrong order → `:error`
  """
  @spec normalize(String.t(), Identifier.casemapping()) :: {:ok, t()} | :error
  def normalize(input, casemapping) when is_binary(input) and is_atom(casemapping) do
    trimmed = String.trim(input)

    with :ok <- one_token(trimmed), {:ok, full} <- full_shape(trimmed) do
      {:ok, fold_mask(full, casemapping)}
    end
  end

  def normalize(_, _), do: :error

  # Is this ONE token an operator could have typed? `safe_line_token?/1` only
  # guards CR/LF/NUL (the CRLF-injection class); a mask is additionally one
  # whitespace-delimited token, so an embedded space or tab is not a mask —
  # it is two things the operator did not mean to join.
  @spec one_token(String.t()) :: :ok | :error
  defp one_token(""), do: :error

  defp one_token(t) do
    cond do
      byte_size(t) > @max_mask_bytes -> :error
      not Identifier.safe_line_token?(t) -> :error
      Regex.match?(~r/\s/u, t) -> :error
      true -> :ok
    end
  end

  # A bare nick becomes `nick!*@*`; otherwise `nick!user@host` — exactly one
  # `!` before exactly one `@`, and the nick part must not be empty (an empty
  # user/host is legal: `*!@*` is odd but harmless, it simply never matches a
  # real prefix).
  @spec full_shape(String.t()) :: {:ok, String.t()} | :error
  defp full_shape(t) do
    cond do
      not String.contains?(t, ["!", "@"]) -> {:ok, t <> "!*@*"}
      Regex.match?(~r/\A([^!@]+)!([^!@]*)@([^!@]*)\z/, t) -> {:ok, t}
      true -> :error
    end
  end

  @doc """
  Compiles a stored mask for matching. A string that is not `nick!user@host`
  compiles to a mask that matches nothing (see `t:part/0`).
  """
  @spec compile(t()) :: compiled()
  def compile(mask) when is_binary(mask) do
    case String.split(mask, ["!", "@"], parts: 3) do
      [n, u, h] -> %__MODULE__{source: mask, nick: part(n), user: part(u), host: part(h)}
      _ -> %__MODULE__{source: mask, nick: :never, user: :never, host: :never}
    end
  end

  @doc "Compiles every mask of a list — the session's load and re-sync door."
  @spec compile_all([t()]) :: [compiled()]
  def compile_all(masks) when is_list(masks), do: Enum.map(masks, &compile/1)

  @doc """
  Does the compiled `mask` match the origin `{nick, user, host}` on a network
  with this `casemapping`?

  `user` and `host` may be `nil` — an ircd that cloaks or a prefix that
  carried only a nick. A `nil` part matches only a wildcard-only pattern
  (`*`), never a concrete one: an ignore on `*!*@evil.example` must not fire
  for a sender whose host we simply cannot see.
  """
  @spec matches?(
          compiled(),
          String.t(),
          String.t() | nil,
          String.t() | nil,
          Identifier.casemapping()
        ) :: boolean()
  def matches?(%__MODULE__{nick: n, user: u, host: h}, nick, user, host, casemapping)
      when is_binary(nick) and is_atom(casemapping) do
    part?(n, Identifier.canonical_target(nick, casemapping)) and
      part?(u, fold_or_nil(user)) and
      part?(h, fold_or_nil(host))
  end

  @doc """
  True when ANY compiled mask in `masks` matches the origin — the per-message
  question the delivery filter asks. An empty list never matches.
  """
  @spec any_match?(
          [compiled()],
          String.t(),
          String.t() | nil,
          String.t() | nil,
          Identifier.casemapping()
        ) :: boolean()
  def any_match?([], _, _, _, _), do: false

  def any_match?(masks, nick, user, host, casemapping) when is_list(masks) do
    Enum.any?(masks, &matches?(&1, nick, user, host, casemapping))
  end

  # ---------------------------------------------------------------------------

  # Fold every part: the nick through the network-aware identifier fold,
  # user/host plain ASCII-lowercase (no national chars in an ident or a host).
  defp fold_mask(mask, casemapping) do
    [n, u, h] = String.split(mask, ["!", "@"], parts: 3)
    Identifier.canonical_target(n, casemapping) <> "!" <> ascii_down(u) <> "@" <> ascii_down(h)
  end

  defp fold_or_nil(nil), do: nil
  defp fold_or_nil(s) when is_binary(s), do: ascii_down(s)

  defp ascii_down(s), do: for(<<c <- s>>, into: "", do: <<if(c in ?A..?Z, do: c + 32, else: c)>>)

  defp part("*"), do: :any
  defp part(pattern), do: compile_glob(pattern, "")

  # Glob a compiled part against a possibly-absent subject. `:any` alone
  # matches an absent part; see `matches?/5`.
  defp part?(:any, _), do: true
  defp part?(:never, _), do: false
  defp part?(_, nil), do: false
  defp part?(%Regex{} = re, subject), do: Regex.match?(re, subject)

  @doc """
  Compiles ONE glob (`*` = any run, `?` = exactly one) into an absolutely
  anchored regex, with `opts` handed to `Regex.compile!/2`.

  Public because it is the grammar, not a mask detail: `Grappa.IRC.Ignore`
  compiles its optional message-text pattern with the SAME `*`/`?` language
  (issue 2294), and a second copy of this function is how the two would
  drift apart the first time one of them learned a new metacharacter.
  Callers inside this module pass `""`; the text pattern passes `"i"`.
  """
  @spec compile_glob(String.t(), binary()) :: Regex.t()
  def compile_glob(pattern, opts) when is_binary(pattern) and is_binary(opts) do
    body =
      pattern
      |> String.split(~r/[*?]/, include_captures: true, trim: true)
      |> Enum.map_join(fn
        "*" -> ".*"
        "?" -> "."
        literal -> Regex.escape(literal)
      end)

    # The ABSOLUTE anchors. `$` also matches before a trailing newline, and
    # the subject side is attacker-controlled: nothing reaches here with a
    # newline today, but that is one refactor away from being false, and the
    # weaker anchor has no test that could notice (review, #1984). The
    # backslashes are pinned by `MaskTest` — a lost one reads as a bare letter
    # and silently matches nothing, which is how the first cut shipped.
    Regex.compile!("\\A" <> body <> "\\z", opts)
  end
end
