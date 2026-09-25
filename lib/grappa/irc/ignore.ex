defmodule Grappa.IRC.Ignore do
  @moduledoc """
  One `/ignore` entry: a `nick!user@host` mask (#162) and an OPTIONAL glob
  over the message TEXT (issue 2294).

  ## Why the text half exists

  A relay bot — the Telegram↔IRC bridge on `#sbiffo` is the reported case —
  speaks for many people through ONE prefix. Every line carries the bot's
  `nick!user@host`, and the real author is in the body as `<Nick> text`. A
  mask-only ignore can therefore only silence the whole bridge. The entry
  gained a second, optional dimension: a PRIVMSG/NOTICE is dropped when the
  mask matches AND the text matches. With no pattern the entry is
  byte-for-byte the #162 behaviour, which is what keeps this additive.

  ## Why a module and not a fourth part on `Grappa.IRC.Mask`

  `Mask` answers "does this prefix match" and nothing else — ban masks,
  `/ignore`, and any future mask consumer all ask exactly that. Hanging a
  text pattern off `Mask.compiled/0` would give every mask a field that is
  meaningless on most of them (CLAUDE.md design discipline (6): a shared
  data model with a mode flag is a boundary violation). The GRAMMAR is
  shared instead of the struct — `Mask.compile_glob/2` compiles both — so
  the two can never learn different metacharacters.

  ## Two representations, and which is which

    * `t:t/0` is the entry as the operator wrote it and as it is STORED and
      put on the wire: two strings (the second `nil`). Normalised, so
      structural equality IS entry identity — `/unignore` removes the entry
      equal to the one it normalises, and a mask may appear more than once
      with different patterns (two bridged authors are two entries).
    * `t:compiled/0` is what the inbound hot path matches against. The
      session compiles the list once at spawn and once per mutation, never
      per line.

  ## Matching rules, all deliberate

    * **Glob, not regex** (`*` any run, `?` exactly one) — the same grammar
      as the mask, which is the one an operator already knows from every
      ircd ban list. A second matching language for the same verb is the
      cost this avoids.
    * **Absolutely anchored**, like every mask part: `<SomeNick>*` matches a
      body that STARTS with `<SomeNick>`, and a bare `spam` matches only the
      body that is exactly `spam`. An operator who wants "contains" writes
      `*spam*`. Consistency with the mask beats convenience here — the two
      halves of one entry must not read differently.
    * **ASCII-case-INSENSITIVE** (`i` on the compiled regex, deliberately
      WITHOUT `u`). A message body is CONTENT, never a key, so caselessness
      here is a matcher option and NOT an identifier fold: nothing is stored
      folded and no key is derived, so the #537 `canonical_target/1` rule is
      untouched. The dominant pattern is a nick inside the text, which the
      operator will spell as they read it. `u` is left OFF for two reasons
      that agree: it would fold beyond `A-Z`, which is the over-fold #525
      reversed everywhere else in this tree, and PCRE in unicode mode
      refuses a subject that is not valid UTF-8 — a body arriving from the
      wire IS bytes, and the inbound filter must not be the thing that
      raises on one. Non-ASCII case (`CAFÉ` vs `café`) therefore stays
      DISTINCT, exactly as it does for a nick.
    * **CTCP ACTION matches on the UNWRAPPED argument.** `/me` arrives as
      `\\x01ACTION waves\\x01`; cic renders `* nick waves`. The operator
      writes patterns against what they SEE, and `\\x01` is not a byte
      anybody can type into a compose box. Any OTHER CTCP frame is matched
      RAW — there the envelope IS the content, and an operator writing
      `*VERSION*` means the frame.
  """

  alias Grappa.IRC.{CTCP, Identifier, Mask}

  defmodule Compiled do
    @moduledoc """
    An entry compiled for the inbound hot path: the mask's precompiled parts
    and, when the entry carries one, the text glob as a regex. `text: nil`
    means "mask alone decides" — the #162 entry.
    """

    alias Grappa.IRC.Mask

    @enforce_keys [:mask, :text]
    defstruct [:mask, :text]

    @type t :: %__MODULE__{mask: Mask.compiled(), text: Regex.t() | nil}
  end

  @enforce_keys [:mask, :text_pattern]
  defstruct [:mask, :text_pattern]

  @typedoc "A normalised entry: the folded mask, and the text glob or `nil`."
  @type t :: %__MODULE__{mask: Mask.t(), text_pattern: String.t() | nil}

  @typedoc "An entry compiled for matching — see `Grappa.IRC.Ignore.Compiled`."
  @type compiled :: Compiled.t()

  @typedoc "Why a normalise refused. Distinct tokens: the two halves fail for different reasons."
  @type error :: :invalid_mask | :invalid_text_pattern

  # An IRC line caps the body well below this, so a longer pattern could
  # never match anything — it is only a regex for the compiler to chew on.
  # The mask's own @max_mask_bytes is tighter because a mask has no spaces.
  @max_text_pattern_bytes 512

  @mask_key "mask"
  @text_key "text_pattern"

  @doc """
  Normalises operator input into an entry under the network's casemapping.

  The mask half is `Grappa.IRC.Mask.normalize/2` unchanged. The text half is
  `nil` (no pattern — today's entry) or a non-blank, CRLF-free line within
  `#{@max_text_pattern_bytes}` bytes. Surrounding whitespace is trimmed;
  interior spaces are kept, because a text pattern is a LINE and not a
  whitespace-delimited token the way a mask is.
  """
  @spec normalize(String.t(), String.t() | nil, Identifier.casemapping()) ::
          {:ok, t()} | {:error, error()}
  def normalize(raw_mask, raw_text, casemapping)
      when is_binary(raw_mask) and is_atom(casemapping) do
    with {:ok, mask} <- normalize_mask(raw_mask, casemapping),
         {:ok, text} <- normalize_text(raw_text) do
      {:ok, %__MODULE__{mask: mask, text_pattern: text}}
    end
  end

  @spec normalize_mask(String.t(), Identifier.casemapping()) ::
          {:ok, Mask.t()} | {:error, :invalid_mask}
  defp normalize_mask(raw, casemapping) do
    case Mask.normalize(raw, casemapping) do
      {:ok, mask} -> {:ok, mask}
      :error -> {:error, :invalid_mask}
    end
  end

  @spec normalize_text(term()) :: {:ok, String.t() | nil} | {:error, :invalid_text_pattern}
  defp normalize_text(nil), do: {:ok, nil}

  defp normalize_text(raw) when is_binary(raw) do
    trimmed = String.trim(raw)

    cond do
      trimmed == "" -> {:error, :invalid_text_pattern}
      byte_size(trimmed) > @max_text_pattern_bytes -> {:error, :invalid_text_pattern}
      not Identifier.safe_line_token?(trimmed) -> {:error, :invalid_text_pattern}
      true -> {:ok, trimmed}
    end
  end

  defp normalize_text(_), do: {:error, :invalid_text_pattern}

  @doc """
  The JSON shape an entry is STORED as inside `Grappa.UserSettings`. The text
  key is OMITTED when there is no pattern rather than written as `null` — a
  pattern-less entry then reads identically whichever spelling wrote it, and
  the common row stays the size it was.
  """
  @spec encode(t()) :: %{String.t() => String.t()}
  def encode(%__MODULE__{mask: mask, text_pattern: nil}), do: %{@mask_key => mask}

  def encode(%__MODULE__{mask: mask, text_pattern: text}),
    do: %{@mask_key => mask, @text_key => text}

  @doc """
  Reads ONE stored value back into an entry, leniently.

  A bare STRING is the #162 encoding and reads as a pattern-less entry.
  Accepting it is not a second storage pattern kept for tidiness: the
  settings blob is written by whichever beam is live, and a hot reload
  (`/admin/reload`, the normal deploy here) runs no migration, so a node
  carrying this code WILL read rows the previous one wrote. Anything else
  is `:error` — the list door drops it, and the read fails OPEN.
  """
  @spec decode(term()) :: {:ok, t()} | :error
  def decode(mask) when is_binary(mask), do: {:ok, %__MODULE__{mask: mask, text_pattern: nil}}

  def decode(%{@mask_key => mask, @text_key => text})
      when is_binary(mask) and is_binary(text) do
    {:ok, %__MODULE__{mask: mask, text_pattern: text}}
  end

  def decode(%{@mask_key => mask}) when is_binary(mask),
    do: {:ok, %__MODULE__{mask: mask, text_pattern: nil}}

  def decode(_), do: :error

  @doc """
  Reads a stored LIST, keeping what it can. A non-list reads as `[]`, the
  same "nothing is ignored" the absent key gives — an unreadable ignore list
  must fail OPEN (messages delivered), never closed.
  """
  @spec decode_all(term()) :: [t()]
  def decode_all(list) when is_list(list) do
    for value <- list, {:ok, entry} <- [decode(value)], do: entry
  end

  def decode_all(_), do: []

  @doc "Compiles one entry for matching."
  @spec compile(t()) :: compiled()
  def compile(%__MODULE__{mask: mask, text_pattern: text}) do
    %Compiled{mask: Mask.compile(mask), text: compile_text(text)}
  end

  @doc "Compiles a whole list — the session's load and re-sync door."
  @spec compile_all([t()]) :: [compiled()]
  def compile_all(entries) when is_list(entries), do: Enum.map(entries, &compile/1)

  @spec compile_text(String.t() | nil) :: Regex.t() | nil
  defp compile_text(nil), do: nil
  defp compile_text(text), do: Mask.compile_glob(text, "i")

  @doc """
  Does this compiled entry drop a line from `{nick, user, host}` with this
  `body`? Both halves must say yes; a `nil` text half abstains.
  """
  @spec matches?(
          compiled(),
          String.t(),
          String.t() | nil,
          String.t() | nil,
          String.t(),
          Identifier.casemapping()
        ) :: boolean()
  def matches?(%Compiled{mask: mask, text: text}, nick, user, host, body, casemapping)
      when is_binary(body) do
    Mask.matches?(mask, nick, user, host, casemapping) and text_matches?(text, body)
  end

  @doc """
  True when ANY entry drops the line — the per-message question the delivery
  filter asks. An empty list never matches.
  """
  @spec any_match?(
          [compiled()],
          String.t(),
          String.t() | nil,
          String.t() | nil,
          String.t(),
          Identifier.casemapping()
        ) :: boolean()
  def any_match?([], _, _, _, _, _), do: false

  def any_match?(entries, nick, user, host, body, casemapping) when is_list(entries) do
    Enum.any?(entries, &matches?(&1, nick, user, host, body, casemapping))
  end

  @spec text_matches?(Regex.t() | nil, String.t()) :: boolean()
  defp text_matches?(nil, _), do: true
  defp text_matches?(re, body), do: Regex.match?(re, text_subject(body))

  # What the pattern is matched AGAINST — see the moduledoc's ACTION rule.
  @spec text_subject(String.t()) :: String.t()
  defp text_subject(body) do
    if CTCP.action?(body) do
      case CTCP.verb_args(body) do
        {"ACTION", args} -> args
        _ -> body
      end
    else
      body
    end
  end
end
