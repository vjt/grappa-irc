// Returns the rendered prefix sigil for a member, given their mode list:
// "@" for op, "+" for voiced, " " (single space) for plain — the space
// keeps columns aligned with @/+-prefixed siblings in monospace
// rendering.
//
// Lifted from `ScrollbackPane.tsx`'s former module-private `memberSigil`
// helper so the same sigil derivation is reused by MembersPane (right
// pane) AND ScrollbackPane (sender prefix in scrollback rows). Per
// CLAUDE.md "implement once, reuse everywhere".
//
// IMPORTANT: this is the DOM-text representation. The previous
// MembersPane implementation rendered the prefix via CSS `::before
// { content: ... }`, which read fine visually but was invisible to
// `textContent` and got clipped when paired with a `width: 100%`
// block-level click button (Spec #5). See memory
// `feedback_css_block_button_wraps_inline_prefix` for the regression
// post-mortem.

export const memberSigil = (modes: string[]): "@" | "+" | " " => {
  if (modes.includes("@")) return "@";
  if (modes.includes("+")) return "+";
  return " ";
};
