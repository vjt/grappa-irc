import type { Component } from "solid-js";
import { nickColorVar } from "./lib/nickColor";

// UX-5 bucket BC2 — single-source-of-truth nick render helper.
//
// Renders a nick as an irssi-style two-part inline unit:
//   <span class="nick {extraClass?}">
//     <span class="nick-prefix nick-prefix-{op|halfop|voiced}">{prefix}</span>
//     <span class="nick-text" style="color: var(--nick-color-N)">{nick}</span>
//   </span>
//
// Two-part split lets the OPS glyph (`@`, `%`, `+`) take the existing
// mode-token color (`--mode-op` / `--mode-halfop` / `--mode-voiced`)
// while the nick text takes the deterministic hash palette color.
// That mirrors irssi's `<+vjt>` render where the `+` reads as "voiced"
// in green and `vjt` reads as the personal hash hue. Members pane
// gets the same treatment so the visual contract is identical across
// scrollback + member list (CLAUDE.md "implement once, reuse everywhere").
//
// Every nick render site in cic routes through this component so the
// color/prefix logic stays in ONE place. Click handlers stay OUTSIDE
// (sites wrap NickText inside a clickable `<button>`); NickText is
// presentation-only.
//
// `prefix` is optional — pass it for scrollback senders + members
// pane (anywhere modes are known); skip it for the WHOIS/WHOWAS card
// header, peer-away banner, mentions sender (where modes aren't on
// the wire — these surfaces are bare-nick by design).
//
// `extraClass` is a hatch for surfaces that already attach styling to
// the outer container (e.g. `mentions-row-sender`, `whois-card-target`,
// `home-pane-network-nick`) — passed as an additional class so the
// pre-existing CSS layout rules still apply. The `.nick` baseline is
// always present.

export type PrefixGlyph = "@" | "%" | "+" | "";

export type NickTextProps = {
  nick: string;
  prefix?: PrefixGlyph;
  extraClass?: string;
};

const prefixClass = (prefix: PrefixGlyph): string => {
  switch (prefix) {
    case "@":
      return "nick-prefix nick-prefix-op";
    case "%":
      return "nick-prefix nick-prefix-halfop";
    case "+":
      return "nick-prefix nick-prefix-voiced";
    default:
      return "nick-prefix";
  }
};

const NickText: Component<NickTextProps> = (props) => {
  const cls = () => (props.extraClass ? `nick ${props.extraClass}` : "nick");
  const prefix = (): PrefixGlyph => props.prefix ?? "";
  return (
    <span class={cls()}>
      {prefix() !== "" && <span class={prefixClass(prefix())}>{prefix()}</span>}
      <span class="nick-text" style={{ color: nickColorVar(props.nick) }}>
        {props.nick}
      </span>
    </span>
  );
};

export default NickText;
