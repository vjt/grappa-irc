defmodule Grappa.IRC.Identity do
  @moduledoc """
  The shared IRC-registration identity tuple (#211 phase 2).

  A single home for the changeset-level validators + value-level
  `effective_*` fallbacks that govern an IRC registration identity
  (`nick` / `ident` / `realname` / `sasl_user`). Both
  `Grappa.Networks.Credential` (user AND visitor subjects) and the
  visitor write-path (`Grappa.Visitors.Visitor` +
  `Grappa.Visitors.SessionPlan`) route through this module, so the #152
  identity logic lives ONCE instead of being pasted into two schemas — a
  review-fix bug lands here once, not three times.

  ## Relationship to `Grappa.IRC.Identifier`

  `Identifier` owns the pure predicate + fold PRIMITIVES (`valid_nick?/1`,
  `valid_ident?/1`, `safe_line_token?/1`, `sanitize_ident/1`,
  `canonical_nick/1`, …). This module owns the CHANGESET-LEVEL wiring —
  the `validate_change/3` callbacks, the `sanitize_ident` changeset step,
  and the effective-value fallbacks — that adapts those primitives to a
  changeset boundary. Every function here delegates to `Identifier`; the
  duplication phase 2 kills was in the adapters, never the primitives.

  ## Why verbs, not an embedded schema (#211 phase-2 design)

  Both schemas store the tuple as FLAT columns, not a nested map, so an
  `embedded_schema` would force a storage change (out of scope). The two
  schemas also legitimately differ (a visitor row has no
  `sasl_user`/`password`/`auth_method` column), so a single bundled
  pipeline that casts a fixed field-set does not fit either. The shared
  unit is the validator VERBS; each schema keeps its own
  `cast`/`validate_required`/`unique_constraint` wiring. "Reuse the
  verbs, not the nouns."

  ## The `effective_realname` divergence is a parameter

  A user's realname falls back to its `nick`; a visitor's falls back to
  the `"Grappa Visitor"` branding default (vjt ruling E). That is ONE
  rule with a per-subject fallback argument (`effective_realname/2`), not
  two implementations.
  """

  import Ecto.Changeset

  alias Grappa.IRC.Identifier

  @doc """
  Strips a single leading `~` from a changed `:ident` before validation
  (GH #152 anti-spoof — grappa runs no identd, so a user-supplied leading
  `~` must not be presented as identd-verified). Delegates the strip rule
  to `Identifier.sanitize_ident/1`. No-op when `:ident` isn't in the
  changeset's changes.
  """
  @spec sanitize_ident(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  def sanitize_ident(changeset) do
    case get_change(changeset, :ident) do
      ident when is_binary(ident) ->
        put_change(changeset, :ident, Identifier.sanitize_ident(ident))

      _ ->
        changeset
    end
  end

  @doc """
  `validate_change/3` callback rejecting a non-RFC nick via
  `Identifier.valid_nick?/1`. Single source of the nick-shape changeset
  error across every identity-bearing schema.
  """
  @spec validate_nick(atom(), String.t()) :: [{atom(), String.t()}]
  def validate_nick(field, value) when is_binary(value) do
    if Identifier.valid_nick?(value),
      do: [],
      else: [{field, "must be a valid IRC nickname"}]
  end

  @doc """
  `validate_change/3` callback rejecting a non-RFC ident via
  `Identifier.valid_ident?/1` (GH #152). The producing boundary is
  expected to have run `sanitize_ident/1` first, so a residual `~` (from
  `~~evil` → `~evil`) still fails here.
  """
  @spec validate_ident(atom(), String.t()) :: [{atom(), String.t()}]
  def validate_ident(field, value) when is_binary(value) do
    if Identifier.valid_ident?(value),
      do: [],
      else: [{field, "must be a valid IRC ident"}]
  end

  @doc """
  `validate_change/3` callback rejecting any value carrying CR/LF/NUL via
  `Identifier.safe_line_token?/1` — the wire-injection guard for every
  free-form field re-interpolated into an IRC line (realname, sasl_user,
  password, auth-command template, connection-state reason). Spaces are
  legal (trailing text); only the three line-terminating bytes are
  rejected.
  """
  @spec safe_line_token(atom(), String.t()) :: [{atom(), String.t()}]
  def safe_line_token(field, value) when is_binary(value) do
    if Identifier.safe_line_token?(value),
      do: [],
      else: [{field, "contains CR, LF, or NUL byte"}]
  end

  @doc """
  Returns `ident` when a binary, else the `nick` fallback (GH #152). The
  ident defaults to the nick so the USER line stays `USER <nick> …` for a
  subject that never set a distinct ident.
  """
  @spec effective_ident(String.t() | nil, String.t()) :: String.t()
  def effective_ident(ident, _) when is_binary(ident), do: ident
  def effective_ident(nil, nick) when is_binary(nick), do: nick

  @doc """
  Returns `sasl_user` when a binary, else the `nick` fallback.
  """
  @spec effective_sasl_user(String.t() | nil, String.t()) :: String.t()
  def effective_sasl_user(sasl_user, _) when is_binary(sasl_user), do: sasl_user
  def effective_sasl_user(nil, nick) when is_binary(nick), do: nick

  @doc """
  Returns `realname` when a binary, else the caller-supplied `fallback`.
  The fallback is a PARAMETER, not a hard-coded default: users pass their
  `nick`, visitors pass the `"Grappa Visitor"` branding string (vjt
  ruling E) — one rule, two call sites.
  """
  @spec effective_realname(String.t() | nil, String.t()) :: String.t()
  def effective_realname(realname, _) when is_binary(realname), do: realname
  def effective_realname(nil, fallback) when is_binary(fallback), do: fallback
end
